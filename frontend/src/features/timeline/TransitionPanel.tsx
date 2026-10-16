import { X, ArrowRightLeft, Trash2 } from "lucide-react";
import { useEditorStore, findClip } from "../../stores/editorStore";
import type { TransitionType, InterpolationType, Transition } from "../../types/project";
import { TransitionSample } from "./TransitionSample";
import { Modal } from "../../components/Modal";

interface TransitionPanelProps {
  clipId: string;
  onClose: () => void;
}

const TRANSITIONS: { type: TransitionType; label: string; tagline: string }[] = [
  { type: "fade", label: "Fade", tagline: "Soft cross-fade" },
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

function Segmented<T extends string>({ options, value, onChange }: { options: { value: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="flex rounded-md bg-surface-1 p-0.5 gap-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          aria-pressed={value === o.value}
          className={`flex-1 text-xs py-1.5 rounded-[5px] transition-colors ${value === o.value ? "bg-accent text-white" : "text-text-secondary hover:text-text-primary"}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function TransitionPanel({ clipId, onClose }: TransitionPanelProps) {
  const project = useEditorStore((s) => s.project);
  const setTransition = useEditorStore((s) => s.setTransition);
  const removeTransition = useEditorStore((s) => s.removeTransition);

  const found = findClip(project, clipId);
  if (!project || !found || found.track.type !== "video") return null;

  const { clip, track } = found;
  const next =
    (track.clips ?? [])
      .filter((c) => c.id !== clip.id && c.timelineStartSec >= clip.timelineEndSec - 0.001)
      .sort((a, b) => a.timelineStartSec - b.timelineStartSec)[0] ?? null;
  const nameOf = (assetId: string) => project.assets.find((a) => a.id === assetId)?.fileName ?? "Untitled clip";

  // Settings live on the clip itself (the store applies changes
  // optimistically), so reopening the panel always shows what's applied.
  const current = clip.transition;
  const durationSec = current?.durationSec ?? 1;
  const direction = (current?.direction as TransitionDirection) ?? "left";
  const easing = current?.easing ?? "linear";
  // A transition can't be longer than either clip it blends.
  const maxDuration = next ? Math.max(0.2, Math.min(3, clip.timelineEndSec - clip.timelineStartSec, next.timelineEndSec - next.timelineStartSec)) : 3;

  const apply = (changes: Partial<Pick<Transition, "type" | "durationSec" | "direction" | "easing">>) => {
    if (!next) return;
    const type = changes.type ?? current?.type;
    if (!type) return;
    setTransition(clip.id, {
      type,
      nextClipId: next.id,
      durationSec: Math.min(maxDuration, changes.durationSec ?? durationSec),
      direction: isDirectional(type) ? (changes.direction ?? direction) : "left",
      easing: changes.easing ?? easing,
    });
  };

  return (
    <Modal onClose={onClose}>
      <div className="w-[620px] max-h-[85vh] rounded-lg bg-surface-2 border border-border-strong shadow-2xl p-5 flex flex-col overflow-hidden">
        <div className="flex items-center justify-between mb-4 shrink-0">
          <div className="flex items-center gap-2 text-text-primary">
            <ArrowRightLeft size={18} className="text-accent" />
            <span className="text-sm font-semibold">Transitions</span>
          </div>
          <button onClick={onClose} className="text-text-tertiary hover:text-text-primary" aria-label="Close">
            <X size={16} />
          </button>
        </div>

        {!next ? (
          <p className="text-sm text-text-secondary">
            <span className="font-semibold text-text-primary">{nameOf(clip.assetId)}</span> is the last clip on{" "}
            <span className="font-semibold text-text-primary">{track.name}</span> - place another clip right after it to add a transition.
          </p>
        ) : (
          <div className="flex-1 flex flex-col gap-4 min-h-0">
            {/* Which cut this edits */}
            <div className="flex items-center gap-2 text-xs rounded-md bg-surface-1 border border-border-subtle px-3 py-2">
              <span className="truncate text-text-primary flex-1 text-right">{nameOf(clip.assetId)}</span>
              <ArrowRightLeft size={13} className="text-accent shrink-0" />
              <span className="truncate text-text-primary flex-1">{nameOf(next.assetId)}</span>
            </div>

            <div className="grid grid-cols-3 gap-2.5 overflow-y-auto pr-1">
              {TRANSITIONS.map((t) => {
                const active = current?.type === t.type;
                return (
                  <button
                    key={t.type}
                    onClick={() => apply({ type: t.type })}
                    aria-pressed={active}
                    className={`text-left rounded-lg border p-1.5 transition-colors ${active ? "border-accent bg-accent/10" : "border-border-subtle bg-surface-1 hover:border-border-strong"}`}
                    title={t.tagline}
                  >
                    <TransitionSample type={t.type} direction={direction} easing={easing} width={178} height={96} className="w-full" />
                    <div className="mt-1.5 flex items-center justify-between px-0.5">
                      <span className="text-xs font-medium text-text-primary">{t.label}</span>
                      {active && <span className="h-1.5 w-1.5 rounded-full bg-accent" />}
                    </div>
                    <span className="text-[10px] text-text-tertiary px-0.5">{t.tagline}</span>
                  </button>
                );
              })}
            </div>

            {current ? (
              <div className="space-y-3 border-t border-border-subtle pt-3">
                <div>
                  <div className="flex items-center justify-between text-xs text-text-secondary mb-1">
                    <label htmlFor="transition-duration">Duration</label>
                    <span className="font-mono-tabular text-text-tertiary">{durationSec.toFixed(1)}s</span>
                  </div>
                  <input
                    id="transition-duration"
                    type="range"
                    min={0.2}
                    max={maxDuration}
                    step={0.1}
                    value={Math.min(durationSec, maxDuration)}
                    onChange={(e) => apply({ durationSec: Number(e.target.value) })}
                    className="w-full accent-accent"
                  />
                </div>

                {isDirectional(current.type) && (
                  <div>
                    <span className="block text-[11px] text-text-tertiary mb-1">Direction</span>
                    <Segmented options={DIRECTIONS} value={direction} onChange={(d) => apply({ direction: d })} />
                  </div>
                )}

                <div>
                  <span className="block text-[11px] text-text-tertiary mb-1">Easing</span>
                  <Segmented options={EASINGS} value={easing} onChange={(e) => apply({ easing: e })} />
                </div>

                <button
                  onClick={() => removeTransition(clip.id)}
                  className="w-full flex items-center justify-center gap-1.5 py-2 rounded-md bg-surface-3 hover:bg-danger/15 hover:text-danger text-xs text-text-secondary transition-colors"
                >
                  <Trash2 size={12} />
                  Remove transition
                </button>
              </div>
            ) : (
              <p className="text-[11px] text-text-tertiary leading-snug">Click a tile to apply it to the cut between these two clips. Each tile previews the effect live.</p>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
