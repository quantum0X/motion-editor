import { Toolbar } from "./Toolbar";
import { MediaLibrary } from "../features/media/MediaLibrary";
import { Player } from "../features/player/Player";
import { Timeline } from "../features/timeline/Timeline";

export function EditorLayout() {
  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden">
      <Toolbar />
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
    </div>
  );
}
