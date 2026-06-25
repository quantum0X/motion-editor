import { useState, useEffect, useCallback } from "react";
import { X, FolderOpen } from "lucide-react";
import { createBackend } from "../../services";

interface SettingsModalProps {
  onClose: () => void;
}

/**
 * Lets the person change the projects storage location after first
 * launch (the same underlying setting as LocationSetupScreen, just
 * reachable later from File > Change Projects Location). Changing this
 * only affects where *future* new projects are created - it does not
 * move any existing project folders (see SetProjectsRootDir's doc
 * comment in backend/project/service.go for why).
 */
export function SettingsModal({ onClose }: SettingsModalProps) {
  const [currentDir, setCurrentDir] = useState<string>("");
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedMessage, setSavedMessage] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const backend = await createBackend();
        const dir = await backend.getProjectsRootDir();
        setCurrentDir(dir);
      } catch (e: any) {
        setError(e.message || String(e));
      }
    })();
  }, []);

  const handleBrowse = useCallback(async () => {
    setError(null);
    try {
      const backend = await createBackend();
      const dir = await backend.openDirectoryDialog();
      if (!dir) return;
      setIsSaving(true);
      const settings = await backend.setProjectsRootDir(dir);
      setCurrentDir(settings.projectsRootDir);
      setSavedMessage(true);
      setTimeout(() => setSavedMessage(false), 2000);
    } catch (e: any) {
      setError(e.message || String(e));
    } finally {
      setIsSaving(false);
    }
  }, []);

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60" onMouseDown={onClose}>
      <div className="w-[420px] rounded-lg bg-surface-2 border border-border-strong shadow-2xl p-5" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <span className="text-sm font-semibold text-text-primary">Projects Location</span>
          <button onClick={onClose} className="text-text-tertiary hover:text-text-primary">
            <X size={16} />
          </button>
        </div>

        <p className="text-xs text-text-secondary mb-3 leading-relaxed">
          New projects are created here. Pointing this at a cloud-synced folder (Dropbox, Google
          Drive, etc.) keeps projects available across your devices. Existing projects stay where
          they are — this only affects new ones.
        </p>

        <div className="text-xs text-text-primary bg-surface-1 rounded-md px-3 py-2 font-mono-tabular truncate mb-3">
          {currentDir || "Loading..."}
        </div>

        {error && <div className="text-xs text-danger bg-danger/10 rounded p-2 mb-3">{error}</div>}
        {savedMessage && <div className="text-xs text-accent bg-accent/10 rounded p-2 mb-3">Location updated.</div>}

        <button
          onClick={handleBrowse}
          disabled={isSaving}
          className="w-full flex items-center justify-center gap-2 py-2.5 rounded-md bg-accent hover:bg-accent-dim disabled:opacity-50 text-white text-sm font-medium transition-colors"
        >
          <FolderOpen size={14} />
          {isSaving ? "Saving..." : "Choose New Location..."}
        </button>
      </div>
    </div>
  );
}
