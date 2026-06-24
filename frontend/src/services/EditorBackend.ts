import type {
  Project,
  Clip,
  ExportSettings,
  ExportProgress,
  RecentEntry,
} from "../types/project";

/**
 * EditorBackend is the full contract the frontend uses to talk to the
 * Go/Wails backend. It exists as an explicit interface (rather than
 * calling `window.go.main.App.*` directly from components) for two
 * reasons:
 *
 *  1. Every backend call is visible in one place, which matters a lot
 *     once dozens of components each need a handful of these.
 *  2. It allows a mock implementation (see mockBackend.ts) that runs
 *     entirely in the browser with no Go process behind it, which is
 *     how this frontend is developed and tested standalone before
 *     wiring into a real `wails dev` session.
 *
 * Every method here corresponds 1:1 to a bound method on app.go's App
 * struct. Keep the names and shapes identical on both sides; when one
 * changes, change the other in the same edit.
 */
export interface EditorBackend {
  // Project lifecycle
  newProject(name: string, canvasWidth: number, canvasHeight: number, fps: number): Promise<Project>;
  openProject(projectDir: string): Promise<Project>;
  saveProject(): Promise<Project>;
  saveProjectAs(newName: string): Promise<Project>;
  autoSave(): Promise<void>;
  recentProjects(): Promise<RecentEntry[]>;
  getCurrentProject(): Promise<Project | null>;

  // Timeline mutation
  addClipToTrack(trackId: string, clip: Partial<Clip> & Pick<Clip, "assetId" | "trackId" | "timelineStartSec" | "timelineEndSec" | "sourceInSec" | "sourceOutSec">): Promise<Project>;
  moveClip(clipId: string, newTrackId: string, newStartSec: number): Promise<Project>;
  trimClip(clipId: string, newTimelineStart: number, newTimelineEnd: number): Promise<Project>;
  splitClip(clipId: string, splitAtSec: number): Promise<Project>;
  deleteClip(clipId: string): Promise<Project>;
  duplicateClip(clipId: string): Promise<{ project: Project; newClipId: string }>;

  // Media import
  openFileDialog(): Promise<string[]>;
  importMediaFiles(filePaths: string[]): Promise<{ project: Project; errors: { fileName?: string; error: string }[] }>;

  // Export
  startExport(settings: ExportSettings): Promise<string>; // returns jobId
  cancelExport(): Promise<void>;
  onExportProgress(callback: (progress: ExportProgress) => void): () => void; // returns unsubscribe fn
}
