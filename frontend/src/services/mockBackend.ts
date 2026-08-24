import { v4 as uuidv4 } from "uuid";
import type { EditorBackend } from "./EditorBackend";
import type { Project, Clip, TextClip, Track, MediaAsset, Effect, Transition, ExportProgress, AppSettings, RecentEntry } from "../types/project";

/**
 * In-browser mock of the Go backend. Mirrors the validation/mutation
 * logic in app.go closely enough that the frontend can be fully built
 * and exercised without a real Wails process - this is how the timeline,
 * media library, and preview compositor in this project were actually
 * developed and verified.
 *
 * This is NOT used in the real packaged app - createBackend() (see
 * index.ts) picks wailsBackend.ts instead whenever `window.go` exists
 * (i.e. whenever we're actually running inside Wails).
 */
function makeEmptyProject(name: string, w = 1920, h = 1080, fps = 30): Project {
  const now = new Date().toISOString();
  return {
    id: uuidv4(),
    name,
    createdAt: now,
    modifiedAt: now,
    formatVersion: 1,
    canvasWidth: w,
    canvasHeight: h,
    fps,
    tracks: [
      { id: uuidv4(), type: "video", name: "Video 2", order: 1, locked: false, hidden: false, muted: false, clips: [], textClips: [] },
      { id: uuidv4(), type: "video", name: "Video 1", order: 0, locked: false, hidden: false, muted: false, clips: [], textClips: [] },
      { id: uuidv4(), type: "audio", name: "Audio 1", order: 0, locked: false, hidden: false, muted: false, clips: [], textClips: [] },
    ],
    assets: [],
  };
}

const RECENTS_KEY = "mock-recent-projects";

function loadRecents(): RecentEntry[] {
  try {
    const raw = window.localStorage?.getItem(RECENTS_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    /* ignore - dev convenience only */
  }
  return [];
}

function saveRecents(list: RecentEntry[]) {
  try {
    window.localStorage?.setItem(RECENTS_KEY, JSON.stringify(list.slice(0, 10)));
  } catch {
    /* ignore - dev convenience only */
  }
}

function touchRecent(dir: string, name: string) {
  const list = loadRecents().filter((r) => r.projectDir !== dir);
  list.unshift({ projectDir: dir, name, lastOpened: new Date().toISOString() });
  saveRecents(list);
}

function defaultEffectParams(type: Effect["type"]): Record<string, number> {
  switch (type) {
    case "brightness":
      return { amount: 0 }; // -100..100
    case "contrast":
      return { amount: 0 }; // -100..100
    case "saturation":
      return { amount: 0 }; // -100..100
    case "blur":
      return { radiusPx: 4 };
    case "sharpen":
      return { amount: 50 };
    case "vignette":
      return { amount: 50 };
    case "grain":
      return { amount: 20 };
    case "vhs":
      return { amount: 50 };
    case "rgbshift":
      return { amount: 5 };
    default:
      return {};
  }
}

export function createMockBackend(): EditorBackend {
  let project: Project = makeEmptyProject("Untitled Project");
  const progressListeners: ((p: ExportProgress) => void)[] = [];
  // Dev-mode mock settings - persisted to localStorage purely so a page
  // reload during development doesn't re-trigger the first-launch
  // location picker every time, which would be annoying to test against
  // repeatedly. The real Wails backend persists this to a real
  // settings.json file on disk instead (see backend/project/service.go).
  let mockSettings: AppSettings = (() => {
    try {
      const raw = window.localStorage?.getItem("mock-app-settings");
      if (raw) return JSON.parse(raw);
    } catch {
      /* ignore - fall through to default below */
    }
    return { projectsRootDir: "/mock/Projects", hasCompletedSetup: false };
  })();

  function findClip(clipId: string): { clip: Clip; track: Track } | null {
    for (const track of project.tracks) {
      const clip = track.clips.find((c) => c.id === clipId);
      if (clip) return { clip, track };
    }
    return null;
  }

  function findTextClip(clipId: string): { clip: TextClip; track: Track } | null {
    for (const track of project.tracks) {
      const clip = track.textClips.find((c) => c.id === clipId);
      if (clip) return { clip, track };
    }
    return null;
  }

  function overlaps(a: Clip | { timelineStartSec: number; timelineEndSec: number }, b: Clip): boolean {
    return a.timelineStartSec < b.timelineEndSec && a.timelineEndSec > b.timelineStartSec;
  }

  return {
    async newProject(name, w, h, fps, parentDir) {
      project = makeEmptyProject(name, w, h, fps);
      touchRecent((parentDir || mockSettings.projectsRootDir) + "/" + name, name);
      return structuredClone(project);
    },

    async openProject(_dir) {
      // Mock has nothing real to open; return the in-memory project as-is
      // so UI flows (recent projects list, open dialog) can still be
      // exercised end-to-end in the browser.
      touchRecent(_dir, project.name);
      return structuredClone(project);
    },

    async saveProject() {
      project.modifiedAt = new Date().toISOString();
      return structuredClone(project);
    },

    async replaceProject(snapshot) {
      project = structuredClone(snapshot);
      project.modifiedAt = new Date().toISOString();
      return structuredClone(project);
    },

    async saveProjectAs(newName, parentDir) {
      project = { ...structuredClone(project), id: uuidv4(), name: newName };
      touchRecent((parentDir || mockSettings.projectsRootDir) + "/" + newName, newName);
      return structuredClone(project);
    },

    async autoSave() {
      // no-op in mock
    },

    async recentProjects() {
      const list = loadRecents();
      if (list.length === 0) {
        return [{ projectDir: mockSettings.projectsRootDir + "/" + project.name, name: project.name, lastOpened: new Date().toISOString() }];
      }
      return list;
    },

    async getCurrentProject() {
      return structuredClone(project);
    },

    async getSettings() {
      return { ...mockSettings };
    },

    async setProjectsRootDir(dir) {
      mockSettings = { projectsRootDir: dir, hasCompletedSetup: true };
      try {
        window.localStorage?.setItem("mock-app-settings", JSON.stringify(mockSettings));
      } catch {
        /* ignore - dev convenience only */
      }
      return { ...mockSettings };
    },

    async openDirectoryDialog() {
      // Browsers have no API to let the user pick and return a real
      // filesystem folder path (the File System Access API returns an
      // opaque handle, not a path string) - dev mode simulates a choice
      // instead of leaving this entirely non-functional, since exercising
      // the "what happens after a location is chosen" flow matters more
      // here than the native picker UI itself, which is what the real
      // Wails OpenDirectoryDialog provides.
      return "/mock/Documents/VideoEditorProjects";
    },

    async getProjectsRootDir() {
      return mockSettings.projectsRootDir;
    },

    async addClipToTrack(trackId, clipInput) {
      const track = project.tracks.find((t) => t.id === trackId);
      if (!track) throw new Error(`Track ${trackId} not found`);

      const asset = project.assets.find((a) => a.id === clipInput.assetId);
      if (!asset) throw new Error(`Asset ${clipInput.assetId} not found in project`);

      const newClip: Clip = {
        id: clipInput.id || uuidv4(),
        assetId: clipInput.assetId,
        trackId,
        timelineStartSec: clipInput.timelineStartSec,
        timelineEndSec: clipInput.timelineEndSec,
        sourceInSec: clipInput.sourceInSec,
        sourceOutSec: clipInput.sourceOutSec,
        speed: clipInput.speed ?? 1,
        opacity: clipInput.opacity ?? 1,
        volume: clipInput.volume ?? 1,
        muted: clipInput.muted ?? false,
        effects: [],
        keyframes: [],
        transition: null,
      };

      for (const existing of track.clips) {
        if (overlaps(newClip, existing)) {
          throw new Error(
            `Clip overlaps an existing clip on this track at ${existing.timelineStartSec.toFixed(2)}s-${existing.timelineEndSec.toFixed(2)}s`
          );
        }
      }

      track.clips.push(newClip);
      return structuredClone(project);
    },

    async moveClip(clipId, newTrackId, newStartSec) {
      const found = findClip(clipId);
      if (!found) throw new Error(`Clip ${clipId} not found`);
      const { clip, track: oldTrack } = found;

      const duration = clip.timelineEndSec - clip.timelineStartSec;
      const newEnd = newStartSec + duration;

      const targetTrack = project.tracks.find((t) => t.id === newTrackId);
      if (!targetTrack) throw new Error(`Target track ${newTrackId} not found`);

      for (const existing of targetTrack.clips) {
        if (existing.id === clipId) continue;
        if (overlaps({ timelineStartSec: newStartSec, timelineEndSec: newEnd }, existing)) {
          throw new Error(
            `Move would overlap an existing clip at ${existing.timelineStartSec.toFixed(2)}s-${existing.timelineEndSec.toFixed(2)}s`
          );
        }
      }

      oldTrack.clips = oldTrack.clips.filter((c) => c.id !== clipId);
      targetTrack.clips.push({ ...clip, trackId: newTrackId, timelineStartSec: newStartSec, timelineEndSec: newEnd });

      return structuredClone(project);
    },

    async trimClip(clipId, newTimelineStart, newTimelineEnd) {
      const found = findClip(clipId);
      if (!found) throw new Error(`Clip ${clipId} not found`);
      const { clip } = found;

      if (newTimelineStart >= 0) {
        const delta = newTimelineStart - clip.timelineStartSec;
        clip.timelineStartSec = newTimelineStart;
        clip.sourceInSec += delta;
      }
      if (newTimelineEnd >= 0) {
        const delta = newTimelineEnd - clip.timelineEndSec;
        clip.timelineEndSec = newTimelineEnd;
        clip.sourceOutSec += delta;
      }

      if (clip.timelineEndSec <= clip.timelineStartSec) throw new Error("Trim would result in zero or negative duration");
      if (clip.sourceOutSec <= clip.sourceInSec) throw new Error("Trim would result in zero or negative source range");

      return structuredClone(project);
    },

    async splitClip(clipId, splitAtSec) {
      const found = findClip(clipId);
      if (!found) throw new Error(`Clip ${clipId} not found`);
      const { clip, track } = found;

      if (splitAtSec <= clip.timelineStartSec || splitAtSec >= clip.timelineEndSec) {
        throw new Error("Split point must be strictly inside the clip's range");
      }

      const sourceSplitPoint = clip.sourceInSec + (splitAtSec - clip.timelineStartSec);

      const left: Clip = { ...clip, timelineEndSec: splitAtSec, sourceOutSec: sourceSplitPoint };
      const right: Clip = { ...clip, id: uuidv4(), timelineStartSec: splitAtSec, sourceInSec: sourceSplitPoint };

      track.clips = track.clips.flatMap((c) => (c.id === clipId ? [left, right] : [c]));
      return structuredClone(project);
    },

    async deleteClip(clipId) {
      for (const track of project.tracks) {
        const before = track.clips.length;
        track.clips = track.clips.filter((c) => c.id !== clipId);
        if (track.clips.length !== before) return structuredClone(project);
      }
      throw new Error(`Clip ${clipId} not found`);
    },

    async duplicateClip(clipId) {
      const found = findClip(clipId);
      if (!found) throw new Error(`Clip ${clipId} not found`);
      const { clip, track } = found;

      const duration = clip.timelineEndSec - clip.timelineStartSec;
      const copy: Clip = { ...clip, id: uuidv4(), timelineStartSec: clip.timelineEndSec, timelineEndSec: clip.timelineEndSec + duration };

      for (const existing of track.clips) {
        if (overlaps(copy, existing)) {
          throw new Error("No room to duplicate clip immediately after itself - move it first");
        }
      }

      track.clips.push(copy);
      return { project: structuredClone(project), newClipId: copy.id };
    },

    async addTextTrack(name) {
      const textTrackCount = project.tracks.filter((t) => t.type === "text").length;
      const maxOrder = Math.max(-1, ...project.tracks.filter((t) => t.type === "text").map((t) => t.order));
      project.tracks.push({
        id: uuidv4(),
        type: "text",
        name: name || `Text ${textTrackCount + 1}`,
        order: maxOrder + 1,
        locked: false,
        hidden: false,
        muted: false,
        clips: [],
        textClips: [],
      });
      return structuredClone(project);
    },

    async addTextClip(trackId, clipInput) {
      const track = project.tracks.find((t) => t.id === trackId);
      if (!track) throw new Error(`Track ${trackId} not found`);
      if (track.type !== "text") throw new Error(`Track ${trackId} is not a text track`);
      if (!clipInput.content || !clipInput.content.trim()) throw new Error("Text content cannot be empty");
      if (clipInput.timelineEndSec <= clipInput.timelineStartSec) throw new Error("Text clip must have a positive duration");

      const newClip: TextClip = {
        id: clipInput.id || uuidv4(),
        trackId,
        timelineStartSec: clipInput.timelineStartSec,
        timelineEndSec: clipInput.timelineEndSec,
        content: clipInput.content,
        fontFamily: clipInput.fontFamily || "sans",
        fontSize: clipInput.fontSize || 32,
        fontWeight: clipInput.fontWeight || "bold",
        color: clipInput.color || "#ffffff",
        positionXPercent: clipInput.positionXPercent ?? 50,
        positionYPercent: clipInput.positionYPercent ?? 85,
        alignment: clipInput.alignment || "center",
        outlineEnabled: clipInput.outlineEnabled ?? false,
        outlineColor: clipInput.outlineColor || "#000000",
        outlineWidth: clipInput.outlineWidth ?? 2,
        shadowEnabled: clipInput.shadowEnabled ?? false,
        shadowColor: clipInput.shadowColor || "#000000",
        opacity: clipInput.opacity ?? 1,
      };

      track.textClips.push(newClip);
      return structuredClone(project);
    },

    async updateTextClip(clipId, updated) {
      const found = findTextClip(clipId);
      if (!found) throw new Error(`Text clip ${clipId} not found`);
      if (!updated.content || !updated.content.trim()) throw new Error("Text content cannot be empty");
      if (updated.timelineEndSec <= updated.timelineStartSec) throw new Error("Text clip must have a positive duration");

      const { track } = found;
      const idx = track.textClips.findIndex((c) => c.id === clipId);
      track.textClips[idx] = { ...updated, id: clipId, trackId: track.id };
      return structuredClone(project);
    },

    async deleteTextClip(clipId) {
      for (const track of project.tracks) {
        const before = track.textClips.length;
        track.textClips = track.textClips.filter((c) => c.id !== clipId);
        if (track.textClips.length !== before) return structuredClone(project);
      }
      throw new Error(`Text clip ${clipId} not found`);
    },

    async moveTextClip(clipId, newStartSec) {
      const found = findTextClip(clipId);
      if (!found) throw new Error(`Text clip ${clipId} not found`);
      const { clip } = found;
      const duration = clip.timelineEndSec - clip.timelineStartSec;
      clip.timelineStartSec = newStartSec;
      clip.timelineEndSec = newStartSec + duration;
      return structuredClone(project);
    },

    async addEffect(clipId, effect) {
      const found = findClip(clipId);
      if (!found) throw new Error(`Clip ${clipId} not found`);
      const newEffect: Effect = {
        id: uuidv4(),
        type: effect.type,
        params: effect.params ?? defaultEffectParams(effect.type),
        enabled: effect.enabled ?? true,
      };
      found.clip.effects = [...(found.clip.effects ?? []), newEffect];
      return structuredClone(project);
    },

    async updateEffect(clipId, effectId, updated) {
      const found = findClip(clipId);
      if (!found) throw new Error(`Clip ${clipId} not found`);
      const idx = (found.clip.effects ?? []).findIndex((e) => e.id === effectId);
      if (idx < 0) throw new Error(`Effect ${effectId} not found on clip ${clipId}`);
      found.clip.effects[idx] = { ...updated, id: effectId };
      return structuredClone(project);
    },

    async removeEffect(clipId, effectId) {
      const found = findClip(clipId);
      if (!found) throw new Error(`Clip ${clipId} not found`);
      found.clip.effects = (found.clip.effects ?? []).filter((e) => e.id !== effectId);
      return structuredClone(project);
    },

    async setTransition(clipId, transition) {
      const found = findClip(clipId);
      if (!found) throw new Error(`Clip ${clipId} not found`);
      const newTransition: Transition = {
        id: uuidv4(),
        type: transition.type,
        durationSec: transition.durationSec ?? 1,
        nextClipId: transition.nextClipId,
        direction: transition.direction || "left",
        easing: transition.easing || "linear",
      };
      found.clip.transition = newTransition;
      return structuredClone(project);
    },

    async removeTransition(clipId) {
      const found = findClip(clipId);
      if (!found) throw new Error(`Clip ${clipId} not found`);
      found.clip.transition = null;
      return structuredClone(project);
    },

    async openFileDialog() {
      // Browsers can't show a native OS path-returning dialog the way
      // Wails can; the mock UI substitutes a hidden <input type=file>
      // element instead (wired up in the media feature's import button)
      // and never calls this method directly in dev mode.
      return [];
    },

    async readMediaFileAsDataUrl(path) {
      // In mock mode, "paths" are already blob: URLs the browser can
      // load directly (see mockMediaImport.ts) - nothing to resolve.
      return path;
    },

    async importMediaFiles(filePaths) {
      // In mock mode, "file paths" are actually object URLs created from
      // real File objects the user dropped/selected in the browser (see
      // mockMediaImport.ts) - this lets thumbnail/duration extraction
      // use real <video>/<img> elements client-side instead of ffmpeg.
      const errors: { error: string }[] = [];
      for (const path of filePaths) {
        try {
          const asset = await import("./mockMediaImport").then((m) => m.probeAssetFromObjectUrl(path));
          project.assets.push(asset);
        } catch (e: any) {
          errors.push({ error: e.message || String(e) });
        }
      }
      return { project: structuredClone(project), errors };
    },

    async startExport(_settings) {
      const jobId = uuidv4();
      // Simulate a render with fake progress ticks so the export UI can
      // be built and tested without invoking real ffmpeg from the
      // browser.
      let percent = 0;
      const interval = setInterval(() => {
        percent += 10 + Math.random() * 10;
        if (percent >= 100) {
          percent = 100;
          clearInterval(interval);
          progressListeners.forEach((cb) => cb({ jobId, percentDone: 100, currentStage: "done" }));
        } else {
          progressListeners.forEach((cb) => cb({ jobId, percentDone: percent, currentStage: "rendering" }));
        }
      }, 400);
      return jobId;
    },

    async cancelExport() {
      // no-op in mock
    },

    onExportProgress(callback) {
      progressListeners.push(callback);
      return () => {
        const idx = progressListeners.indexOf(callback);
        if (idx >= 0) progressListeners.splice(idx, 1);
      };
    },
  };
}

export type { MediaAsset };
