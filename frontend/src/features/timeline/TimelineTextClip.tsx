import { useState, useRef, useCallback } from "react";
import type { TextClip } from "../../types/project";
import { useEditorStore } from "../../stores/editorStore";

interface TimelineTextClipProps {
  clip: TextClip;
  pixelsPerSecond: number;
  isSelected: boolean;
  onDoubleClick: () => void;
}

type DragMode = "move" | "resize-right" | null;

export function TimelineTextClip({ clip, pixelsPerSecond, isSelected, onDoubleClick }: TimelineTextClipProps) {
  const selectTextClip = useEditorStore((s) => s.selectTextClip);
  const moveTextClip = useEditorStore((s) => s.moveTextClip);
  const updateTextClip = useEditorStore((s) => s.updateTextClip);

  const [dragMode, setDragMode] = useState<DragMode>(null);
  const dragStartRef = useRef<{ mouseX: number; clipStart: number; clipEnd: number } | null>(null);
  const liveOffsetRef = useRef(0);
  const [previewOffset, setPreviewOffset] = useState(0);

  const left = clip.timelineStartSec * pixelsPerSecond;
  const width = (clip.timelineEndSec - clip.timelineStartSec) * pixelsPerSecond;

  const handleMouseDown = useCallback(
    (e: React.MouseEvent, mode: DragMode) => {
      e.stopPropagation();
      selectTextClip(clip.id);
      setDragMode(mode);
      dragStartRef.current = { mouseX: e.clientX, clipStart: clip.timelineStartSec, clipEnd: clip.timelineEndSec };

      const handleMouseMove = (moveEvent: MouseEvent) => {
        if (!dragStartRef.current) return;
        const deltaPx = moveEvent.clientX - dragStartRef.current.mouseX;
        const deltaSec = deltaPx / pixelsPerSecond;

        if (mode === "move") {
          const offset = Math.max(-dragStartRef.current.clipStart, deltaSec);
          liveOffsetRef.current = offset;
          setPreviewOffset(offset);
        } else if (mode === "resize-right") {
          const minDuration = 0.2;
          const offset = Math.max(minDuration - (dragStartRef.current.clipEnd - dragStartRef.current.clipStart), deltaSec);
          liveOffsetRef.current = offset;
          setPreviewOffset(offset);
        }
      };

      const handleMouseUp = () => {
        window.removeEventListener("mousemove", handleMouseMove);
        window.removeEventListener("mouseup", handleMouseUp);

        if (dragStartRef.current && Math.abs(liveOffsetRef.current) > 0.001) {
          if (mode === "move") {
            moveTextClip(clip.id, Math.max(0, dragStartRef.current.clipStart + liveOffsetRef.current));
          } else if (mode === "resize-right") {
            updateTextClip(clip.id, { ...clip, timelineEndSec: dragStartRef.current.clipEnd + liveOffsetRef.current });
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
    [clip, pixelsPerSecond, selectTextClip, moveTextClip, updateTextClip]
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
      className={`absolute top-1 bottom-1 rounded-md overflow-hidden cursor-grab active:cursor-grabbing bg-gradient-to-r from-purple-500/70 to-purple-600/70 ${
        isSelected ? "ring-2 ring-accent" : "ring-1 ring-black/30"
      }`}
      style={{ left: displayLeft, width: Math.max(displayWidth, 4) }}
      onMouseDown={(e) => handleMouseDown(e, "move")}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onDoubleClick();
      }}
      title={clip.content}
    >
      <div className="relative h-full flex items-center px-2 pointer-events-none">
        <span className="text-[11px] font-medium text-white/90 truncate drop-shadow">{clip.content || "(empty text)"}</span>
      </div>
      <div
        className="absolute top-0 right-0 bottom-0 w-2 cursor-ew-resize hover:bg-white/20"
        onMouseDown={(e) => handleMouseDown(e, "resize-right")}
      />
    </div>
  );
}
