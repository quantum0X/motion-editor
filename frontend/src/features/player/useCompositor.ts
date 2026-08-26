import { useEffect, useRef, useCallback } from "react";
import type { Project, Clip, Track, TextClip, Effect, InterpolationType, TransitionType } from "../../types/project";
import { resolveMediaUrl } from "../../utils/mediaUrl";

/**
 * useCompositor drives a <canvas> preview by:
 *  1. Maintaining one hidden <video> element per video/image asset that
 *     has at least one clip on the timeline (not per clip - multiple
 *     clips from the same asset share one decoder).
 *  2. On every animation frame, for each video track (bottom to top, by
 *     Track.order) finding the clip (if any) active at the current
 *     playhead time, seeking its <video> element to the right source
 *     time, and drawing it onto the canvas.
 *  3. Compositing top tracks over bottom tracks in canvas draw order,
 *     respecting each clip's opacity.
 *
 * This is the "closer to final renderer" approach (vs. just stacking
 * DOM <video> elements) - it's what makes multi-track overlays, and
 * eventually effects/transitions, possible to preview accurately, since
 * everything funnels through one 2D context we fully control.
 *
 * Seeking strategy: rather than constantly calling video.currentTime
 * (which is expensive and asynchronous - the browser needs to decode to
 * the nearest keyframe), we only seek when the required source time
 * drifts from the video's current playback position by more than a
 * small tolerance. During normal playback the videos play natively and
 * stay roughly in sync with the playhead clock on their own; the canvas
 * loop just keeps redrawing whatever frame is currently decoded.
 */

const SEEK_TOLERANCE_SEC = 0.08;

interface VideoElementEntry {
  el: HTMLVideoElement;
  assetId: string;
}

/**
 * Applies an easing curve to a normalized [0,1] progress value, used by
 * transitions to accelerate/decelerate the blend between the outgoing and
 * incoming clip.
 */
export function applyEasing(t: number, easing: InterpolationType): number {
  t = Math.max(0, Math.min(1, t));
  switch (easing) {
    case "easeIn":
      return t * t;
    case "easeOut":
      return 1 - (1 - t) * (1 - t);
    case "bezier":
      // CSS "ease" approximation (cubic bezier 0.25 0.1 0.25 1)
      return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    default:
      return t;
  }
}

/**
 * Computes the source-media time for a clip at a given timeline position,
 * accounting for the clip's source in-point and playback speed.
 */
function sourceTimeForClip(clip: Clip, timelineTime: number): number {
  return clip.sourceInSec + (timelineTime - clip.timelineStartSec) * (clip.speed || 1);
}

/**
 * Computes a clipping rectangle for a directional wipe/slide/push transition.
 * The rectangle is the region where the incoming clip is visible; it grows
 * from the specified direction as progress goes 0 → 1.
 *   "left"  → reveals from left edge (left→right)
 *   "right" → reveals from right edge (right→left)
 *   "up"    → reveals from top edge (top→bottom)
 *   "down"  → reveals from bottom edge (bottom→top)
 */
export function wipeRect(
  direction: string,
  progress: number,
  w: number,
  h: number
): { x: number; y: number; width: number; height: number } {
  switch (direction) {
    case "left":
      return { x: 0, y: 0, width: w * progress, height: h };
    case "right":
      return { x: w * (1 - progress), y: 0, width: w * progress, height: h };
    case "up":
      return { x: 0, y: 0, width: w, height: h * progress };
    default:
      // "down"
      return { x: 0, y: h * (1 - progress), width: w, height: h * progress };
  }
}
/**
 * Describes a transition that is currently being previewed on the
 * timeline: the outgoing clip (the earlier one, which owns the
 * transition), the incoming clip (its next on the same track), and the
 * normalized blend progress (0 = start of the blend, 1 = fully switched
 * to the incoming clip).
 */
interface ActiveTransition {
  out: Clip;
  in: Clip;
  progress: number;
  type: TransitionType;
  direction: string;
  easing: InterpolationType;
}

/**
 * Given a track's clips (sorted by timeline start time), finds the
 * transition whose window covers the given timeline time, if any.
 *
 * A transition is attached to the EARLIER clip and spans the tail of
 * that clip up to the boundary with the next clip on the same track. The
 * window is `[nextClip.timelineStartSec - durationSec, nextClip.timelineStartSec)`.
 */
function findActiveTransition(sortedClips: Clip[], t: number): ActiveTransition | null {
  for (let i = 0; i < sortedClips.length - 1; i++) {
    const out = sortedClips[i];
    const next = sortedClips[i + 1];
    if (!out.transition) continue;

    const duration = out.transition.durationSec || 0;
    if (duration <= 0) continue;

    const boundary = Math.min(out.timelineEndSec, next.timelineStartSec);
    const windowStart = boundary - duration;
    if (t >= windowStart && t < boundary) {
      const rawProgress = (t - windowStart) / duration;
      return {
        out,
        in: next,
        progress: Math.max(0, Math.min(1, rawProgress)),
        type: out.transition.type,
        direction: out.transition.direction || "left",
        easing: out.transition.easing,
      };
    }
  }
  return null;
}

/**
 * Pure drawing step for the outgoing+incoming pair of a transition. Given
 * two already-seeked media sources and the transition's eased progress, it
 * composites them as fade/dissolve (alpha cross-blend), wipe/slide/push
 * (incoming revealed from a direction), or zoom (incoming scales up in).
 *
 * Both sources are drawn inside the same "contain" frame used by normal
 * playback, so the framing never jumps during a transition.
 */
export function drawTransitionPair(
  ctx: CanvasRenderingContext2D,
  outSource: { source: CanvasImageSource | null; srcW: number; srcH: number; filter: string; baseAlpha: number },
  inSource: { source: CanvasImageSource | null; srcW: number; srcH: number; filter: string; baseAlpha: number },
  progress: number, // eased, 0..1
  type: TransitionType,
  direction: string,
  canvasWidth: number,
  canvasHeight: number
) {
  if (!outSource.source && !inSource.source) return;

  const outRect = containRect(outSource.srcW, outSource.srcH, canvasWidth, canvasHeight);
  const inRect = containRect(inSource.srcW, inSource.srcH, canvasWidth, canvasHeight);

  // Draw the outgoing clip first (underneath everything).
  if (outSource.source) {
    ctx.save();
    ctx.filter = outSource.filter;
    ctx.globalAlpha = outSource.baseAlpha;
    ctx.drawImage(outSource.source, outRect.x, outRect.y, outRect.dw, outRect.dh);
    ctx.restore();
  }

  if (!inSource.source) return;

  switch (type) {
    case "fade":
    case "dissolve": {
      // Cross-blend: outgoing stays put, incoming fades up over it.
      ctx.save();
      ctx.filter = inSource.filter;
      ctx.globalAlpha = inSource.baseAlpha * progress;
      ctx.drawImage(inSource.source, inRect.x, inRect.y, inRect.dw, inRect.dh);
      ctx.restore();
      break;
    }
    case "wipe": {
      // Incoming revealed via a growing region from `direction`.
      const region = wipeRect(direction, progress, canvasWidth, canvasHeight);
      ctx.save();
      ctx.beginPath();
      ctx.rect(region.x, region.y, region.width, region.height);
      ctx.clip();
      ctx.filter = inSource.filter;
      ctx.globalAlpha = inSource.baseAlpha;
      ctx.drawImage(inSource.source, inRect.x, inRect.y, inRect.dw, inRect.dh);
      ctx.restore();
      break;
    }
    case "slide":
    case "push": {
      // Incoming slides in from a direction while outgoing stays put.
      const offsetX =
        direction === "left" ? (1 - progress) * canvasWidth : direction === "right" ? -(1 - progress) * canvasWidth : 0;
      const offsetY =
        direction === "up" ? (1 - progress) * canvasHeight : direction === "down" ? -(1 - progress) * canvasHeight : 0;
      ctx.save();
      ctx.filter = inSource.filter;
      ctx.globalAlpha = inSource.baseAlpha;
      ctx.drawImage(inSource.source, inRect.x + offsetX, inRect.y + offsetY, inRect.dw, inRect.dh);
      ctx.restore();
      break;
    }
    case "zoom": {
      // Incoming scales up from ~35% to full size as it fades in.
      const scale = 0.35 + 0.65 * progress;
      ctx.save();
      ctx.translate(inRect.x + inRect.dw / 2, inRect.y + inRect.dh / 2);
      ctx.scale(scale, scale);
      ctx.filter = inSource.filter;
      ctx.globalAlpha = inSource.baseAlpha * progress;
      ctx.drawImage(inSource.source, -inRect.dw / 2, -inRect.dh / 2, inRect.dw, inRect.dh);
      ctx.restore();
      break;
    }
    default: {
      ctx.save();
      ctx.filter = inSource.filter;
      ctx.globalAlpha = inSource.baseAlpha * progress;
      ctx.drawImage(inSource.source, inRect.x, inRect.y, inRect.dw, inRect.dh);
      ctx.restore();
    }
  }
}

/**
 * Computes the "contain" rectangle for a source of the given aspect ratio
 * fitted inside the canvas while preserving aspect ratio (letterboxing --
 * object-fit: contain). Shared by drawContained and the transition
 * renderer so every place that places a media frame on the canvas agrees
 * exactly on the frame's bounds.
 */
export function containRect(
  srcWidth: number,
  srcHeight: number,
  canvasWidth: number,
  canvasHeight: number
): { x: number; y: number; dw: number; dh: number } {
  if (!srcWidth || !srcHeight) return { x: 0, y: 0, dw: 0, dh: 0 };
  const sourceAspect = srcWidth / srcHeight;
  const canvasAspect = canvasWidth / canvasHeight;
  let dw: number, dh: number;
  if (sourceAspect > canvasAspect) {
    dw = canvasWidth;
    dh = canvasWidth / sourceAspect;
  } else {
    dh = canvasHeight;
    dw = canvasHeight * sourceAspect;
  }
  return { x: (canvasWidth - dw) / 2, y: (canvasHeight - dh) / 2, dw, dh };
}

export function useCompositor(
  project: Project | null,
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  hiddenHostRef: React.RefObject<HTMLDivElement | null>,
  playheadSec: number,
  isPlaying: boolean
) {
  const videoElementsRef = useRef<Map<string, VideoElementEntry>>(new Map());
  const imageElementsRef = useRef<Map<string, HTMLImageElement>>(new Map());
  const rafRef = useRef<number | null>(null);
  // Refs mirroring the latest playheadSec / isPlaying so that drawFrame —
  // which runs inside a requestAnimationFrame callback — always reads
  // the *current* values instead of a stale closure capture. This is
  // critical: during playback playheadSec changes every frame, and baking
  // it into drawFrame's useCallback deps would recreate drawFrame (and
  // thus tear down & rebuild the entire RAF loop) sixty times a second,
  // which races against the playback clock and starves the canvas of
  // frames (the preview stops updating while the timeline keeps advancing).
  // The same "read latest via ref inside a stable callback" pattern is
  // already used correctly by usePlaybackClock's tick function.
  const playheadSecRef = useRef(playheadSec);
  const isPlayingRef = useRef(isPlaying);
  // Keep the refs in sync with the latest render values. Updating a ref is
  // not allowed during render, so this happens inside an effect, which React
  // runs synchronously before the browser paints / before the next animation
  // frame. That ordering is what lets drawFrame read the freshest playhead and
  // playing state from the refs without ever needing to be recreated.
  useEffect(() => {
    playheadSecRef.current = playheadSec;
    isPlayingRef.current = isPlaying;
  });

  // --- Element pool management: create/destroy hidden <video>/<img>
  // elements as assets are referenced by clips on the timeline. ---
  useEffect(() => {
    if (!project) return;

    const neededAssetIds = new Set<string>();
    for (const track of project.tracks) {
      if (track.type !== "video") continue;
      for (const clip of track.clips ?? []) neededAssetIds.add(clip.assetId);
    }

    const assetsById = new Map(project.assets.map((a) => [a.id, a]));

    // Create any missing elements.
    for (const assetId of neededAssetIds) {
      const asset = assetsById.get(assetId);
      if (!asset) continue;

      if (asset.mediaType === "video" && !videoElementsRef.current.has(assetId)) {
        const video = document.createElement("video");
        video.muted = true; // canvas compositor handles visuals only; audio is mixed/played separately (see useAudioSync)
        video.preload = "auto";
        video.playsInline = true;
        // Crucial: the element must be attached to the document for the
        // browser to reliably advance it past readyState
        // HAVE_METADATA (1) to HAVE_ENOUGH_DATA (2+) - a video element
        // created via document.createElement and never inserted into
        // the DOM can get permanently stuck at readyState 1 in Chromium,
        // even though decoding doesn't require the element to be
        // visible (we keep it visually hidden via the host container's
        // own styling, not via detachment).
        hiddenHostRef.current?.appendChild(video);
        videoElementsRef.current.set(assetId, { el: video, assetId });
        // asset.filePath is a raw filesystem path from the real backend
        // (not a browser-loadable URL) - resolve it before assigning src.
        // Until this resolves the element just has no src, so the draw
        // loop's videoWidth/videoHeight check below naturally skips
        // drawing it (a legitimate loading state, not a bug).
        resolveMediaUrl(asset.filePath)
          .then((url) => {
            video.src = url;
          })
          .catch((err) => {
            console.error(`Failed to load video asset ${asset.fileName}:`, err);
          });
      }

      if (asset.mediaType === "image" && !imageElementsRef.current.has(assetId)) {
        const img = new Image();
        hiddenHostRef.current?.appendChild(img);
        imageElementsRef.current.set(assetId, img);
        resolveMediaUrl(asset.filePath)
          .then((url) => {
            img.src = url;
          })
          .catch((err) => {
            console.error(`Failed to load image asset ${asset.fileName}:`, err);
          });
      }
    }

    // Destroy elements for assets no longer referenced by any clip, so a
    // long editing session doesn't accumulate unused decoders.
    for (const [assetId, entry] of videoElementsRef.current) {
      if (!neededAssetIds.has(assetId)) {
        entry.el.pause();
        entry.el.removeAttribute("src");
        entry.el.remove();
        videoElementsRef.current.delete(assetId);
      }
    }
    for (const assetId of imageElementsRef.current.keys()) {
      const img = imageElementsRef.current.get(assetId);
      if (!neededAssetIds.has(assetId)) {
        img?.remove();
        imageElementsRef.current.delete(assetId);
      }
    }
  }, [project, hiddenHostRef]);

  const findActiveClip = useCallback((track: Track, atSec: number): Clip | null => {
    for (const clip of track.clips ?? []) {
      if (atSec >= clip.timelineStartSec && atSec < clip.timelineEndSec) return clip;
    }
    return null;
  }, []);

  // --- Play/pause: drive every active video element's native playback
  // (or paused) state so frames actually advance between our redraw calls.
  // When transitioning to playing we also nudge each already-decoded video
  // element to the current playhead *before* calling play(), so playback
  // doesn't start from a stale currentTime (e.g. 0 on a fresh load, or a
  // position left over from a previous clip) and the very first drawn frame
  // is correct instead of a one-frame flash from the wrong position. ---
  useEffect(() => {
    if (!project) return;

    if (isPlaying) {
      const assetsById = new Map(project.assets.map((a) => [a.id, a]));
      for (const track of project.tracks) {
        if (track.type !== "video" || track.hidden) continue;
        const clip = findActiveClip(track, playheadSec);
        if (!clip) continue;
        const asset = assetsById.get(clip.assetId);
        if (!asset || asset.mediaType !== "video") continue;
        const entry = videoElementsRef.current.get(asset.id);
        if (!entry) continue;
        const sourceTime = clip.sourceInSec + (playheadSec - clip.timelineStartSec) * (clip.speed || 1);
        if (entry.el.readyState >= 1 && Math.abs(entry.el.currentTime - sourceTime) > SEEK_TOLERANCE_SEC) {
          entry.el.currentTime = sourceTime;
        }
      }
      // Now start every video element playing natively. Those that are
      // already at the right position will show their decoded frame
      // immediately; the drawFrame loop below keeps them in sync.
      for (const { el } of videoElementsRef.current.values()) {
        el.play().catch(() => {
          /* benign: browsers can reject play() if called before a user
             gesture in some contexts; the compositor's drawFrame still
             seeks and draws the correct frame on every tick. */
        });
      }
    } else {
      for (const { el } of videoElementsRef.current.values()) {
        el.pause();
      }
    }
  }, [isPlaying, project, playheadSec, findActiveClip]);

  // --- The render loop itself. ---
  // drawFrame is a *stable* callback (its deps do NOT include playheadSec
  // or isPlaying -- those are read from refs below). This is essential:
  // if playheadSec were a dependency, playback would recreate drawFrame on
  // every frame, causing the RAF useEffect below to cancel & reschedule
  // the animation loop 60x/second -- racing the playback clock and leaving
  // the canvas starved of frames (nothing renders while the timeline
  // keeps advancing). By reading the latest values via refs we keep the
  // RAF loop running continuously at full browser refresh rate.
  const drawFrame = useCallback(() => {
    // Read latest values from refs -- updated on every React render --
    // so the RAF callback always sees the current playhead/time without
    // needing to be recreated.
    const currentPlayhead = playheadSecRef.current;
    const currentIsPlaying = isPlayingRef.current;

    const canvas = canvasRef.current;
    if (!canvas || !project) {
      // Don't just bail - reschedule. The canvas ref may not be attached
      // yet on the very first frame (React hasn't committed the DOM
      // node), and a project can briefly be null between unmount/remount
      // in StrictMode. Returning without rescheduling here would
      // permanently kill the loop on exactly the kind of transient
      // single-frame failure that's common right at mount - which is
      // exactly the bug this comment is here to prevent reintroducing.
      rafRef.current = requestAnimationFrame(drawFrame);
      return;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      rafRef.current = requestAnimationFrame(drawFrame);
      return;
    }

    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const assetsById = new Map(project.assets.map((a) => [a.id, a]));
    const videoTracks = project.tracks.filter((t) => t.type === "video" && !t.hidden).sort((a, b) => a.order - b.order);

    // Local per-frame helpers used to render clips and transitions. These
    // are recreated on every requestAnimationFrame tick (they're cheap);
    // crucially they read the *current* drawFrame values (playhead, playing
    // state, refs), which is what keeps the whole loop correct and stable.
    const seekVideoNear = (video: HTMLVideoElement, atSec: number) => {
      if (atSec < 0) atSec = 0;
      if (!currentIsPlaying || Math.abs(video.currentTime - atSec) > SEEK_TOLERANCE_SEC) {
        if (video.readyState >= 1) {
          video.currentTime = atSec;
        }
      }
    };

    // Resolves a clip's media into a drawable atom at the given *source*
    // time, seeking its underlying <video> element as needed. Returns null
    // when the media isn't decodable yet (the transition just draws the side
    // that is ready).
    const mediaAtomFor = (clip: Clip, sourceTimeSec: number) => {
      const asset = assetsById.get(clip.assetId);
      if (!asset) return null;
      if (asset.mediaType === "video") {
        const video = videoElementsRef.current.get(asset.id)?.el;
        if (!video) return null;
        seekVideoNear(video, sourceTimeSec);
        if (video.videoWidth > 0 && video.videoHeight > 0) {
          return { source: video, srcW: video.videoWidth, srcH: video.videoHeight };
        }
        return null;
      }
      if (asset.mediaType === "image") {
        const img = imageElementsRef.current.get(asset.id);
        if (img && img.complete) {
          return { source: img, srcW: img.naturalWidth, srcH: img.naturalHeight };
        }
        return null;
      }
      return null;
    };

    // Draws the two sides of a transition at the current playhead: the
    // outgoing clip continues forward at its real position while the
    // incoming clip advances its head through the blend (so motion stays
    // continuous across what would otherwise be a hard cut).
    const drawPreviewTransition = (tr: ActiveTransition) => {
      const progress = applyEasing(tr.progress, tr.easing);
      const dur = (tr.out.transition && tr.out.transition.durationSec) || 1;

      const outAtom = mediaAtomFor(tr.out, sourceTimeForClip(tr.out, currentPlayhead));
      const inSourceTime = tr.in.sourceInSec + tr.progress * dur * (tr.in.speed || 1);
      const inAtom = mediaAtomFor(tr.in, inSourceTime);

      drawTransitionPair(
        ctx,
        {
          source: outAtom ? outAtom.source : null,
          srcW: outAtom ? outAtom.srcW : 0,
          srcH: outAtom ? outAtom.srcH : 0,
          filter: buildCanvasFilter(tr.out.effects ?? []),
          baseAlpha: tr.out.opacity ?? 1,
        },
        {
          source: inAtom ? inAtom.source : null,
          srcW: inAtom ? inAtom.srcW : 0,
          srcH: inAtom ? inAtom.srcH : 0,
          filter: buildCanvasFilter(tr.in.effects ?? []),
          baseAlpha: tr.in.opacity ?? 1,
        },
        progress,
        tr.type,
        tr.direction,
        canvas.width,
        canvas.height
      );
    };

    for (const track of videoTracks) {
      const sortedClips = (track.clips ?? []).slice().sort((a, b) => a.timelineStartSec - b.timelineStartSec);

      // If the playhead is inside a transition window, composite the outgoing
      // + incoming clips instead of drawing a straight hard-cut active clip.
      const activeTransition = findActiveTransition(sortedClips, currentPlayhead);
      if (activeTransition) {
        drawPreviewTransition(activeTransition);
        continue;
      }

      const clip = findActiveClip(track, currentPlayhead);
      if (!clip) continue;

      const asset = assetsById.get(clip.assetId);
      if (!asset) continue;

      const opacity = clip.opacity ?? 1;
      ctx.globalAlpha = opacity;
      ctx.filter = buildCanvasFilter(clip.effects ?? []);

      if (asset.mediaType === "video") {
        const entry = videoElementsRef.current.get(asset.id);
        if (!entry) continue;
        const video = entry.el;

        const sourceTime = clip.sourceInSec + (currentPlayhead - clip.timelineStartSec) * (clip.speed || 1);

        // Only force a seek when not currently playing, or when natural
        // playback has drifted noticeably from where it should be (e.g.
        // right after a scrub or a clip boundary jump). This keeps
        // scrubbing precise while letting playback run smoothly off the
        // video element's own clock rather than fighting it every frame.
        if (!currentIsPlaying || Math.abs(video.currentTime - sourceTime) > SEEK_TOLERANCE_SEC) {
          if (video.readyState >= 1) {
            video.currentTime = sourceTime;
          }
        }

        // Note on readyState: immediately after setting video.currentTime
        // (the seek above), the browser can transiently drop readyState
        // back down to HAVE_METADATA (1) while it buffers around the new
        // position, even though the element already has a decodable
        // frame available. Gating strictly on readyState >= 2
        // (HAVE_CURRENT_DATA) caused the canvas to skip drawing on
        // exactly the frames right after every seek - i.e. constantly,
        // since scrubbing/seeking is the normal way the playhead moves
        // when not playing. videoWidth becoming non-zero is a more
        // reliable signal that there's an actual decoded frame to draw;
        // canvas drawImage against a <video> with at least one decoded
        // frame works correctly even at readyState 1.
        if (video.videoWidth > 0 && video.videoHeight > 0) {
          drawContained(ctx, video, video.videoWidth, video.videoHeight, canvas.width, canvas.height);
        }
      } else if (asset.mediaType === "image") {
        const img = imageElementsRef.current.get(asset.id);
        if (img && img.complete) {
          drawContained(ctx, img, img.naturalWidth, img.naturalHeight, canvas.width, canvas.height);
        }
      }

      ctx.globalAlpha = 1;
      ctx.filter = "none";
    }

    // Text layers - always drawn above every video track, matching the
    // export pipeline's drawtext chain (see backend/export/builder.go),
    // which always composites text as the last stage before the final
    // format normalization.
    const textTracks = project.tracks.filter((t) => t.type === "text" && !t.hidden).sort((a, b) => a.order - b.order);
    for (const track of textTracks) {
      for (const tc of track.textClips ?? []) {
        if (currentPlayhead < tc.timelineStartSec || currentPlayhead >= tc.timelineEndSec) continue;
        drawTextClip(ctx, tc, canvas.width, canvas.height);
      }
    }

    rafRef.current = requestAnimationFrame(drawFrame);
  }, [project, canvasRef, findActiveClip]);

  useEffect(() => {
    rafRef.current = requestAnimationFrame(drawFrame);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [drawFrame]);
}

/**
 * Maps a clip's Effects stack to a CSS filter string for Canvas 2D's
 * ctx.filter, so the Effects panel's sliders visibly change the preview
 * in real time.
 *
 * Canvas 2D's filter only supports the same primitives as CSS filters
 * (blur/brightness/contrast/saturate/hue-rotate/etc.) - there's no
 * canvas-native vignette, grain, or RGB-channel-shift filter. For those
 * three, this is intentionally a no-op here (the effect is still saved
 * on the clip and will apply at export time via backend/export/builder.go,
 * it just isn't previewed pixel-for-pixel in the canvas yet). Sharpen
 * and vhs get a rough visual approximation using the filters that ARE
 * available, since "some directionally-correct feedback while dragging
 * the slider" is more useful here than nothing at all.
 */
function buildCanvasFilter(effects: Effect[]): string {
  const parts: string[] = [];
  for (const effect of effects) {
    if (!effect.enabled) continue;
    const amount = effect.params?.amount ?? 0;
    switch (effect.type) {
      case "brightness":
        parts.push(`brightness(${Math.max(0, 1 + amount / 100)})`);
        break;
      case "contrast":
        parts.push(`contrast(${Math.max(0, 1 + amount / 100)})`);
        break;
      case "saturation":
        parts.push(`saturate(${Math.max(0, 1 + amount / 100)})`);
        break;
      case "blur": {
        const radius = effect.params?.radiusPx ?? 0;
        if (radius > 0) parts.push(`blur(${radius}px)`);
        break;
      }
      case "sharpen":
        // Rough stand-in: a mild contrast boost reads as "crisper" at a
        // glance even though it isn't a true unsharp mask.
        parts.push(`contrast(${1 + amount / 200})`);
        break;
      case "vhs":
        parts.push(`saturate(${Math.max(0, 1 - amount / 300)}) contrast(${1 + amount / 400})`);
        break;
      // vignette / grain / rgbshift: no canvas-filter equivalent, see doc comment above.
      default:
        break;
    }
  }
  return parts.length > 0 ? parts.join(" ") : "none";
}

/**
 * drawContained draws a source media element onto the canvas using
 * "object-fit: contain" semantics (preserve aspect ratio, letterbox if
 * needed) - this matches how the eventual export's `scale + pad` filter
 * chain treats mismatched-aspect-ratio source clips, so the preview and
 * the final render agree on framing.
 */
function drawContained(
  ctx: CanvasRenderingContext2D,
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  canvasWidth: number,
  canvasHeight: number
) {
  if (!sourceWidth || !sourceHeight) return;

  const sourceAspect = sourceWidth / sourceHeight;
  const canvasAspect = canvasWidth / canvasHeight;

  let drawWidth: number, drawHeight: number;
  if (sourceAspect > canvasAspect) {
    drawWidth = canvasWidth;
    drawHeight = canvasWidth / sourceAspect;
  } else {
    drawHeight = canvasHeight;
    drawWidth = canvasHeight * sourceAspect;
  }

  const x = (canvasWidth - drawWidth) / 2;
  const y = (canvasHeight - drawHeight) / 2;

  ctx.drawImage(source, x, y, drawWidth, drawHeight);
}

/**
 * Maps a TextClip.fontFamily key to a CSS font-family stack for Canvas
 * 2D rendering. Mirrors backend/export/builder.go's fontRegistry()
 * mapping of the same keys to bundled .ttf file paths - the actual
 * glyph shapes will differ slightly (browser system font vs. the
 * bundled DejaVu files used at export time) since loading and using a
 * custom @font-face purely for canvas preview accuracy isn't worth the
 * complexity in Phase 1, but the family *category* (sans/serif/mono)
 * and weight always match, so preview and export agree closely enough
 * for positioning, sizing, and timing decisions - the things that
 * actually matter while editing.
 */
function fontFamilyToCss(fontFamily: string): string {
  switch (fontFamily) {
    case "serif":
      return "Georgia, 'Times New Roman', serif";
    case "mono":
      return "'Courier New', monospace";
    default:
      return "Arial, Helvetica, sans-serif";
  }
}

/**
 * drawTextClip renders one TextClip onto the canvas using Canvas 2D's
 * text APIs, matching the positioning/styling semantics of the export
 * pipeline's drawtext filter (see backend/export/builder.go) as closely
 * as Canvas 2D allows:
 *   - position percentages mark the CENTER of the text, same as the
 *     export filter's x/y expressions subtract half the measured
 *     text_w/text_h.
 *   - outline is drawn via strokeText before fillText (canvas has no
 *     direct equivalent of drawtext's bordercolor/borderw, but stroking
 *     then filling produces the same visual effect).
 *   - shadow uses native canvas shadow properties, approximating
 *     drawtext's shadowx/shadowy/shadowcolor.
 */
function drawTextClip(ctx: CanvasRenderingContext2D, tc: TextClip, canvasWidth: number, canvasHeight: number) {
  const fontWeight = tc.fontWeight === "bold" ? "bold" : "normal";
  const fontStack = fontFamilyToCss(tc.fontFamily);

  ctx.save();
  ctx.font = `${fontWeight} ${tc.fontSize}px ${fontStack}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.globalAlpha = tc.opacity ?? 1;

  const x = (tc.positionXPercent / 100) * canvasWidth;
  const y = (tc.positionYPercent / 100) * canvasHeight;

  if (tc.shadowEnabled) {
    ctx.shadowColor = tc.shadowColor || "rgba(0,0,0,0.5)";
    ctx.shadowOffsetX = 2;
    ctx.shadowOffsetY = 2;
    ctx.shadowBlur = 2;
  }

  if (tc.outlineEnabled && tc.outlineWidth > 0) {
    ctx.lineWidth = tc.outlineWidth * 2; // canvas strokes centered on the path; double width to match drawtext's border appearing fully outside the glyph
    ctx.strokeStyle = tc.outlineColor || "#000000";
    ctx.strokeText(tc.content, x, y);
  }

  ctx.fillStyle = tc.color || "#ffffff";
  ctx.fillText(tc.content, x, y);

  ctx.restore();
}

