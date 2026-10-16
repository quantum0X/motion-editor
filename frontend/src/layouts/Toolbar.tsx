import { useEffect } from "react";
import { Save, Download, Undo2, Redo2, AlertCircle, X } from "lucide-react";
import { useEditorStore } from "../stores/editorStore";

interface ToolbarProps {
  onShowExport: () => void;
}

const ERROR_AUTO_DISMISS_MS = 8000;

const iconButton =
  "p-1.5 rounded text-text-secondary hover:text-text-primary hover:bg-surface-3 disabled:opacity-30 disabled:pointer-events-none transition-colors";

export function Toolbar({ onShowExport }: ToolbarProps) {
  const project = useEditorStore((s) => s.project);
  const isDirty = useEditorStore((s) => s.isDirty);
  const saveProject = useEditorStore((s) => s.saveProject);
  const lastError = useEditorStore((s) => s.lastError);
  const setError = useEditorStore((s) => s.setError);
  const undo = useEditorStore((s) => s.undo);
  const redo = useEditorStore((s) => s.redo);
  const canUndo = useEditorStore((s) => s.canUndo);
  const canRedo = useEditorStore((s) => s.canRedo);

  // Errors used to sit in the toolbar until clicked; most are transient
  // ("no room to paste here"), so let them fade on their own.
  useEffect(() => {
    if (!lastError) return;
    const id = window.setTimeout(() => setError(null), ERROR_AUTO_DISMISS_MS);
    return () => window.clearTimeout(id);
  }, [lastError, setError]);

  return (
    <div className="flex items-center gap-1 px-3 py-1.5 border-b border-border-subtle bg-surface-2 shrink-0">
      <span className="text-sm font-semibold text-text-primary px-1 truncate max-w-xs" title={project?.name}>
        {project?.name ?? "VideoEditor"}
      </span>
      {isDirty && (
        <span className="h-1.5 w-1.5 rounded-full bg-text-secondary shrink-0" title="Unsaved changes" aria-label="Unsaved changes" />
      )}

      <div className="h-4 w-px bg-border-subtle mx-2" />

      <button onClick={() => undo()} disabled={!canUndo} className={iconButton} title="Undo (Ctrl+Z)" aria-label="Undo">
        <Undo2 size={15} />
      </button>
      <button onClick={() => redo()} disabled={!canRedo} className={iconButton} title="Redo (Ctrl+Y)" aria-label="Redo">
        <Redo2 size={15} />
      </button>

      <div className="flex-1 min-w-4" />

      {lastError && (
        <div role="alert" className="flex items-center gap-2 text-xs text-danger bg-danger/10 border border-danger/20 rounded-md pl-2 pr-1 py-1 max-w-md mr-2">
          <AlertCircle size={13} className="shrink-0" />
          <span className="truncate" title={lastError}>
            {lastError}
          </span>
          <button onClick={() => setError(null)} className="p-0.5 rounded hover:bg-danger/20 shrink-0" aria-label="Dismiss error">
            <X size={12} />
          </button>
        </div>
      )}

      <button
        onClick={() => saveProject()}
        disabled={!project}
        className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-md text-text-secondary hover:text-text-primary hover:bg-surface-3 disabled:opacity-40 transition-colors"
        title="Save (Ctrl+S)"
      >
        <Save size={13} />
        {isDirty ? "Save" : "Saved"}
      </button>
      <button
        onClick={onShowExport}
        disabled={!project}
        className="flex items-center gap-1.5 text-xs px-3 py-1.5 ml-1 rounded-md bg-accent hover:bg-accent-dim text-white disabled:opacity-40 transition-colors"
        title="Export (Ctrl+E)"
      >
        <Download size={13} />
        Export
      </button>
    </div>
  );
}
