// Package models defines the core data structures for a video editing project.
//
// These types are serialized to/from project.json and are also mirrored
// (field-for-field, same JSON tags) in the frontend's TypeScript types
// (frontend/src/types/project.ts). If you change a field here, update the
// TS side too, or the Wails-bound methods will silently produce data the
// UI can't parse correctly.
package models

import "time"

// MediaType enumerates the kinds of source media a project can import.
type MediaType string

const (
	MediaVideo MediaType = "video"
	MediaAudio MediaType = "audio"
	MediaImage MediaType = "image"
)

// TrackType enumerates timeline track kinds. Phase 1 supports video tracks
// (which may contain video or image clips) and audio tracks separately,
// matching how most NLEs (Premiere, CapCut, Resolve) split video/audio
// track stacks even when a clip technically carries both.
type TrackType string

const (
	TrackVideo TrackType = "video"
	TrackAudio TrackType = "audio"
	TrackText  TrackType = "text"
)

// MediaAsset represents one imported source file, before it's placed on
// any timeline. Metadata (duration, resolution, fps) is extracted once at
// import time via ffprobe and cached here so we never need to re-probe
// just to compute timeline layout.
type MediaAsset struct {
	ID            string    `json:"id"`
	FileName      string    `json:"fileName"`
	FilePath      string    `json:"filePath"`      // absolute path to the original file (kept outside the project dir; we don't copy large media by default)
	ThumbnailPath string    `json:"thumbnailPath"` // path inside <project>/thumbnails/
	MediaType     MediaType `json:"mediaType"`
	DurationSec   float64   `json:"durationSec"` // 0 for images
	Width         int       `json:"width"`
	Height        int       `json:"height"`
	FPS           float64   `json:"fps"`        // 0 for images/audio
	SampleRate    int       `json:"sampleRate"` // audio only, 0 otherwise
	Channels      int       `json:"channels"`   // audio only, 0 otherwise
	FileSizeBytes int64     `json:"fileSizeBytes"`
	ImportedAt    time.Time `json:"importedAt"`
}

// Clip is one instance of a MediaAsset placed on a track. The same asset
// can appear as multiple clips (e.g. used twice in a project), so Clip has
// its own ID distinct from the asset's ID.
//
// Timing model:
//   - TimelineStartSec / TimelineEndSec: where this clip sits on the
//     overall project timeline (the "outer" time).
//   - SourceInSec / SourceOutSec: which portion of the underlying asset is
//     played (the "inner" / source time), i.e. trim in/out points.
//
// (TimelineEndSec - TimelineStartSec) must equal
// (SourceOutSec - SourceInSec) / Speed. We store Speed separately rather
// than implying it, so trim and speed-change operations stay independent
// and unambiguous when building the export filter graph.
type Clip struct {
	ID               string  `json:"id"`
	AssetID          string  `json:"assetId"`
	TrackID          string  `json:"trackId"`
	TimelineStartSec float64 `json:"timelineStartSec"`
	TimelineEndSec   float64 `json:"timelineEndSec"`
	SourceInSec      float64 `json:"sourceInSec"`
	SourceOutSec     float64 `json:"sourceOutSec"`
	Speed            float64 `json:"speed"`   // 1.0 = normal speed; reserved for later phase, must stay 1.0 in Phase 1
	Opacity          float64 `json:"opacity"` // 0..1, video/image clips only; reserved for layering, default 1.0
	Volume           float64 `json:"volume"`  // 0..1 (or up to 2.0 for boost), audio-bearing clips only
	Muted            bool    `json:"muted"`
}

// TextClip is a title/caption placed directly on the timeline. Unlike
// Clip, it has no AssetID — its "content" is the styling and text baked
// into the clip itself, since text isn't sourced from an imported media
// file. It lives on its own TrackText-type track, always composited
// above every video track (text is the topmost layer by definition in
// Phase 1 — true z-ordering among multiple text tracks is a later-phase
// concern once there's a reason to need it).
//
// Position (PositionXPercent/PositionYPercent) is stored as 0-100
// percentages of canvas width/height, not raw pixels, so the same
// TextClip looks correct regardless of the project's resolution or any
// future resize - this mirrors how the canvas compositor and the export
// filter graph both already treat opacity/timing as resolution-
// independent.
type TextClip struct {
	ID               string  `json:"id"`
	TrackID          string  `json:"trackId"`
	TimelineStartSec float64 `json:"timelineStartSec"`
	TimelineEndSec   float64 `json:"timelineEndSec"`
	Content          string  `json:"content"`
	FontFamily       string  `json:"fontFamily"`       // a key into the font registry (see backend/export font map), not a raw file path
	FontSize         int     `json:"fontSize"`         // in pixels, relative to the project's canvas height (see export scaling note)
	FontWeight       string  `json:"fontWeight"`       // "normal" | "bold"
	Color            string  `json:"color"`            // hex, e.g. "#ffffff"
	PositionXPercent float64 `json:"positionXPercent"` // 0-100, horizontal center of the text box
	PositionYPercent float64 `json:"positionYPercent"` // 0-100, vertical center of the text box
	Alignment        string  `json:"alignment"`        // "left" | "center" | "right" - multi-line text alignment, not position
	OutlineEnabled   bool    `json:"outlineEnabled"`
	OutlineColor     string  `json:"outlineColor"`
	OutlineWidth     int     `json:"outlineWidth"` // pixels
	ShadowEnabled    bool    `json:"shadowEnabled"`
	ShadowColor      string  `json:"shadowColor"`
	Opacity          float64 `json:"opacity"` // 0..1
}

// Track is an ordered lane of non-overlapping clips. Within a single
// Track, clips must not overlap in timeline time — overlap across
// *different* tracks is exactly what lets multiple video layers exist,
// which is composited in preview and export by track order.
type Track struct {
	ID        string     `json:"id"`
	Type      TrackType  `json:"type"`
	Name      string     `json:"name"`
	Order     int        `json:"order"` // lower Order = lower in the visual stack (rendered first / underneath)
	Locked    bool       `json:"locked"`
	Hidden    bool       `json:"hidden"` // video tracks: skip in preview/export compositing
	Muted     bool       `json:"muted"`  // audio-bearing tracks: skip in audio mixdown
	Clips     []Clip     `json:"clips"`
	TextClips []TextClip `json:"textClips"` // only populated for Type == TrackText
}

// Project is the root object persisted as project.json inside a project
// folder (see ProjectPaths for the on-disk layout).
type Project struct {
	ID            string       `json:"id"`
	Name          string       `json:"name"`
	CreatedAt     time.Time    `json:"createdAt"`
	ModifiedAt    time.Time    `json:"modifiedAt"`
	FormatVersion int          `json:"formatVersion"` // bump on breaking schema changes; lets us migrate old project.json files later
	CanvasWidth   int          `json:"canvasWidth"`   // export/preview resolution basis, e.g. 1920
	CanvasHeight  int          `json:"canvasHeight"`  // e.g. 1080
	FPS           float64      `json:"fps"`           // project (timeline) frame rate, e.g. 30
	Tracks        []Track      `json:"tracks"`
	Assets        []MediaAsset `json:"assets"`
}

// ExportSettings configures one render job.
type ExportSettings struct {
	OutputPath string  `json:"outputPath"`
	Format     string  `json:"format"` // "mp4" | "mov" | "webm" | "mkv"
	Width      int     `json:"width"`
	Height     int     `json:"height"`
	FPS        float64 `json:"fps"`
	Quality    string  `json:"quality"` // "low" | "medium" | "high" | "ultra"
}

// ExportProgress is streamed to the frontend during a render so the UI can
// show a real progress bar instead of an indeterminate spinner.
type ExportProgress struct {
	JobID        string  `json:"jobId"`
	PercentDone  float64 `json:"percentDone"`
	CurrentStage string  `json:"currentStage"` // "preparing" | "rendering" | "finalizing" | "done" | "error"
	ErrorMessage string  `json:"errorMessage,omitempty"`
}
