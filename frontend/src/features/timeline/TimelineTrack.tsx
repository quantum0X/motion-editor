import { memo, useCallback, useRef, useEffect } from "react";
import { Video, Music, Type, Lock, Unlock, Eye, EyeOff, Volume2, VolumeX, Shuffle } from "lucide-react";
import type { Track, MediaAsset } from "../../types/project";
import { TimelineClip } from "./TimelineClip";
import { TimelineTextClip } from "./TimelineTextClip";
import { useEditorStore } from "../../stores/editorStore";
import { TRACK_HEADER_WIDTH } from "./constants";

const DEFAULT_TRACK_HEIGHT = 64;

interface TimelineTrackProps {
  track: Track;
  assetsById: Map<string, MediaAsset>;
  fps: number;
  pixelsPerSecond: number;
  totalWidth: number;
  onEditTextClip?: (clipId: string) => void;
  onEditClipEffects?: (clipId: string) => void;
  onEditTransition?: (clipId: string) => void;
}

function HeaderToggle({ active, onClick, label, children }: { active: boolean; onClick: () => void; label: string; children: React.ReactNode }) {
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={`p-1 rounded transition-colors hover:bg-surface-3 ${active ? "text-accent" : "text-text-tertiary hover:text-text-primary"}`}
    >
      {children}
    </button>
  );
}

// Memoized: with the playhead no longer passed down, a track only
// re-renders when its own data, the zoom, or the selection changes.
export const TimelineTrack = memo(function TimelineTrack({
  track,
  assetsById,
  fps,
  pixelsPerSecond,
  totalWidth,
  onEditTextClip,
  onEditClipEffects,
  onEditTransition,
}: TimelineTrackProps) {
  const selectedClipId = useEditorStore((s) => s.selectedClipId);
  const selectedTextClipId = useEditorStore((s) => s.selectedTextClipId);
  const setTrackHeight = useEditorStore((s) => s.setTrackHeight);
  const commitTrackHeight = useEditorStore((s) => s.commitTrackHeight);
  const updateTrack = useEditorStore((s) => s.updateTrack);

  const trackHeight = track.height && track.height > 0 ? track.height : DEFAULT_TRACK_HEIGHT;

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
      setTrackHeight(track.id, startHeight.current + (e.clientY - startY.current));
    };
    const handleUp = () => {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.style.cursor = "";
      commitTrackHeight();
    };
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
    };
  }, [track.id, setTrackHeight, commitTrackHeight]);

  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      dragging.current = true;
      startY.current = e.clientY;
      startHeight.current = trackHeight;
      document.body.style.cursor = "row-resize";
    },
    [trackHeight]
  );

  const isVideo = track.type === "video";
  const isText = track.type === "text";
  const isAudio = track.type === "audio";
  const headerColor = isVideo ? "text-track-video-clip" : isText ? "text-purple-400" : "text-track-audio-clip";
  const clips = track.clips ?? [];
  const textClips = track.textClips ?? [];
  const dimmed = track.hidden || (isAudio && track.muted);

  return (
    <div className="flex border-b border-border-subtle relative group/track" style={{ height: trackHeight }}>
      {/* Track header (sticky left column) */}
      <div
        className="shrink-0 bg-surface-2 border-r border-border-subtle px-2.5 py-1.5 flex flex-col justify-center gap-0.5 sticky left-0 z-20"
        style={{ width: TRACK_HEADER_WIDTH }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-1.5 min-w-0">
          {isVideo ? <Video size={12} className={headerColor} /> : isText ? <Type size={12} className={headerColor} /> : <Music size={12} className={headerColor} />}
          <span className={`text-xs font-medium truncate ${dimmed ? "text-text-tertiary" : "text-text-secondary"}`}>{track.name}</span>
        </div>
        <div className="flex items-center gap-0.5 -ml-1">
          <HeaderToggle active={track.locked} onClick={() => updateTrack(track.id, { locked: !track.locked })} label={track.locked ? "Unlock track" : "Lock track"}>
            {track.locked ? <Lock size={12} /> : <Unlock size={12} />}
          </HeaderToggle>
          {!isAudio && (
            <HeaderToggle active={track.hidden} onClick={() => updateTrack(track.id, { hidden: !track.hidden })} label={track.hidden ? "Show track" : "Hide track"}>
              {track.hidden ? <EyeOff size={12} /> : <Eye size={12} />}
            </HeaderToggle>
          )}
          {isAudio && (
            <HeaderToggle active={track.muted} onClick={() => updateTrack(track.id, { muted: !track.muted })} label={track.muted ? "Unmute track" : "Mute track"}>
              {track.muted ? <VolumeX size={12} className="text-danger" /> : <Volume2 size={12} />}
            </HeaderToggle>
          )}
        </div>
      </div>

      {/* Clip lane */}
      <div
        data-track-id={track.id}
        data-track-type={track.type}
        data-track-locked={track.locked ? "true" : undefined}
        className={`relative h-full transition-opacity ${dimmed ? "opacity-40" : ""} ${track.locked ? "bg-[repeating-linear-gradient(135deg,transparent_0_6px,rgba(255,255,255,0.025)_6px_12px)]" : ""}`}
        style={{ width: totalWidth }}
      >
        {isText
          ? textClips.map((clip) => (
              <TimelineTextClip
                key={clip.id}
                clip={clip}
                pixelsPerSecond={pixelsPerSecond}
                isSelected={selectedTextClipId === clip.id}
                locked={track.locked}
                onDoubleClick={onEditTextClip}
              />
            ))
          : clips.map((clip) => (
              <TimelineClip
                key={clip.id}
                clip={clip}
                track={track}
                asset={assetsById.get(clip.assetId)}
                pixelsPerSecond={pixelsPerSecond}
                fps={fps}
                isSelected={selectedClipId === clip.id}
                onDoubleClick={onEditClipEffects}
              />
            ))}

        {/*
          Visible transition control at every clip boundary on this
          track (two clips with no gap between them - a transition only
          makes sense where one clip ends exactly where the next begins).
        */}
        {isVideo &&
          clips
            .slice()
            .sort((a, b) => a.timelineStartSec - b.timelineStartSec)
            .map((clip, i, sorted) => {
              const next = sorted[i + 1];
              if (!next || Math.abs(next.timelineStartSec - clip.timelineEndSec) > 0.05) return null;
              const hasTransition = !!clip.transition;
              return (
                <button
                  key={`${clip.id}-transition`}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    onEditTransition?.(clip.id);
                  }}
                  disabled={track.locked}
                  title={hasTransition ? `Transition: ${clip.transition!.type} (click to edit)` : "Add a transition between these clips"}
                  aria-label={hasTransition ? "Edit transition" : "Add transition"}
                  className={`absolute top-1/2 -translate-y-1/2 -translate-x-1/2 z-10 w-5 h-5 rounded-full flex items-center justify-center border shadow transition-colors disabled:pointer-events-none ${
                    hasTransition
                      ? "bg-accent border-accent text-white"
                      : "bg-surface-2 border-border-strong text-text-tertiary hover:text-text-primary hover:border-accent"
                  }`}
                  style={{ left: clip.timelineEndSec * pixelsPerSecond }}
                >
                  <Shuffle size={10} />
                </button>
              );
            })}
      </div>

      {/* Vertical resize handle */}
      <div
        onMouseDown={handleResizeStart}
        onClick={(e) => e.stopPropagation()}
        className="absolute left-0 right-0 bottom-0 h-1 z-20 cursor-row-resize opacity-0 group-hover/track:opacity-100 hover:bg-accent/60 transition-opacity"
        title="Drag to resize track"
      />
    </div>
  );
});
