import { memo, useMemo } from "react";
import { useEditorStore } from "../../stores/editorStore";
import { formatTimecode } from "../../utils/time";

interface TimeRulerProps {
  pixelsPerSecond: number;
  totalWidth: number; // must match the track lanes' width so ticks line up to the end
  fps: number;
  onSeek: (sec: number) => void;
}

/**
 * Picks a "nice" interval between labelled ruler ticks (1, 2, 5, 10, 30,
 * 60s etc.) based on zoom level, so labels never overlap at any zoom and
 * never go so sparse that the ruler feels empty when zoomed in.
 */
function pickTickInterval(pixelsPerSecond: number): number {
  const minPixelsBetweenTicks = 70;
  const candidates = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  for (const candidate of candidates) {
    if (candidate * pixelsPerSecond >= minPixelsBetweenTicks) return candidate;
  }
  return 600;
}

function RulerPlayhead({ pixelsPerSecond }: { pixelsPerSecond: number }) {
  const playheadSec = useEditorStore((s) => s.playheadSec);
  return (
    <div className="absolute top-0 bottom-0 w-px bg-accent pointer-events-none" style={{ transform: `translateX(${playheadSec * pixelsPerSecond}px)` }}>
      <div className="absolute top-0 -left-[5px] w-[11px] h-3 bg-accent rounded-b-sm" />
    </div>
  );
}

export const TimeRuler = memo(function TimeRuler({ pixelsPerSecond, totalWidth, fps, onSeek }: TimeRulerProps) {
  const tickInterval = pickTickInterval(pixelsPerSecond);
  const minorPerMajor = tickInterval >= 1 && tickInterval * pixelsPerSecond >= 120 ? 5 : 2;

  const ticks = useMemo(() => {
    const result: { t: number; major: boolean }[] = [];
    const step = tickInterval / minorPerMajor;
    const end = totalWidth / pixelsPerSecond;
    for (let i = 0; i * step <= end; i++) {
      result.push({ t: i * step, major: i % minorPerMajor === 0 });
    }
    return result;
  }, [tickInterval, minorPerMajor, totalWidth, pixelsPerSecond]);

  // Click or drag anywhere on the ruler to scrub.
  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    useEditorStore.getState().setIsPlaying(false);
    const seekTo = (clientX: number) => {
      const rect = el.getBoundingClientRect();
      onSeek(Math.max(0, (clientX - rect.left) / pixelsPerSecond));
    };
    seekTo(e.clientX);
    const onMove = (ev: PointerEvent) => seekTo(ev.clientX);
    const onUp = () => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
  };

  return (
    <div
      className="relative h-7 bg-surface-2 border-b border-border-subtle cursor-ew-resize select-none shrink-0 overflow-hidden"
      style={{ width: totalWidth }}
      onPointerDown={handlePointerDown}
      onClick={(e) => e.stopPropagation()}
    >
      {ticks.map(({ t, major }) => (
        <div key={t} className="absolute bottom-0" style={{ left: t * pixelsPerSecond }}>
          <div className={`w-px ${major ? "h-2.5 bg-border-strong" : "h-1.5 bg-border-subtle"}`} />
          {major && (
            <span className="absolute bottom-2.5 left-1 text-[10px] font-mono-tabular text-text-tertiary whitespace-nowrap">
              {/* Drop the frames field unless ticks are sub-second (it'd repeat labels otherwise). */}
              {tickInterval < 1 ? formatTimecode(t, fps) : formatTimecode(t, fps).replace(/[:.]\d{2}$/, "")}
            </span>
          )}
        </div>
      ))}
      <RulerPlayhead pixelsPerSecond={pixelsPerSecond} />
    </div>
  );
});
