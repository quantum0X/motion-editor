import { useState, useCallback } from "react";
import { Film } from "lucide-react";
import { MenuDropdown, type MenuItemDef } from "./MenuDropdown";
import { useEditorStore } from "../stores/editorStore";
import { createBackend } from "../services";

interface MenuBarProps {
  onShowExport: () => void;
  onShowSettings: () => void;
  onShowNewProject: () => void;
  onShowOpenProject: () => void;
  onShowShortcuts: () => void;
}

/**
 * The application's top menu bar, rendered in-app (same look on every
 * platform) rather than as a native OS menu - matches how the rest of
 * this editor's chrome is built, and avoids the extra Wails menu-API
 * surface for something this app-specific.
 *
 * Each menu's actions call directly into useEditorStore where an action
 * already exists; a few (Settings, New/Open dialogs) are passed in as
 * callbacks since they're owned by EditorLayout's local UI state rather
 * than global store state.
 */
export function MenuBar({ onShowExport, onShowSettings, onShowNewProject, onShowOpenProject, onShowShortcuts }: MenuBarProps) {
  const [openMenu, setOpenMenu] = useState<string | null>(null);

  const project = useEditorStore((s) => s.project);
  const selectedClipId = useEditorStore((s) => s.selectedClipId);
  const selectedTextClipId = useEditorStore((s) => s.selectedTextClipId);
  const saveProject = useEditorStore((s) => s.saveProject);
  const splitClipAt = useEditorStore((s) => s.splitClipAt);
  const deleteSelection = useEditorStore((s) => s.deleteSelection);
  const copySelectedClip = useEditorStore((s) => s.copySelectedClip);
  const pasteAtPlayhead = useEditorStore((s) => s.pasteAtPlayhead);
  const hasClipboard = useEditorStore((s) => s.clipboard !== null);
  const duplicateSelectedClip = useEditorStore((s) => s.duplicateSelectedClip);
  const setZoom = useEditorStore((s) => s.setZoom);
  const pixelsPerSecond = useEditorStore((s) => s.pixelsPerSecond);
  const undo = useEditorStore((s) => s.undo);
  const redo = useEditorStore((s) => s.redo);
  const canUndo = useEditorStore((s) => s.canUndo);
  const canRedo = useEditorStore((s) => s.canRedo);

  const handleOpen = useCallback((menu: string) => setOpenMenu(menu), []);
  const handleClose = useCallback(() => setOpenMenu(null), []);

  const handleSaveAs = useCallback(async () => {
    const name = window.prompt("Save project as:", project?.name ? `${project.name} copy` : "Untitled Project copy");
    if (!name) return;
    try {
      const backend = await createBackend();
      let parentDir: string | undefined;
      if (window.confirm("Choose a custom save location for this copy? (Cancel keeps the default Projects folder.)")) {
        parentDir = await backend.openDirectoryDialog();
      }
      const updated = await backend.saveProjectAs(name, parentDir);
      useEditorStore.getState().setProject(updated);
      useEditorStore.setState({ isDirty: false });
    } catch (e) {
      useEditorStore.getState().setError(e instanceof Error ? e.message : String(e));
    }
  }, [project]);

  const handleRevealProjectFolder = useCallback(async () => {
    try {
      const backend = await createBackend();
      await backend.revealInFileManager("");
    } catch (e) {
      useEditorStore.getState().setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const fileMenu: MenuItemDef[] = [
    { label: "New Project...", shortcut: "Ctrl+N", onClick: onShowNewProject },
    { label: "Open Project...", shortcut: "Ctrl+O", onClick: onShowOpenProject },
    { divider: true, label: "" },
    { label: "Save", shortcut: "Ctrl+S", onClick: () => saveProject(), disabled: !project },
    { label: "Save As...", onClick: handleSaveAs, disabled: !project },
    { divider: true, label: "" },
    { label: "Export...", shortcut: "Ctrl+E", onClick: onShowExport, disabled: !project },
    { divider: true, label: "" },
    { label: "Show Project Folder", onClick: handleRevealProjectFolder, disabled: !project },
    { label: "Change Projects Location...", onClick: onShowSettings },
  ];

  const editMenu: MenuItemDef[] = [
    { label: "Undo", shortcut: "Ctrl+Z", disabled: !canUndo, onClick: () => undo() },
    { label: "Redo", shortcut: "Ctrl+Y", disabled: !canRedo, onClick: () => redo() },
    { divider: true, label: "" },
    {
      label: "Split at Playhead",
      shortcut: "S",
      disabled: !selectedClipId,
      // Read at click time - subscribing to playheadSec here would re-render
      // the whole menu bar every frame during playback.
      onClick: () => selectedClipId && splitClipAt(selectedClipId, useEditorStore.getState().playheadSec),
    },
    { divider: true, label: "" },
    { label: "Copy", shortcut: "Ctrl+C", disabled: !selectedClipId, onClick: () => copySelectedClip() },
    { label: "Paste at Playhead", shortcut: "Ctrl+V", disabled: !hasClipboard, onClick: () => pasteAtPlayhead() },
    {
      label: "Duplicate",
      shortcut: "Ctrl+D",
      disabled: !selectedClipId,
      onClick: () => duplicateSelectedClip(),
    },
    {
      label: "Delete",
      shortcut: "Del",
      disabled: !selectedClipId && !selectedTextClipId,
      danger: true,
      onClick: () => deleteSelection(),
    },
  ];

  const viewMenu: MenuItemDef[] = [
    { label: "Zoom In", shortcut: "Ctrl+=", onClick: () => setZoom(pixelsPerSecond * 1.4) },
    { label: "Zoom Out", shortcut: "Ctrl+-", onClick: () => setZoom(pixelsPerSecond / 1.4) },
    { label: "Reset Zoom", shortcut: "Ctrl+0", onClick: () => setZoom(60) },
  ];

  const helpMenu: MenuItemDef[] = [
    { label: "Keyboard Shortcuts", shortcut: "?", onClick: onShowShortcuts },
    { label: "About VideoEditor", onClick: () => window.alert("VideoEditor — built with Wails + React") },
  ];

  return (
    <div className="flex items-center gap-1 px-2 py-1 bg-surface-0 border-b border-border-subtle shrink-0">
      <Film size={14} className="text-accent mr-1" />
      <MenuDropdown label="File" items={fileMenu} isOpen={openMenu === "file"} onOpen={() => handleOpen("file")} onClose={handleClose} />
      <MenuDropdown label="Edit" items={editMenu} isOpen={openMenu === "edit"} onOpen={() => handleOpen("edit")} onClose={handleClose} />
      <MenuDropdown label="View" items={viewMenu} isOpen={openMenu === "view"} onOpen={() => handleOpen("view")} onClose={handleClose} />
      <MenuDropdown label="Help" items={helpMenu} isOpen={openMenu === "help"} onOpen={() => handleOpen("help")} onClose={handleClose} />
    </div>
  );
}
