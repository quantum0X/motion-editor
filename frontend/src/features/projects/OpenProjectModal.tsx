import { useState, useEffect } from "react";
import { X, FolderOpen, Clock } from "lucide-react";
import { useEditorStore } from "../../stores/editorStore";
import { createBackend } from "../../services";
import type { RecentEntry } from "../../types/project";

interface OpenProjectModalProps {
  onClose: () => void;
}

export function OpenProjectModal({ onClose }: OpenProjectModalProps) {
  const [recents, setRecents] = useState<RecentEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const backend = await createBackend();
        const list = await backend.recentProjects();
        setRecents(list);
      } catch (e: any) {
        setError(e.message || String(e));
      } finally {
        setIsLoading(false);
      }
    })();
  }, []);

  const handleOpen = async (dir: string) => {
    setError(null);
    try {
      const backend = await createBackend();
      const project = await backend.openProject(dir);
      useEditorStore.getState().setProject(project);
      onClose();
    } catch (e: any) {
      setError(e.message || String(e));
    }
  };

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60" onMouseDown={onClose}>
      <div className="w-[420px] max-h-[70vh] rounded-lg bg-surface-2 border border-border-strong shadow-2xl p-5 flex flex-col" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2 text-text-primary">
            <FolderOpen size={18} className="text-accent" />
            <span className="text-sm font-semibold">Open Project</span>
          </div>
          <button onClick={onClose} className="text-text-tertiary hover:text-text-primary">
            <X size={16} />
          </button>
        </div>

        {error && <div className="text-xs text-danger bg-danger/10 rounded p-2 mb-3">{error}</div>}

        <div className="flex-1 overflow-y-auto space-y-1 -mx-1 px-1">
          {isLoading && <div className="text-xs text-text-tertiary text-center py-8">Loading...</div>}

          {!isLoading && recents.length === 0 && (
            <div className="text-xs text-text-tertiary text-center py-8">No recent projects yet.</div>
          )}

          {recents.map((entry) => (
            <button
              key={entry.projectDir}
              onClick={() => handleOpen(entry.projectDir)}
              className="w-full flex items-center gap-3 p-2.5 rounded-md hover:bg-surface-3 transition-colors text-left"
            >
              <div className="w-9 h-9 rounded bg-surface-1 flex items-center justify-center shrink-0">
                <FolderOpen size={15} className="text-text-tertiary" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm text-text-primary truncate">{entry.name}</div>
                <div className="text-[11px] text-text-tertiary truncate font-mono-tabular">{entry.projectDir}</div>
              </div>
              <div className="flex items-center gap-1 text-text-tertiary text-[11px] shrink-0">
                <Clock size={10} />
                {new Date(entry.lastOpened).toLocaleDateString()}
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
