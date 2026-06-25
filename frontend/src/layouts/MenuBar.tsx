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
export function MenuBar({ onShowExport, onShowSettings, onShowNewProject, onShowOpenProject }: MenuBarProps) {
  const [openMenu, setOpenMenu] = useState<string | null>(null);

  const project = useEditorStore((s) => s.project);
  const selectedClipId = useEditorStore((s) => s.selectedClipId);
  const selectedTextClipId = useEditorStore((s) => s.selectedTextClipId);
  const saveProject = useEditorStore((s) => s.saveProject);
  const splitClipAt = useEditorStore((s) => s.splitClipAt);
  const playheadSec = useEditorStore((s) => s.playheadSec);
  const deleteSelectedClip = useEditorStore((s) => s.deleteSelectedClip);
  const deleteSelectedTextClip = useEditorStore((s) => s.deleteSelectedTextClip);
  const duplicateSelectedClip = useEditorStore((s) => s.duplicateSelectedClip);
  const setZoom = useEditorStore((s) => s.setZoom);
  const pixelsPerSecond = useEditorStore((s) => s.pixelsPerSecond);

  const handleOpen = useCallback((menu: string) => setOpenMenu(menu), []);
  const handleClose = useCallback(() => setOpenMenu(null), []);

  const handleSaveAs = useCallback(async () => {
    const name = window.prompt("Save project as:", project?.name ? `${project.name} copy` : "Untitled Project copy");
    if (!name) return;
    try {
      const backend = await createBackend();
      const updated = await backend.saveProjectAs(name);
      useEditorStore.getState().setProject(updated);
    } catch (e: any) {
      useEditorStore.getState().setError(e.message || String(e));
    }
  }, [project]);

  const handleRevealProjectFolder = useCallback(async () => {
    // Best-effort: not every platform/Wails version exposes a direct
    // "reveal in file manager" runtime call in this app's current
    // bindings, so this surfaces the path for the person to navigate to
    // manually rather than silently doing nothing.
    try {
      const backend = await createBackend();
      const dir = await backend.getProjectsRootDir();
      window.alert(`Projects are stored in:\n${dir}`);
    } catch (e: any) {
      useEditorStore.getState().setError(e.message || String(e));
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
    { label: "Show Project Folder", onClick: handleRevealProjectFolder },
    { label: "Change Projects Location...", onClick: onShowSettings },
  ];

  const editMenu: MenuItemDef[] = [
    { label: "Undo", shortcut: "Ctrl+Z", disabled: true },
    { label: "Redo", shortcut: "Ctrl+Y", disabled: true },
    { divider: true, label: "" },
    {
      label: "Split at Playhead",
      shortcut: "S",
      disabled: !selectedClipId,
      onClick: () => selectedClipId && splitClipAt(selectedClipId, playheadSec),
    },
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
      onClick: () => {
        if (selectedClipId) deleteSelectedClip();
        if (selectedTextClipId) deleteSelectedTextClip();
      },
    },
  ];

  const viewMenu: MenuItemDef[] = [
    { label: "Zoom In", shortcut: "Ctrl++", onClick: () => setZoom(pixelsPerSecond * 1.4) },
    { label: "Zoom Out", shortcut: "Ctrl+-", onClick: () => setZoom(pixelsPerSecond / 1.4) },
    { label: "Reset Zoom", onClick: () => setZoom(60) },
  ];

  const projectMenu: MenuItemDef[] = [
    { label: "Project Settings...", disabled: !project, onClick: () => window.alert("Project settings panel coming in a later phase.") },
    { label: "Canvas Resolution & FPS", disabled: true },
  ];

  const helpMenu: MenuItemDef[] = [
    { label: "Keyboard Shortcuts", onClick: () => window.alert("Space: Play/Pause\nS: Split at playhead\nDel: Delete selected\nCtrl+D: Duplicate\nCtrl+S: Save\n←/→: Step one frame") },
    { label: "About VideoEditor", onClick: () => window.alert("VideoEditor — built with Wails + React") },
  ];

  return (
    <div className="flex items-center gap-1 px-2 py-1 bg-surface-0 border-b border-border-subtle shrink-0">
      <Film size={14} className="text-accent mr-1" />
      <MenuDropdown label="File" items={fileMenu} isOpen={openMenu === "file"} onOpen={() => handleOpen("file")} onClose={handleClose} />
      <MenuDropdown label="Edit" items={editMenu} isOpen={openMenu === "edit"} onOpen={() => handleOpen("edit")} onClose={handleClose} />
      <MenuDropdown label="View" items={viewMenu} isOpen={openMenu === "view"} onOpen={() => handleOpen("view")} onClose={handleClose} />
      <MenuDropdown label="Project" items={projectMenu} isOpen={openMenu === "project"} onOpen={() => handleOpen("project")} onClose={handleClose} />
      <MenuDropdown label="Help" items={helpMenu} isOpen={openMenu === "help"} onOpen={() => handleOpen("help")} onClose={handleClose} />
    </div>
  );
}
