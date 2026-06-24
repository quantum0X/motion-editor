import { useState } from "react";
import { Save, Download, Undo2, Redo2 } from "lucide-react";
import { useEditorStore } from "../stores/editorStore";
import { ExportPanel } from "../features/export/ExportPanel";

export function Toolbar() {
  const project = useEditorStore((s) => s.project);
  const saveProject = useEditorStore((s) => s.saveProject);
  const lastError = useEditorStore((s) => s.lastError);
  const setError = useEditorStore((s) => s.setError);
  const [showExport, setShowExport] = useState(false);

  return (
    <>
      <div className="flex items-center gap-3 px-3 py-2 border-b border-border-subtle bg-surface-2 shrink-0">
        <span className="text-sm font-semibold text-text-primary px-1">{project?.name ?? "VideoEditor"}</span>

        <div className="h-4 w-px bg-border-subtle" />

        {/* Undo/redo are wired to a history stack in a later pass; shown
            here disabled so the toolbar layout doesn't shift later. */}
        <button disabled className="text-text-tertiary opacity-40" title="Undo (Ctrl+Z) — coming in a later phase">
          <Undo2 size={15} />
        </button>
        <button disabled className="text-text-tertiary opacity-40" title="Redo (Ctrl+Y) — coming in a later phase">
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
          onClick={() => setShowExport(true)}
          disabled={!project}
          className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md bg-accent hover:bg-accent-dim text-white disabled:opacity-40 transition-colors"
        >
          <Download size={13} />
          Export
        </button>
      </div>

      {showExport && <ExportPanel onClose={() => setShowExport(false)} />}
    </>
  );
}
