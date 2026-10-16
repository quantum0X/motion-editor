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
import { ShortcutsModal } from "./ShortcutsModal";
import { useEditorShortcuts } from "./useEditorShortcuts";
import { useEditorStore } from "../stores/editorStore";

const MEDIA_WIDTH_KEY = "editor-media-library-width";
const TIMELINE_HEIGHT_KEY = "editor-timeline-height";
const AUTOSAVE_INTERVAL_MS = 60_000;

function persistNumber(key: string, value: number) {
  try {
    window.localStorage?.setItem(key, String(value));
  } catch {
    /* ignore - purely a UX nicety */
  }
}

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
function ResizeHandle({ axis, onResize, onResizeEnd }: { axis: "x" | "y"; onResize: (deltaPx: number) => void; onResizeEnd: () => void }) {
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
      if (!dragging.current) return;
      dragging.current = false;
      onResizeEnd();
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
    };
  }, [axis, onResize, onResizeEnd]);

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
      role="separator"
      aria-orientation={axis === "x" ? "vertical" : "horizontal"}
      className={
        axis === "x"
          ? "w-1 shrink-0 cursor-col-resize bg-border-subtle hover:bg-accent/60 active:bg-accent transition-colors"
          : "h-1 shrink-0 cursor-row-resize bg-border-subtle hover:bg-accent/60 active:bg-accent transition-colors"
      }
    />
  );
}

interface WailsDropRuntime {
  OnFileDrop?: (callback: (x: number, y: number, paths: string[]) => void, useDropTarget: boolean) => void;
  OnFileDropOff?: () => void;
}

export function EditorLayout() {
  const [showNewProject, setShowNewProject] = useState(false);
  const [showOpenProject, setShowOpenProject] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);

  const [mediaWidth, setMediaWidth] = useState(() => loadPersistedNumber(MEDIA_WIDTH_KEY, 288));
  const [timelineHeight, setTimelineHeight] = useState(() => loadPersistedNumber(TIMELINE_HEIGHT_KEY, 288));

  const handleMediaResize = useCallback((delta: number) => {
    setMediaWidth((w) => Math.min(560, Math.max(200, w + delta)));
  }, []);

  const handleTimelineResize = useCallback((delta: number) => {
    // Dragging the handle up (negative deltaY) should grow the timeline,
    // since the timeline sits below it.
    setTimelineHeight((h) => Math.min(window.innerHeight - 200, Math.max(160, h - delta)));
  }, []);

  // Persist sizes once per drag rather than on every mousemove.
  const mediaWidthRef = useRef(mediaWidth);
  const timelineHeightRef = useRef(timelineHeight);
  useEffect(() => {
    mediaWidthRef.current = mediaWidth;
    timelineHeightRef.current = timelineHeight;
  });
  const persistMediaWidth = useCallback(() => persistNumber(MEDIA_WIDTH_KEY, mediaWidthRef.current), []);
  const persistTimelineHeight = useCallback(() => persistNumber(TIMELINE_HEIGHT_KEY, timelineHeightRef.current), []);

  useEditorShortcuts({
    onNewProject: () => setShowNewProject(true),
    onOpenProject: () => setShowOpenProject(true),
    onExport: () => setShowExport(true),
    onShowShortcuts: () => setShowShortcuts(true),
  });

  // Periodic crash-recovery autosave (writes <project>/cache/autosave.json,
  // separate from the real project file) while there are unsaved changes.
  useEffect(() => {
    const id = window.setInterval(() => useEditorStore.getState().autoSave(), AUTOSAVE_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, []);

  // Native file drops (Wails only): the webview's own HTML drop events
  // only expose sandboxed File objects without real paths, which the Go
  // importer can't read - Wails' OnFileDrop delivers absolute paths.
  useEffect(() => {
    const runtime = (window as { runtime?: WailsDropRuntime }).runtime;
    if (!runtime?.OnFileDrop) return;
    runtime.OnFileDrop((_x, _y, paths) => {
      if (paths.length > 0) useEditorStore.getState().importFiles(paths);
    }, false);
    return () => runtime.OnFileDropOff?.();
  }, []);

  return (
    <div className="relative flex flex-col h-screen w-screen overflow-hidden">
      <MenuBar
        onShowExport={() => setShowExport(true)}
        onShowSettings={() => setShowSettings(true)}
        onShowNewProject={() => setShowNewProject(true)}
        onShowOpenProject={() => setShowOpenProject(true)}
        onShowShortcuts={() => setShowShortcuts(true)}
      />
      <Toolbar onShowExport={() => setShowExport(true)} />
      <div className="flex flex-1 min-h-0">
        <div style={{ width: mediaWidth }} className="shrink-0 min-h-0">
          <PanelErrorBoundary label="media library">
            <MediaLibrary />
          </PanelErrorBoundary>
        </div>
        <ResizeHandle axis="x" onResize={handleMediaResize} onResizeEnd={persistMediaWidth} />
        <div className="flex-1 min-h-0 min-w-0">
          <PanelErrorBoundary label="preview">
            <Player />
          </PanelErrorBoundary>
        </div>
      </div>
      <ResizeHandle axis="y" onResize={handleTimelineResize} onResizeEnd={persistTimelineHeight} />
      <div style={{ height: timelineHeight }} className="min-h-0 shrink-0">
        <PanelErrorBoundary label="timeline">
          <Timeline />
        </PanelErrorBoundary>
      </div>

      {showNewProject && <NewProjectModal onClose={() => setShowNewProject(false)} />}
      {showOpenProject && <OpenProjectModal onClose={() => setShowOpenProject(false)} />}
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
      {showExport && <ExportPanel onClose={() => setShowExport(false)} />}
      {showShortcuts && <ShortcutsModal onClose={() => setShowShortcuts(false)} />}
    </div>
  );
}
