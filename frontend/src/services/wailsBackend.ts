import type { EditorBackend } from "./EditorBackend";
import type { Project, Clip, TextClip, ExportSettings, ExportProgress } from "../types/project";

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
          NewProject(name: string, w: number, h: number, fps: number): Promise<Project>;
          OpenProject(dir: string): Promise<Project>;
          SaveProject(): Promise<Project>;
          SaveProjectAs(name: string): Promise<Project>;
          AutoSave(): Promise<void>;
          RecentProjects(): Promise<any[]>;
          GetCurrentProject(): Promise<Project | null>;
          AddClipToTrack(trackId: string, clip: Partial<Clip>): Promise<Project>;
          MoveClip(clipId: string, newTrackId: string, newStart: number): Promise<Project>;
          TrimClip(clipId: string, newStart: number, newEnd: number): Promise<Project>;
          SplitClip(clipId: string, splitAt: number): Promise<Project>;
          DeleteClip(clipId: string): Promise<Project>;
          DuplicateClip(clipId: string): Promise<[Project, string]>;
          AddTextTrack(name: string): Promise<Project>;
          AddTextClip(trackId: string, clip: Partial<TextClip>): Promise<Project>;
          UpdateTextClip(clipId: string, updated: TextClip): Promise<Project>;
          DeleteTextClip(clipId: string): Promise<Project>;
          MoveTextClip(clipId: string, newStart: number): Promise<Project>;
          OpenFileDialog(): Promise<string[]>;
          ImportMediaFiles(paths: string[]): Promise<[Project, any[]]>;
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
    newProject: (name, w, h, fps) => api.NewProject(name, w, h, fps),
    openProject: (dir) => api.OpenProject(dir),
    saveProject: () => api.SaveProject(),
    saveProjectAs: (name) => api.SaveProjectAs(name),
    autoSave: () => api.AutoSave(),
    recentProjects: () => api.RecentProjects(),
    getCurrentProject: () => api.GetCurrentProject(),

    addClipToTrack: (trackId, clip) => api.AddClipToTrack(trackId, clip),
    moveClip: (clipId, newTrackId, newStart) => api.MoveClip(clipId, newTrackId, newStart),
    trimClip: (clipId, newStart, newEnd) => api.TrimClip(clipId, newStart, newEnd),
    splitClip: (clipId, splitAt) => api.SplitClip(clipId, splitAt),
    deleteClip: (clipId) => api.DeleteClip(clipId),
    duplicateClip: async (clipId) => {
      const [project, newClipId] = await api.DuplicateClip(clipId);
      return { project, newClipId };
    },

    addTextTrack: (name) => api.AddTextTrack(name),
    addTextClip: (trackId, clip) => api.AddTextClip(trackId, clip),
    updateTextClip: (clipId, updated) => api.UpdateTextClip(clipId, updated),
    deleteTextClip: (clipId) => api.DeleteTextClip(clipId),
    moveTextClip: (clipId, newStartSec) => api.MoveTextClip(clipId, newStartSec),

    openFileDialog: () => api.OpenFileDialog(),
    importMediaFiles: async (paths) => {
      const [project, rawResults] = await api.ImportMediaFiles(paths);
      const errors = (rawResults || [])
        .filter((r: any) => r.Error)
        .map((r: any) => ({ error: r.Error as string }));
      return { project, errors };
    },

    startExport: (settings) => api.StartExport(settings),
    cancelExport: () => api.CancelExport(),
    onExportProgress: (callback) => {
      return window.runtime.EventsOn("export:progress", callback);
    },
  };
}
