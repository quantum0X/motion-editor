import { useState, useRef } from "react";
import { X, Sparkles, Trash2, RotateCcw } from "lucide-react";
import { useEditorStore, findClip } from "../../stores/editorStore";
import type { Effect, EffectType } from "../../types/project";
import { Modal } from "../../components/Modal";

interface ClipEffectsPanelProps {
  clipId: string;
  onClose: () => void;
}

const COLOR_EFFECTS: { type: EffectType; label: string }[] = [
  { type: "brightness", label: "Brightness" },
  { type: "contrast", label: "Contrast" },
  { type: "saturation", label: "Saturation" },
];

const FILTER_EFFECTS: { type: EffectType; label: string; hint: string; previewed: boolean }[] = [
  { type: "blur", label: "Blur", hint: "Softens the image", previewed: true },
  { type: "sharpen", label: "Sharpen", hint: "Crisper edges", previewed: true },
  { type: "vignette", label: "Vignette", hint: "Darkened corners", previewed: false },
  { type: "grain", label: "Film Grain", hint: "Adds texture/noise", previewed: false },
  { type: "vhs", label: "VHS", hint: "Retro tape look", previewed: true },
  { type: "rgbshift", label: "RGB Shift", hint: "Chromatic aberration", previewed: false },
];

function defaultParamKey(type: EffectType): string {
  return type === "blur" ? "radiusPx" : "amount";
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

  // Values for color effects whose addEffect call hasn't returned yet.
  // Without this, every slider tick during that round-trip saw "no effect
  // yet" and called addEffect again, stacking duplicate effects.
  // The ref is read from async callbacks; the state mirrors it for rendering.
  const pendingRef = useRef<Partial<Record<EffectType, number>>>({});
  const [pendingValues, setPendingValues] = useState<Partial<Record<EffectType, number>>>({});
  const setPending = (next: Partial<Record<EffectType, number>>) => {
    pendingRef.current = next;
    setPendingValues(next);
  };

  const found = findClip(project, clipId);
  if (!found) return null;
  const { clip } = found;
  const effects = clip.effects ?? [];
  const asset = project?.assets.find((a) => a.id === clip.assetId);

  const effectByType = (type: EffectType): Effect | undefined => effects.find((e) => e.type === type);

  const handleColorChange = (type: EffectType, amount: number) => {
    const existing = effectByType(type);
    if (existing) {
      updateEffect(clip.id, existing.id, { ...existing, params: { ...existing.params, amount } });
      return;
    }
    const alreadyAdding = pendingRef.current[type] !== undefined;
    setPending({ ...pendingRef.current, [type]: amount });
    if (alreadyAdding) return;

    addEffect(clip.id, { type, params: { amount }, enabled: true }).then(() => {
      const latest = pendingRef.current[type];
      const rest = { ...pendingRef.current };
      delete rest[type];
      setPending(rest);
      const created = findClip(useEditorStore.getState().project, clip.id)?.clip.effects?.find((e) => e.type === type);
      if (created && latest !== undefined && latest !== created.params?.amount) {
        updateEffect(clip.id, created.id, { ...created, params: { ...created.params, amount: latest } });
      }
    });
  };

  const handleAddFilter = (type: EffectType, defaultAmount: number) => {
    if (effectByType(type)) return;
    addEffect(clip.id, { type, params: { [defaultParamKey(type)]: defaultAmount }, enabled: true });
  };

  const colorEffectsActive = COLOR_EFFECTS.some(({ type }) => (effectByType(type)?.params?.amount ?? 0) !== 0);

  return (
    <Modal onClose={onClose}>
      <div className="w-[420px] max-h-[80vh] rounded-lg bg-surface-2 border border-border-strong shadow-2xl p-5 flex flex-col overflow-hidden">
        <div className="flex items-center justify-between mb-4 shrink-0">
          <div className="flex items-center gap-2 text-text-primary min-w-0">
            <Sparkles size={18} className="text-accent shrink-0" />
            <span className="text-sm font-semibold">Effects</span>
            {asset && <span className="text-xs text-text-tertiary truncate">· {asset.fileName}</span>}
          </div>
          <button onClick={onClose} className="text-text-tertiary hover:text-text-primary" aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto space-y-5 -mx-1 px-1">
          {/* Color correction */}
          <section>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-[11px] font-medium text-text-tertiary uppercase tracking-wide">Color Correction</h3>
              <button
                onClick={() => COLOR_EFFECTS.forEach(({ type }) => effectByType(type) && handleColorChange(type, 0))}
                disabled={!colorEffectsActive}
                className="flex items-center gap-1 text-[11px] text-text-tertiary hover:text-text-primary disabled:opacity-30 disabled:pointer-events-none"
              >
                <RotateCcw size={11} />
                Reset
              </button>
            </div>
            <div className="space-y-3">
              {COLOR_EFFECTS.map(({ type, label }) => {
                const value = effectByType(type)?.params?.amount ?? pendingValues[type] ?? 0;
                const { min, max } = paramRange(type);
                return (
                  <div key={type}>
                    <div className="flex items-center justify-between text-xs text-text-secondary mb-1">
                      <label htmlFor={`fx-${type}`}>{label}</label>
                      <span className="font-mono-tabular text-text-tertiary">{value > 0 ? `+${value}` : value}</span>
                    </div>
                    <input
                      id={`fx-${type}`}
                      type="range"
                      min={min}
                      max={max}
                      value={value}
                      onChange={(e) => handleColorChange(type, Number(e.target.value))}
                      onDoubleClick={() => handleColorChange(type, 0)}
                      title="Double-click to reset"
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
            <div className="grid grid-cols-3 gap-1.5 mb-3">
              {FILTER_EFFECTS.map(({ type, label, hint, previewed }) => {
                const active = !!effectByType(type);
                return (
                  <button
                    key={type}
                    onClick={() => handleAddFilter(type, paramRange(type).max / 2)}
                    disabled={active}
                    title={previewed ? hint : `${hint} - applied on export (not shown in the live preview)`}
                    className={`text-xs py-1.5 rounded-md border transition-colors ${
                      active ? "border-accent bg-accent/10 text-text-primary cursor-default" : "border-border-subtle text-text-secondary hover:border-border-strong hover:text-text-primary"
                    }`}
                  >
                    {label}
                    {!previewed && <span className="text-text-tertiary">*</span>}
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
                      onChange={(e) => updateEffect(clip.id, effect.id, { ...effect, params: { ...effect.params, [paramKey]: Number(e.target.value) } })}
                      className="flex-1 accent-accent"
                      aria-label={`${label} amount`}
                    />
                    <span className="font-mono-tabular text-[10px] text-text-tertiary w-6 text-right">{value}</span>
                    <button onClick={() => removeEffect(clip.id, effect.id)} className="p-0.5 text-text-tertiary hover:text-danger" aria-label={`Remove ${label}`}>
                      <Trash2 size={12} />
                    </button>
                  </div>
                );
              })}

            {FILTER_EFFECTS.some((f) => !f.previewed) && (
              <p className="text-[10px] text-text-tertiary mt-2">* Rendered on export only - not visible in the live preview.</p>
            )}
          </section>
        </div>
      </div>
    </Modal>
  );
}
