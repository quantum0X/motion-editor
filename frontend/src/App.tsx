import { useState, useEffect } from "react";
import { useEditorStore } from "./stores/editorStore";
import { WelcomeScreen } from "./features/projects/WelcomeScreen";
import { LocationSetupScreen } from "./features/projects/LocationSetupScreen";
import { EditorLayout } from "./layouts/EditorLayout";
import { createBackend } from "./services";
import type { AppSettings } from "./types/project";

function App() {
  const project = useEditorStore((s) => s.project);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [isCheckingSettings, setIsCheckingSettings] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const backend = await createBackend();
        const loaded = await backend.getSettings();
        setSettings(loaded);
      } catch {
        // If settings can't be loaded for any reason, fall back to
        // treating setup as already complete rather than blocking the
        // person from using the app at all over a settings-file glitch.
        setSettings({ projectsRootDir: "", hasCompletedSetup: true });
      } finally {
        setIsCheckingSettings(false);
      }
    })();
  }, []);

  if (isCheckingSettings) {
    return <div className="h-screen w-screen bg-surface-0" />;
  }

  if (settings && !settings.hasCompletedSetup) {
    return (
      <LocationSetupScreen
        defaultDir={settings.projectsRootDir}
        onComplete={(updated) => setSettings(updated)}
      />
    );
  }

  return project ? <EditorLayout /> : <WelcomeScreen />;
}

export default App;
