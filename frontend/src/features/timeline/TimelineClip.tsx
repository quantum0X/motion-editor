import { useState, useRef, useCallback } from "react";
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
  onDoubleClick?: () => void;
}

type DragMode = "move" | "trim-left" | "trim-right" | null;

const SNAP_THRESHOLD_PX = 8;

export function TimelineClip({ clip, track, asset, pixelsPerSecond, fps, isSelected, onDoubleClick }: TimelineClipProps) {
  const selectClip = useEditorStore((s) => s.selectClip);
  const moveClip = useEditorStore((s) => s.moveClip);
  const trimClip = useEditorStore((s) => s.trimClip);
  const project = useEditorStore((s) => s.project);
  const playheadSec = useEditorStore((s) => s.playheadSec);

  const [dragMode, setDragMode] = useState<DragMode>(null);
  const [isSnapped, setIsSnapped] = useState(false);
  const dragStartRef = useRef<{ mouseX: number; clipStart: number; clipEnd: number } | null>(null);
  const [previewOffset, setPreviewOffset] = useState(0);
  // Mirrors previewOffset but updated synchronously inside the
  // mousemove handler. handleMouseUp is created once (inside the same
  // handleMouseDown call) and added as a raw window event listener, so
  // it closes over whatever `previewOffset` was AT MOUSEDOWN TIME -
  // React state updates from handleMouseMove never reach that closure.
  // Reading the ref instead (mutated directly, not through React state)
  // gives handleMouseUp the actual live value when the drag ends.
  const liveOffsetRef = useRef(0);

  const left = clip.timelineStartSec * pixelsPerSecond;
  const width = (clip.timelineEndSec - clip.timelineStartSec) * pixelsPerSecond;

  const isVideo = track.type === "video";
  const baseColor = isVideo ? "bg-track-video-clip" : "bg-track-audio-clip";
  const thumbnailUrl = useResolvedMediaUrl(asset?.thumbnailPath);

  /** Collects every other clip's start/end (in seconds) across all tracks, plus the playhead, used for snap targets while dragging. */
  const getSnapPoints = useCallback((): number[] => {
    if (!project) return [0];
    const points = new Set<number>([0, playheadSec]);
    for (const t of project.tracks) {
      for (const c of t.clips ?? []) {
        if (c.id === clip.id) continue;
        points.add(c.timelineStartSec);
        points.add(c.timelineEndSec);
      }
    }
    return Array.from(points);
  }, [project, clip.id, playheadSec]);

  const snapTime = useCallback(
    (timeSec: number): { time: number; snapped: boolean } => {
      const snapPoints = getSnapPoints();
      const thresholdSec = SNAP_THRESHOLD_PX / pixelsPerSecond;
      let closest = timeSec;
      let closestDist = Infinity;
      for (const point of snapPoints) {
        const dist = Math.abs(point - timeSec);
        if (dist < thresholdSec && dist < closestDist) {
          closest = point;
          closestDist = dist;
        }
      }
      return { time: closest, snapped: closest !== timeSec };
    },
    [getSnapPoints, pixelsPerSecond]
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent, mode: DragMode) => {
      e.stopPropagation();
      selectClip(clip.id);
      setDragMode(mode);
      dragStartRef.current = { mouseX: e.clientX, clipStart: clip.timelineStartSec, clipEnd: clip.timelineEndSec };

      // Cross-track dragging (move mode only): track which track lane
      // the cursor is currently over, so dropping on a different
      // (type-compatible) track actually moves the clip there instead
      // of only ever repositioning it in time on its original track.
      let hoveredTrackEl: HTMLElement | null = null;
      const clearHighlight = () => {
        hoveredTrackEl?.classList.remove("bg-accent/15", "ring-1", "ring-accent", "ring-inset");
      };

      const handleMouseMove = (moveEvent: MouseEvent) => {
        if (!dragStartRef.current) return;
        const deltaPx = moveEvent.clientX - dragStartRef.current.mouseX;
        const deltaSec = deltaPx / pixelsPerSecond;

        if (mode === "move") {
          const trackEl = findTrackElementAtPoint(moveEvent.clientX, moveEvent.clientY);
          if (trackEl !== hoveredTrackEl) {
            clearHighlight();
            hoveredTrackEl = trackEl;
          }
          const compatible = hoveredTrackEl?.dataset.trackType === track.type && hoveredTrackEl?.dataset.trackId !== track.id;
          if (compatible) hoveredTrackEl!.classList.add("bg-accent/15", "ring-1", "ring-accent", "ring-inset");

          const rawStart = dragStartRef.current.clipStart + deltaSec;
          const { time: snappedStart, snapped } = snapTime(Math.max(0, rawStart));
          const offset = snappedStart - dragStartRef.current.clipStart;
          liveOffsetRef.current = offset;
          setPreviewOffset(offset);
          setIsSnapped(snapped);
        } else if (mode === "trim-left") {
          const rawStart = dragStartRef.current.clipStart + deltaSec;
          const { time: snappedStart, snapped } = snapTime(Math.max(0, Math.min(rawStart, dragStartRef.current.clipEnd - 0.1)));
          const offset = snappedStart - dragStartRef.current.clipStart;
          liveOffsetRef.current = offset;
          setPreviewOffset(offset);
          setIsSnapped(snapped);
        } else if (mode === "trim-right") {
          const rawEnd = dragStartRef.current.clipEnd + deltaSec;
          const { time: snappedEnd, snapped } = snapTime(Math.max(dragStartRef.current.clipStart + 0.1, rawEnd));
          const offset = snappedEnd - dragStartRef.current.clipEnd;
          liveOffsetRef.current = offset;
          setPreviewOffset(offset);
          setIsSnapped(snapped);
        }
      };

      const handleMouseUp = (upEvent: MouseEvent) => {
        window.removeEventListener("mousemove", handleMouseMove);
        window.removeEventListener("mouseup", handleMouseUp);
        clearHighlight();

        if (dragStartRef.current) {
          const finalOffset = liveOffsetRef.current;

          let targetTrackId = track.id;
          if (mode === "move") {
            const trackEl = findTrackElementAtPoint(upEvent.clientX, upEvent.clientY);
            if (trackEl?.dataset.trackType === track.type && trackEl.dataset.trackId) {
              targetTrackId = trackEl.dataset.trackId;
            }
          }

          if (Math.abs(finalOffset) > 0.001 || targetTrackId !== track.id) {
            if (mode === "move") {
              moveClip(clip.id, targetTrackId, Math.max(0, dragStartRef.current.clipStart + finalOffset));
            } else if (mode === "trim-left") {
              trimClip(clip.id, dragStartRef.current.clipStart + finalOffset, -1);
            } else if (mode === "trim-right") {
              trimClip(clip.id, -1, dragStartRef.current.clipEnd + finalOffset);
            }
          }
        }

        liveOffsetRef.current = 0;
        setDragMode(null);
        setPreviewOffset(0);
        setIsSnapped(false);
        dragStartRef.current = null;
      };

      window.addEventListener("mousemove", handleMouseMove);
      window.addEventListener("mouseup", handleMouseUp);
    },
    [clip, track.id, track.type, pixelsPerSecond, selectClip, moveClip, trimClip, snapTime]
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

  return (
    <div
      className={`absolute top-1 bottom-1 rounded-md overflow-hidden cursor-grab active:cursor-grabbing transition-shadow ${baseColor} ${
        dragMode && isSnapped ? "ring-2 ring-yellow-400" : isSelected ? "ring-2 ring-accent" : "ring-1 ring-black/30"
      }`}
      style={{ left: displayLeft, width: Math.max(displayWidth, 4) }}
      onMouseDown={(e) => handleMouseDown(e, "move")}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onDoubleClick?.();
      }}
      title={`${asset?.fileName ?? "Unknown"} — ${formatTimecode(clip.timelineStartSec, fps)} to ${formatTimecode(clip.timelineEndSec, fps)}`}
    >
      {/* Thumbnail strip background for video clips */}
      {isVideo && thumbnailUrl && (
        <div
          className="absolute inset-0 opacity-40 bg-cover bg-center"
          style={{ backgroundImage: `url(${thumbnailUrl})` }}
        />
      )}

      <div className="relative h-full flex items-center px-2 pointer-events-none">
        <span className="text-[11px] font-medium text-white/90 truncate drop-shadow">{asset?.fileName ?? "Unknown clip"}</span>
      </div>

      {/* Trim handles */}
      <div
        className="absolute top-0 left-0 bottom-0 w-2 cursor-ew-resize hover:bg-white/20"
        onMouseDown={(e) => handleMouseDown(e, "trim-left")}
      />
      <div
        className="absolute top-0 right-0 bottom-0 w-2 cursor-ew-resize hover:bg-white/20"
        onMouseDown={(e) => handleMouseDown(e, "trim-right")}
      />
    </div>
  );
}
