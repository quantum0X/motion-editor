import { useState, useCallback, useRef, useEffect } from "react";
import { Video, Music, Type, Lock, Eye, EyeOff, Volume2, VolumeX } from "lucide-react";
import type { Track, Project } from "../../types/project";
import { TimelineClip } from "./TimelineClip";
import { TimelineTextClip } from "./TimelineTextClip";
import { useEditorStore } from "../../stores/editorStore";

const DEFAULT_TRACK_HEIGHT = 64;

interface TimelineTrackProps {
  track: Track;
  project: Project;
  pixelsPerSecond: number;
  totalWidth: number;
  onEditTextClip?: (clipId: string) => void;
  onEditClipEffects?: (clipId: string) => void;
}

export function TimelineTrack({ track, project, pixelsPerSecond, totalWidth, onEditTextClip, onEditClipEffects }: TimelineTrackProps) {
  const selectedClipId = useEditorStore((s) => s.selectedClipId);
  const selectedTextClipId = useEditorStore((s) => s.selectedTextClipId);
  const addClip = useEditorStore((s) => s.addClip);
  const setTrackHeight = useEditorStore((s) => s.setTrackHeight);
  const [isDragOver, setIsDragOver] = useState(false);

  const trackHeight = track.height && track.height > 0 ? track.height : DEFAULT_TRACK_HEIGHT;

  const assetsById = new Map(project.assets.map((a) => [a.id, a]));

  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragOver(true);
    },
    []
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragOver(false);

      const assetId = e.dataTransfer.getData("application/x-media-asset-id");
      if (!assetId) return;
      const asset = assetsById.get(assetId);
      if (!asset) return;

      const rect = e.currentTarget.getBoundingClientRect();
      const dropX = e.clientX - rect.left;
      const dropStartSec = Math.max(0, dropX / pixelsPerSecond);

      const duration = asset.mediaType === "image" ? 5 : asset.durationSec;

      addClip(track.id, {
        assetId: asset.id,
        timelineStartSec: dropStartSec,
        timelineEndSec: dropStartSec + duration,
        sourceInSec: 0,
        sourceOutSec: duration,
        speed: 1,
        opacity: 1,
        volume: 1,
        muted: false,
        effects: [],
        keyframes: [],
        transition: null,
      });
    },
    [assetsById, pixelsPerSecond, track.id, addClip]
  );

  // Per-track vertical resize: drag the thin strip at the bottom of the
  // track row. Each track keeps its own height (track.height) so a video
  // track full of overlapping keyframed clips can be made taller while a
  // simple audio track stays compact.
  const dragging = useRef(false);
  const startY = useRef(0);
  const startHeight = useRef(trackHeight);

  useEffect(() => {
    const handleMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      const delta = e.clientY - startY.current;
      setTrackHeight(track.id, startHeight.current + delta);
    };
    const handleUp = () => {
      dragging.current = false;
      document.body.style.cursor = "";
    };
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
    };
  }, [track.id, setTrackHeight]);

  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      dragging.current = true;
      startY.current = e.clientY;
      startHeight.current = trackHeight;
      document.body.style.cursor = "row-resize";
    },
    [trackHeight]
  );

  const isVideo = track.type === "video";
  const isText = track.type === "text";
  const headerColor = isVideo ? "text-track-video-clip" : isText ? "text-purple-400" : "text-track-audio-clip";
  const clips = track.clips ?? [];
  const textClips = track.textClips ?? [];

  return (
    <div className="flex border-b border-border-subtle relative group/track" style={{ height: trackHeight }}>
      {/* Track header (sticky left column) */}
      <div className="w-36 shrink-0 bg-surface-2 border-r border-border-subtle px-2.5 py-2 flex flex-col gap-1 sticky left-0 z-10">
        <div className="flex items-center gap-1.5">
          {isVideo ? (
            <Video size={12} className={headerColor} />
          ) : isText ? (
            <Type size={12} className={headerColor} />
          ) : (
            <Music size={12} className={headerColor} />
          )}
          <span className="text-xs font-medium text-text-secondary truncate">{track.name}</span>
        </div>
        <div className="flex items-center gap-2 text-text-tertiary">
          <button title={track.locked ? "Unlock track" : "Lock track"} className="hover:text-text-primary">
            <Lock size={11} className={track.locked ? "text-accent" : ""} />
          </button>
          {isVideo && (
            <button title={track.hidden ? "Show track" : "Hide track"} className="hover:text-text-primary">
              {track.hidden ? <EyeOff size={11} /> : <Eye size={11} />}
            </button>
          )}
          {!isVideo && !isText && (
            <button title={track.muted ? "Unmute track" : "Mute track"} className="hover:text-text-primary">
              {track.muted ? <VolumeX size={11} className="text-danger" /> : <Volume2 size={11} />}
            </button>
          )}
          {isText && (
            <button title={track.hidden ? "Show track" : "Hide track"} className="hover:text-text-primary">
              {track.hidden ? <EyeOff size={11} /> : <Eye size={11} />}
            </button>
          )}
        </div>
      </div>

      {/* Clip lane */}
      <div
        className={`relative h-full ${isDragOver ? "bg-accent/10" : ""}`}
        style={{ width: totalWidth }}
        onDragOver={handleDragOver}
        onDragLeave={() => setIsDragOver(false)}
        onDrop={handleDrop}
      >
        {isText
          ? textClips.map((clip) => (
              <TimelineTextClip
                key={clip.id}
                clip={clip}
                pixelsPerSecond={pixelsPerSecond}
                isSelected={selectedTextClipId === clip.id}
                onDoubleClick={() => onEditTextClip?.(clip.id)}
              />
            ))
          : clips.map((clip) => (
              <TimelineClip
                key={clip.id}
                clip={clip}
                track={track}
                asset={assetsById.get(clip.assetId)}
                pixelsPerSecond={pixelsPerSecond}
                fps={project.fps}
                isSelected={selectedClipId === clip.id}
                onDoubleClick={() => onEditClipEffects?.(clip.id)}
              />
            ))}
      </div>

      {/* Vertical resize handle */}
      <div
        onMouseDown={handleResizeStart}
        className="absolute left-0 right-0 bottom-0 h-1 cursor-row-resize opacity-0 group-hover/track:opacity-100 hover:bg-accent/60 transition-opacity"
        title="Drag to resize track"
      />
    </div>
  );
}
