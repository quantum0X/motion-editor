import { useState, useCallback } from "react";
import { FolderOpen, HardDrive, Cloud } from "lucide-react";
import { createBackend } from "../../services";
import type { AppSettings } from "../../types/project";

interface LocationSetupScreenProps {
  defaultDir: string;
  onComplete: (settings: AppSettings) => void;
}

/**
 * Shown once, on first launch (gated by AppSettings.hasCompletedSetup -
 * see backend/project/service.go). Lets the person choose where project
 * folders, assets, caches, and thumbnails live on disk. Pointing this at
 * a folder that's already synced by Dropbox/Google Drive/iCloud Drive/
 * OneDrive is how project.json and its assets end up shared across
 * devices - this app has no server-side sync of its own, so the sync
 * mechanism is "whatever the OS/cloud-drive client already does to this
 * folder."
 */
export function LocationSetupScreen({ defaultDir, onComplete }: LocationSetupScreenProps) {
  const [chosenDir, setChosenDir] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleBrowse = useCallback(async () => {
    setError(null);
    try {
      const backend = await createBackend();
      const dir = await backend.openDirectoryDialog();
      if (dir) setChosenDir(dir);
    } catch (e: any) {
      setError(e.message || String(e));
    }
  }, []);

  const handleUseDefault = useCallback(() => {
    setChosenDir(defaultDir);
  }, [defaultDir]);

  const handleConfirm = useCallback(async () => {
    const dir = chosenDir || defaultDir;
    setIsSaving(true);
    setError(null);
    try {
      const backend = await createBackend();
      const settings = await backend.setProjectsRootDir(dir);
      onComplete(settings);
    } catch (e: any) {
      setError(e.message || String(e));
      setIsSaving(false);
    }
  }, [chosenDir, defaultDir, onComplete]);

  return (
    <div className="h-screen w-screen flex items-center justify-center bg-surface-0">
      <div className="w-[440px] space-y-5">
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-text-primary">
            <FolderOpen size={20} className="text-accent" />
            <span className="text-base font-semibold">Where should your projects live?</span>
          </div>
          <p className="text-sm text-text-secondary leading-relaxed">
            Every project (video files references, captions, edit history) is stored as plain
            files in this folder. Choose a folder inside Dropbox, Google Drive, iCloud Drive, or
            OneDrive to keep your projects in sync across devices — or use the default local
            folder if you don't need that.
          </p>
        </div>

        <div className="space-y-2">
          <button
            onClick={handleBrowse}
            className="w-full flex items-center gap-3 p-3 rounded-md border border-border-subtle hover:border-border-strong bg-surface-2 transition-colors text-left"
          >
            <Cloud size={18} className="text-accent shrink-0" />
            <div>
              <div className="text-sm text-text-primary font-medium">Choose a folder…</div>
              <div className="text-xs text-text-tertiary">Pick any folder, e.g. inside a cloud-synced drive</div>
            </div>
          </button>

          <button
            onClick={handleUseDefault}
            className="w-full flex items-center gap-3 p-3 rounded-md border border-border-subtle hover:border-border-strong bg-surface-2 transition-colors text-left"
          >
            <HardDrive size={18} className="text-text-secondary shrink-0" />
            <div>
              <div className="text-sm text-text-primary font-medium">Use the default location</div>
              <div className="text-xs text-text-tertiary font-mono-tabular truncate">{defaultDir}</div>
            </div>
          </button>
        </div>

        {chosenDir && (
          <div className="text-xs text-text-secondary bg-surface-2 rounded-md px-3 py-2 font-mono-tabular truncate">
            Selected: {chosenDir}
          </div>
        )}

        {error && <div className="text-xs text-danger bg-danger/10 rounded p-2">{error}</div>}

        <button
          onClick={handleConfirm}
          disabled={isSaving}
          className="w-full py-2.5 rounded-md bg-accent hover:bg-accent-dim disabled:opacity-50 text-white text-sm font-medium transition-colors"
        >
          {isSaving ? "Saving..." : "Continue"}
        </button>

        <p className="text-[11px] text-text-tertiary text-center">
          You can change this later from the settings menu.
        </p>
      </div>
    </div>
  );
}
