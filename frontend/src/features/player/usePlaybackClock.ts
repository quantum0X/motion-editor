import { useEffect } from "react";
import { useEditorStore, timelineDurationSec } from "../../stores/editorStore";

/**
 * usePlaybackClock advances playheadSec forward in real time while
 * isPlaying is true, using performance.now() deltas rather than
 * incrementing by a fixed step per animation frame - the latter drifts
 * against wall-clock time whenever the browser skips or coalesces
 * frames (e.g. under load), which would make playback speed inconsistent
 * across machines, exactly the kind of "feels slightly off" bug that's
 * very noticeable in an editor's preview.
 *
 * Stops automatically and resets isPlaying when the playhead reaches the
 * end of the timeline.
 */
export function usePlaybackClock() {
  const isPlaying = useEditorStore((s) => s.isPlaying);

  useEffect(() => {
    if (!isPlaying) return;

    let raf = 0;
    let lastTick: number | null = null;

    const tick = (now: number) => {
      const deltaSec = lastTick === null ? 0 : (now - lastTick) / 1000;
      lastTick = now;

      // Read fresh each tick (not captured when the effect started) so
      // edits made during playback - e.g. a clip added past the old end -
      // extend playback instead of stopping at a stale duration.
      const { project, playheadSec, setPlayhead, setIsPlaying } = useEditorStore.getState();
      const duration = timelineDurationSec(project);
      const next = playheadSec + deltaSec;

      if (duration <= 0 || next >= duration) {
        setPlayhead(Math.max(0, duration));
        setIsPlaying(false);
        return;
      }

      setPlayhead(next);
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [isPlaying]);
}
