import { create } from "zustand";
import type { Project, Clip, TextClip } from "../types/project";
import { createBackend } from "../services";

interface EditorState {
  project: Project | null;
  selectedClipId: string | null;
  selectedTextClipId: string | null;
  playheadSec: number;
  isPlaying: boolean;
  pixelsPerSecond: number; // timeline zoom level
  isLoading: boolean;
  lastError: string | null;

  // derived-ish setters
  setProject: (p: Project) => void;
  selectClip: (clipId: string | null) => void;
  selectTextClip: (clipId: string | null) => void;
  setPlayhead: (sec: number) => void;
  setIsPlaying: (playing: boolean) => void;
  setZoom: (pixelsPerSecond: number) => void;
  setError: (message: string | null) => void;

  // actions that call the backend and refresh project state
  initNewProject: (name: string, w: number, h: number, fps: number) => Promise<void>;
  importFiles: (filePaths: string[]) => Promise<void>;
  addClip: (trackId: string, clip: Omit<Clip, "id" | "trackId"> & { id?: string }) => Promise<void>;
  moveClip: (clipId: string, newTrackId: string, newStartSec: number) => Promise<void>;
  trimClip: (clipId: string, newStart: number, newEnd: number) => Promise<void>;
  splitClipAt: (clipId: string, atSec: number) => Promise<void>;
  deleteSelectedClip: () => Promise<void>;
  duplicateSelectedClip: () => Promise<void>;
  saveProject: () => Promise<void>;

  // text clip actions
  ensureTextTrack: () => Promise<string>; // returns the text track ID, creating one if none exists
  addTextClip: (trackId: string, clip: Omit<TextClip, "id" | "trackId">) => Promise<void>;
  updateTextClip: (clipId: string, updated: TextClip) => Promise<void>;
  deleteSelectedTextClip: () => Promise<void>;
  moveTextClip: (clipId: string, newStartSec: number) => Promise<void>;
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
    for (const clip of track.clips) {
      if (clip.timelineEndSec > max) max = clip.timelineEndSec;
    }
  }
  return max;
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

  setProject: (p) => set({ project: p }),
  selectClip: (clipId) => set({ selectedClipId: clipId, selectedTextClipId: clipId ? null : get().selectedTextClipId }),
  selectTextClip: (clipId) => set({ selectedTextClipId: clipId, selectedClipId: clipId ? null : get().selectedClipId }),
  setPlayhead: (sec) => set({ playheadSec: Math.max(0, sec) }),
  setIsPlaying: (playing) => set({ isPlaying: playing }),
  setZoom: (pixelsPerSecond) => set({ pixelsPerSecond: Math.min(800, Math.max(5, pixelsPerSecond)) }),
  setError: (message) => set({ lastError: message }),

  initNewProject: async (name, w, h, fps) => {
    set({ isLoading: true, lastError: null });
    try {
      const backend = await createBackend();
      const project = await backend.newProject(name, w, h, fps);
      set({ project, isLoading: false });
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
    set({ lastError: null });
    try {
      const backend = await createBackend();
      const project = await backend.addClipToTrack(trackId, { ...clip, trackId });
      set({ project });
    } catch (e: any) {
      set({ lastError: e.message || String(e) });
    }
  },

  moveClip: async (clipId, newTrackId, newStartSec) => {
    set({ lastError: null });
    try {
      const backend = await createBackend();
      const project = await backend.moveClip(clipId, newTrackId, newStartSec);
      set({ project });
    } catch (e: any) {
      set({ lastError: e.message || String(e) });
    }
  },

  trimClip: async (clipId, newStart, newEnd) => {
    set({ lastError: null });
    try {
      const backend = await createBackend();
      const project = await backend.trimClip(clipId, newStart, newEnd);
      set({ project });
    } catch (e: any) {
      set({ lastError: e.message || String(e) });
    }
  },

  splitClipAt: async (clipId, atSec) => {
    set({ lastError: null });
    try {
      const backend = await createBackend();
      const project = await backend.splitClip(clipId, atSec);
      set({ project });
    } catch (e: any) {
      set({ lastError: e.message || String(e) });
    }
  },

  deleteSelectedClip: async () => {
    const { selectedClipId } = get();
    if (!selectedClipId) return;
    set({ lastError: null });
    try {
      const backend = await createBackend();
      const project = await backend.deleteClip(selectedClipId);
      set({ project, selectedClipId: null });
    } catch (e: any) {
      set({ lastError: e.message || String(e) });
    }
  },

  duplicateSelectedClip: async () => {
    const { selectedClipId } = get();
    if (!selectedClipId) return;
    set({ lastError: null });
    try {
      const backend = await createBackend();
      const { project, newClipId } = await backend.duplicateClip(selectedClipId);
      set({ project, selectedClipId: newClipId });
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
      set({ project: updatedProject });
      const newTrack = updatedProject.tracks.find((t) => t.type === "text");
      if (!newTrack) throw new Error("Text track was not created");
      return newTrack.id;
    } catch (e: any) {
      set({ lastError: e.message || String(e) });
      throw e;
    }
  },

  addTextClip: async (trackId, clip) => {
    set({ lastError: null });
    try {
      const backend = await createBackend();
      const project = await backend.addTextClip(trackId, { ...clip, trackId });
      set({ project });
    } catch (e: any) {
      set({ lastError: e.message || String(e) });
    }
  },

  updateTextClip: async (clipId, updated) => {
    set({ lastError: null });
    try {
      const backend = await createBackend();
      const project = await backend.updateTextClip(clipId, updated);
      set({ project });
    } catch (e: any) {
      set({ lastError: e.message || String(e) });
    }
  },

  deleteSelectedTextClip: async () => {
    const { selectedTextClipId } = get();
    if (!selectedTextClipId) return;
    set({ lastError: null });
    try {
      const backend = await createBackend();
      const project = await backend.deleteTextClip(selectedTextClipId);
      set({ project, selectedTextClipId: null });
    } catch (e: any) {
      set({ lastError: e.message || String(e) });
    }
  },

  moveTextClip: async (clipId, newStartSec) => {
    set({ lastError: null });
    try {
      const backend = await createBackend();
      const project = await backend.moveTextClip(clipId, newStartSec);
      set({ project });
    } catch (e: any) {
      set({ lastError: e.message || String(e) });
    }
  },
}));
