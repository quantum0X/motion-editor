import { useEffect, useRef, useCallback } from "react";
import type { Project, Clip, MediaAsset, TextClip, Effect, InterpolationType, TransitionType } from "../../types/project";
import { resolveMediaUrl } from "../../utils/mediaUrl";
import { useEditorStore } from "../../stores/editorStore";

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
 * object-fit: contain). Shared by the clip renderer and the transition
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

/** Everything the render loop needs, derived once per project change instead of every frame. */
interface RenderPlan {
  // Logical (project) frame size. All drawing happens in these units; the
  // canvas buffer itself may be smaller (see renderFrame).
  width: number;
  height: number;
  assetsById: Map<string, MediaAsset>;
  // Visible video tracks, bottom-most first, each with its clips sorted by start time.
  videoTracks: Clip[][];
  // Visible text clips, in draw order.
  textClips: TextClip[];
  // Canvas filter string per clip id (see buildCanvasFilter), valid for filterScale.
  filterByClip: Map<string, string>;
  filterScale: number;
}

function buildRenderPlan(project: Project): RenderPlan {
  const videoTracks = project.tracks
    .filter((t) => t.type === "video" && !t.hidden)
    .sort((a, b) => a.order - b.order)
    .map((t) => {
      return (t.clips ?? []).slice().sort((a, b) => a.timelineStartSec - b.timelineStartSec);
    });
  const textClips = project.tracks
    .filter((t) => t.type === "text" && !t.hidden)
    .sort((a, b) => a.order - b.order)
    .flatMap((t) => t.textClips ?? []);
  return {
    width: project.canvasWidth,
    height: project.canvasHeight,
    assetsById: new Map(project.assets.map((a) => [a.id, a])),
    videoTracks,
    textClips,
    filterByClip: new Map(),
    filterScale: 1,
  };
}

function findActiveClip(sortedClips: Clip[], atSec: number): Clip | null {
  for (const clip of sortedClips) {
    if (clip.timelineStartSec > atSec) break;
    if (atSec < clip.timelineEndSec) return clip;
  }
  return null;
}

/**
 * Brings one decoder element to the frame the timeline needs.
 *
 * Paused: seek only when the target actually changed - the old loop set
 * currentTime on every animation frame even when nothing moved, keeping
 * the decoder permanently busy re-seeking to the same frame.
 * Playing: let the element play natively at the clip's speed and only
 * correct real drift (e.g. after a scrub or clip boundary).
 */
function syncVideo(video: HTMLVideoElement, targetSec: number, speed: number, playing: boolean) {
  if (video.readyState < 1) return; // no metadata yet - can't seek
  const target = Math.max(0, targetSec);
  const rate = Math.min(16, Math.max(0.0625, speed || 1));
  if (video.playbackRate !== rate) video.playbackRate = rate;
  const drift = Math.abs(video.currentTime - target);
  if (playing) {
    if (drift > SEEK_TOLERANCE_SEC && !video.seeking) video.currentTime = target;
    if (video.paused) video.play().catch(() => {});
  } else {
    if (!video.paused) video.pause();
    if (drift > 0.001) video.currentTime = target;
  }
}

function releaseVideo(video: HTMLVideoElement) {
  video.pause();
  video.removeAttribute("src");
  video.load(); // actually frees the decoder/buffer
  video.remove();
}

/**
 * useCompositor renders the timeline at the current playhead into the
 * given canvas. It reads the playhead straight from the store (not via
 * React props), so playback doesn't re-render the Player 60x/second, and
 * when paused it only redraws when something actually changed (playhead
 * moved, project edited, or a decoder finished loading/seeking).
 */
export function useCompositor(
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  hiddenHostRef: React.RefObject<HTMLDivElement | null>
) {
  const project = useEditorStore((s) => s.project);
  const isPlaying = useEditorStore((s) => s.isPlaying);

  // Decoder pool keyed by `${assetId}#${slot}`. Slot 0 serves the common
  // case; extra slots are created on demand when one asset is visible
  // more than once in the same frame (a transition between two halves of
  // a split clip, or the same video on two tracks) - sharing one element
  // there made it seek back and forth between two times every frame.
  const videosRef = useRef(new Map<string, HTMLVideoElement>());
  const imagesRef = useRef(new Map<string, HTMLImageElement>());
  const planRef = useRef<RenderPlan | null>(null);
  const dirtyRef = useRef(true);

  const getVideo = useCallback(
    (asset: MediaAsset, slot: number): HTMLVideoElement => {
      const key = `${asset.id}#${slot}`;
      const existing = videosRef.current.get(key);
      if (existing) return existing;

      const video = document.createElement("video");
      video.muted = true; // visuals only; audio is played by useAudioSync
      video.preload = "auto";
      video.playsInline = true;
      const markDirty = () => {
        dirtyRef.current = true;
      };
      video.addEventListener("loadedmetadata", markDirty);
      video.addEventListener("loadeddata", markDirty);
      video.addEventListener("seeked", markDirty);
      // Must be attached to the document: Chromium can leave a detached
      // <video> stuck at readyState HAVE_METADATA forever.
      hiddenHostRef.current?.appendChild(video);
      videosRef.current.set(key, video);
      resolveMediaUrl(asset.filePath)
        .then((url) => {
          video.src = url;
        })
        .catch((err) => console.error(`Failed to load video asset ${asset.fileName}:`, err));
      return video;
    },
    [hiddenHostRef]
  );

  const getImage = useCallback(
    (asset: MediaAsset): HTMLImageElement => {
      const existing = imagesRef.current.get(asset.id);
      if (existing) return existing;

      const img = new Image();
      img.addEventListener("load", () => {
        dirtyRef.current = true;
      });
      hiddenHostRef.current?.appendChild(img);
      imagesRef.current.set(asset.id, img);
      resolveMediaUrl(asset.filePath)
        .then((url) => {
          img.src = url;
        })
        .catch((err) => console.error(`Failed to load image asset ${asset.fileName}:`, err));
      return img;
    },
    [hiddenHostRef]
  );

  // Rebuild the render plan and pre-warm/destroy decoders as clips come
  // and go, so a long session doesn't accumulate unused elements.
  useEffect(() => {
    const plan = project ? buildRenderPlan(project) : null;
    planRef.current = plan;
    dirtyRef.current = true;
    if (!project || !plan) return;

    const needed = new Set<string>();
    for (const track of project.tracks) {
      if (track.type !== "video") continue;
      for (const clip of track.clips ?? []) needed.add(clip.assetId);
    }
    for (const assetId of needed) {
      const asset = plan.assetsById.get(assetId);
      if (asset?.mediaType === "video") getVideo(asset, 0);
      else if (asset?.mediaType === "image") getImage(asset);
    }
    for (const [key, video] of videosRef.current) {
      if (!needed.has(key.slice(0, key.lastIndexOf("#")))) {
        releaseVideo(video);
        videosRef.current.delete(key);
      }
    }
    for (const [assetId, img] of imagesRef.current) {
      if (!needed.has(assetId)) {
        img.remove();
        imagesRef.current.delete(assetId);
      }
    }
  }, [project, getVideo, getImage]);

  useEffect(() => {
    dirtyRef.current = true;
    if (!isPlaying) for (const video of videosRef.current.values()) video.pause();
  }, [isPlaying]);

  useEffect(
    () =>
      useEditorStore.subscribe((state, prev) => {
        if (state.playheadSec !== prev.playheadSec) dirtyRef.current = true;
      }),
    []
  );

  // Release every decoder on unmount.
  useEffect(() => {
    const videos = videosRef.current;
    const images = imagesRef.current;
    return () => {
      for (const video of videos.values()) releaseVideo(video);
      for (const img of images.values()) img.remove();
      videos.clear();
      images.clear();
    };
  }, []);

  // --- The render loop. ---
  useEffect(() => {
    let raf = 0;
    let ctx: CanvasRenderingContext2D | null = null;

    const frame = () => {
      // Always reschedule first: a single bad frame (canvas not mounted
      // yet, no project during a StrictMode remount) must never kill the loop.
      raf = requestAnimationFrame(frame);

      const canvas = canvasRef.current;
      const plan = planRef.current;
      if (!canvas || !plan) return;
      const { playheadSec, isPlaying: playing } = useEditorStore.getState();
      if (!playing && !dirtyRef.current) return;
      dirtyRef.current = false;

      if (!ctx || ctx.canvas !== canvas) ctx = canvas.getContext("2d", { alpha: false });
      if (!ctx) return;
      renderFrame(ctx, plan, playheadSec, playing, getVideo, getImage, videosRef.current);
    };

    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [canvasRef, getVideo, getImage]);

  // Lets the Player force a redraw (e.g. after resizing the canvas buffer,
  // which clears it).
  return useCallback(() => {
    dirtyRef.current = true;
  }, []);
}

type MediaAtom = { source: CanvasImageSource; srcW: number; srcH: number };

function renderFrame(
  ctx: CanvasRenderingContext2D,
  plan: RenderPlan,
  t: number,
  playing: boolean,
  getVideo: (asset: MediaAsset, slot: number) => HTMLVideoElement,
  getImage: (asset: MediaAsset) => HTMLImageElement,
  allVideos: Map<string, HTMLVideoElement>
) {
  // The canvas buffer is sized to how big the preview is on screen
  // (capped at project resolution - see Player.tsx), not always the full
  // project size: a 4K project previewed in an 800px panel used to fill
  // 8.3M pixels per frame. Everything below draws in project units and
  // this transform maps them onto the buffer, so framing is identical.
  const { width, height } = plan;
  const scale = ctx.canvas.width / width;
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.globalAlpha = 1;
  ctx.filter = "none";
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, width, height);

  // Canvas filters work in buffer pixels (they ignore the transform), so
  // blur radii are scaled to match - cached until the scale changes.
  if (plan.filterScale !== scale) {
    plan.filterByClip.clear();
    plan.filterScale = scale;
  }
  const filterFor = (clip: Clip): string => {
    let f = plan.filterByClip.get(clip.id);
    if (f === undefined) {
      f = buildCanvasFilter(clip.effects ?? [], scale);
      plan.filterByClip.set(clip.id, f);
    }
    return f;
  };

  const slotsUsed = new Map<string, number>();
  const activeVideos = new Set<HTMLVideoElement>();

  // Resolves a clip's media at a given *source* time into something
  // drawable, syncing its decoder. Null while the media isn't decodable
  // yet (a legitimate loading state - the frame just skips it).
  const atomFor = (clip: Clip, sourceTimeSec: number): MediaAtom | null => {
    const asset = plan.assetsById.get(clip.assetId);
    if (!asset) return null;
    if (asset.mediaType === "video") {
      const slot = slotsUsed.get(asset.id) ?? 0;
      slotsUsed.set(asset.id, slot + 1);
      const video = getVideo(asset, slot);
      activeVideos.add(video);
      syncVideo(video, sourceTimeSec, clip.speed || 1, playing);
      // videoWidth > 0 (not readyState >= 2) is the reliable "a frame is
      // decoded" signal: readyState transiently drops to HAVE_METADATA
      // right after every seek even though the frame is drawable.
      return video.videoWidth > 0 && video.videoHeight > 0 ? { source: video, srcW: video.videoWidth, srcH: video.videoHeight } : null;
    }
    if (asset.mediaType === "image") {
      const img = getImage(asset);
      return img.complete && img.naturalWidth > 0 ? { source: img, srcW: img.naturalWidth, srcH: img.naturalHeight } : null;
    }
    return null;
  };

  for (const clips of plan.videoTracks) {
    // Inside a transition window: composite outgoing + incoming instead
    // of a hard cut. The outgoing clip continues at its real position
    // while the incoming clip advances its head through the blend.
    const tr = findActiveTransition(clips, t);
    if (tr) {
      const dur = tr.out.transition?.durationSec || 1;
      const outAtom = atomFor(tr.out, sourceTimeForClip(tr.out, t));
      const inAtom = atomFor(tr.in, tr.in.sourceInSec + tr.progress * dur * (tr.in.speed || 1));
      drawTransitionPair(
        ctx,
        {
          source: outAtom?.source ?? null,
          srcW: outAtom?.srcW ?? 0,
          srcH: outAtom?.srcH ?? 0,
          filter: filterFor(tr.out),
          baseAlpha: tr.out.opacity ?? 1,
        },
        {
          source: inAtom?.source ?? null,
          srcW: inAtom?.srcW ?? 0,
          srcH: inAtom?.srcH ?? 0,
          filter: filterFor(tr.in),
          baseAlpha: tr.in.opacity ?? 1,
        },
        applyEasing(tr.progress, tr.easing),
        tr.type,
        tr.direction,
        width,
        height
      );
      continue;
    }

    const clip = findActiveClip(clips, t);
    if (!clip) continue;
    const atom = atomFor(clip, sourceTimeForClip(clip, t));
    if (!atom) continue;
    const rect = containRect(atom.srcW, atom.srcH, width, height);
    ctx.save();
    ctx.globalAlpha = clip.opacity ?? 1;
    ctx.filter = filterFor(clip);
    ctx.drawImage(atom.source, rect.x, rect.y, rect.dw, rect.dh);
    ctx.restore();
  }

  // Text layers - always drawn above every video track, matching the
  // export pipeline's drawtext chain (see backend/export/builder.go).
  for (const tc of plan.textClips) {
    if (t >= tc.timelineStartSec && t < tc.timelineEndSec) drawTextClip(ctx, tc, width, height);
  }

  // Only clips under the playhead should be decoding - the old code
  // started *every* pooled video playing whenever playback began.
  for (const video of allVideos.values()) {
    if (!activeVideos.has(video) && !video.paused) video.pause();
  }
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
function buildCanvasFilter(effects: Effect[], pixelScale = 1): string {
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
        if (radius > 0) parts.push(`blur(${radius * pixelScale}px)`);
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
    // Shadow offsets/blur are in buffer pixels (unaffected by the
    // transform), so scale them to stay proportional at any preview size.
    const px = ctx.getTransform().a;
    ctx.shadowColor = tc.shadowColor || "rgba(0,0,0,0.5)";
    ctx.shadowOffsetX = 2 * px;
    ctx.shadowOffsetY = 2 * px;
    ctx.shadowBlur = 2 * px;
  }

  const lines = tc.content.split("\n");
  const lineHeight = tc.fontSize * 1.2;
  const firstY = y - ((lines.length - 1) * lineHeight) / 2;

  if (tc.outlineEnabled && tc.outlineWidth > 0) {
    ctx.lineWidth = tc.outlineWidth * 2; // canvas strokes centered on the path; double width to match drawtext's border appearing fully outside the glyph
    ctx.strokeStyle = tc.outlineColor || "#000000";
    ctx.lineJoin = "round";
    lines.forEach((line, i) => ctx.strokeText(line, x, firstY + i * lineHeight));
  }

  ctx.fillStyle = tc.color || "#ffffff";
  lines.forEach((line, i) => ctx.fillText(line, x, firstY + i * lineHeight));

  ctx.restore();
}

