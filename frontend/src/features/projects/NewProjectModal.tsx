import { useState } from "react";
import { X, Film } from "lucide-react";
import { useEditorStore } from "../../stores/editorStore";

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
 */
export function NewProjectModal({ onClose }: NewProjectModalProps) {
  const initNewProject = useEditorStore((s) => s.initNewProject);
  const isLoading = useEditorStore((s) => s.isLoading);
  const [name, setName] = useState("Untitled Project");
  const [presetIdx, setPresetIdx] = useState(0);

  const handleCreate = async () => {
    const preset = PRESETS[presetIdx];
    await initNewProject(name.trim() || "Untitled Project", preset.width, preset.height, preset.fps);
    onClose();
  };

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60" onMouseDown={onClose}>
      <div className="w-[380px] rounded-lg bg-surface-2 border border-border-strong shadow-2xl p-5" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2 text-text-primary">
            <Film size={18} className="text-accent" />
            <span className="text-sm font-semibold">New Project</span>
          </div>
          <button onClick={onClose} className="text-text-tertiary hover:text-text-primary">
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
    </div>
  );
}
