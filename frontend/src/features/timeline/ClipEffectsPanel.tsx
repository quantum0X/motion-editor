import { useMemo } from "react";
import { X, Sparkles, Trash2 } from "lucide-react";
import { useEditorStore } from "../../stores/editorStore";
import type { Effect, EffectType } from "../../types/project";

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

  const found = useMemo(() => {
    if (!project) return null;
    for (const track of project.tracks) {
      const clip = (track.clips ?? []).find((c) => c.id === clipId);
      if (clip) return clip;
    }
    return null;
  }, [project, clipId]);

  if (!found) return null;
  const clip = found;
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

          {/* Transition into the next clip moved to the dedicated
              transitions panel (see TransitionPanel.tsx) */}
        </div>
      </div>
    </div>
  );
}
