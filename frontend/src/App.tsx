import { useEditorStore } from "./stores/editorStore";
import { WelcomeScreen } from "./features/projects/WelcomeScreen";
import { EditorLayout } from "./layouts/EditorLayout";

function App() {
  const project = useEditorStore((s) => s.project);
  return project ? <EditorLayout /> : <WelcomeScreen />;
}

export default App;
