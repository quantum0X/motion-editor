// Package models defines the core data structures for a video editing project.
//
// These types are serialized to/from project.json and are also mirrored
// (field-for-field, same JSON tags) in the frontend's TypeScript types
// (frontend/src/types/project.ts). If you change a field here, update the
// TS side too, or the Wails-bound methods will silently produce data the
// UI can't parse correctly.
package models

import (
	"encoding/json"
	"time"
)

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
	TrackVideo    TrackType = "video"
	TrackAudio    TrackType = "audio"
	TrackText     TrackType = "text"
	TrackSubtitle TrackType = "subtitle"
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

// TransitionType enumerates the supported clip-to-clip transitions.
// Implemented via `xfade` in the export filter graph (see
// backend/export/transitions.go) - dissolve/fade/wipe/slide are all
// `xfade` transition presets, so adding more of xfade's ~50 built-in
// presets later is cheap; this list covers the original spec's
// explicit ask (fade, dissolve, zoom, slide, wipe, push).
type TransitionType string

const (
	TransitionFade     TransitionType = "fade"
	TransitionDissolve TransitionType = "dissolve"
	TransitionWipe     TransitionType = "wipe"
	TransitionSlide    TransitionType = "slide"
	TransitionPush     TransitionType = "push"
	TransitionZoom     TransitionType = "zoom"
)

// Transition describes a crossfade-style transition applied at the
// boundary between two adjacent clips on the SAME track. It's attached
// to the EARLIER clip (the one whose TimelineEndSec is the boundary) and
// references the later clip by ID, rather than living as a standalone
// timeline object - this guarantees a transition can never exist
// without exactly the two clips it blends between, and moves/deletes of
// either clip have one clear place to also invalidate the transition.
type Transition struct {
	ID          string            `json:"id"`
	Type        TransitionType    `json:"type"`
	DurationSec float64           `json:"durationSec"` // how long the two clips overlap/blend
	NextClipID  string            `json:"nextClipId"`  // the clip immediately following this one on the same track
	Direction   string            `json:"direction"`   // meaningful for wipe/slide/push: "left" | "right" | "up" | "down"
	Easing      InterpolationType `json:"easing"`
}

type Clip struct {
	ID               string      `json:"id"`
	AssetID          string      `json:"assetId"`
	TrackID          string      `json:"trackId"`
	TimelineStartSec float64     `json:"timelineStartSec"`
	TimelineEndSec   float64     `json:"timelineEndSec"`
	SourceInSec      float64     `json:"sourceInSec"`
	SourceOutSec     float64     `json:"sourceOutSec"`
	Speed            float64     `json:"speed"`   // 1.0 = normal speed; reserved for later phase, must stay 1.0 in Phase 1
	Opacity          float64     `json:"opacity"` // 0..1, video/image clips only; reserved for layering, default 1.0
	Volume           float64     `json:"volume"`  // 0..1 (or up to 2.0 for boost), audio-bearing clips only
	Muted            bool        `json:"muted"`
	Effects          []Effect    `json:"effects"`              // applied in array order; see Effect doc comment
	Keyframes        []Keyframe  `json:"keyframes"`            // animates position/rotation/scale/opacity over the clip's own local time
	Transition       *Transition `json:"transition,omitempty"` // transition INTO the next clip on this track, if any; nil means a hard cut
}

// MarshalJSON normalizes Effects/Keyframes to non-nil arrays for the same
// reason documented on Track.MarshalJSON above - most Clip{} construction
// sites only set the fields relevant to the operation at hand (e.g.
// AddClipToTrack never touches Effects), leaving these nil and therefore
// `null` on the wire unless normalized here.
func (c Clip) MarshalJSON() ([]byte, error) {
	type alias Clip
	a := alias(c)
	if a.Effects == nil {
		a.Effects = []Effect{}
	}
	if a.Keyframes == nil {
		a.Keyframes = []Keyframe{}
	}
	return json.Marshal(a)
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

// SubtitleClip is one caption line. Modeled separately from TextClip
// (rather than reusing it with different defaults) because subtitles
// have different semantics worth keeping distinct in the data model:
// they're typically sequential and non-overlapping (one line visible at
// a time), commonly imported/exported as a block via SRT, and intended
// to eventually be machine-generated (the original spec's "Auto
// Subtitle Engine" - explicitly deferred; this phase covers manual
// create/edit/delete only). Styling is intentionally minimal compared
// to TextClip's full font/position/outline/shadow controls - standard
// subtitle conventions (bottom-center, outlined white text) cover the
// vast majority of real usage and match what SRT itself can express.
type SubtitleClip struct {
	ID               string  `json:"id"`
	TrackID          string  `json:"trackId"`
	TimelineStartSec float64 `json:"timelineStartSec"`
	TimelineEndSec   float64 `json:"timelineEndSec"`
	Content          string  `json:"content"`
}

// Track is an ordered lane of non-overlapping clips. Within a single
// Track, clips must not overlap in timeline time — overlap across
// *different* tracks is exactly what lets multiple video layers exist,
// which is composited in preview and export by track order.
type Track struct {
	ID            string         `json:"id"`
	Type          TrackType      `json:"type"`
	Name          string         `json:"name"`
	Order         int            `json:"order"` // lower Order = lower in the visual stack (rendered first / underneath)
	Locked        bool           `json:"locked"`
	Hidden        bool           `json:"hidden"` // video tracks: skip in preview/export compositing
	Muted         bool           `json:"muted"`  // audio-bearing tracks: skip in audio mixdown
	Height        int            `json:"height,omitempty"` // per-track timeline lane height in px; 0 means "use the UI default"
	Clips         []Clip         `json:"clips"`
	TextClips     []TextClip     `json:"textClips"`     // only populated for Type == TrackText
	SubtitleClips []SubtitleClip `json:"subtitleClips"` // only populated for Type == TrackSubtitle
}

// MarshalJSON normalizes every slice field to a non-nil (possibly empty)
// array before serializing.
//
// Why this exists: a Track literal that only sets Clips (e.g. a freshly
// created video/audio track never touches TextClips/SubtitleClips) leaves
// those fields at Go's zero value for a slice, which is `nil`. Go's
// encoding/json marshals a nil slice as JSON `null`, not `[]` - even
// though the field has no `omitempty` tag. The frontend (see
// frontend/src/types/project.ts) always types these as arrays and calls
// array methods on them unconditionally (e.g. `track.textClips.map(...)`
// or `project.tracks.flatMap(t => t.textClips)`); receiving `null`
// instead of `[]` for any non-text/non-subtitle track throws a
// TypeError deep in a render function, which (with no error boundary
// mounted) unmounts the entire React tree and leaves a blank/black
// screen - this was a real, reproduced bug (nil TextClips on the
// video/audio tracks created by NewProject), not a hypothetical one.
// A type-local MarshalJSON is a more durable fix than hunting down and
// fixing every Track{} construction site by hand, since it also covers
// call sites added later.
func (t Track) MarshalJSON() ([]byte, error) {
	type alias Track // avoids infinite recursion into this same MarshalJSON
	a := alias(t)
	if a.Clips == nil {
		a.Clips = []Clip{}
	}
	if a.TextClips == nil {
		a.TextClips = []TextClip{}
	}
	if a.SubtitleClips == nil {
		a.SubtitleClips = []SubtitleClip{}
	}
	return json.Marshal(a)
}

// Effect is one stackable visual effect applied to a Clip. Effects on a
// single clip apply in array order (Clip.Effects[0] first, etc.) - this
// matches how the export filter graph chains them: each effect becomes
// one more comma-separated stage in that clip's existing
// trim/scale/pad filter chain (see backend/export/builder.go).
//
// Params holds effect-specific values as a flat string-keyed map rather
// than a different Go struct per effect type, since effects are
// data-driven (added/removed/reordered freely in the UI) and this keeps
// the JSON shape and the Go code that walks it uniform regardless of
// which effect it is. Each EffectType's expected param keys are
// documented next to its filter-string builder in
// backend/export/effects.go.
type EffectType string

const (
	EffectBlur       EffectType = "blur"
	EffectSharpen    EffectType = "sharpen"
	EffectBrightness EffectType = "brightness"
	EffectContrast   EffectType = "contrast"
	EffectSaturation EffectType = "saturation"
	EffectVignette   EffectType = "vignette"
	EffectGrain      EffectType = "grain"
	EffectVHS        EffectType = "vhs"
	EffectRGBShift   EffectType = "rgbshift"
)

type Effect struct {
	ID     string             `json:"id"`
	Type   EffectType         `json:"type"`
	Params map[string]float64 `json:"params"`
	// Enabled lets the UI toggle an effect off without losing its
	// configured params - removing it outright would lose whatever
	// values the person had dialed in if they re-enable it later.
	Enabled bool `json:"enabled"`
}

// KeyframeProperty enumerates which Clip property a Keyframe track
// animates. Phase 1 (per the original spec) covers position, rotation,
// scale, and opacity - the four properties every NLE's basic keyframe
// system starts with.
type KeyframeProperty string

const (
	KeyframePositionX KeyframeProperty = "positionX" // pixels, relative to canvas
	KeyframePositionY KeyframeProperty = "positionY"
	KeyframeRotation  KeyframeProperty = "rotation" // degrees
	KeyframeScale     KeyframeProperty = "scale"    // 1.0 = 100%
	KeyframeOpacity   KeyframeProperty = "opacity"  // 0..1
)

// InterpolationType controls how values are blended between two
// consecutive keyframes on the same property.
type InterpolationType string

const (
	InterpolationLinear  InterpolationType = "linear"
	InterpolationEaseIn  InterpolationType = "easeIn"
	InterpolationEaseOut InterpolationType = "easeOut"
	InterpolationBezier  InterpolationType = "bezier" // Phase 1 approximates bezier as ease-in-out (see export/keyframes.go) rather than accepting arbitrary control points
)

// Keyframe is one (time, value) control point on a Clip's animation
// timeline for a given property. TimeSec is relative to the CLIP's own
// timeline position (0 = the clip's TimelineStartSec), not the overall
// project timeline, so a keyframe set doesn't need to be rewritten every
// time the clip is moved on the timeline.
type Keyframe struct {
	ID            string            `json:"id"`
	Property      KeyframeProperty  `json:"property"`
	TimeSec       float64           `json:"timeSec"`
	Value         float64           `json:"value"`
	Interpolation InterpolationType `json:"interpolation"` // interpolation used for the segment FROM this keyframe TO the next one on the same property
}

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
