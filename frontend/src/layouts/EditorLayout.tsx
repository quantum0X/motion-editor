import { useState } from "react";
import { MenuBar } from "./MenuBar";
import { Toolbar } from "./Toolbar";
import { MediaLibrary } from "../features/media/MediaLibrary";
import { Player } from "../features/player/Player";
import { Timeline } from "../features/timeline/Timeline";
import { NewProjectModal } from "../features/projects/NewProjectModal";
import { OpenProjectModal } from "../features/projects/OpenProjectModal";
import { SettingsModal } from "../features/projects/SettingsModal";
import { ExportPanel } from "../features/export/ExportPanel";

export function EditorLayout() {
  const [showNewProject, setShowNewProject] = useState(false);
  const [showOpenProject, setShowOpenProject] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showExport, setShowExport] = useState(false);

  return (
    <div className="relative flex flex-col h-screen w-screen overflow-hidden">
      <MenuBar
        onShowExport={() => setShowExport(true)}
        onShowSettings={() => setShowSettings(true)}
        onShowNewProject={() => setShowNewProject(true)}
        onShowOpenProject={() => setShowOpenProject(true)}
      />
      <Toolbar onShowExport={() => setShowExport(true)} />
      <div className="flex flex-1 min-h-0">
        <div className="w-72 shrink-0 min-h-0">
          <MediaLibrary />
        </div>
        <div className="flex-1 min-h-0 min-w-0">
          <Player />
        </div>
      </div>
      <div className="h-72 border-t border-border-subtle min-h-0">
        <Timeline />
      </div>

      {showNewProject && <NewProjectModal onClose={() => setShowNewProject(false)} />}
      {showOpenProject && <OpenProjectModal onClose={() => setShowOpenProject(false)} />}
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
      {showExport && <ExportPanel onClose={() => setShowExport(false)} />}
    </div>
  );
}
