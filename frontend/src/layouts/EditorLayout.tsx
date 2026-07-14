import { useState, useCallback, useRef, useEffect } from "react";
import { MenuBar } from "./MenuBar";
import { Toolbar } from "./Toolbar";
import { MediaLibrary } from "../features/media/MediaLibrary";
import { Player } from "../features/player/Player";
import { Timeline } from "../features/timeline/Timeline";
import { NewProjectModal } from "../features/projects/NewProjectModal";
import { OpenProjectModal } from "../features/projects/OpenProjectModal";
import { SettingsModal } from "../features/projects/SettingsModal";
import { ExportPanel } from "../features/export/ExportPanel";
import { PanelErrorBoundary } from "../components/PanelErrorBoundary";

const MEDIA_WIDTH_KEY = "editor-media-library-width";
const TIMELINE_HEIGHT_KEY = "editor-timeline-height";

function loadPersistedNumber(key: string, fallback: number): number {
  try {
    const raw = window.localStorage?.getItem(key);
    if (raw) {
      const n = Number(raw);
      if (Number.isFinite(n)) return n;
    }
  } catch {
    /* ignore - purely a UX nicety */
  }
  return fallback;
}

/**
 * A thin draggable divider. `axis="x"` resizes something to its left by
 * dragging horizontally; `axis="y"` resizes something above it by
 * dragging vertically. Kept intentionally simple (no external resizer
 * library) since only two dividers exist in this layout.
 */
function ResizeHandle({ axis, onResize }: { axis: "x" | "y"; onResize: (deltaPx: number) => void }) {
  const dragging = useRef(false);
  const lastPos = useRef(0);

  useEffect(() => {
    const handleMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      const pos = axis === "x" ? e.clientX : e.clientY;
      const delta = pos - lastPos.current;
      lastPos.current = pos;
      onResize(delta);
    };
    const handleUp = () => {
      dragging.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
    };
  }, [axis, onResize]);

  const handleDown = useCallback(
    (e: React.MouseEvent) => {
      dragging.current = true;
      lastPos.current = axis === "x" ? e.clientX : e.clientY;
      document.body.style.cursor = axis === "x" ? "col-resize" : "row-resize";
      document.body.style.userSelect = "none";
    },
    [axis]
  );

  return (
    <div
      onMouseDown={handleDown}
      className={
        axis === "x"
          ? "w-1 shrink-0 cursor-col-resize hover:bg-accent/50 active:bg-accent transition-colors"
          : "h-1 shrink-0 cursor-row-resize hover:bg-accent/50 active:bg-accent transition-colors"
      }
    />
  );
}

export function EditorLayout() {
  const [showNewProject, setShowNewProject] = useState(false);
  const [showOpenProject, setShowOpenProject] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showExport, setShowExport] = useState(false);

  const [mediaWidth, setMediaWidth] = useState(() => loadPersistedNumber(MEDIA_WIDTH_KEY, 288));
  const [timelineHeight, setTimelineHeight] = useState(() => loadPersistedNumber(TIMELINE_HEIGHT_KEY, 288));

  const handleMediaResize = useCallback((delta: number) => {
    setMediaWidth((w) => {
      const next = Math.min(560, Math.max(200, w + delta));
      try {
        window.localStorage?.setItem(MEDIA_WIDTH_KEY, String(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  const handleTimelineResize = useCallback((delta: number) => {
    // Dragging the handle up (negative deltaY) should grow the timeline,
    // since the timeline sits below it.
    setTimelineHeight((h) => {
      const next = Math.min(window.innerHeight - 200, Math.max(160, h - delta));
      try {
        window.localStorage?.setItem(TIMELINE_HEIGHT_KEY, String(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

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
        <div style={{ width: mediaWidth }} className="shrink-0 min-h-0">
          <PanelErrorBoundary label="media library">
            <MediaLibrary />
          </PanelErrorBoundary>
        </div>
        <ResizeHandle axis="x" onResize={handleMediaResize} />
        <div className="flex-1 min-h-0 min-w-0">
          <PanelErrorBoundary label="preview">
            <Player />
          </PanelErrorBoundary>
        </div>
      </div>
      <ResizeHandle axis="y" onResize={handleTimelineResize} />
      <div style={{ height: timelineHeight }} className="border-t border-border-subtle min-h-0 shrink-0">
        <PanelErrorBoundary label="timeline">
          <Timeline />
        </PanelErrorBoundary>
      </div>

      {showNewProject && <NewProjectModal onClose={() => setShowNewProject(false)} />}
      {showOpenProject && <OpenProjectModal onClose={() => setShowOpenProject(false)} />}
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
      {showExport && <ExportPanel onClose={() => setShowExport(false)} />}
    </div>
  );
}
