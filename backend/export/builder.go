// Package export builds and runs FFmpeg commands that render a project's
// timeline (multiple video + audio tracks, each with trimmed/positioned
// clips) down to a single output video file.
//
// The filter-graph strategy implemented here was prototyped and verified
// against a real ffmpeg binary before being encoded as Go (see project
// notes for the verification transcript). The key things that verification
// caught, which are easy to get wrong and worth restating here so nobody
// "simplifies" this later and reintroduces the bugs:
//
//  1. Clips within a single track must be concatenated via the `concat`
//     filter WITHOUT any manual setpts time-shift on the segments —
//     concat itself places each input sequentially. Manually shifting a
//     segment's pts *before* concat double-shifts it and silently
//     produces a longer-than-expected output.
//  2. Gaps between clips on the base (lowest) track must be filled with
//     an explicit `color=black` source of the right duration, inserted
//     into the concat chain in position — concat has no concept of an
//     empty segment.
//  3. Additional (higher) video tracks are composited with `overlay`,
//     not `concat` — each clip on an overlay track gets its own setpts
//     shift to position it at its timeline start, and an
//     `enable='between(t,start,end)'` expression so it's invisible
//     outside its own time range without truncating the output. Tracks
//     are layered bottom-to-top by Track.Order.
//  4. Always pass an explicit `-t <total_duration>` on the final ffmpeg
//     command. Filter-graph output duration metadata is not reliable
//     enough on its own to trust for correctness.
//  5. Audio-bearing clips are independently trimmed/shifted and combined
//     with `amix`; assets with no audio stream must be detected and
//     skipped, or ffmpeg errors out immediately on the missing stream
//     specifier.
package export

import (
	"context"
	"fmt"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"

	"videoeditor/backend/models"
)

// Builder constructs FFmpeg commands from a Project + ExportSettings.
// It needs to know which assets actually have audio streams (probed at
// import time and stored on MediaAsset) to avoid referencing a
// non-existent audio stream in the filter graph.
type Builder struct {
	FFmpegPath string
}

func NewBuilder() *Builder {
	return &Builder{FFmpegPath: "ffmpeg"}
}

// inputRef tracks, for each Clip we need as an ffmpeg input, which
// physical file it comes from and what numeric input index ffmpeg
// assigned it (inputs are deduplicated per *clip*, not per asset, since
// each clip may need different -ss/-t trimming applied at the input
// level for very long source files — see note in buildInputs).
type inputRef struct {
	clip      models.Clip
	asset     models.MediaAsset
	inputIdx  int
}

// PlanExport assembles every piece needed to run the export: the ordered
// list of -i inputs, the full -filter_complex string, and the final
// -map/-t/codec arguments. Splitting "planning" from "execution" like
// this means the filter graph can be unit-tested (as a string) without
// actually invoking ffmpeg.
type ExportPlan struct {
	InputArgs    []string // e.g. ["-i", "/path/a.mp4", "-i", "/path/b.mp4", ...]
	FilterComplex string
	VideoOutLabel string // e.g. "[outv]" -- always set
	AudioOutLabel string // e.g. "[outa]" -- empty string if the project has no audio at all
	TotalDuration float64
}

// assetByID is a small lookup helper built once per export.
func assetByID(proj *models.Project) map[string]models.MediaAsset {
	m := make(map[string]models.MediaAsset, len(proj.Assets))
	for _, a := range proj.Assets {
		m[a.ID] = a
	}
	return m
}

// timelineDuration returns the end time of the latest clip across all
// tracks, i.e. how long the rendered output needs to be.
func timelineDuration(proj *models.Project) float64 {
	var maxEnd float64
	for _, track := range proj.Tracks {
		for _, clip := range track.Clips {
			if clip.TimelineEndSec > maxEnd {
				maxEnd = clip.TimelineEndSec
			}
		}
	}
	return maxEnd
}

// sortedClips returns a track's clips sorted by timeline start time. The
// in-memory order from the project JSON is not guaranteed to be sorted
// (the user can reorder via drag in any sequence of operations), but the
// concat-chain construction requires strictly sequential order.
func sortedClips(track models.Track) []models.Clip {
	clips := make([]models.Clip, len(track.Clips))
	copy(clips, track.Clips)
	sort.Slice(clips, func(i, j int) bool {
		return clips[i].TimelineStartSec < clips[j].TimelineStartSec
	})
	return clips
}

// videoTracksSortedByOrder returns only video tracks, sorted so the
// bottom-most layer (lowest Order) comes first — that track becomes the
// concat-built base layer, and every subsequent track is overlaid on top
// of it in order.
func videoTracksSortedByOrder(proj *models.Project) []models.Track {
	var tracks []models.Track
	for _, t := range proj.Tracks {
		if t.Type == models.TrackVideo && !t.Hidden {
			tracks = append(tracks, t)
		}
	}
	sort.Slice(tracks, func(i, j int) bool { return tracks[i].Order < tracks[j].Order })
	return tracks
}

func audioTracksNotMuted(proj *models.Project) []models.Track {
	var tracks []models.Track
	for _, t := range proj.Tracks {
		if t.Type == models.TrackAudio && !t.Muted {
			tracks = append(tracks, t)
		}
	}
	sort.Slice(tracks, func(i, j int) bool { return tracks[i].Order < tracks[j].Order })
	return tracks
}

// Plan builds the full ExportPlan for a project at the given canvas
// resolution/fps (from settings). It does not run ffmpeg.
func Plan(proj *models.Project, settings models.ExportSettings) (*ExportPlan, error) {
	assets := assetByID(proj)
	totalDuration := timelineDuration(proj)
	if totalDuration <= 0 {
		return nil, fmt.Errorf("timeline is empty - nothing to export")
	}

	var inputArgs []string
	inputIdx := 0
	var filterParts []string

	// nextInput appends a -i argument for a clip's source file and
	// returns the ffmpeg input index assigned to it. Every clip gets its
	// own input (rather than reusing one input per asset across multiple
	// clips) — simpler to reason about and avoids ffmpeg input-seeking
	// edge cases when the same asset is trimmed differently in two
	// places, at the cost of decoding shared source files more than
	// once. For Phase 1 project sizes this tradeoff is the right one;
	// revisit if export time on long projects with heavily reused assets
	// becomes a problem.
	nextInput := func(asset models.MediaAsset) int {
		inputArgs = append(inputArgs, "-i", asset.FilePath)
		idx := inputIdx
		inputIdx++
		return idx
	}

	videoTracks := videoTracksSortedByOrder(proj)
	if len(videoTracks) == 0 {
		return nil, fmt.Errorf("project has no visible video tracks")
	}

	// --- Base layer: bottom-most video track, built via concat ---
	baseTrack := videoTracks[0]
	baseClips := sortedClips(baseTrack)

	concatLabels := []string{}
	cursor := 0.0
	segmentIdx := 0

	for _, clip := range baseClips {
		asset, ok := assets[clip.AssetID]
		if !ok {
			return nil, fmt.Errorf("clip %s references unknown asset %s", clip.ID, clip.AssetID)
		}

		// Fill any gap before this clip with black.
		if clip.TimelineStartSec > cursor+0.001 {
			gapDur := clip.TimelineStartSec - cursor
			label := fmt.Sprintf("gap%d", segmentIdx)
			filterParts = append(filterParts, fmt.Sprintf(
				"color=black:size=%dx%d:rate=%g:duration=%.6f[%s]",
				settings.Width, settings.Height, settings.FPS, gapDur, label,
			))
			concatLabels = append(concatLabels, "["+label+"]")
			segmentIdx++
		}

		idx := nextInput(asset)
		label := fmt.Sprintf("seg%d", segmentIdx)
		clipDuration := clip.SourceOutSec - clip.SourceInSec

		var videoFilter string
		if asset.MediaType == models.MediaImage {
			// Images have no inherent duration/trim points - loop a
			// single frame for the clip's full timeline duration instead
			// of using trim (which applies to a video stream's time
			// axis, not a static image).
			videoFilter = fmt.Sprintf(
				"[%d:v]scale=%d:%d:force_original_aspect_ratio=decrease,pad=%d:%d:(ow-iw)/2:(oh-ih)/2,setsar=1,loop=loop=-1:size=1,trim=duration=%.6f,setpts=PTS-STARTPTS[%s]",
				idx, settings.Width, settings.Height, settings.Width, settings.Height, clipDuration, label,
			)
		} else {
			videoFilter = fmt.Sprintf(
				"[%d:v]trim=start=%.6f:end=%.6f,setpts=PTS-STARTPTS,scale=%d:%d:force_original_aspect_ratio=decrease,pad=%d:%d:(ow-iw)/2:(oh-ih)/2,setsar=1[%s]",
				idx, clip.SourceInSec, clip.SourceOutSec, settings.Width, settings.Height, settings.Width, settings.Height, label,
			)
		}
		filterParts = append(filterParts, videoFilter)
		concatLabels = append(concatLabels, "["+label+"]")

		cursor = clip.TimelineEndSec
		segmentIdx++
	}

	// Trailing gap to fill the rest of the timeline if the base track
	// ends before the overall project duration (e.g. an overlay track
	// extends past the last base clip).
	if totalDuration > cursor+0.001 {
		gapDur := totalDuration - cursor
		label := fmt.Sprintf("gap%d", segmentIdx)
		filterParts = append(filterParts, fmt.Sprintf(
			"color=black:size=%dx%d:rate=%g:duration=%.6f[%s]",
			settings.Width, settings.Height, settings.FPS, gapDur, label,
		))
		concatLabels = append(concatLabels, "["+label+"]")
		segmentIdx++
	}

	if len(concatLabels) == 0 {
		return nil, fmt.Errorf("base video track has no clips")
	}

	currentVideoLabel := "trackbase"
	if len(concatLabels) == 1 {
		// concat with n=1 is invalid in ffmpeg; a single segment can be
		// passed straight through with a no-op filter rename instead.
		filterParts = append(filterParts, fmt.Sprintf("%snull[%s]", concatLabels[0], currentVideoLabel))
	} else {
		filterParts = append(filterParts, fmt.Sprintf(
			"%sconcat=n=%d:v=1:a=0[%s]",
			strings.Join(concatLabels, ""), len(concatLabels), currentVideoLabel,
		))
	}

	// --- Overlay layers: every video track above the base ---
	for trackPos, track := range videoTracks[1:] {
		for clipPos, clip := range sortedClips(track) {
			asset, ok := assets[clip.AssetID]
			if !ok {
				return nil, fmt.Errorf("clip %s references unknown asset %s", clip.ID, clip.AssetID)
			}
			idx := nextInput(asset)
			overlayLabel := fmt.Sprintf("ovl_%d_%d", trackPos, clipPos)
			clipDuration := clip.SourceOutSec - clip.SourceInSec

			opacity := clip.Opacity
			if opacity <= 0 {
				opacity = 1.0
			}

			var prep string
			if asset.MediaType == models.MediaImage {
				prep = fmt.Sprintf(
					"[%d:v]scale=%d:%d:force_original_aspect_ratio=decrease,pad=%d:%d:(ow-iw)/2:(oh-ih)/2,setsar=1,loop=loop=-1:size=1,trim=duration=%.6f,setpts=PTS-STARTPTS+%.6f/TB,format=yuva420p,colorchannelmixer=aa=%.3f[%s]",
					idx, settings.Width, settings.Height, settings.Width, settings.Height, clipDuration, clip.TimelineStartSec, opacity, overlayLabel,
				)
			} else {
				prep = fmt.Sprintf(
					"[%d:v]trim=start=%.6f:end=%.6f,setpts=PTS-STARTPTS+%.6f/TB,scale=%d:%d:force_original_aspect_ratio=decrease,pad=%d:%d:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuva420p,colorchannelmixer=aa=%.3f[%s]",
					idx, clip.SourceInSec, clip.SourceOutSec, clip.TimelineStartSec, settings.Width, settings.Height, settings.Width, settings.Height, opacity, overlayLabel,
				)
			}
			filterParts = append(filterParts, prep)

			nextVideoLabel := fmt.Sprintf("v_%d_%d", trackPos, clipPos)
			filterParts = append(filterParts, fmt.Sprintf(
				"[%s][%s]overlay=enable='between(t,%.6f,%.6f)'[%s]",
				currentVideoLabel, overlayLabel, clip.TimelineStartSec, clip.TimelineEndSec, nextVideoLabel,
			))
			currentVideoLabel = nextVideoLabel
		}
	}

	finalVideoLabel := "outv"
	// Final format normalization: after overlay chains the stream may be
	// yuva420p (has alpha); the output container/encoder expects
	// yuv420p, so always convert at the very end.
	filterParts = append(filterParts, fmt.Sprintf("[%s]format=yuv420p[%s]", currentVideoLabel, finalVideoLabel))

	// --- Audio: trim + position every audio-bearing clip, then amix ---
	var audioLabels []string
	audioSegIdx := 0
	for _, track := range audioTracksNotMuted(proj) {
		for _, clip := range sortedClips(track) {
			asset, ok := assets[clip.AssetID]
			if !ok {
				return nil, fmt.Errorf("clip %s references unknown asset %s", clip.ID, clip.AssetID)
			}
			if asset.MediaType == models.MediaImage || asset.SampleRate == 0 {
				// No audio stream on this asset (e.g. silent video, or
				// an image) - skip rather than reference a non-existent
				// :a stream, which would hard-fail the whole ffmpeg
				// command.
				continue
			}
			if clip.Muted {
				continue
			}
			idx := nextInput(asset)
			label := fmt.Sprintf("aud%d", audioSegIdx)
			volume := clip.Volume
			if volume <= 0 {
				volume = 1.0
			}
			delayMs := clip.TimelineStartSec * 1000.0
			filterParts = append(filterParts, fmt.Sprintf(
				"[%d:a]atrim=start=%.6f:end=%.6f,asetpts=PTS-STARTPTS,volume=%.3f,adelay=%.0f|%.0f[%s]",
				idx, clip.SourceInSec, clip.SourceOutSec, volume, delayMs, delayMs, label,
			))
			audioLabels = append(audioLabels, "["+label+"]")
			audioSegIdx++
		}
	}

	var audioOutLabel string
	if len(audioLabels) > 0 {
		audioOutLabel = "outa"
		if len(audioLabels) == 1 {
			filterParts = append(filterParts, fmt.Sprintf("%sanull[%s]", audioLabels[0], audioOutLabel))
		} else {
			filterParts = append(filterParts, fmt.Sprintf(
				"%samix=inputs=%d:duration=longest:dropout_transition=0[%s]",
				strings.Join(audioLabels, ""), len(audioLabels), audioOutLabel,
			))
		}
	}

	return &ExportPlan{
		InputArgs:     inputArgs,
		FilterComplex: strings.Join(filterParts, ";\n"),
		VideoOutLabel: "[" + finalVideoLabel + "]",
		AudioOutLabel: tern(audioOutLabel != "", "["+audioOutLabel+"]", ""),
		TotalDuration: totalDuration,
	}, nil
}

func tern(cond bool, a, b string) string {
	if cond {
		return a
	}
	return b
}

// qualityToCRF maps the human-facing quality preset to an x264 CRF value
// (lower = higher quality / bigger file). These values follow x264's own
// documented sane range (18 = visually lossless, 28 = noticeably
// compressed) rather than arbitrary numbers.
func qualityToCRF(quality string) int {
	switch quality {
	case "low":
		return 28
	case "medium":
		return 23
	case "high":
		return 19
	case "ultra":
		return 16
	default:
		return 23
	}
}

func codecForFormat(format string) (videoCodec, audioCodec, containerExt string) {
	switch format {
	case "webm":
		return "libvpx-vp9", "libopus", "webm"
	case "mov":
		return "libx264", "aac", "mov"
	case "mkv":
		return "libx264", "aac", "mkv"
	default: // "mp4"
		return "libx264", "aac", "mp4"
	}
}

// BuildCommand turns an ExportPlan + settings into a ready-to-run
// exec.Cmd. Splitting this from Plan() means tests can assert on the
// argument list without spawning a real process.
func BuildCommand(ctx context.Context, ffmpegPath string, plan *ExportPlan, settings models.ExportSettings) *exec.Cmd {
	videoCodec, audioCodec, _ := codecForFormat(settings.Format)
	crf := qualityToCRF(settings.Quality)

	args := []string{"-y"}
	args = append(args, plan.InputArgs...)
	args = append(args, "-filter_complex", plan.FilterComplex)
	args = append(args, "-map", plan.VideoOutLabel)
	if plan.AudioOutLabel != "" {
		args = append(args, "-map", plan.AudioOutLabel)
	} else {
		// No audio anywhere in the project - explicitly disable the
		// audio stream rather than letting ffmpeg guess.
		args = append(args, "-an")
	}

	args = append(args,
		"-c:v", videoCodec,
		"-crf", fmt.Sprintf("%d", crf),
		"-r", fmt.Sprintf("%g", settings.FPS),
		"-pix_fmt", "yuv420p",
	)
	if plan.AudioOutLabel != "" {
		args = append(args, "-c:a", audioCodec, "-b:a", "192k")
	}
	args = append(args,
		"-t", fmt.Sprintf("%.6f", plan.TotalDuration),
		"-progress", "pipe:1", // machine-readable progress on stdout, parsed by the export progress reporter
		settings.OutputPath,
	)

	return exec.CommandContext(ctx, ffmpegPath, args...)
}

// EnsureOutputDir is a small helper the caller (the Wails-bound export
// service) uses before running BuildCommand, since ffmpeg will not create
// missing parent directories for -output.
func EnsureOutputDir(outputPath string) string {
	return filepath.Dir(outputPath)
}
