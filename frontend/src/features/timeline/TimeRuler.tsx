import { useMemo } from "react";
import { formatTimecode } from "../../utils/time";

interface TimeRulerProps {
  pixelsPerSecond: number;
  durationSec: number;
  fps: number;
  playheadSec: number;
  onSeek: (sec: number) => void;
}

/**
 * Picks a "nice" interval between ruler tick marks (1, 2, 5, 10, 30, 60s
 * etc.) based on zoom level, so labels never overlap at any zoom and
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

export function TimeRuler({ pixelsPerSecond, durationSec, fps, playheadSec, onSeek }: TimeRulerProps) {
  const tickInterval = pickTickInterval(pixelsPerSecond);
  const totalWidth = Math.max(durationSec, 10) * pixelsPerSecond + 200;

  const ticks = useMemo(() => {
    const result: number[] = [];
    const displayDuration = Math.max(durationSec + 30, 60);
    for (let t = 0; t <= displayDuration; t += tickInterval) {
      result.push(t);
    }
    return result;
  }, [tickInterval, durationSec]);

  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    onSeek(Math.max(0, x / pixelsPerSecond));
  };

  return (
    <div
      className="relative h-7 bg-surface-2 border-b border-border-subtle cursor-pointer select-none shrink-0"
      style={{ width: totalWidth }}
      onClick={handleClick}
    >
      {ticks.map((t) => (
        <div key={t} className="absolute top-0 bottom-0 flex flex-col" style={{ left: t * pixelsPerSecond }}>
          <div className="w-px h-2 bg-border-strong mt-auto" />
          <span className="absolute top-0.5 left-1.5 text-[10px] font-mono-tabular text-text-tertiary whitespace-nowrap">
            {formatTimecode(t, fps).replace(/[:.]\d{2}$/, "")}
          </span>
        </div>
      ))}
      {/* Playhead marker on the ruler itself */}
      <div className="absolute top-0 bottom-0 w-px bg-accent pointer-events-none" style={{ left: playheadSec * pixelsPerSecond }}>
        <div className="absolute -top-0 -left-[5px] w-[11px] h-3 bg-accent rounded-sm" />
      </div>
    </div>
  );
}
