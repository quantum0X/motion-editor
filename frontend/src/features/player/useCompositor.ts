import { useEffect, useRef, useCallback } from "react";
import type { Project, Clip, Track, TextClip } from "../../types/project";

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

  // --- Element pool management: create/destroy hidden <video>/<img>
  // elements as assets are referenced by clips on the timeline. ---
  useEffect(() => {
    if (!project) return;

    const neededAssetIds = new Set<string>();
    for (const track of project.tracks) {
      if (track.type !== "video") continue;
      for (const clip of track.clips) neededAssetIds.add(clip.assetId);
    }

    const assetsById = new Map(project.assets.map((a) => [a.id, a]));

    // Create any missing elements.
    for (const assetId of neededAssetIds) {
      const asset = assetsById.get(assetId);
      if (!asset) continue;

      if (asset.mediaType === "video" && !videoElementsRef.current.has(assetId)) {
        const video = document.createElement("video");
        video.src = asset.filePath;
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
      }

      if (asset.mediaType === "image" && !imageElementsRef.current.has(assetId)) {
        const img = new Image();
        img.src = asset.filePath;
        hiddenHostRef.current?.appendChild(img);
        imageElementsRef.current.set(assetId, img);
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

  // --- Play/pause: drive every active video element's native playback
  // state so frames actually advance between our redraw calls. ---
  useEffect(() => {
    for (const { el } of videoElementsRef.current.values()) {
      if (isPlaying) {
        el.play().catch(() => {
          /* benign: browsers can reject play() if called before user
             gesture in some contexts; the compositor will simply hold
             on the last decoded frame until play succeeds. */
        });
      } else {
        el.pause();
      }
    }
  }, [isPlaying]);

  const findActiveClip = useCallback((track: Track, atSec: number): Clip | null => {
    for (const clip of track.clips) {
      if (atSec >= clip.timelineStartSec && atSec < clip.timelineEndSec) return clip;
    }
    return null;
  }, []);

  // --- The render loop itself. ---
  const drawFrame = useCallback(() => {
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

    for (const track of videoTracks) {
      const clip = findActiveClip(track, playheadSec);
      if (!clip) continue;

      const asset = assetsById.get(clip.assetId);
      if (!asset) continue;

      const opacity = clip.opacity ?? 1;
      ctx.globalAlpha = opacity;

      if (asset.mediaType === "video") {
        const entry = videoElementsRef.current.get(asset.id);
        if (!entry) continue;
        const video = entry.el;

        const sourceTime = clip.sourceInSec + (playheadSec - clip.timelineStartSec) * (clip.speed || 1);

        // Only force a seek when not currently playing, or when natural
        // playback has drifted noticeably from where it should be (e.g.
        // right after a scrub or a clip boundary jump). This keeps
        // scrubbing precise while letting playback run smoothly off the
        // video element's own clock rather than fighting it every frame.
        if (!isPlaying || Math.abs(video.currentTime - sourceTime) > SEEK_TOLERANCE_SEC) {
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
    }

    // Text layers - always drawn above every video track, matching the
    // export pipeline's drawtext chain (see backend/export/builder.go),
    // which always composites text as the last stage before the final
    // format normalization.
    const textTracks = project.tracks.filter((t) => t.type === "text" && !t.hidden).sort((a, b) => a.order - b.order);
    for (const track of textTracks) {
      for (const tc of track.textClips) {
        if (playheadSec < tc.timelineStartSec || playheadSec >= tc.timelineEndSec) continue;
        drawTextClip(ctx, tc, canvas.width, canvas.height);
      }
    }

    rafRef.current = requestAnimationFrame(drawFrame);
  }, [project, playheadSec, isPlaying, canvasRef, findActiveClip]);

  useEffect(() => {
    rafRef.current = requestAnimationFrame(drawFrame);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [drawFrame]);
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
