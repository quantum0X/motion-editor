import { memo, useState, useRef, useCallback } from "react";
import { Sparkles } from "lucide-react";
import type { Clip, MediaAsset, Track } from "../../types/project";
import { useEditorStore } from "../../stores/editorStore";
import { formatTimecode } from "../../utils/time";
import { useResolvedMediaUrl } from "../../utils/mediaUrl";
import { findTrackElementAtPoint } from "../../utils/dragCoordinator";

interface TimelineClipProps {
  clip: Clip;
  track: Track;
  asset: MediaAsset | undefined;
  pixelsPerSecond: number;
  fps: number;
  isSelected: boolean;
  onDoubleClick?: (clipId: string) => void;
}

type DragMode = "move" | "trim-left" | "trim-right" | null;

const SNAP_THRESHOLD_PX = 8;
// Movement below this is treated as a click (select), not a drag.
const DRAG_THRESHOLD_PX = 3;
const DROP_HIGHLIGHT = ["bg-accent/15", "ring-1", "ring-accent", "ring-inset"];

/** Every other clip's edges (all tracks) plus the playhead - read once when a drag starts, not on every mousemove. */
function collectSnapPoints(excludeClipId: string): number[] {
  const { project, playheadSec } = useEditorStore.getState();
  const points = new Set<number>([0, playheadSec]);
  for (const t of project?.tracks ?? []) {
    for (const c of t.clips ?? []) {
      if (c.id === excludeClipId) continue;
      points.add(c.timelineStartSec);
      points.add(c.timelineEndSec);
    }
    for (const c of t.textClips ?? []) {
      points.add(c.timelineStartSec);
      points.add(c.timelineEndSec);
    }
  }
  return Array.from(points);
}

function snap(timeSec: number, points: number[], pixelsPerSecond: number): { time: number; snapped: boolean } {
  const thresholdSec = SNAP_THRESHOLD_PX / pixelsPerSecond;
  let closest = timeSec;
  let closestDist = Infinity;
  for (const point of points) {
    const dist = Math.abs(point - timeSec);
    if (dist < thresholdSec && dist < closestDist) {
      closest = point;
      closestDist = dist;
    }
  }
  return { time: closest, snapped: closest !== timeSec };
}

export const TimelineClip = memo(function TimelineClip({ clip, track, asset, pixelsPerSecond, fps, isSelected, onDoubleClick }: TimelineClipProps) {
  const [dragMode, setDragMode] = useState<DragMode>(null);
  const [isSnapped, setIsSnapped] = useState(false);
  const [previewOffset, setPreviewOffset] = useState(0);
  // Mirrors previewOffset synchronously for the mouseup handler, which is
  // created at mousedown and would otherwise only ever see the state
  // value captured then (a real bug this ref was added to fix).
  const liveOffsetRef = useRef(0);

  const left = clip.timelineStartSec * pixelsPerSecond;
  const width = (clip.timelineEndSec - clip.timelineStartSec) * pixelsPerSecond;

  const isVideo = track.type === "video";
  const baseColor = isVideo ? "bg-track-video-clip" : "bg-track-audio-clip";
  const thumbnailUrl = useResolvedMediaUrl(asset?.thumbnailPath);
  const locked = track.locked;

  const handleMouseDown = useCallback(
    (e: React.MouseEvent, mode: Exclude<DragMode, null>) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      useEditorStore.getState().selectClip(clip.id);
      if (locked) return;

      const start = { mouseX: e.clientX, mouseY: e.clientY, clipStart: clip.timelineStartSec, clipEnd: clip.timelineEndSec };
      const snapPoints = collectSnapPoints(clip.id);
      let started = false;
      let hoveredTrackEl: HTMLElement | null = null;
      const clearHighlight = () => hoveredTrackEl?.classList.remove(...DROP_HIGHLIGHT);
      const isDropTarget = (el: HTMLElement | null) =>
        !!el && el.dataset.trackType === track.type && el.dataset.trackId !== track.id && el.dataset.trackLocked !== "true";

      const applyOffset = (offset: number, snapped: boolean) => {
        liveOffsetRef.current = offset;
        setPreviewOffset(offset);
        setIsSnapped(snapped);
      };

      const handleMouseMove = (moveEvent: MouseEvent) => {
        const deltaPx = moveEvent.clientX - start.mouseX;
        if (!started) {
          if (mode === "move" && Math.hypot(deltaPx, moveEvent.clientY - start.mouseY) < DRAG_THRESHOLD_PX) return;
          started = true;
          setDragMode(mode);
        }
        const deltaSec = deltaPx / pixelsPerSecond;

        if (mode === "move") {
          // Cross-track dragging: highlight a compatible lane under the
          // cursor; dropping there moves the clip to that track.
          const trackEl = findTrackElementAtPoint(moveEvent.clientX, moveEvent.clientY);
          if (trackEl !== hoveredTrackEl) {
            clearHighlight();
            hoveredTrackEl = trackEl;
            if (isDropTarget(trackEl)) trackEl!.classList.add(...DROP_HIGHLIGHT);
          }
          // Snap either edge of the clip, whichever is closer.
          const length = start.clipEnd - start.clipStart;
          const rawStart = Math.max(0, start.clipStart + deltaSec);
          const byStart = snap(rawStart, snapPoints, pixelsPerSecond);
          const byEnd = snap(rawStart + length, snapPoints, pixelsPerSecond);
          const snappedStart = byStart.snapped ? byStart.time : byEnd.snapped ? Math.max(0, byEnd.time - length) : rawStart;
          applyOffset(snappedStart - start.clipStart, byStart.snapped || byEnd.snapped);
        } else if (mode === "trim-left") {
          const { time, snapped } = snap(Math.max(0, Math.min(start.clipStart + deltaSec, start.clipEnd - 0.1)), snapPoints, pixelsPerSecond);
          applyOffset(time - start.clipStart, snapped);
        } else {
          const { time, snapped } = snap(Math.max(start.clipStart + 0.1, start.clipEnd + deltaSec), snapPoints, pixelsPerSecond);
          applyOffset(time - start.clipEnd, snapped);
        }
      };

      const handleMouseUp = (upEvent: MouseEvent) => {
        window.removeEventListener("mousemove", handleMouseMove);
        window.removeEventListener("mouseup", handleMouseUp);
        clearHighlight();

        if (started) {
          const finalOffset = liveOffsetRef.current;
          const { moveClip, trimClip } = useEditorStore.getState();
          let targetTrackId = track.id;
          if (mode === "move") {
            const trackEl = findTrackElementAtPoint(upEvent.clientX, upEvent.clientY);
            if (isDropTarget(trackEl)) targetTrackId = trackEl!.dataset.trackId!;
          }
          if (Math.abs(finalOffset) > 0.001 || targetTrackId !== track.id) {
            if (mode === "move") moveClip(clip.id, targetTrackId, Math.max(0, start.clipStart + finalOffset));
            else if (mode === "trim-left") trimClip(clip.id, start.clipStart + finalOffset, -1);
            else trimClip(clip.id, -1, start.clipEnd + finalOffset);
          }
        }

        liveOffsetRef.current = 0;
        setDragMode(null);
        setPreviewOffset(0);
        setIsSnapped(false);
      };

      window.addEventListener("mousemove", handleMouseMove);
      window.addEventListener("mouseup", handleMouseUp);
    },
    [clip.id, clip.timelineStartSec, clip.timelineEndSec, track.id, track.type, locked, pixelsPerSecond]
  );

  let displayLeft = left;
  let displayWidth = width;
  if (dragMode === "move") {
    displayLeft = left + previewOffset * pixelsPerSecond;
  } else if (dragMode === "trim-left") {
    displayLeft = left + previewOffset * pixelsPerSecond;
    displayWidth = width - previewOffset * pixelsPerSecond;
  } else if (dragMode === "trim-right") {
    displayWidth = width + previewOffset * pixelsPerSecond;
  }

  const ring = dragMode && isSnapped ? "ring-2 ring-yellow-400" : isSelected ? "ring-2 ring-accent" : "ring-1 ring-black/30";
  const effectCount = (clip.effects ?? []).filter((e) => e.enabled).length;

  return (
    <div
      className={`absolute top-1 bottom-1 rounded-md overflow-hidden ${baseColor} ${ring} ${
        locked ? "cursor-not-allowed" : "cursor-grab active:cursor-grabbing"
      } ${dragMode ? "z-30 shadow-lg opacity-90" : ""} ${clip.muted ? "saturate-50" : ""}`}
      style={{ left: displayLeft, width: Math.max(displayWidth, 4) }}
      onMouseDown={(e) => handleMouseDown(e, "move")}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => {
        e.stopPropagation();
        if (!locked) onDoubleClick?.(clip.id);
      }}
      title={`${asset?.fileName ?? "Unknown"} — ${formatTimecode(clip.timelineStartSec, fps)} to ${formatTimecode(clip.timelineEndSec, fps)}${
        isVideo ? "\nDouble-click for effects" : ""
      }`}
    >
      {/* Thumbnail strip background for video clips */}
      {isVideo && thumbnailUrl && (
        <div className="absolute inset-0 opacity-40 bg-repeat-x bg-contain bg-left" style={{ backgroundImage: `url(${thumbnailUrl})` }} />
      )}

      <div className="relative h-full flex items-start gap-1 px-2 pt-1 pointer-events-none">
        <span className="text-[11px] font-medium text-white/90 truncate drop-shadow">{asset?.fileName ?? "Unknown clip"}</span>
        {effectCount > 0 && displayWidth > 80 && (
          <span className="ml-auto shrink-0 flex items-center gap-0.5 text-[10px] text-white/80 bg-black/30 rounded px-1" title={`${effectCount} effect(s)`}>
            <Sparkles size={9} />
            {effectCount}
          </span>
        )}
      </div>

      {/* Trim handles */}
      {!locked && (
        <>
          <div
            className="absolute top-0 left-0 bottom-0 w-2 cursor-ew-resize hover:bg-white/25 border-l-2 border-transparent hover:border-white/60"
            onMouseDown={(e) => handleMouseDown(e, "trim-left")}
          />
          <div
            className="absolute top-0 right-0 bottom-0 w-2 cursor-ew-resize hover:bg-white/25 border-r-2 border-transparent hover:border-white/60"
            onMouseDown={(e) => handleMouseDown(e, "trim-right")}
          />
        </>
      )}
    </div>
  );
});
