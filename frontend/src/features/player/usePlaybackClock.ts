import { useEffect, useRef } from "react";
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
  const project = useEditorStore((s) => s.project);
  const setPlayhead = useEditorStore((s) => s.setPlayhead);
  const setIsPlaying = useEditorStore((s) => s.setIsPlaying);

  const lastTickRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (!isPlaying) {
      lastTickRef.current = null;
      return;
    }

    const tick = (now: number) => {
      if (lastTickRef.current === null) {
        lastTickRef.current = now;
      }
      const deltaSec = (now - lastTickRef.current) / 1000;
      lastTickRef.current = now;

      const duration = timelineDurationSec(project);
      const current = useEditorStore.getState().playheadSec;
      const next = current + deltaSec;

      if (duration > 0 && next >= duration) {
        setPlayhead(duration);
        setIsPlaying(false);
        return;
      }

      setPlayhead(next);
      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
    // project is read fresh inside tick() via the store getter rather
    // than captured in the closure, so we don't need it as a dependency
    // here (re-subscribing the whole RAF loop on every project mutation
    // during playback, e.g. nothing should change mid-scrub, would be
    // wasteful and could cause stutter).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying]);
}
