import { create } from "zustand";
import type { Project, Clip, TextClip, Effect, Transition, Track } from "../types/project";
import type { EditorBackend } from "../services/EditorBackend";
import { createBackend } from "../services";

const MAX_HISTORY = 100;

// Edits sharing a coalesce key within this window collapse into a single
// undo step - so dragging an effect slider or typing into a text clip is
// one Ctrl+Z, not one per pixel/keystroke.
const COALESCE_WINDOW_MS = 1000;

interface EditorState {
  project: Project | null;
  selectedClipId: string | null;
  selectedTextClipId: string | null;
  playheadSec: number;
  isPlaying: boolean;
  pixelsPerSecond: number; // timeline zoom level
  isLoading: boolean;
  lastError: string | null;
  // True when the project has changes since the last explicit save.
  isDirty: boolean;
  // Copied clip (Ctrl+C) - a snapshot, so pasting still works after the
  // original is deleted or changed.
  clipboard: { clip: Clip; trackType: Track["type"] } | null;

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
  clearSelection: () => void;
  setPlayhead: (sec: number) => void;
  setIsPlaying: (playing: boolean) => void;
  togglePlay: () => void;
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
  deleteSelection: () => Promise<void>;
  duplicateSelectedClip: () => Promise<void>;
  copySelectedClip: () => void;
  pasteAtPlayhead: () => Promise<void>;
  saveProject: () => Promise<void>;
  autoSave: () => Promise<void>;

  // track state
  setTrackHeight: (trackId: string, height: number) => void;
  commitTrackHeight: () => void;
  updateTrack: (trackId: string, partial: Partial<Pick<Track, "locked" | "hidden" | "muted">>) => void;

  // text clip actions
  ensureTextTrack: () => Promise<string>; // returns the text track ID, creating one if none exists
  addTextClip: (trackId: string, clip: Omit<TextClip, "id" | "trackId">) => Promise<void>;
  updateTextClip: (clipId: string, updated: TextClip) => void;
  deleteSelectedTextClip: () => Promise<void>;
  moveTextClip: (clipId: string, newStartSec: number) => Promise<void>;

  // effects (color correction, filters, etc.)
  addEffect: (clipId: string, effect: Partial<Effect> & Pick<Effect, "type">) => Promise<void>;
  updateEffect: (clipId: string, effectId: string, updated: Effect) => void;
  removeEffect: (clipId: string, effectId: string) => Promise<void>;

  // transitions
  setTransition: (clipId: string, transition: Partial<Transition> & Pick<Transition, "type" | "nextClipId">) => void;
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

/** Asks before replacing a project that has unsaved changes. Returns true to proceed. */
export function confirmDiscardUnsaved(): boolean {
  const { project, isDirty } = useEditorStore.getState();
  if (!project || !isDirty) return true;
  return window.confirm(`"${project.name}" has unsaved changes. Continue without saving?`);
}

/** Finds a video/audio clip and the track it lives on. */
export function findClip(project: Project | null, clipId: string | null): { clip: Clip; track: Track } | null {
  if (!project || !clipId) return null;
  for (const track of project.tracks) {
    const clip = (track.clips ?? []).find((c) => c.id === clipId);
    if (clip) return { clip, track };
  }
  return null;
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

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Returns a copy of `project` with one clip (on any track) replaced via `fn`. */
function mapClip(project: Project, clipId: string, fn: (c: Clip) => Clip): Project {
  return {
    ...project,
    tracks: project.tracks.map((t) =>
      (t.clips ?? []).some((c) => c.id === clipId) ? { ...t, clips: t.clips.map((c) => (c.id === clipId ? fn(c) : c)) } : t
    ),
  };
}

function mapTextClip(project: Project, clipId: string, fn: (c: TextClip) => TextClip): Project {
  return {
    ...project,
    tracks: project.tracks.map((t) =>
      (t.textClips ?? []).some((c) => c.id === clipId) ? { ...t, textClips: t.textClips.map((c) => (c.id === clipId ? fn(c) : c)) } : t
    ),
  };
}

// --- Optimistic edit syncing ---
//
// High-frequency edits (effect sliders, transition duration, typing in a
// text clip) are applied to local state immediately so the preview reacts
// instantly, then mirrored to the backend "latest wins": while one call
// for a key is in flight, newer values replace any queued one instead of
// stacking up dozens of IPC round-trips, each of which used to replace the
// whole project (and could land out of order, reverting typed text).

// Incremented on every local project change; a backend response is only
// adopted if nothing changed locally since its request was sent.
let localRevision = 0;
const pendingSyncs = new Map<string, (b: EditorBackend) => Promise<Project>>();
const inflightSyncs = new Map<string, Promise<void>>();
let lastCoalesce: { key: string; at: number } | null = null;

async function flushSyncs(): Promise<void> {
  while (inflightSyncs.size > 0) {
    await Promise.all(inflightSyncs.values());
  }
}

export const useEditorStore = create<EditorState>((set, get) => {
  /** Pushes `before` onto the undo stack, unless this edit continues a coalesced burst. */
  const recordHistory = (before: Project, coalesceKey?: string) => {
    const now = Date.now();
    const continuesBurst = coalesceKey && lastCoalesce && lastCoalesce.key === coalesceKey && now - lastCoalesce.at < COALESCE_WINDOW_MS;
    lastCoalesce = coalesceKey ? { key: coalesceKey, at: now } : null;
    if (continuesBurst) return;
    set({ history: { past: [...get().history.past, before].slice(-MAX_HISTORY), future: [] }, canUndo: true, canRedo: false });
  };

  /**
   * Runs a backend mutation that returns the updated project, records an
   * undo step, and surfaces any error. Shared by every non-optimistic
   * timeline action.
   */
  const mutate = async (call: (b: EditorBackend) => Promise<Project>, extra?: Partial<EditorState>): Promise<boolean> => {
    const before = get().project;
    if (!before) return false;
    set({ lastError: null });
    try {
      await flushSyncs();
      const backend = await createBackend();
      const updated = await call(backend);
      localRevision++;
      recordHistory(before);
      set({ project: updated, isDirty: true, ...extra });
      return true;
    } catch (e) {
      set({ lastError: errorMessage(e) });
      return false;
    }
  };

  /**
   * Mirrors a local change to the backend "latest wins" per key. When
   * `adopt` is set, the backend's returned project replaces local state -
   * but only if nothing newer happened locally in the meantime.
   */
  const syncLatest = (key: string, call: (b: EditorBackend) => Promise<Project>, adopt: boolean) => {
    pendingSyncs.set(key, call);
    if (inflightSyncs.has(key)) return;
    const run = (async () => {
      const backend = await createBackend();
      while (pendingSyncs.has(key)) {
        const nextCall = pendingSyncs.get(key)!;
        pendingSyncs.delete(key);
        const revisionAtSend = localRevision;
        try {
          const result = await nextCall(backend);
          if (adopt && !pendingSyncs.has(key) && localRevision === revisionAtSend) set({ project: result });
        } catch (e) {
          set({ lastError: errorMessage(e) });
        }
      }
    })().finally(() => inflightSyncs.delete(key));
    inflightSyncs.set(key, run);
  };

  /** Applies `next` locally right away, then syncs it to the backend (see "Optimistic edit syncing" above). */
  const optimistic = (key: string, next: Project, call: (b: EditorBackend) => Promise<Project>) => {
    const before = get().project;
    if (!before) return;
    recordHistory(before, key);
    localRevision++;
    set({ project: next, isDirty: true, lastError: null });
    syncLatest(key, call, true);
  };

  const restoreSnapshot = async (snapshot: Project) => {
    await flushSyncs();
    try {
      const backend = await createBackend();
      await backend.replaceProject(snapshot);
    } catch (e) {
      set({ lastError: errorMessage(e) });
    }
  };

  const freshProjectState = (project: Project): Partial<EditorState> => ({
    project,
    isLoading: false,
    isDirty: false,
    history: { past: [], future: [] },
    canUndo: false,
    canRedo: false,
    playheadSec: 0,
    isPlaying: false,
    selectedClipId: null,
    selectedTextClipId: null,
  });

  return {
    project: null,
    selectedClipId: null,
    selectedTextClipId: null,
    playheadSec: 0,
    isPlaying: false,
    pixelsPerSecond: 60,
    isLoading: false,
    lastError: null,
    isDirty: false,
    clipboard: null,

    history: { past: [], future: [] },
    canUndo: false,
    canRedo: false,

    setProject: (p) => {
      localRevision++;
      set({ project: p });
    },
    selectClip: (clipId) => set({ selectedClipId: clipId, selectedTextClipId: clipId ? null : get().selectedTextClipId }),
    selectTextClip: (clipId) => set({ selectedTextClipId: clipId, selectedClipId: clipId ? null : get().selectedClipId }),
    clearSelection: () => set({ selectedClipId: null, selectedTextClipId: null }),
    setPlayhead: (sec) => set({ playheadSec: Math.max(0, sec) }),
    setIsPlaying: (playing) => set({ isPlaying: playing }),
    togglePlay: () => {
      const { project, isPlaying, playheadSec } = get();
      if (!project) return;
      const duration = timelineDurationSec(project);
      if (!isPlaying && duration > 0 && playheadSec >= duration) set({ playheadSec: 0 });
      set({ isPlaying: !isPlaying });
    },
    setZoom: (pixelsPerSecond) => set({ pixelsPerSecond: Math.min(800, Math.max(5, pixelsPerSecond)) }),
    setError: (message) => set({ lastError: message }),

    setTrackHeight: (trackId, height) => {
      const { project } = get();
      if (!project) return;
      const clamped = Math.round(Math.max(40, Math.min(240, height)));
      localRevision++;
      set({
        project: {
          ...project,
          tracks: project.tracks.map((t) => (t.id === trackId ? { ...t, height: clamped } : t)),
        },
      });
    },

    // Track height is a layout preference, so it isn't an undo step, but
    // it must still reach the backend - otherwise the very next backend
    // mutation returns the old height and the lane snaps back.
    commitTrackHeight: () => {
      const { project } = get();
      if (!project) return;
      syncLatest("track-height", (b) => b.replaceProject(project), false);
      set({ isDirty: true });
    },

    updateTrack: (trackId, partial) => {
      const { project } = get();
      if (!project) return;
      const next = { ...project, tracks: project.tracks.map((t) => (t.id === trackId ? { ...t, ...partial } : t)) };
      optimistic(`track:${trackId}:${Object.keys(partial).join(",")}`, next, (b) => b.replaceProject(next));
    },

    undo: async () => {
      const { history, project } = get();
      if (history.past.length === 0 || !project) return;
      const previous = history.past[history.past.length - 1];
      const newPast = history.past.slice(0, -1);
      const newFuture = [project, ...history.future].slice(0, MAX_HISTORY);
      lastCoalesce = null;
      localRevision++;
      set({ project: previous, history: { past: newPast, future: newFuture }, canUndo: newPast.length > 0, canRedo: true, lastError: null, isDirty: true });
      await restoreSnapshot(previous);
    },

    redo: async () => {
      const { history, project } = get();
      if (history.future.length === 0 || !project) return;
      const next = history.future[0];
      const newFuture = history.future.slice(1);
      const newPast = [...history.past, project].slice(-MAX_HISTORY);
      lastCoalesce = null;
      localRevision++;
      set({ project: next, history: { past: newPast, future: newFuture }, canUndo: true, canRedo: newFuture.length > 0, lastError: null, isDirty: true });
      await restoreSnapshot(next);
    },

    initNewProject: async (name, w, h, fps, parentDir) => {
      set({ isLoading: true, lastError: null });
      try {
        const backend = await createBackend();
        const project = await backend.newProject(name, w, h, fps, parentDir);
        localRevision++;
        set(freshProjectState(project));
      } catch (e) {
        set({ lastError: errorMessage(e), isLoading: false });
      }
    },

    openProjectFrom: async (dir) => {
      set({ isLoading: true, lastError: null });
      try {
        const backend = await createBackend();
        const project = await backend.openProject(dir);
        localRevision++;
        set(freshProjectState(project));
      } catch (e) {
        set({ lastError: errorMessage(e), isLoading: false });
      }
    },

    importFiles: async (filePaths) => {
      set({ lastError: null });
      try {
        await flushSyncs();
        const backend = await createBackend();
        const { project, errors } = await backend.importMediaFiles(filePaths);
        localRevision++;
        set({ project, isDirty: true });
        if (errors.length > 0) {
          set({ lastError: `${errors.length} file(s) failed to import: ${errors.map((e) => e.error).join("; ")}` });
        }
      } catch (e) {
        set({ lastError: errorMessage(e) });
      }
    },

    addClip: async (trackId, clip) => {
      await mutate((b) => b.addClipToTrack(trackId, { ...clip, trackId }));
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
        set({ lastError: `No unlocked ${asset.mediaType === "audio" ? "audio" : "video"} track available to place this clip on` });
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
      await mutate((b) => b.moveClip(clipId, newTrackId, newStartSec));
    },

    trimClip: async (clipId, newStart, newEnd) => {
      await mutate((b) => b.trimClip(clipId, newStart, newEnd));
    },

    splitClipAt: async (clipId, atSec) => {
      await mutate((b) => b.splitClip(clipId, atSec));
    },

    deleteSelectedClip: async () => {
      const { selectedClipId } = get();
      if (!selectedClipId) return;
      await mutate((b) => b.deleteClip(selectedClipId), { selectedClipId: null });
    },

    deleteSelection: async () => {
      if (get().selectedClipId) await get().deleteSelectedClip();
      else if (get().selectedTextClipId) await get().deleteSelectedTextClip();
    },

    duplicateSelectedClip: async () => {
      const { selectedClipId } = get();
      if (!selectedClipId) return;
      let newClipId: string | null = null;
      const ok = await mutate(async (b) => {
        const result = await b.duplicateClip(selectedClipId);
        newClipId = result.newClipId;
        return result.project;
      });
      if (ok && newClipId) set({ selectedClipId: newClipId });
    },

    copySelectedClip: () => {
      const found = findClip(get().project, get().selectedClipId);
      if (found) set({ clipboard: { clip: found.clip, trackType: found.track.type } });
    },

    // Pastes the copied clip at the playhead: on its original track if
    // that still exists and has room there, otherwise on the first
    // compatible unlocked track that does.
    pasteAtPlayhead: async () => {
      const { clipboard, project, playheadSec } = get();
      if (!clipboard || !project) return;
      const { clip } = clipboard;
      const length = clip.timelineEndSec - clip.timelineStartSec;
      const range = { timelineStartSec: playheadSec, timelineEndSec: playheadSec + length };
      const candidates = project.tracks
        .filter((t) => t.type === clipboard.trackType && !t.locked)
        .sort((a, b) => (a.id === clip.trackId ? -1 : b.id === clip.trackId ? 1 : b.order - a.order));
      const target = candidates.find((t) => !(t.clips ?? []).some((c) => clipsOverlap(range, c)));
      if (!target) {
        set({ lastError: "No room at the playhead to paste this clip" });
        return;
      }
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { id: _id, trackId: _trackId, ...rest } = clip;
      await get().addClip(target.id, { ...rest, ...range, transition: null });
    },

    saveProject: async () => {
      set({ lastError: null });
      try {
        await flushSyncs();
        const backend = await createBackend();
        const project = await backend.saveProject();
        localRevision++;
        set({ project, isDirty: false });
      } catch (e) {
        set({ lastError: errorMessage(e) });
      }
    },

    autoSave: async () => {
      if (!get().project || !get().isDirty) return;
      try {
        await flushSyncs();
        const backend = await createBackend();
        await backend.autoSave();
      } catch {
        // Autosave is best-effort and silent; explicit saves surface errors.
      }
    },

    ensureTextTrack: async () => {
      const existing = get().project?.tracks.find((t) => t.type === "text");
      if (existing) return existing.id;

      const ok = await mutate((b) => b.addTextTrack("Text 1"));
      const newTrack = get().project?.tracks.find((t) => t.type === "text");
      if (!ok || !newTrack) throw new Error(get().lastError ?? "Text track was not created");
      return newTrack.id;
    },

    addTextClip: async (trackId, clip) => {
      await mutate((b) => b.addTextClip(trackId, { ...clip, trackId }));
    },

    updateTextClip: (clipId, updated) => {
      const { project } = get();
      if (!project) return;
      const next = mapTextClip(project, clipId, () => updated);
      optimistic(`text:${clipId}`, next, (b) => b.updateTextClip(clipId, updated));
    },

    deleteSelectedTextClip: async () => {
      const { selectedTextClipId } = get();
      if (!selectedTextClipId) return;
      await mutate((b) => b.deleteTextClip(selectedTextClipId), { selectedTextClipId: null });
    },

    moveTextClip: async (clipId, newStartSec) => {
      await mutate((b) => b.moveTextClip(clipId, newStartSec));
    },

    addEffect: async (clipId, effect) => {
      await mutate((b) => b.addEffect(clipId, effect));
    },

    updateEffect: (clipId, effectId, updated) => {
      const { project } = get();
      if (!project) return;
      const next = mapClip(project, clipId, (c) => ({ ...c, effects: (c.effects ?? []).map((e) => (e.id === effectId ? updated : e)) }));
      optimistic(`effect:${clipId}:${effectId}`, next, (b) => b.updateEffect(clipId, effectId, updated));
    },

    removeEffect: async (clipId, effectId) => {
      await mutate((b) => b.removeEffect(clipId, effectId));
    },

    setTransition: (clipId, transition) => {
      const { project } = get();
      if (!project) return;
      const existingId = findClip(project, clipId)?.clip.transition?.id ?? "";
      const full: Transition = { id: existingId, durationSec: 1, direction: "left", easing: "linear", ...transition };
      const next = mapClip(project, clipId, (c) => ({ ...c, transition: full }));
      optimistic(`transition:${clipId}`, next, (b) => b.setTransition(clipId, full));
    },

    removeTransition: async (clipId) => {
      await mutate((b) => b.removeTransition(clipId));
    },
  };
});
