import { useMemo } from "react";
import { X, Sparkles, Trash2 } from "lucide-react";
import { useEditorStore } from "../../stores/editorStore";
import type { Effect, EffectType, TransitionType } from "../../types/project";

interface ClipEffectsPanelProps {
  clipId: string;
  onClose: () => void;
}

const COLOR_EFFECTS: { type: EffectType; label: string }[] = [
  { type: "brightness", label: "Brightness" },
  { type: "contrast", label: "Contrast" },
  { type: "saturation", label: "Saturation" },
];

const FILTER_EFFECTS: { type: EffectType; label: string; hint: string }[] = [
  { type: "blur", label: "Blur", hint: "Softens the image" },
  { type: "sharpen", label: "Sharpen", hint: "Crisper edges" },
  { type: "vignette", label: "Vignette", hint: "Darkened corners" },
  { type: "grain", label: "Film Grain", hint: "Adds texture/noise" },
  { type: "vhs", label: "VHS", hint: "Retro tape look" },
  { type: "rgbshift", label: "RGB Shift", hint: "Chromatic aberration" },
];

const TRANSITION_TYPES: { type: TransitionType; label: string }[] = [
  { type: "fade", label: "Fade" },
  { type: "dissolve", label: "Dissolve" },
  { type: "wipe", label: "Wipe" },
  { type: "slide", label: "Slide" },
  { type: "push", label: "Push" },
  { type: "zoom", label: "Zoom" },
];

function defaultParamKey(type: EffectType): string {
  switch (type) {
    case "blur":
      return "radiusPx";
    default:
      return "amount";
  }
}

function paramRange(type: EffectType): { min: number; max: number } {
  switch (type) {
    case "brightness":
    case "contrast":
    case "saturation":
      return { min: -100, max: 100 };
    case "blur":
      return { min: 0, max: 20 };
    default:
      return { min: 0, max: 100 };
  }
}

export function ClipEffectsPanel({ clipId, onClose }: ClipEffectsPanelProps) {
  const project = useEditorStore((s) => s.project);
  const addEffect = useEditorStore((s) => s.addEffect);
  const updateEffect = useEditorStore((s) => s.updateEffect);
  const removeEffect = useEditorStore((s) => s.removeEffect);
  const setTransition = useEditorStore((s) => s.setTransition);
  const removeTransition = useEditorStore((s) => s.removeTransition);

  const found = useMemo(() => {
    if (!project) return null;
    for (const track of project.tracks) {
      const clip = (track.clips ?? []).find((c) => c.id === clipId);
      if (clip) return { clip, track };
    }
    return null;
  }, [project, clipId]);

  if (!found) return null;
  const { clip, track } = found;
  const effects = clip.effects ?? [];

  const effectByType = (type: EffectType): Effect | undefined => effects.find((e) => e.type === type);

  const handleColorChange = (type: EffectType, amount: number) => {
    const existing = effectByType(type);
    if (existing) {
      updateEffect(clip.id, existing.id, { ...existing, params: { ...existing.params, amount } });
    } else {
      addEffect(clip.id, { type, params: { amount }, enabled: true });
    }
  };

  const handleAddFilter = (type: EffectType, defaultAmount: number) => {
    if (effectByType(type)) return;
    addEffect(clip.id, { type, params: { [defaultParamKey(type)]: defaultAmount }, enabled: true });
  };

  // Only clips starting after this one on the SAME track are valid
  // transition targets - a transition dissolves/wipes into whatever
  // plays next in that lane.
  const nextClipCandidates = (track.clips ?? [])
    .filter((c) => c.id !== clip.id && c.timelineStartSec >= clip.timelineEndSec - 0.001)
    .sort((a, b) => a.timelineStartSec - b.timelineStartSec);

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60" onMouseDown={onClose}>
      <div
        className="w-[420px] max-h-[80vh] rounded-lg bg-surface-2 border border-border-strong shadow-2xl p-5 flex flex-col overflow-hidden"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4 shrink-0">
          <div className="flex items-center gap-2 text-text-primary">
            <Sparkles size={18} className="text-accent" />
            <span className="text-sm font-semibold">Effects</span>
          </div>
          <button onClick={onClose} className="text-text-tertiary hover:text-text-primary">
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto space-y-5 -mx-1 px-1">
          {/* Color correction */}
          <section>
            <h3 className="text-[11px] font-medium text-text-tertiary uppercase tracking-wide mb-2">Color Correction</h3>
            <div className="space-y-3">
              {COLOR_EFFECTS.map(({ type, label }) => {
                const existing = effectByType(type);
                const value = existing?.params?.amount ?? 0;
                const { min, max } = paramRange(type);
                return (
                  <div key={type}>
                    <div className="flex items-center justify-between text-xs text-text-secondary mb-1">
                      <span>{label}</span>
                      <span className="font-mono-tabular text-text-tertiary">{value}</span>
                    </div>
                    <input
                      type="range"
                      min={min}
                      max={max}
                      value={value}
                      onChange={(e) => handleColorChange(type, Number(e.target.value))}
                      className="w-full accent-accent"
                    />
                  </div>
                );
              })}
            </div>
          </section>

          {/* Filters */}
          <section>
            <h3 className="text-[11px] font-medium text-text-tertiary uppercase tracking-wide mb-2">Filters</h3>
            <div className="grid grid-cols-2 gap-1.5 mb-3">
              {FILTER_EFFECTS.map(({ type, label, hint }) => {
                const active = !!effectByType(type);
                return (
                  <button
                    key={type}
                    onClick={() => handleAddFilter(type, paramRange(type).max / 2)}
                    disabled={active}
                    title={hint}
                    className={`text-xs py-1.5 rounded-md border transition-colors ${
                      active
                        ? "border-accent bg-accent/10 text-text-primary cursor-default"
                        : "border-border-subtle text-text-secondary hover:border-border-strong"
                    }`}
                  >
                    {label}
                    {active ? " ✓" : ""}
                  </button>
                );
              })}
            </div>

            {effects
              .filter((e) => FILTER_EFFECTS.some((f) => f.type === e.type))
              .map((effect) => {
                const paramKey = defaultParamKey(effect.type);
                const { min, max } = paramRange(effect.type);
                const value = effect.params?.[paramKey] ?? 0;
                const label = FILTER_EFFECTS.find((f) => f.type === effect.type)?.label ?? effect.type;
                return (
                  <div key={effect.id} className="flex items-center gap-2 py-1.5">
                    <span className="text-xs text-text-secondary w-16 shrink-0">{label}</span>
                    <input
                      type="range"
                      min={min}
                      max={max}
                      value={value}
                      onChange={(e) =>
                        updateEffect(clip.id, effect.id, { ...effect, params: { ...effect.params, [paramKey]: Number(e.target.value) } })
                      }
                      className="flex-1 accent-accent"
                    />
                    <span className="font-mono-tabular text-[10px] text-text-tertiary w-6 text-right">{value}</span>
                    <button onClick={() => removeEffect(clip.id, effect.id)} className="text-text-tertiary hover:text-danger">
                      <Trash2 size={12} />
                    </button>
                  </div>
                );
              })}
          </section>

          {/* Transition into the next clip on this track */}
          <section>
            <h3 className="text-[11px] font-medium text-text-tertiary uppercase tracking-wide mb-2">Transition</h3>
            {nextClipCandidates.length === 0 ? (
              <p className="text-xs text-text-tertiary">No clip follows this one on {track.name} yet - add one to set a transition.</p>
            ) : (
              <div className="space-y-2">
                <select
                  value={clip.transition?.type ?? ""}
                  onChange={(e) => {
                    const value = e.target.value as TransitionType | "";
                    if (!value) {
                      if (clip.transition) removeTransition(clip.id);
                      return;
                    }
                    setTransition(clip.id, {
                      type: value,
                      nextClipId: clip.transition?.nextClipId ?? nextClipCandidates[0].id,
                      durationSec: clip.transition?.durationSec ?? 1,
                    });
                  }}
                  className="w-full px-2.5 py-1.5 rounded-md bg-surface-1 border border-border-subtle text-xs text-text-primary outline-none focus:ring-1 focus:ring-accent"
                >
                  <option value="">Hard cut (no transition)</option>
                  {TRANSITION_TYPES.map((t) => (
                    <option key={t.type} value={t.type}>
                      {t.label}
                    </option>
                  ))}
                </select>

                {clip.transition && (
                  <div>
                    <div className="flex items-center justify-between text-xs text-text-secondary mb-1">
                      <span>Duration</span>
                      <span className="font-mono-tabular text-text-tertiary">{clip.transition.durationSec.toFixed(1)}s</span>
                    </div>
                    <input
                      type="range"
                      min={0.2}
                      max={3}
                      step={0.1}
                      value={clip.transition.durationSec}
                      onChange={(e) =>
                        setTransition(clip.id, {
                          type: clip.transition!.type,
                          nextClipId: clip.transition!.nextClipId,
                          durationSec: Number(e.target.value),
                        })
                      }
                      className="w-full accent-accent"
                    />
                  </div>
                )}
                <p className="text-[10px] text-text-tertiary leading-snug">
                  Transition data saves with the project now; rendering it into the final exported video is still on the roadmap.
                </p>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
