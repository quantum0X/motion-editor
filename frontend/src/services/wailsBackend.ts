import type { EditorBackend } from "./EditorBackend";
import type { Project, Clip, TextClip, Effect, Transition, ExportSettings, ExportProgress, AppSettings } from "../types/project";

// Wails injects a `window.go.main.App.<MethodName>` function for every
// bound method on the Go App struct, plus `window.runtime.EventsOn` for
// subscribing to backend-emitted events. These are not present until the
// app is actually running inside a real Wails webview, hence the runtime
// check in createBackend() (see index.ts in this folder).
declare global {
  interface Window {
    go: {
      main: {
        App: {
          NewProject(name: string, w: number, h: number, fps: number, parentDir: string): Promise<Project>;
          OpenProject(dir: string): Promise<Project>;
          SaveProject(): Promise<Project>;
          ReplaceProject(project: Project): Promise<Project>;
          SaveProjectAs(name: string, parentDir: string): Promise<Project>;
          AutoSave(): Promise<void>;
          RecentProjects(): Promise<any[]>;
          GetCurrentProject(): Promise<Project | null>;
          GetSettings(): Promise<AppSettings>;
          SetProjectsRootDir(dir: string): Promise<AppSettings>;
          OpenDirectoryDialog(): Promise<string>;
          GetProjectsRootDir(): Promise<string>;
          AddClipToTrack(trackId: string, clip: Partial<Clip>): Promise<Project>;
          MoveClip(clipId: string, newTrackId: string, newStart: number): Promise<Project>;
          TrimClip(clipId: string, newStart: number, newEnd: number): Promise<Project>;
          SplitClip(clipId: string, splitAt: number): Promise<Project>;
          DeleteClip(clipId: string): Promise<Project>;
          DuplicateClip(clipId: string): Promise<{ project: Project; newClipId: string }>;
          AddTextTrack(name: string): Promise<Project>;
          AddTextClip(trackId: string, clip: Partial<TextClip>): Promise<Project>;
          UpdateTextClip(clipId: string, updated: TextClip): Promise<Project>;
          DeleteTextClip(clipId: string): Promise<Project>;
          MoveTextClip(clipId: string, newStart: number): Promise<Project>;
          AddEffect(clipId: string, effect: Partial<Effect>): Promise<Project>;
          UpdateEffect(clipId: string, effectId: string, updated: Effect): Promise<Project>;
          RemoveEffect(clipId: string, effectId: string): Promise<Project>;
          SetTransition(clipId: string, transition: Partial<Transition>): Promise<Project>;
          RemoveTransition(clipId: string): Promise<Project>;
          OpenFileDialog(): Promise<string[]>;
          ImportMediaFiles(paths: string[]): Promise<{ project: Project; results: any[] }>;
          StartExport(settings: ExportSettings): Promise<string>;
          CancelExport(): Promise<void>;
        };
      };
    };
    runtime: {
      EventsOn(eventName: string, callback: (data: ExportProgress) => void): () => void;
    };
  }
}

export function createWailsBackend(): EditorBackend {
  const api = window.go.main.App;

  return {
    newProject: (name, w, h, fps, parentDir) => api.NewProject(name, w, h, fps, parentDir || ""),
    openProject: (dir) => api.OpenProject(dir),
    saveProject: () => api.SaveProject(),
    replaceProject: (project) => api.ReplaceProject(project),
    saveProjectAs: (name, parentDir) => api.SaveProjectAs(name, parentDir || ""),
    autoSave: () => api.AutoSave(),
    recentProjects: () => api.RecentProjects(),
    getCurrentProject: () => api.GetCurrentProject(),
    getSettings: () => api.GetSettings(),
    setProjectsRootDir: (dir) => api.SetProjectsRootDir(dir),
    openDirectoryDialog: () => api.OpenDirectoryDialog(),
    getProjectsRootDir: () => api.GetProjectsRootDir(),

    addClipToTrack: (trackId, clip) => api.AddClipToTrack(trackId, clip),
    moveClip: (clipId, newTrackId, newStart) => api.MoveClip(clipId, newTrackId, newStart),
    trimClip: (clipId, newStart, newEnd) => api.TrimClip(clipId, newStart, newEnd),
    splitClip: (clipId, splitAt) => api.SplitClip(clipId, splitAt),
    deleteClip: (clipId) => api.DeleteClip(clipId),
    duplicateClip: async (clipId) => {
      const result = await api.DuplicateClip(clipId);
      return { project: result.project, newClipId: result.newClipId };
    },

    addTextTrack: (name) => api.AddTextTrack(name),
    addTextClip: (trackId, clip) => api.AddTextClip(trackId, clip),
    updateTextClip: (clipId, updated) => api.UpdateTextClip(clipId, updated),
    deleteTextClip: (clipId) => api.DeleteTextClip(clipId),
    moveTextClip: (clipId, newStartSec) => api.MoveTextClip(clipId, newStartSec),

    addEffect: (clipId, effect) => api.AddEffect(clipId, effect),
    updateEffect: (clipId, effectId, updated) => api.UpdateEffect(clipId, effectId, updated),
    removeEffect: (clipId, effectId) => api.RemoveEffect(clipId, effectId),
    setTransition: (clipId, transition) => api.SetTransition(clipId, transition),
    removeTransition: (clipId) => api.RemoveTransition(clipId),

    openFileDialog: () => api.OpenFileDialog(),
    importMediaFiles: async (paths) => {
      const result = await api.ImportMediaFiles(paths);
      const errors = (result.results || [])
        .filter((r: any) => r.error)
        .map((r: any) => ({ error: r.error as string }));
      return { project: result.project, errors };
    },

    startExport: (settings) => api.StartExport(settings),
    cancelExport: () => api.CancelExport(),
    onExportProgress: (callback) => {
      return window.runtime.EventsOn("export:progress", callback);
    },
  };
}
