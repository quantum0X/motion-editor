import { v4 as uuidv4 } from "uuid";
import type { EditorBackend } from "./EditorBackend";
import type { Project, Clip, Track, MediaAsset, ExportProgress } from "../types/project";

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
      { id: uuidv4(), type: "video", name: "Video 2", order: 1, locked: false, hidden: false, muted: false, clips: [] },
      { id: uuidv4(), type: "video", name: "Video 1", order: 0, locked: false, hidden: false, muted: false, clips: [] },
      { id: uuidv4(), type: "audio", name: "Audio 1", order: 0, locked: false, hidden: false, muted: false, clips: [] },
    ],
    assets: [],
  };
}

export function createMockBackend(): EditorBackend {
  let project: Project = makeEmptyProject("Untitled Project");
  const progressListeners: ((p: ExportProgress) => void)[] = [];

  function findClip(clipId: string): { clip: Clip; track: Track } | null {
    for (const track of project.tracks) {
      const clip = track.clips.find((c) => c.id === clipId);
      if (clip) return { clip, track };
    }
    return null;
  }

  function overlaps(a: Clip | { timelineStartSec: number; timelineEndSec: number }, b: Clip): boolean {
    return a.timelineStartSec < b.timelineEndSec && a.timelineEndSec > b.timelineStartSec;
  }

  return {
    async newProject(name, w, h, fps) {
      project = makeEmptyProject(name, w, h, fps);
      return structuredClone(project);
    },

    async openProject(_dir) {
      // Mock has nothing real to open; return the in-memory project as-is
      // so UI flows (recent projects list, open dialog) can still be
      // exercised end-to-end in the browser.
      return structuredClone(project);
    },

    async saveProject() {
      project.modifiedAt = new Date().toISOString();
      return structuredClone(project);
    },

    async saveProjectAs(newName) {
      project = { ...structuredClone(project), id: uuidv4(), name: newName };
      return structuredClone(project);
    },

    async autoSave() {
      // no-op in mock
    },

    async recentProjects() {
      return [{ projectDir: "/mock/Projects/" + project.name, name: project.name, lastOpened: new Date().toISOString() }];
    },

    async getCurrentProject() {
      return structuredClone(project);
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

    async openFileDialog() {
      // Browsers can't show a native OS path-returning dialog the way
      // Wails can; the mock UI substitutes a hidden <input type=file>
      // element instead (wired up in the media feature's import button)
      // and never calls this method directly in dev mode.
      return [];
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
