import { useState, useEffect } from "react";
import { X, Trash2 } from "lucide-react";
import { useEditorStore } from "../../stores/editorStore";
import type { TextClip } from "../../types/project";

interface TextClipPanelProps {
  clipId: string;
  onClose: () => void;
}

const FONT_OPTIONS = [
  { key: "sans", label: "Sans" },
  { key: "serif", label: "Serif" },
  { key: "mono", label: "Mono" },
];

const POSITION_PRESETS = [
  { label: "Top", x: 50, y: 12 },
  { label: "Center", x: 50, y: 50 },
  { label: "Lower Third", x: 50, y: 85 },
];

export function TextClipPanel({ clipId, onClose }: TextClipPanelProps) {
  const project = useEditorStore((s) => s.project);
  const updateTextClip = useEditorStore((s) => s.updateTextClip);
  const deleteSelectedTextClip = useEditorStore((s) => s.deleteSelectedTextClip);
  const selectTextClip = useEditorStore((s) => s.selectTextClip);

  const clip = project?.tracks.flatMap((t) => t.textClips).find((c) => c.id === clipId);
  const [draft, setDraft] = useState<TextClip | null>(clip ?? null);

  useEffect(() => {
    setDraft(clip ?? null);
  }, [clip]);

  if (!draft) return null;

  const apply = (partial: Partial<TextClip>) => {
    const updated = { ...draft, ...partial };
    setDraft(updated);
    updateTextClip(clipId, updated);
  };

  const handleDelete = () => {
    selectTextClip(clipId);
    deleteSelectedTextClip();
    onClose();
  };

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60" onMouseDown={onClose}>
      <div
        className="w-[360px] rounded-lg bg-surface-2 border border-border-strong shadow-2xl p-5 max-h-[85vh] overflow-y-auto"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-text-primary">Edit Text</h2>
          <div className="flex items-center gap-2">
            <button onClick={handleDelete} className="text-text-tertiary hover:text-danger" title="Delete text clip">
              <Trash2 size={14} />
            </button>
            <button onClick={onClose} className="text-text-tertiary hover:text-text-primary">
              <X size={16} />
            </button>
          </div>
        </div>

        <div className="space-y-3.5">
          <Field label="Content">
            <textarea
              value={draft.content}
              onChange={(e) => apply({ content: e.target.value })}
              rows={2}
              className="w-full px-3 py-2 rounded-md bg-surface-1 border border-border-subtle text-sm text-text-primary outline-none focus:ring-1 focus:ring-accent resize-none"
              autoFocus
            />
          </Field>

          <Field label="Font">
            <div className="flex rounded-md bg-surface-1 p-0.5 gap-0.5">
              {FONT_OPTIONS.map((opt) => (
                <button
                  key={opt.key}
                  onClick={() => apply({ fontFamily: opt.key })}
                  className={`flex-1 text-xs py-1.5 rounded-[5px] transition-colors ${
                    draft.fontFamily === opt.key ? "bg-accent text-white" : "text-text-secondary hover:text-text-primary"
                  }`}
                  style={{ fontFamily: opt.key === "serif" ? "Georgia, serif" : opt.key === "mono" ? "monospace" : undefined }}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Size">
              <input
                type="number"
                min={8}
                max={200}
                value={draft.fontSize}
                onChange={(e) => apply({ fontSize: Number(e.target.value) || 32 })}
                className="w-full px-3 py-1.5 rounded-md bg-surface-1 border border-border-subtle text-sm text-text-primary outline-none focus:ring-1 focus:ring-accent font-mono-tabular"
              />
            </Field>
            <Field label="Weight">
              <div className="flex rounded-md bg-surface-1 p-0.5 gap-0.5">
                {(["normal", "bold"] as const).map((w) => (
                  <button
                    key={w}
                    onClick={() => apply({ fontWeight: w })}
                    className={`flex-1 text-xs py-1.5 rounded-[5px] capitalize transition-colors ${
                      draft.fontWeight === w ? "bg-accent text-white" : "text-text-secondary hover:text-text-primary"
                    }`}
                  >
                    {w}
                  </button>
                ))}
              </div>
            </Field>
          </div>

          <Field label="Color">
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={draft.color}
                onChange={(e) => apply({ color: e.target.value })}
                className="w-9 h-9 rounded cursor-pointer bg-surface-1 border border-border-subtle"
              />
              <input
                value={draft.color}
                onChange={(e) => apply({ color: e.target.value })}
                className="flex-1 px-3 py-1.5 rounded-md bg-surface-1 border border-border-subtle text-sm text-text-primary outline-none focus:ring-1 focus:ring-accent font-mono-tabular"
              />
            </div>
          </Field>

          <Field label="Position">
            <div className="flex rounded-md bg-surface-1 p-0.5 gap-0.5">
              {POSITION_PRESETS.map((preset) => (
                <button
                  key={preset.label}
                  onClick={() => apply({ positionXPercent: preset.x, positionYPercent: preset.y })}
                  className={`flex-1 text-xs py-1.5 rounded-[5px] transition-colors ${
                    Math.abs(draft.positionXPercent - preset.x) < 1 && Math.abs(draft.positionYPercent - preset.y) < 1
                      ? "bg-accent text-white"
                      : "text-text-secondary hover:text-text-primary"
                  }`}
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </Field>

          <div className="flex items-center justify-between pt-1">
            <ToggleField
              label="Outline"
              checked={draft.outlineEnabled}
              onChange={(checked) => apply({ outlineEnabled: checked })}
            />
            <ToggleField
              label="Shadow"
              checked={draft.shadowEnabled}
              onChange={(checked) => apply({ shadowEnabled: checked })}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-[11px] text-text-tertiary mb-1">{label}</label>
      {children}
    </div>
  );
}

function ToggleField({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <button onClick={() => onChange(!checked)} className="flex items-center gap-2 text-xs text-text-secondary hover:text-text-primary">
      <div className={`w-8 h-4.5 rounded-full transition-colors relative ${checked ? "bg-accent" : "bg-surface-3"}`}>
        <div
          className={`absolute top-0.5 w-3.5 h-3.5 rounded-full bg-white transition-transform ${checked ? "translate-x-[18px]" : "translate-x-0.5"}`}
        />
      </div>
      {label}
    </button>
  );
}
