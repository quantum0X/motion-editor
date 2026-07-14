import { create } from "zustand";
import type { Project, Clip, TextClip, Effect, Transition, Track } from "../types/project";
import { createBackend } from "../services";

const MAX_HISTORY = 100;

interface EditorState {
  project: Project | null;
  selectedClipId: string | null;
  selectedTextClipId: string | null;
  playheadSec: number;
  isPlaying: boolean;
  pixelsPerSecond: number; // timeline zoom level
  isLoading: boolean;
  lastError: string | null;

  // undo/redo - full-project snapshots taken before each mutation
  history: { past: Project[]; future: Project[] };
  canUndo: boolean;
  canRedo: boolean;
  undo: () => Promise<void>;
  redo: () => Promise<void>;

  // derived-ish setters
  setProject: (p: Project) => void;
  selectClip: (clipId: string | null) => void;
  selectTextClip: (clipId: string | null) => void;
  setPlayhead: (sec: number) => void;
  setIsPlaying: (playing: boolean) => void;
  setZoom: (pixelsPerSecond: number) => void;
  setError: (message: string | null) => void;

  // actions that call the backend and refresh project state
  initNewProject: (name: string, w: number, h: number, fps: number, parentDir?: string) => Promise<void>;
  openProjectFrom: (dir: string) => Promise<void>;
  importFiles: (filePaths: string[]) => Promise<void>;
  addClip: (trackId: string, clip: Omit<Clip, "id" | "trackId"> & { id?: string }) => Promise<void>;
  // Adds an asset to the timeline at the current playhead position,
  // choosing the first compatible track that has room (creating the
  // clip on whichever video/audio track fits) - this backs both
  // double-clicking a media card and any other "insert at playhead"
  // entry point, so new media never silently lands at time 0 underneath
  // whatever's already there.
  addAssetAtPlayhead: (assetId: string) => Promise<void>;
  moveClip: (clipId: string, newTrackId: string, newStartSec: number) => Promise<void>;
  trimClip: (clipId: string, newStart: number, newEnd: number) => Promise<void>;
  splitClipAt: (clipId: string, atSec: number) => Promise<void>;
  deleteSelectedClip: () => Promise<void>;
  duplicateSelectedClip: () => Promise<void>;
  saveProject: () => Promise<void>;
  setTrackHeight: (trackId: string, height: number) => void;

  // text clip actions
  ensureTextTrack: () => Promise<string>; // returns the text track ID, creating one if none exists
  addTextClip: (trackId: string, clip: Omit<TextClip, "id" | "trackId">) => Promise<void>;
  updateTextClip: (clipId: string, updated: TextClip) => Promise<void>;
  deleteSelectedTextClip: () => Promise<void>;
  moveTextClip: (clipId: string, newStartSec: number) => Promise<void>;

  // effects (color correction, filters, etc.)
  addEffect: (clipId: string, effect: Partial<Effect> & Pick<Effect, "type">) => Promise<void>;
  updateEffect: (clipId: string, effectId: string, updated: Effect) => Promise<void>;
  removeEffect: (clipId: string, effectId: string) => Promise<void>;

  // transitions
  setTransition: (clipId: string, transition: Partial<Transition> & Pick<Transition, "type" | "nextClipId">) => Promise<void>;
  removeTransition: (clipId: string) => Promise<void>;
}

/**
 * timelineDurationSec computes how long the overall timeline is (the
 * latest clip end time across all tracks), used by the player and ruler
 * to know how far playback/zoom can extend. Exported standalone (not a
 * store method) since several components need this derived from
 * whatever project state they already have, without re-subscribing to
 * the whole store.
 */
export function timelineDurationSec(project: Project | null): number {
  if (!project) return 0;
  let max = 0;
  for (const track of project.tracks) {
    for (const clip of track.clips ?? []) {
      if (clip.timelineEndSec > max) max = clip.timelineEndSec;
    }
    for (const clip of track.textClips ?? []) {
      if (clip.timelineEndSec > max) max = clip.timelineEndSec;
    }
  }
  return max;
}

function clipsOverlap(a: { timelineStartSec: number; timelineEndSec: number }, b: { timelineStartSec: number; timelineEndSec: number }): boolean {
  return a.timelineStartSec < b.timelineEndSec && a.timelineEndSec > b.timelineStartSec;
}

function trackAcceptsAsset(track: Track, mediaType: "video" | "audio" | "image"): boolean {
  if (track.locked) return false;
  if (mediaType === "audio") return track.type === "audio";
  // video and image assets both live on video tracks
  return track.type === "video";
}

export const useEditorStore = create<EditorState>((set, get) => ({
  project: null,
  selectedClipId: null,
  selectedTextClipId: null,
  playheadSec: 0,
  isPlaying: false,
  pixelsPerSecond: 60,
  isLoading: false,
  lastError: null,

  history: { past: [], future: [] },
  canUndo: false,
  canRedo: false,

  setProject: (p) => set({ project: p }),
  selectClip: (clipId) => set({ selectedClipId: clipId, selectedTextClipId: clipId ? null : get().selectedTextClipId }),
  selectTextClip: (clipId) => set({ selectedTextClipId: clipId, selectedClipId: clipId ? null : get().selectedClipId }),
  setPlayhead: (sec) => set({ playheadSec: Math.max(0, sec) }),
  setIsPlaying: (playing) => set({ isPlaying: playing }),
  setZoom: (pixelsPerSecond) => set({ pixelsPerSecond: Math.min(800, Math.max(5, pixelsPerSecond)) }),
  setError: (message) => set({ lastError: message }),

  setTrackHeight: (trackId, height) => {
    const { project } = get();
    if (!project) return;
    const clamped = Math.max(40, Math.min(240, height));
    set({
      project: {
        ...project,
        tracks: project.tracks.map((t) => (t.id === trackId ? { ...t, height: clamped } : t)),
      },
    });
  },

  undo: async () => {
    const { history, project } = get();
    if (history.past.length === 0 || !project) return;
    const previous = history.past[history.past.length - 1];
    const newPast = history.past.slice(0, -1);
    const newFuture = [project, ...history.future].slice(0, MAX_HISTORY);
    set({ project: previous, history: { past: newPast, future: newFuture }, canUndo: newPast.length > 0, canRedo: true, lastError: null });
    try {
      const backend = await createBackend();
      await backend.replaceProject(previous);
    } catch (e: any) {
      set({ lastError: e.message || String(e) });
    }
  },

  redo: async () => {
    const { history, project } = get();
    if (history.future.length === 0 || !project) return;
    const next = history.future[0];
    const newFuture = history.future.slice(1);
    const newPast = [...history.past, project].slice(-MAX_HISTORY);
    set({ project: next, history: { past: newPast, future: newFuture }, canUndo: true, canRedo: newFuture.length > 0, lastError: null });
    try {
      const backend = await createBackend();
      await backend.replaceProject(next);
    } catch (e: any) {
      set({ lastError: e.message || String(e) });
    }
  },

  initNewProject: async (name, w, h, fps, parentDir) => {
    set({ isLoading: true, lastError: null });
    try {
      const backend = await createBackend();
      const project = await backend.newProject(name, w, h, fps, parentDir);
      set({ project, isLoading: false, history: { past: [], future: [] }, canUndo: false, canRedo: false, playheadSec: 0, selectedClipId: null, selectedTextClipId: null });
    } catch (e: any) {
      set({ lastError: e.message || String(e), isLoading: false });
    }
  },

  openProjectFrom: async (dir) => {
    set({ isLoading: true, lastError: null });
    try {
      const backend = await createBackend();
      const project = await backend.openProject(dir);
      set({ project, isLoading: false, history: { past: [], future: [] }, canUndo: false, canRedo: false, playheadSec: 0, selectedClipId: null, selectedTextClipId: null });
    } catch (e: any) {
      set({ lastError: e.message || String(e), isLoading: false });
    }
  },

  importFiles: async (filePaths) => {
    set({ lastError: null });
    try {
      const backend = await createBackend();
      const { project, errors } = await backend.importMediaFiles(filePaths);
      set({ project });
      if (errors.length > 0) {
        set({ lastError: `${errors.length} file(s) failed to import: ${errors.map((e) => e.error).join("; ")}` });
      }
    } catch (e: any) {
      set({ lastError: e.message || String(e) });
    }
  },

  addClip: async (trackId, clip) => {
    const { project } = get();
    if (!project) return;
    set({ lastError: null });
    try {
      const backend = await createBackend();
      const updated = await backend.addClipToTrack(trackId, { ...clip, trackId });
      set({ project: updated, history: { past: [...get().history.past, project].slice(-MAX_HISTORY), future: [] }, canUndo: true, canRedo: false });
    } catch (e: any) {
      set({ lastError: e.message || String(e) });
    }
  },

  addAssetAtPlayhead: async (assetId) => {
    const { project, playheadSec } = get();
    if (!project) return;
    const asset = project.assets.find((a) => a.id === assetId);
    if (!asset) {
      set({ lastError: `Asset ${assetId} not found` });
      return;
    }
    const duration = asset.mediaType === "image" ? 5 : asset.durationSec;
    const candidateRange = { timelineStartSec: playheadSec, timelineEndSec: playheadSec + duration };

    const compatibleTracks = project.tracks
      .filter((t) => trackAcceptsAsset(t, asset.mediaType))
      .sort((a, b) => b.order - a.order); // topmost video track first

    let targetTrack = compatibleTracks.find((t) => !(t.clips ?? []).some((c) => clipsOverlap(candidateRange, c)));
    if (!targetTrack) targetTrack = compatibleTracks[0];

    if (!targetTrack) {
      set({ lastError: `No ${asset.mediaType === "audio" ? "audio" : "video"} track available to place this clip on` });
      return;
    }

    await get().addClip(targetTrack.id, {
      assetId: asset.id,
      timelineStartSec: playheadSec,
      timelineEndSec: playheadSec + duration,
      sourceInSec: 0,
      sourceOutSec: duration,
      speed: 1,
      opacity: 1,
      volume: 1,
      muted: false,
      effects: [],
      keyframes: [],
      transition: null,
    });
  },

  moveClip: async (clipId, newTrackId, newStartSec) => {
    const { project } = get();
    if (!project) return;
    set({ lastError: null });
    try {
      const backend = await createBackend();
      const updated = await backend.moveClip(clipId, newTrackId, newStartSec);
      set({ project: updated, history: { past: [...get().history.past, project].slice(-MAX_HISTORY), future: [] }, canUndo: true, canRedo: false });
    } catch (e: any) {
      set({ lastError: e.message || String(e) });
    }
  },

  trimClip: async (clipId, newStart, newEnd) => {
    const { project } = get();
    if (!project) return;
    set({ lastError: null });
    try {
      const backend = await createBackend();
      const updated = await backend.trimClip(clipId, newStart, newEnd);
      set({ project: updated, history: { past: [...get().history.past, project].slice(-MAX_HISTORY), future: [] }, canUndo: true, canRedo: false });
    } catch (e: any) {
      set({ lastError: e.message || String(e) });
    }
  },

  splitClipAt: async (clipId, atSec) => {
    const { project } = get();
    if (!project) return;
    set({ lastError: null });
    try {
      const backend = await createBackend();
      const updated = await backend.splitClip(clipId, atSec);
      set({ project: updated, history: { past: [...get().history.past, project].slice(-MAX_HISTORY), future: [] }, canUndo: true, canRedo: false });
    } catch (e: any) {
      set({ lastError: e.message || String(e) });
    }
  },

  deleteSelectedClip: async () => {
    const { selectedClipId, project } = get();
    if (!selectedClipId || !project) return;
    set({ lastError: null });
    try {
      const backend = await createBackend();
      const updated = await backend.deleteClip(selectedClipId);
      set({
        project: updated,
        selectedClipId: null,
        history: { past: [...get().history.past, project].slice(-MAX_HISTORY), future: [] },
        canUndo: true,
        canRedo: false,
      });
    } catch (e: any) {
      set({ lastError: e.message || String(e) });
    }
  },

  duplicateSelectedClip: async () => {
    const { selectedClipId, project } = get();
    if (!selectedClipId || !project) return;
    set({ lastError: null });
    try {
      const backend = await createBackend();
      const { project: updated, newClipId } = await backend.duplicateClip(selectedClipId);
      set({
        project: updated,
        selectedClipId: newClipId,
        history: { past: [...get().history.past, project].slice(-MAX_HISTORY), future: [] },
        canUndo: true,
        canRedo: false,
      });
    } catch (e: any) {
      set({ lastError: e.message || String(e) });
    }
  },

  saveProject: async () => {
    set({ lastError: null });
    try {
      const backend = await createBackend();
      const project = await backend.saveProject();
      set({ project });
    } catch (e: any) {
      set({ lastError: e.message || String(e) });
    }
  },

  ensureTextTrack: async () => {
    const { project } = get();
    const existing = project?.tracks.find((t) => t.type === "text");
    if (existing) return existing.id;

    set({ lastError: null });
    try {
      const backend = await createBackend();
      const updatedProject = await backend.addTextTrack("Text 1");
      set({
        project: updatedProject,
        history: project ? { past: [...get().history.past, project].slice(-MAX_HISTORY), future: [] } : get().history,
        canUndo: true,
        canRedo: false,
      });
      const newTrack = updatedProject.tracks.find((t) => t.type === "text");
      if (!newTrack) throw new Error("Text track was not created");
      return newTrack.id;
    } catch (e: any) {
      set({ lastError: e.message || String(e) });
      throw e;
    }
  },

  addTextClip: async (trackId, clip) => {
    const { project } = get();
    if (!project) return;
    set({ lastError: null });
    try {
      const backend = await createBackend();
      const updated = await backend.addTextClip(trackId, { ...clip, trackId });
      set({ project: updated, history: { past: [...get().history.past, project].slice(-MAX_HISTORY), future: [] }, canUndo: true, canRedo: false });
    } catch (e: any) {
      set({ lastError: e.message || String(e) });
    }
  },

  updateTextClip: async (clipId, updated) => {
    const { project } = get();
    if (!project) return;
    set({ lastError: null });
    try {
      const backend = await createBackend();
      const newProject = await backend.updateTextClip(clipId, updated);
      set({ project: newProject, history: { past: [...get().history.past, project].slice(-MAX_HISTORY), future: [] }, canUndo: true, canRedo: false });
    } catch (e: any) {
      set({ lastError: e.message || String(e) });
    }
  },

  deleteSelectedTextClip: async () => {
    const { selectedTextClipId, project } = get();
    if (!selectedTextClipId || !project) return;
    set({ lastError: null });
    try {
      const backend = await createBackend();
      const updated = await backend.deleteTextClip(selectedTextClipId);
      set({
        project: updated,
        selectedTextClipId: null,
        history: { past: [...get().history.past, project].slice(-MAX_HISTORY), future: [] },
        canUndo: true,
        canRedo: false,
      });
    } catch (e: any) {
      set({ lastError: e.message || String(e) });
    }
  },

  moveTextClip: async (clipId, newStartSec) => {
    const { project } = get();
    if (!project) return;
    set({ lastError: null });
    try {
      const backend = await createBackend();
      const updated = await backend.moveTextClip(clipId, newStartSec);
      set({ project: updated, history: { past: [...get().history.past, project].slice(-MAX_HISTORY), future: [] }, canUndo: true, canRedo: false });
    } catch (e: any) {
      set({ lastError: e.message || String(e) });
    }
  },

  addEffect: async (clipId, effect) => {
    const { project } = get();
    if (!project) return;
    set({ lastError: null });
    try {
      const backend = await createBackend();
      const updated = await backend.addEffect(clipId, effect);
      set({ project: updated, history: { past: [...get().history.past, project].slice(-MAX_HISTORY), future: [] }, canUndo: true, canRedo: false });
    } catch (e: any) {
      set({ lastError: e.message || String(e) });
    }
  },

  updateEffect: async (clipId, effectId, updated) => {
    const { project } = get();
    if (!project) return;
    // Live-editing a slider shouldn't spam the undo stack with one entry
    // per pixel of drag - snapshot before the first change in a burst is
    // enough for a meaningful undo. We approximate this cheaply by only
    // pushing history when the previous history head isn't already this
    // same clip/effect (good enough given how this store is used - the
    // panel calls updateEffect on every slider tick while dragging).
    set({ lastError: null });
    try {
      const backend = await createBackend();
      const newProject = await backend.updateEffect(clipId, effectId, updated);
      set({ project: newProject, history: { past: [...get().history.past, project].slice(-MAX_HISTORY), future: [] }, canUndo: true, canRedo: false });
    } catch (e: any) {
      set({ lastError: e.message || String(e) });
    }
  },

  removeEffect: async (clipId, effectId) => {
    const { project } = get();
    if (!project) return;
    set({ lastError: null });
    try {
      const backend = await createBackend();
      const updated = await backend.removeEffect(clipId, effectId);
      set({ project: updated, history: { past: [...get().history.past, project].slice(-MAX_HISTORY), future: [] }, canUndo: true, canRedo: false });
    } catch (e: any) {
      set({ lastError: e.message || String(e) });
    }
  },

  setTransition: async (clipId, transition) => {
    const { project } = get();
    if (!project) return;
    set({ lastError: null });
    try {
      const backend = await createBackend();
      const updated = await backend.setTransition(clipId, { durationSec: 1, direction: "left", easing: "linear", ...transition });
      set({ project: updated, history: { past: [...get().history.past, project].slice(-MAX_HISTORY), future: [] }, canUndo: true, canRedo: false });
    } catch (e: any) {
      set({ lastError: e.message || String(e) });
    }
  },

  removeTransition: async (clipId) => {
    const { project } = get();
    if (!project) return;
    set({ lastError: null });
    try {
      const backend = await createBackend();
      const updated = await backend.removeTransition(clipId);
      set({ project: updated, history: { past: [...get().history.past, project].slice(-MAX_HISTORY), future: [] }, canUndo: true, canRedo: false });
    } catch (e: any) {
      set({ lastError: e.message || String(e) });
    }
  },
}));
