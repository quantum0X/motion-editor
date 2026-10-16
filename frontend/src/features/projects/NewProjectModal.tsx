import { useState, useEffect, useCallback } from "react";
import { X, Film, FolderOpen, Clock, FolderInput } from "lucide-react";
import { useEditorStore, confirmDiscardUnsaved } from "../../stores/editorStore";
import { createBackend } from "../../services";
import type { RecentEntry } from "../../types/project";
import { Modal } from "../../components/Modal";

interface NewProjectModalProps {
  onClose: () => void;
}

const PRESETS = [
  { label: "1080p · 30fps", width: 1920, height: 1080, fps: 30 },
  { label: "4K · 30fps", width: 3840, height: 2160, fps: 30 },
  { label: "1080p · 60fps", width: 1920, height: 1080, fps: 60 },
  { label: "Vertical 1080×1920", width: 1080, height: 1920, fps: 30 },
];

/**
 * Same project-creation logic as WelcomeScreen, but rendered as a modal
 * overlay for the "File > New Project" menu action when a project is
 * already open - WelcomeScreen itself stays full-screen-only, for the
 * very first app launch before any project exists.
 *
 * Also shows a Recent Projects column so switching to a different
 * existing project is one click away from the same screen, without
 * making the person hunt for File > Open Project separately.
 */
export function NewProjectModal({ onClose }: NewProjectModalProps) {
  const initNewProject = useEditorStore((s) => s.initNewProject);
  const openProjectFrom = useEditorStore((s) => s.openProjectFrom);
  const isLoading = useEditorStore((s) => s.isLoading);
  const [name, setName] = useState("Untitled Project");
  const [presetIdx, setPresetIdx] = useState(0);
  const [location, setLocation] = useState("");
  const [defaultLocation, setDefaultLocation] = useState("");
  const [recents, setRecents] = useState<RecentEntry[]>([]);
  const [recentsLoading, setRecentsLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const backend = await createBackend();
        const [dir, recentList] = await Promise.all([backend.getProjectsRootDir(), backend.recentProjects()]);
        setDefaultLocation(dir);
        setLocation(dir);
        setRecents(recentList);
      } catch {
        /* non-fatal - the location field/recents list just stays empty */
      } finally {
        setRecentsLoading(false);
      }
    })();
  }, []);

  const handleBrowse = useCallback(async () => {
    try {
      const backend = await createBackend();
      const dir = await backend.openDirectoryDialog();
      if (dir) setLocation(dir);
    } catch (e) {
      useEditorStore.getState().setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const handleCreate = async () => {
    if (!confirmDiscardUnsaved()) return;
    const preset = PRESETS[presetIdx];
    // Only pass a custom parentDir when it differs from the app's
    // configured default - avoids sending a redundant override for the
    // common case where nobody touched the location field.
    const parentDir = location && location !== defaultLocation ? location : undefined;
    await initNewProject(name.trim() || "Untitled Project", preset.width, preset.height, preset.fps, parentDir);
    onClose();
  };

  const handleOpenRecent = async (dir: string) => {
    if (!confirmDiscardUnsaved()) return;
    await openProjectFrom(dir);
    onClose();
  };

  return (
    <Modal onClose={onClose}>
      <div className="w-[760px] max-h-[80vh] rounded-lg bg-surface-2 border border-border-strong shadow-2xl flex overflow-hidden">
        {/* Left: new project form */}
        <div className="w-[380px] shrink-0 p-5 border-r border-border-subtle overflow-y-auto">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2 text-text-primary">
              <Film size={18} className="text-accent" />
              <span className="text-sm font-semibold">New Project</span>
            </div>
            <button onClick={onClose} className="text-text-tertiary hover:text-text-primary lg:hidden">
              <X size={16} />
            </button>
          </div>

          <div className="space-y-4">
            <div>
              <label className="block text-[11px] text-text-tertiary mb-1.5">Project name</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleCreate()}
                className="w-full px-3 py-2 rounded-md bg-surface-1 border border-border-subtle text-sm text-text-primary outline-none focus:ring-1 focus:ring-accent"
                autoFocus
              />
            </div>

            <div>
              <label className="block text-[11px] text-text-tertiary mb-1.5">Save location</label>
              <div className="flex gap-1.5">
                <input
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                  placeholder={defaultLocation}
                  className="flex-1 min-w-0 px-3 py-2 rounded-md bg-surface-1 border border-border-subtle text-xs text-text-primary font-mono-tabular outline-none focus:ring-1 focus:ring-accent truncate"
                  title={location}
                />
                <button
                  onClick={handleBrowse}
                  title="Choose folder"
                  className="shrink-0 px-2.5 rounded-md bg-surface-3 hover:bg-border-strong text-text-secondary hover:text-text-primary transition-colors"
                >
                  <FolderInput size={14} />
                </button>
              </div>
              {location && location !== defaultLocation && (
                <p className="mt-1 text-[10px] text-accent">Saving here instead of the default Projects folder</p>
              )}
            </div>

            <div>
              <label className="block text-[11px] text-text-tertiary mb-1.5">Resolution & frame rate</label>
              <div className="grid grid-cols-2 gap-1.5">
                {PRESETS.map((preset, idx) => (
                  <button
                    key={preset.label}
                    onClick={() => setPresetIdx(idx)}
                    className={`text-xs py-2 rounded-md border transition-colors ${
                      presetIdx === idx
                        ? "border-accent bg-accent/10 text-text-primary"
                        : "border-border-subtle text-text-secondary hover:border-border-strong"
                    }`}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            </div>

            <button
              onClick={handleCreate}
              disabled={isLoading}
              className="w-full py-2.5 rounded-md bg-accent hover:bg-accent-dim disabled:opacity-50 text-white text-sm font-medium transition-colors"
            >
              {isLoading ? "Creating..." : "Create Project"}
            </button>
          </div>
        </div>

        {/* Right: recent projects */}
        <div className="flex-1 min-w-0 p-5 flex flex-col">
          <div className="flex items-center justify-between mb-4">
            <span className="text-sm font-semibold text-text-primary">Recent Projects</span>
            <button onClick={onClose} className="text-text-tertiary hover:text-text-primary">
              <X size={16} />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto space-y-1 -mx-1 px-1">
            {recentsLoading && <div className="text-xs text-text-tertiary text-center py-8">Loading...</div>}

            {!recentsLoading && recents.length === 0 && (
              <div className="flex flex-col items-center justify-center text-center gap-2 text-text-tertiary text-xs py-10 px-3">
                <FolderOpen size={20} />
                <p>Projects you create or open will show up here.</p>
              </div>
            )}

            {recents.map((entry) => (
              <button
                key={entry.projectDir}
                onClick={() => handleOpenRecent(entry.projectDir)}
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
    </Modal>
  );
}
