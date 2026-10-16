import { useRef, useEffect, useCallback } from "react";
import { Play, Pause, SkipBack, SkipForward, Maximize2 } from "lucide-react";
import { useEditorStore, timelineDurationSec } from "../../stores/editorStore";
import { useCompositor } from "./useCompositor";
import { useAudioSync } from "./useAudioSync";
import { usePlaybackClock } from "./usePlaybackClock";
import { formatTimecode } from "../../utils/time";

/**
 * The only part of the player that re-renders as the playhead moves -
 * the canvas, compositor and transport buttons don't depend on it.
 */
function TimecodeDisplay({ fps, duration }: { fps: number; duration: number }) {
  const playheadSec = useEditorStore((s) => s.playheadSec);
  return (
    <div className="flex items-baseline gap-1.5 ml-1 font-mono-tabular text-sm tabular-nums">
      <span className="text-text-primary">{formatTimecode(playheadSec, fps)}</span>
      <span className="text-text-tertiary">/ {formatTimecode(duration, fps)}</span>
    </div>
  );
}

export function Player() {
  const project = useEditorStore((s) => s.project);
  const isPlaying = useEditorStore((s) => s.isPlaying);
  const togglePlay = useEditorStore((s) => s.togglePlay);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const hiddenHostRef = useRef<HTMLDivElement>(null);

  const requestRedraw = useCompositor(canvasRef, hiddenHostRef);
  useAudioSync();
  usePlaybackClock();

  const canvasWidth = project?.canvasWidth ?? 1920;
  const canvasHeight = project?.canvasHeight ?? 1080;
  const fps = project?.fps ?? 30;
  const duration = timelineDurationSec(project);

  // Size the canvas buffer to its on-screen size (in device pixels),
  // capped at the project resolution. The compositor draws in project
  // coordinates through a scale transform, so framing matches export
  // exactly while a 4K project in a small panel no longer pays for
  // millions of off-screen pixels every frame. Grows again in fullscreen.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const fit = () => {
      const cssWidth = canvas.getBoundingClientRect().width;
      if (cssWidth <= 0) return;
      const scale = Math.min(1, (cssWidth * (window.devicePixelRatio || 1)) / canvasWidth);
      const w = Math.max(1, Math.round(canvasWidth * scale));
      const h = Math.max(1, Math.round(canvasHeight * scale));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        requestRedraw(); // resizing the buffer clears it
      }
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [canvasWidth, canvasHeight, requestRedraw]);

  const stepFrame = useCallback(
    (direction: 1 | -1) => {
      const { setIsPlaying, setPlayhead, playheadSec } = useEditorStore.getState();
      setIsPlaying(false);
      setPlayhead(playheadSec + direction / fps);
    },
    [fps]
  );

  const handleFullscreen = useCallback(() => {
    containerRef.current?.requestFullscreen?.();
  }, []);

  const isEmpty = !!project && duration === 0;

  return (
    <div className="flex flex-col h-full bg-surface-1">
      {/* Hidden decoder pool: video/image elements the compositor draws
          from. Positioned off-screen rather than display:none - some
          browsers deprioritize or stall decoding for display:none media
          elements the same way they do for fully detached ones. */}
      <div ref={hiddenHostRef} aria-hidden style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", top: -9999, left: -9999 }} />

      <div ref={containerRef} className="flex-1 flex items-center justify-center bg-surface-0 min-h-0 p-3" onDoubleClick={handleFullscreen}>
        <div
          className="relative shadow-2xl ring-1 ring-border-subtle"
          style={{ aspectRatio: `${canvasWidth} / ${canvasHeight}`, maxHeight: "100%", maxWidth: "100%" }}
        >
          <canvas ref={canvasRef} className="w-full h-full block bg-black" />
          {(!project || isEmpty) && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-center text-text-tertiary text-sm pointer-events-none px-4">
              {project ? (
                <>
                  <span className="text-text-secondary">Your timeline is empty</span>
                  <span className="text-xs">Drag media onto a track, or double-click it in the library</span>
                </>
              ) : (
                "No project open"
              )}
            </div>
          )}
        </div>
      </div>

      {/* Transport bar */}
      <div className="flex items-center gap-3 px-4 py-2 border-t border-border-subtle bg-surface-1 shrink-0">
        <button
          onClick={() => stepFrame(-1)}
          disabled={!project}
          className="p-1 rounded text-text-secondary hover:text-text-primary hover:bg-surface-3 disabled:opacity-40 transition-colors"
          title="Previous frame (←)"
          aria-label="Previous frame"
        >
          <SkipBack size={16} />
        </button>
        <button
          onClick={togglePlay}
          disabled={!project}
          className="w-8 h-8 flex items-center justify-center rounded-full bg-accent hover:bg-accent-dim disabled:opacity-40 transition-colors text-white"
          title={isPlaying ? "Pause (Space)" : "Play (Space)"}
          aria-label={isPlaying ? "Pause" : "Play"}
        >
          {isPlaying ? <Pause size={15} /> : <Play size={15} className="translate-x-px" />}
        </button>
        <button
          onClick={() => stepFrame(1)}
          disabled={!project}
          className="p-1 rounded text-text-secondary hover:text-text-primary hover:bg-surface-3 disabled:opacity-40 transition-colors"
          title="Next frame (→)"
          aria-label="Next frame"
        >
          <SkipForward size={16} />
        </button>

        <TimecodeDisplay fps={fps} duration={duration} />

        <div className="flex-1" />

        <div className="text-xs text-text-tertiary font-mono-tabular">
          {canvasWidth}×{canvasHeight} · {fps}fps
        </div>
        <button
          onClick={handleFullscreen}
          className="p-1 rounded text-text-secondary hover:text-text-primary hover:bg-surface-3 transition-colors"
          title="Fullscreen (double-click preview)"
          aria-label="Fullscreen"
        >
          <Maximize2 size={14} />
        </button>
      </div>
    </div>
  );
}
