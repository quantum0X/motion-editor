import { useState, useRef, useCallback } from "react";
import type { Clip, MediaAsset, Track } from "../../types/project";
import { useEditorStore } from "../../stores/editorStore";
import { formatTimecode } from "../../utils/time";

interface TimelineClipProps {
  clip: Clip;
  track: Track;
  asset: MediaAsset | undefined;
  pixelsPerSecond: number;
  fps: number;
  isSelected: boolean;
}

type DragMode = "move" | "trim-left" | "trim-right" | null;

const SNAP_THRESHOLD_PX = 8;

export function TimelineClip({ clip, track, asset, pixelsPerSecond, fps, isSelected }: TimelineClipProps) {
  const selectClip = useEditorStore((s) => s.selectClip);
  const moveClip = useEditorStore((s) => s.moveClip);
  const trimClip = useEditorStore((s) => s.trimClip);
  const project = useEditorStore((s) => s.project);

  const [dragMode, setDragMode] = useState<DragMode>(null);
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

  /** Collects every other clip's start/end (in seconds) across all tracks, used for snap targets while dragging. */
  const getSnapPoints = useCallback((): number[] => {
    if (!project) return [0];
    const points = new Set<number>([0]);
    for (const t of project.tracks) {
      for (const c of t.clips) {
        if (c.id === clip.id) continue;
        points.add(c.timelineStartSec);
        points.add(c.timelineEndSec);
      }
    }
    return Array.from(points);
  }, [project, clip.id]);

  const snapTime = useCallback(
    (timeSec: number): number => {
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
      return closest;
    },
    [getSnapPoints, pixelsPerSecond]
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent, mode: DragMode) => {
      e.stopPropagation();
      selectClip(clip.id);
      setDragMode(mode);
      dragStartRef.current = { mouseX: e.clientX, clipStart: clip.timelineStartSec, clipEnd: clip.timelineEndSec };

      const handleMouseMove = (moveEvent: MouseEvent) => {
        if (!dragStartRef.current) return;
        const deltaPx = moveEvent.clientX - dragStartRef.current.mouseX;
        const deltaSec = deltaPx / pixelsPerSecond;

        if (mode === "move") {
          const rawStart = dragStartRef.current.clipStart + deltaSec;
          const snappedStart = snapTime(Math.max(0, rawStart));
          const offset = snappedStart - dragStartRef.current.clipStart;
          liveOffsetRef.current = offset;
          setPreviewOffset(offset);
        } else if (mode === "trim-left") {
          const rawStart = dragStartRef.current.clipStart + deltaSec;
          const snappedStart = snapTime(Math.max(0, Math.min(rawStart, dragStartRef.current.clipEnd - 0.1)));
          const offset = snappedStart - dragStartRef.current.clipStart;
          liveOffsetRef.current = offset;
          setPreviewOffset(offset);
        } else if (mode === "trim-right") {
          const rawEnd = dragStartRef.current.clipEnd + deltaSec;
          const snappedEnd = snapTime(Math.max(dragStartRef.current.clipStart + 0.1, rawEnd));
          const offset = snappedEnd - dragStartRef.current.clipEnd;
          liveOffsetRef.current = offset;
          setPreviewOffset(offset);
        }
      };

      const handleMouseUp = () => {
        window.removeEventListener("mousemove", handleMouseMove);
        window.removeEventListener("mouseup", handleMouseUp);

        if (dragStartRef.current) {
          const finalOffset = liveOffsetRef.current;
          if (Math.abs(finalOffset) > 0.001) {
            if (mode === "move") {
              moveClip(clip.id, track.id, Math.max(0, dragStartRef.current.clipStart + finalOffset));
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
        dragStartRef.current = null;
      };

      window.addEventListener("mousemove", handleMouseMove);
      window.addEventListener("mouseup", handleMouseUp);
    },
    [clip, track.id, pixelsPerSecond, selectClip, moveClip, trimClip, snapTime]
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
        isSelected ? "ring-2 ring-accent" : "ring-1 ring-black/30"
      }`}
      style={{ left: displayLeft, width: Math.max(displayWidth, 4) }}
      onMouseDown={(e) => handleMouseDown(e, "move")}
      onClick={(e) => e.stopPropagation()}
      title={`${asset?.fileName ?? "Unknown"} — ${formatTimecode(clip.timelineStartSec, fps)} to ${formatTimecode(clip.timelineEndSec, fps)}`}
    >
      {/* Thumbnail strip background for video clips */}
      {isVideo && asset?.thumbnailPath && (
        <div
          className="absolute inset-0 opacity-40 bg-cover bg-center"
          style={{ backgroundImage: `url(${asset.thumbnailPath})` }}
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
