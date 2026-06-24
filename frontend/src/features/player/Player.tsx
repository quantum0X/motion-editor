import { useRef, useEffect, useCallback } from "react";
import { Play, Pause, SkipBack, SkipForward, Maximize2 } from "lucide-react";
import { useEditorStore, timelineDurationSec } from "../../stores/editorStore";
import { useCompositor } from "./useCompositor";
import { useAudioSync } from "./useAudioSync";
import { usePlaybackClock } from "./usePlaybackClock";
import { formatTimecode } from "../../utils/time";

export function Player() {
  const project = useEditorStore((s) => s.project);
  const playheadSec = useEditorStore((s) => s.playheadSec);
  const isPlaying = useEditorStore((s) => s.isPlaying);
  const setPlayhead = useEditorStore((s) => s.setPlayhead);
  const setIsPlaying = useEditorStore((s) => s.setIsPlaying);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const hiddenHostRef = useRef<HTMLDivElement>(null);

  useCompositor(project, canvasRef, hiddenHostRef, playheadSec, isPlaying);
  useAudioSync(project, playheadSec, isPlaying);
  usePlaybackClock();

  const canvasWidth = project?.canvasWidth ?? 1920;
  const canvasHeight = project?.canvasHeight ?? 1080;
  const fps = project?.fps ?? 30;
  const duration = timelineDurationSec(project);

  // Keep the canvas's actual pixel buffer at the project's real
  // resolution (so export-quality framing matches preview exactly),
  // while CSS scales it down to fit the available panel space.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = canvasWidth;
    canvas.height = canvasHeight;
  }, [canvasWidth, canvasHeight]);

  const togglePlay = useCallback(() => {
    if (!project) return;
    if (playheadSec >= duration && duration > 0) {
      setPlayhead(0);
    }
    setIsPlaying(!isPlaying);
  }, [project, isPlaying, playheadSec, duration, setIsPlaying, setPlayhead]);

  const stepFrame = useCallback(
    (direction: 1 | -1) => {
      setIsPlaying(false);
      setPlayhead(playheadSec + direction / fps);
    },
    [playheadSec, fps, setIsPlaying, setPlayhead]
  );

  // Keyboard shortcuts: Space = play/pause. Scoped to this component via
  // a window listener guarded by checking the active element isn't a
  // text input, so typing a project name elsewhere doesn't accidentally
  // toggle playback.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;

      if (e.code === "Space") {
        e.preventDefault();
        togglePlay();
      } else if (e.code === "ArrowLeft") {
        e.preventDefault();
        stepFrame(-1);
      } else if (e.code === "ArrowRight") {
        e.preventDefault();
        stepFrame(1);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [togglePlay, stepFrame]);

  const handleFullscreen = useCallback(() => {
    containerRef.current?.requestFullscreen?.();
  }, []);

  return (
    <div className="flex flex-col h-full bg-surface-1">
      {/* Hidden decoder pool: video/image elements the compositor draws
          from. Positioned off-screen rather than display:none - some
          browsers deprioritize or stall decoding for display:none media
          elements the same way they do for fully detached ones. */}
      <div ref={hiddenHostRef} style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", top: -9999, left: -9999 }} />

      <div ref={containerRef} className="flex-1 flex items-center justify-center bg-surface-0 min-h-0 p-3">
        <div
          className="relative shadow-2xl"
          style={{ aspectRatio: `${canvasWidth} / ${canvasHeight}`, maxHeight: "100%", maxWidth: "100%" }}
        >
          <canvas ref={canvasRef} className="w-full h-full block bg-black" style={{ aspectRatio: `${canvasWidth} / ${canvasHeight}` }} />
          {!project && (
            <div className="absolute inset-0 flex items-center justify-center text-text-tertiary text-sm">
              No project open
            </div>
          )}
        </div>
      </div>

      {/* Transport bar */}
      <div className="flex items-center gap-3 px-4 py-2.5 border-t border-border-subtle bg-surface-1 shrink-0">
        <button
          onClick={() => stepFrame(-1)}
          className="text-text-secondary hover:text-text-primary transition-colors"
          title="Previous frame (←)"
        >
          <SkipBack size={16} />
        </button>
        <button
          onClick={togglePlay}
          className="w-8 h-8 flex items-center justify-center rounded-full bg-accent hover:bg-accent-dim transition-colors text-white"
          title="Play/Pause (Space)"
        >
          {isPlaying ? <Pause size={15} /> : <Play size={15} />}
        </button>
        <button
          onClick={() => stepFrame(1)}
          className="text-text-secondary hover:text-text-primary transition-colors"
          title="Next frame (→)"
        >
          <SkipForward size={16} />
        </button>

        <div className="font-mono-tabular text-sm text-text-primary tabular-nums ml-1">
          {formatTimecode(playheadSec, fps)}
        </div>
        <div className="font-mono-tabular text-sm text-text-tertiary tabular-nums">/ {formatTimecode(duration, fps)}</div>

        <div className="flex-1" />

        <div className="text-xs text-text-tertiary font-mono-tabular">
          {canvasWidth}×{canvasHeight} · {fps}fps
        </div>
        <button onClick={handleFullscreen} className="text-text-secondary hover:text-text-primary transition-colors" title="Fullscreen">
          <Maximize2 size={14} />
        </button>
      </div>
    </div>
  );
}
