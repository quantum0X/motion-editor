// Mirrors backend/models/models.go exactly. If a field changes on the Go
// side, update it here too — Wails serializes Go structs to JSON using
// their `json:"..."` tags, and these types describe that exact JSON
// shape as it arrives in the frontend.

export type MediaType = "video" | "audio" | "image";
export type TrackType = "video" | "audio";

export interface MediaAsset {
  id: string;
  fileName: string;
  filePath: string;
  thumbnailPath: string;
  mediaType: MediaType;
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  sampleRate: number;
  channels: number;
  fileSizeBytes: number;
  importedAt: string; // ISO timestamp string (Go time.Time marshals to RFC3339)
}

export interface Clip {
  id: string;
  assetId: string;
  trackId: string;
  timelineStartSec: number;
  timelineEndSec: number;
  sourceInSec: number;
  sourceOutSec: number;
  speed: number;
  opacity: number;
  volume: number;
  muted: boolean;
}

export interface Track {
  id: string;
  type: TrackType;
  name: string;
  order: number;
  locked: boolean;
  hidden: boolean;
  muted: boolean;
  clips: Clip[];
}

export interface Project {
  id: string;
  name: string;
  createdAt: string;
  modifiedAt: string;
  formatVersion: number;
  canvasWidth: number;
  canvasHeight: number;
  fps: number;
  tracks: Track[];
  assets: MediaAsset[];
}

export interface ExportSettings {
  outputPath: string;
  format: "mp4" | "mov" | "webm" | "mkv";
  width: number;
  height: number;
  fps: number;
  quality: "low" | "medium" | "high" | "ultra";
}

export interface ExportProgress {
  jobId: string;
  percentDone: number;
  currentStage: "preparing" | "rendering" | "finalizing" | "done" | "error";
  errorMessage?: string;
}

export interface RecentEntry {
  projectDir: string;
  name: string;
  lastOpened: string;
}
