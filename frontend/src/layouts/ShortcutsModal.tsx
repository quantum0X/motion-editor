import { Keyboard, X } from "lucide-react";
import { Modal } from "../components/Modal";
import { SHORTCUTS } from "./useEditorShortcuts";

export function ShortcutsModal({ onClose }: { onClose: () => void }) {
  return (
    <Modal onClose={onClose}>
      <div className="w-[420px] max-h-[80vh] rounded-lg bg-surface-2 border border-border-strong shadow-2xl p-5 flex flex-col">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2 text-text-primary">
            <Keyboard size={18} className="text-accent" />
            <span className="text-sm font-semibold">Keyboard Shortcuts</span>
          </div>
          <button onClick={onClose} className="text-text-tertiary hover:text-text-primary" aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <dl className="overflow-y-auto -mx-1 px-1 divide-y divide-border-subtle">
          {SHORTCUTS.map(({ keys, action }) => (
            <div key={keys} className="flex items-center justify-between gap-4 py-1.5">
              <dt className="text-xs text-text-secondary">{action}</dt>
              <dd className="text-[11px] font-mono-tabular text-text-primary bg-surface-1 border border-border-subtle rounded px-1.5 py-0.5 whitespace-nowrap">
                {keys}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </Modal>
  );
}
