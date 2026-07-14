import { Save, Download, Undo2, Redo2 } from "lucide-react";
import { useEditorStore } from "../stores/editorStore";

interface ToolbarProps {
  onShowExport: () => void;
}

export function Toolbar({ onShowExport }: ToolbarProps) {
  const project = useEditorStore((s) => s.project);
  const saveProject = useEditorStore((s) => s.saveProject);
  const lastError = useEditorStore((s) => s.lastError);
  const setError = useEditorStore((s) => s.setError);
  const undo = useEditorStore((s) => s.undo);
  const redo = useEditorStore((s) => s.redo);
  const canUndo = useEditorStore((s) => s.canUndo);
  const canRedo = useEditorStore((s) => s.canRedo);

  return (
    <div className="flex items-center gap-3 px-3 py-2 border-b border-border-subtle bg-surface-2 shrink-0">
      <span className="text-sm font-semibold text-text-primary px-1">{project?.name ?? "VideoEditor"}</span>

      <div className="h-4 w-px bg-border-subtle" />

      <button
        onClick={() => undo()}
        disabled={!canUndo}
        className="text-text-secondary hover:text-text-primary disabled:text-text-tertiary disabled:opacity-40 transition-colors"
        title="Undo (Ctrl+Z)"
      >
        <Undo2 size={15} />
      </button>
      <button
        onClick={() => redo()}
        disabled={!canRedo}
        className="text-text-secondary hover:text-text-primary disabled:text-text-tertiary disabled:opacity-40 transition-colors"
        title="Redo (Ctrl+Y)"
      >
        <Redo2 size={15} />
      </button>

      <div className="flex-1" />

      {lastError && (
        <button
          onClick={() => setError(null)}
          className="text-xs text-danger bg-danger/10 hover:bg-danger/20 rounded px-2 py-1 max-w-md truncate transition-colors"
          title="Dismiss"
        >
          {lastError}
        </button>
      )}

      <button
        onClick={() => saveProject()}
        disabled={!project}
        className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-md text-text-secondary hover:text-text-primary hover:bg-surface-3 disabled:opacity-40 transition-colors"
        title="Save (Ctrl+S)"
      >
        <Save size={13} />
        Save
      </button>
      <button
        onClick={onShowExport}
        disabled={!project}
        className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md bg-accent hover:bg-accent-dim text-white disabled:opacity-40 transition-colors"
      >
        <Download size={13} />
        Export
      </button>
    </div>
  );
}
