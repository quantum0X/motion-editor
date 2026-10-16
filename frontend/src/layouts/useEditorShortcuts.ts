import { useEffect, useRef } from "react";
import { useEditorStore, timelineDurationSec } from "../stores/editorStore";

interface ShortcutHandlers {
  onNewProject: () => void;
  onOpenProject: () => void;
  onExport: () => void;
  onShowShortcuts: () => void;
}

/** Every editor shortcut, for the Help menu - keep in sync with the handler below. */
export const SHORTCUTS: { keys: string; action: string }[] = [
  { keys: "Space", action: "Play / pause" },
  { keys: "← / →", action: "Step one frame (Shift: one second)" },
  { keys: "Home / End", action: "Jump to start / end" },
  { keys: "S", action: "Split selected clip at playhead" },
  { keys: "Del / Backspace", action: "Delete selected clip" },
  { keys: "Ctrl+C / Ctrl+V", action: "Copy clip / paste at playhead" },
  { keys: "Ctrl+D", action: "Duplicate selected clip" },
  { keys: "Ctrl+Z / Ctrl+Y", action: "Undo / redo" },
  { keys: "Ctrl+S", action: "Save project" },
  { keys: "Ctrl+N / Ctrl+O", action: "New / open project" },
  { keys: "Ctrl+E", action: "Export" },
  { keys: "Ctrl+= / Ctrl+-", action: "Zoom timeline in / out" },
  { keys: "Ctrl+Scroll", action: "Zoom timeline at cursor" },
  { keys: "Esc", action: "Deselect / close dialog" },
  { keys: "?", action: "Show this list" },
];

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT";
}

/**
 * One window-level keyboard handler for the whole editor. Previously the
 * Player and Timeline each registered their own, re-subscribing on every
 * playhead change during playback (60x/second) and leaving most of the
 * shortcuts the menus advertise (Ctrl+S/N/O/E, zoom) unimplemented.
 *
 * All state is read via getState() at key time, so this registers once.
 */
export function useEditorShortcuts(handlers: ShortcutHandlers) {
  const handlersRef = useRef(handlers);
  useEffect(() => {
    handlersRef.current = handlers;
  });

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      // Dialogs own the keyboard while open (they handle Escape themselves).
      if (document.querySelector('[role="dialog"]')) return;

      const s = useEditorStore.getState();
      if (!s.project) return;
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      const handled = () => e.preventDefault();

      if (mod) {
        switch (key) {
          case "z":
            handled();
            if (e.shiftKey) s.redo();
            else s.undo();
            return;
          case "y":
            handled();
            s.redo();
            return;
          case "s":
            handled();
            s.saveProject();
            return;
          case "n":
            handled();
            handlersRef.current.onNewProject();
            return;
          case "o":
            handled();
            handlersRef.current.onOpenProject();
            return;
          case "e":
            handled();
            handlersRef.current.onExport();
            return;
          case "d":
            if (s.selectedClipId) {
              handled();
              s.duplicateSelectedClip();
            }
            return;
          case "c":
            if (s.selectedClipId) {
              handled();
              s.copySelectedClip();
            }
            return;
          case "v":
            if (s.clipboard) {
              handled();
              s.pasteAtPlayhead();
            }
            return;
          case "=":
          case "+":
            handled();
            s.setZoom(s.pixelsPerSecond * 1.4);
            return;
          case "-":
            handled();
            s.setZoom(s.pixelsPerSecond / 1.4);
            return;
          case "0":
            handled();
            s.setZoom(60);
            return;
        }
        return;
      }

      const fps = s.project.fps || 30;
      switch (e.key) {
        case " ":
          handled();
          // A focused button would otherwise also "click" on keyup.
          if (document.activeElement instanceof HTMLButtonElement) document.activeElement.blur();
          s.togglePlay();
          return;
        case "ArrowLeft":
        case "ArrowRight": {
          handled();
          const step = e.shiftKey ? 1 : 1 / fps;
          s.setIsPlaying(false);
          s.setPlayhead(s.playheadSec + (e.key === "ArrowLeft" ? -step : step));
          return;
        }
        case "Home":
          handled();
          s.setPlayhead(0);
          return;
        case "End":
          handled();
          s.setPlayhead(timelineDurationSec(s.project));
          return;
        case "s":
        case "S":
          if (s.selectedClipId) {
            handled();
            s.splitClipAt(s.selectedClipId, s.playheadSec);
          }
          return;
        case "Delete":
        case "Backspace":
          if (s.selectedClipId || s.selectedTextClipId) {
            handled();
            s.deleteSelection();
          }
          return;
        case "Escape":
          s.clearSelection();
          return;
        case "?":
          handled();
          handlersRef.current.onShowShortcuts();
          return;
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
