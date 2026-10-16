import { memo, useState, useRef, useCallback } from "react";
import { Type } from "lucide-react";
import type { TextClip } from "../../types/project";
import { useEditorStore } from "../../stores/editorStore";

interface TimelineTextClipProps {
  clip: TextClip;
  pixelsPerSecond: number;
  isSelected: boolean;
  locked: boolean;
  onDoubleClick?: (clipId: string) => void;
}

type DragMode = "move" | "resize-right" | null;

const DRAG_THRESHOLD_PX = 3;
const SNAP_THRESHOLD_PX = 8;

/** Playhead and every video/audio clip edge, so captions line up with cuts. */
function collectSnapPoints(): number[] {
  const { project, playheadSec } = useEditorStore.getState();
  const points = [0, playheadSec];
  for (const t of project?.tracks ?? []) {
    for (const c of t.clips ?? []) points.push(c.timelineStartSec, c.timelineEndSec);
  }
  return points;
}

function snap(timeSec: number, points: number[], pixelsPerSecond: number): number {
  const threshold = SNAP_THRESHOLD_PX / pixelsPerSecond;
  let best = timeSec;
  let bestDist = threshold;
  for (const p of points) {
    const d = Math.abs(p - timeSec);
    if (d < bestDist) {
      best = p;
      bestDist = d;
    }
  }
  return best;
}

export const TimelineTextClip = memo(function TimelineTextClip({ clip, pixelsPerSecond, isSelected, locked, onDoubleClick }: TimelineTextClipProps) {
  const [dragMode, setDragMode] = useState<DragMode>(null);
  const liveOffsetRef = useRef(0);
  const [previewOffset, setPreviewOffset] = useState(0);

  const left = clip.timelineStartSec * pixelsPerSecond;
  const width = (clip.timelineEndSec - clip.timelineStartSec) * pixelsPerSecond;

  const handleMouseDown = useCallback(
    (e: React.MouseEvent, mode: Exclude<DragMode, null>) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      useEditorStore.getState().selectTextClip(clip.id);
      if (locked) return;

      const start = { x: e.clientX, y: e.clientY, clipStart: clip.timelineStartSec, clipEnd: clip.timelineEndSec };
      const snapPoints = collectSnapPoints();
      let started = false;

      const handleMouseMove = (moveEvent: MouseEvent) => {
        const deltaPx = moveEvent.clientX - start.x;
        if (!started) {
          if (mode === "move" && Math.hypot(deltaPx, moveEvent.clientY - start.y) < DRAG_THRESHOLD_PX) return;
          started = true;
          setDragMode(mode);
        }
        const deltaSec = deltaPx / pixelsPerSecond;

        let offset: number;
        if (mode === "move") {
          const length = start.clipEnd - start.clipStart;
          const rawStart = Math.max(0, start.clipStart + deltaSec);
          const snappedStart = snap(rawStart, snapPoints, pixelsPerSecond);
          const snappedEnd = snap(rawStart + length, snapPoints, pixelsPerSecond);
          const newStart = snappedStart !== rawStart ? snappedStart : snappedEnd !== rawStart + length ? Math.max(0, snappedEnd - length) : rawStart;
          offset = newStart - start.clipStart;
        } else {
          const minEnd = start.clipStart + 0.2;
          offset = Math.max(minEnd, snap(start.clipEnd + deltaSec, snapPoints, pixelsPerSecond)) - start.clipEnd;
        }
        liveOffsetRef.current = offset;
        setPreviewOffset(offset);
      };

      const handleMouseUp = () => {
        window.removeEventListener("mousemove", handleMouseMove);
        window.removeEventListener("mouseup", handleMouseUp);

        if (started && Math.abs(liveOffsetRef.current) > 0.001) {
          const { moveTextClip, updateTextClip } = useEditorStore.getState();
          if (mode === "move") {
            moveTextClip(clip.id, Math.max(0, start.clipStart + liveOffsetRef.current));
          } else {
            updateTextClip(clip.id, { ...clip, timelineEndSec: start.clipEnd + liveOffsetRef.current });
          }
        }

        liveOffsetRef.current = 0;
        setDragMode(null);
        setPreviewOffset(0);
      };

      window.addEventListener("mousemove", handleMouseMove);
      window.addEventListener("mouseup", handleMouseUp);
    },
    [clip, locked, pixelsPerSecond]
  );

  let displayLeft = left;
  let displayWidth = width;
  if (dragMode === "move") {
    displayLeft = left + previewOffset * pixelsPerSecond;
  } else if (dragMode === "resize-right") {
    displayWidth = width + previewOffset * pixelsPerSecond;
  }

  return (
    <div
      className={`absolute top-1 bottom-1 rounded-md overflow-hidden bg-gradient-to-r from-purple-500/70 to-purple-600/70 ${
        isSelected ? "ring-2 ring-accent" : "ring-1 ring-black/30"
      } ${locked ? "cursor-not-allowed" : "cursor-grab active:cursor-grabbing"} ${dragMode ? "z-30 shadow-lg" : ""}`}
      style={{ left: displayLeft, width: Math.max(displayWidth, 4) }}
      onMouseDown={(e) => handleMouseDown(e, "move")}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => {
        e.stopPropagation();
        if (!locked) onDoubleClick?.(clip.id);
      }}
      title={`${clip.content}\nDouble-click to edit`}
    >
      <div className="relative h-full flex items-center gap-1.5 px-2 pointer-events-none">
        <Type size={11} className="text-white/70 shrink-0" />
        <span className="text-[11px] font-medium text-white/90 truncate drop-shadow">{clip.content || "(empty text)"}</span>
      </div>
      {!locked && (
        <div
          className="absolute top-0 right-0 bottom-0 w-2 cursor-ew-resize hover:bg-white/25 border-r-2 border-transparent hover:border-white/60"
          onMouseDown={(e) => handleMouseDown(e, "resize-right")}
        />
      )}
    </div>
  );
});
