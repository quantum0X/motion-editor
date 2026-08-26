import { useState } from "react";
import { X, ArrowRightLeft } from "lucide-react";
import { useEditorStore } from "../../stores/editorStore";
import type { TransitionType, InterpolationType } from "../../types/project";
import { TransitionSample } from "./TransitionSample";

interface TransitionPanelProps {
  clipId: string;
  onClose: () => void;
}

const TRANSITIONS: { type: TransitionType; label: string; tagline: string }[] = [
  { type: "fade", label: "Fade", tagline: "Cut through black" },
  { type: "dissolve", label: "Dissolve", tagline: "Cross-blend" },
  { type: "wipe", label: "Wipe", tagline: "Directional reveal" },
  { type: "slide", label: "Slide", tagline: "Slides in" },
  { type: "push", label: "Push", tagline: "Shoves forward" },
  { type: "zoom", label: "Zoom", tagline: "Zoom in" },
];

type TransitionDirection = "left" | "right" | "up" | "down";

const DIRECTIONS: { value: TransitionDirection; label: string }[] = [
  { value: "left", label: "Left" },
  { value: "right", label: "Right" },
  { value: "up", label: "Up" },
  { value: "down", label: "Down" },
];

const EASINGS: { value: InterpolationType; label: string }[] = [
  { value: "linear", label: "Linear" },
  { value: "easeIn", label: "Ease In" },
  { value: "easeOut", label: "Ease Out" },
  { value: "bezier", label: "Smooth" },
];

function isDirectional(type: TransitionType): boolean {
  return type === "wipe" || type === "slide" || type === "push";
}

export function TransitionPanel({ clipId, onClose }: TransitionPanelProps) {
  const project = useEditorStore((s) => s.project);
  const setTransition = useEditorStore((s) => s.setTransition);
  const removeTransition = useEditorStore((s) => s.removeTransition);

  const boundary = (() => {
    if (!project) return null;
    for (const track of project.tracks) {
      if (track.type !== "video") continue;
      const clips = track.clips ?? [];
      const clip = clips.find((c) => c.id === clipId);
      if (!clip) continue;
      const next = clips
        .filter((c) => c.id !== clip.id && c.timelineStartSec >= clip.timelineEndSec - 0.001)
        .sort((a, b) => a.timelineStartSec - b.timelineStartSec)[0];
      return { clip, next: next ?? null, trackName: track.name };
    }
    return null;
  })();

  const initialTransition = boundary?.clip?.transition;

  const [durationSec, setDurationSec] = useState(initialTransition?.durationSec ?? 1);
  const [direction, setDirection] = useState<TransitionDirection>((initialTransition?.direction as TransitionDirection) ?? "left");
  const [easing, setEasing] = useState<InterpolationType>(initialTransition?.easing ?? "linear");
  const [showSettings, setShowSettings] = useState(false);

  if (!project || !boundary) return null;

  const { clip, next, trackName } = boundary;
  const currentType = clip.transition?.type ?? null;

  const apply = (type: TransitionType | null) => {
    if (!type) {
      if (clip.transition) removeTransition(clip.id);
      return;
    }
    if (!next) return;
    setTransition(clip.id, {
      type,
      nextClipId: next.id,
      durationSec,
      direction: isDirectional(type) ? direction : "left",
      easing,
    });
  };

  const handlePick = (type: TransitionType) => {
    const alreadyCurrent = currentType === type;
    setShowSettings(!alreadyCurrent || !showSettings);
    apply(type);
  };

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60" onMouseDown={onClose}>
      <div
        className="w-[620px] max-h-[85vh] rounded-lg bg-surface-2 border border-border-strong shadow-2xl p-5 flex flex-col overflow-hidden"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4 shrink-0">
          <div className="flex items-center gap-2 text-text-primary">
            <ArrowRightLeft size={18} className="text-accent" />
            <span className="text-sm font-semibold">Transitions</span>
          </div>
          <button onClick={onClose} className="text-text-tertiary hover:text-text-primary">
            <X size={16} />
          </button>
        </div>

        {!next ? (
          <p className="text-sm text-text-secondary">
            <span className="font-semibold text-text-primary">{clip.id.slice(0, 8)}</span> is the last clip on{" "}
            <span className="font-semibold text-text-primary">{trackName}</span> - add a clip right after it to set a
            transition.
          </p>
        ) : (
          <div className="flex-1 flex flex-col gap-4 min-h-0">
            {/* Current selection summary */}
            <div className="flex items-center justify-between text-xs text-text-secondary px-1 -mb-1">
              <span className="font-mono-tabular text-text-tertiary">{clip.id.slice(0, 8)} ...</span>
              <ArrowRightLeft size={14} className="text-accent mx-1" />
              <span className="font-mono-tabular text-text-tertiary">{next.id.slice(0, 8)}</span>
            </div>

            {/* Grid of transition previews */}
            <div className="grid grid-cols-3 gap-2.5 overflow-y-auto pr-1">
              {TRANSITIONS.map((t) => {
                const active = currentType === t.type;
                return (
                  <button
                    key={t.type}
                    onClick={() => handlePick(t.type)}
                    className={`text-left rounded-lg border p-1.5 transition-colors ${
                      active
                        ? "border-accent bg-accent/10"
                        : "border-border-subtle bg-surface-1 hover:border-border-strong"
                    }`}
                    title={t.tagline}
                  >
                    <TransitionSample type={t.type} direction={direction} width={178} height={96} className="w-full" />
                    <div className="mt-1.5 flex items-center justify-between px-0.5">
                      <span className="text-xs font-medium text-text-primary">{t.label}</span>
                      {active && <span className="h-1.5 w-1.5 rounded-full bg-accent" />}
                    </div>
                    <span className="text-[10px] text-text-tertiary px-0.5">{t.tagline}</span>
                  </button>
                );
              })}
            </div>

            <p className="text-[10px] text-text-tertiary leading-snug">
              Each tile plays a live preview automatically. Click a tile to apply it to the cut between these two clips.
            </p>

            {showSettings && currentType ? (
              <div className="space-y-3 border-t border-border-subtle pt-3">
                <div className="flex items-center justify-between text-xs text-text-secondary">
                  <span>Duration</span>
                  <span className="font-mono-tabular text-text-tertiary">{durationSec.toFixed(1)}s</span>
                </div>
                <input
                  type="range"
                  min={0.2}
                  max={3}
                  step={0.1}
                  value={durationSec}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    setDurationSec(v);
                    setTransition(clip.id, {
                      type: currentType,
                      nextClipId: next.id,
                      durationSec: v,
                      direction: isDirectional(currentType) ? direction : "left",
                      easing,
                    });
                  }}
                  className="w-full accent-accent"
                />

                {isDirectional(currentType) && (
                  <div>
                    <label className="block text-[11px] text-text-tertiary mb-1">Direction</label>
                    <div className="flex rounded-md bg-surface-1 p-0.5 gap-0.5">
                      {DIRECTIONS.map((d) => (
                        <button
                          key={d.value}
                          onClick={() => {
                            setDirection(d.value);
                            setTransition(clip.id, {
                              type: currentType,
                              nextClipId: next.id,
                              durationSec,
                              direction: d.value,
                              easing,
                            });
                          }}
                          className={`flex-1 text-xs py-1.5 rounded-[5px] transition-colors ${
                            direction === d.value ? "bg-accent text-white" : "text-text-secondary hover:text-text-primary"
                          }`}
                        >
                          {d.label}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                <div>
                  <label className="block text-[11px] text-text-tertiary mb-1">Easing</label>
                  <div className="flex rounded-md bg-surface-1 p-0.5 gap-0.5">
                    {EASINGS.map((e) => (
                      <button
                        key={e.value}
                        onClick={() => {
                          setEasing(e.value);
                          setTransition(clip.id, {
                            type: currentType,
                            nextClipId: next.id,
                            durationSec,
                            direction: isDirectional(currentType) ? direction : "left",
                            easing: e.value,
                          });
                        }}
                        className={`flex-1 text-xs py-1.5 rounded-[5px] transition-colors ${
                          easing === e.value ? "bg-accent text-white" : "text-text-secondary hover:text-text-primary"
                        }`}
                      >
                        {e.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="flex gap-2 pt-1">
                  <button
                    onClick={() => {
                      apply(null);
                      setShowSettings(false);
                    }}
                    className="flex-1 py-2 rounded-md bg-surface-3 hover:bg-surface-1 text-xs text-text-secondary transition-colors"
                  >
                    Remove transition
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}