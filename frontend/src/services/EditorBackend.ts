import type {
  Project,
  Clip,
  TextClip,
  Effect,
  Transition,
  ExportSettings,
  ExportProgress,
  RecentEntry,
  AppSettings,
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
  // parentDir is optional ("" or omitted = use the configured default
  // Projects location) - lets a single project be created/saved somewhere
  // else without changing the app-wide default.
  newProject(name: string, canvasWidth: number, canvasHeight: number, fps: number, parentDir?: string): Promise<Project>;
  openProject(projectDir: string): Promise<Project>;
  saveProject(): Promise<Project>;
  // Restores a full project snapshot as the backend's source of truth -
  // used by undo/redo (see editorStore.ts). Does not touch the on-disk
  // location; the normal save/autosave flow persists it later.
  replaceProject(project: Project): Promise<Project>;
  saveProjectAs(newName: string, parentDir?: string): Promise<Project>;
  autoSave(): Promise<void>;
  recentProjects(): Promise<RecentEntry[]>;
  getCurrentProject(): Promise<Project | null>;

  // App settings (projects storage location)
  getSettings(): Promise<AppSettings>;
  setProjectsRootDir(dir: string): Promise<AppSettings>;
  openDirectoryDialog(): Promise<string>;
  getProjectsRootDir(): Promise<string>;
  // Opens the OS file manager at a file or folder ("" = current project folder).
  revealInFileManager(path: string): Promise<void>;

  // Timeline mutation
  addClipToTrack(trackId: string, clip: Partial<Clip> & Pick<Clip, "assetId" | "trackId" | "timelineStartSec" | "timelineEndSec" | "sourceInSec" | "sourceOutSec">): Promise<Project>;
  moveClip(clipId: string, newTrackId: string, newStartSec: number): Promise<Project>;
  trimClip(clipId: string, newTimelineStart: number, newTimelineEnd: number): Promise<Project>;
  splitClip(clipId: string, splitAtSec: number): Promise<Project>;
  deleteClip(clipId: string): Promise<Project>;
  duplicateClip(clipId: string): Promise<{ project: Project; newClipId: string }>;

  // Text clips
  addTextTrack(name: string): Promise<Project>;
  addTextClip(trackId: string, clip: Partial<TextClip> & Pick<TextClip, "content" | "timelineStartSec" | "timelineEndSec">): Promise<Project>;
  updateTextClip(clipId: string, updated: TextClip): Promise<Project>;
  deleteTextClip(clipId: string): Promise<Project>;
  moveTextClip(clipId: string, newStartSec: number): Promise<Project>;

  // Effects (color correction, filters, etc.) - stack on a video/image clip
  addEffect(clipId: string, effect: Partial<Effect> & Pick<Effect, "type">): Promise<Project>;
  updateEffect(clipId: string, effectId: string, updated: Effect): Promise<Project>;
  removeEffect(clipId: string, effectId: string): Promise<Project>;

  // Transitions - attached to the earlier of two adjacent clips on the same track
  setTransition(clipId: string, transition: Partial<Transition> & Pick<Transition, "type" | "nextClipId">): Promise<Project>;
  removeTransition(clipId: string): Promise<Project>;

  // Media import
  openFileDialog(): Promise<string[]>;
  // Resolves a raw filesystem path (MediaAsset.filePath/thumbnailPath)
  // into a data: URL an HTML element can load - see utils/mediaUrl.ts
  // for the full explanation of why this is necessary at all.
  readMediaFileAsDataUrl(path: string): Promise<string>;
  importMediaFiles(filePaths: string[]): Promise<{ project: Project; errors: { fileName?: string; error: string }[] }>;

  // Export
  startExport(settings: ExportSettings): Promise<string>; // returns jobId
  cancelExport(): Promise<void>;
  onExportProgress(callback: (progress: ExportProgress) => void): () => void; // returns unsubscribe fn
}
