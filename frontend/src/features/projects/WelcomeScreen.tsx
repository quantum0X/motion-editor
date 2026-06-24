import { useState } from "react";
import { Film } from "lucide-react";
import { useEditorStore } from "../../stores/editorStore";

const PRESETS = [
  { label: "1080p · 30fps", width: 1920, height: 1080, fps: 30 },
  { label: "4K · 30fps", width: 3840, height: 2160, fps: 30 },
  { label: "1080p · 60fps", width: 1920, height: 1080, fps: 60 },
  { label: "Vertical 1080×1920", width: 1080, height: 1920, fps: 30 },
];

export function WelcomeScreen() {
  const initNewProject = useEditorStore((s) => s.initNewProject);
  const isLoading = useEditorStore((s) => s.isLoading);
  const [name, setName] = useState("Untitled Project");
  const [presetIdx, setPresetIdx] = useState(0);

  const handleCreate = () => {
    const preset = PRESETS[presetIdx];
    initNewProject(name.trim() || "Untitled Project", preset.width, preset.height, preset.fps);
  };

  return (
    <div className="h-screen w-screen flex items-center justify-center bg-surface-0">
      <div className="w-[380px] space-y-5">
        <div className="flex items-center gap-2 text-text-primary">
          <Film size={20} className="text-accent" />
          <span className="text-base font-semibold">New Project</span>
        </div>

        <div>
          <label className="block text-[11px] text-text-tertiary mb-1.5">Project name</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleCreate()}
            className="w-full px-3 py-2 rounded-md bg-surface-2 border border-border-subtle text-sm text-text-primary outline-none focus:ring-1 focus:ring-accent"
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
  );
}
