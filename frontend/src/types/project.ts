// Mirrors backend/models/models.go exactly. If a field changes on the Go
// side, update it here too — Wails serializes Go structs to JSON using
// their `json:"..."` tags, and these types describe that exact JSON
// shape as it arrives in the frontend.

export type MediaType = "video" | "audio" | "image";
export type TrackType = "video" | "audio" | "text";

export interface TextClip {
  id: string;
  trackId: string;
  timelineStartSec: number;
  timelineEndSec: number;
  content: string;
  fontFamily: string; // "sans" | "serif" | "mono" - keys into the backend's bundled font registry
  fontSize: number;
  fontWeight: "normal" | "bold";
  color: string; // hex, e.g. "#ffffff"
  positionXPercent: number; // 0-100, horizontal center of the text box
  positionYPercent: number; // 0-100, vertical center of the text box
  alignment: "left" | "center" | "right";
  outlineEnabled: boolean;
  outlineColor: string;
  outlineWidth: number;
  shadowEnabled: boolean;
  shadowColor: string;
  opacity: number;
}

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

export type EffectType =
  | "blur"
  | "sharpen"
  | "brightness"
  | "contrast"
  | "saturation"
  | "vignette"
  | "grain"
  | "vhs"
  | "rgbshift";

export interface Effect {
  id: string;
  type: EffectType;
  params: Record<string, number>;
  enabled: boolean;
}

export type TransitionType = "fade" | "dissolve" | "wipe" | "slide" | "push" | "zoom";
export type InterpolationType = "linear" | "easeIn" | "easeOut" | "bezier";

export interface Transition {
  id: string;
  type: TransitionType;
  durationSec: number;
  nextClipId: string;
  direction: string; // "left" | "right" | "up" | "down"
  easing: InterpolationType;
}

export type KeyframeProperty = "positionX" | "positionY" | "rotation" | "scale" | "opacity";

export interface Keyframe {
  id: string;
  property: KeyframeProperty;
  timeSec: number;
  value: number;
  interpolation: InterpolationType;
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
  effects: Effect[];
  keyframes: Keyframe[];
  transition?: Transition | null;
}

export interface Track {
  id: string;
  type: TrackType;
  name: string;
  order: number;
  locked: boolean;
  hidden: boolean;
  muted: boolean;
  height?: number; // per-track timeline lane height in px; undefined/0 = UI default
  clips: Clip[];
  textClips: TextClip[];
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
  outputPath?: string; // set on "done": absolute path of the rendered file
}

export interface RecentEntry {
  projectDir: string;
  name: string;
  lastOpened: string;
}

export interface AppSettings {
  projectsRootDir: string;
  hasCompletedSetup: boolean;
}
