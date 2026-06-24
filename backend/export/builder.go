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
//  6. Text overlays use `drawtext` with `expansion=none` — without it,
//     ffmpeg's default "normal" expansion mode treats any literal `%` in
//     the text as the start of a `%{...}` template token. A malformed
//     token doesn't error; it silently warns ("Stray %...") and the text
//     renders as blank. With expansion=none, % needs no escaping at all.
//     Colon and backslash still need backslash-escaping (colon separates
//     filter options); single quote has no escape inside a single-quoted
//     filter value, so it's substituted with a Unicode right single
//     quotation mark instead.
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
	clip     models.Clip
	asset    models.MediaAsset
	inputIdx int
}

// PlanExport assembles every piece needed to run the export: the ordered
// list of -i inputs, the full -filter_complex string, and the final
// -map/-t/codec arguments. Splitting "planning" from "execution" like
// this means the filter graph can be unit-tested (as a string) without
// actually invoking ffmpeg.
type ExportPlan struct {
	InputArgs     []string // e.g. ["-i", "/path/a.mp4", "-i", "/path/b.mp4", ...]
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

// sortedTextClips mirrors sortedClips for TextClip, used so text overlays
// chain onto the filter graph in a stable, deterministic order rather
// than whatever order they happen to sit in project.json.
func sortedTextClips(track models.Track) []models.TextClip {
	clips := make([]models.TextClip, len(track.TextClips))
	copy(clips, track.TextClips)
	sort.Slice(clips, func(i, j int) bool {
		return clips[i].TimelineStartSec < clips[j].TimelineStartSec
	})
	return clips
}

// textTracksSortedByOrder returns only text tracks, sorted bottom-to-top
// by Order, mirroring videoTracksSortedByOrder. In Phase 1 there's
// typically just one text track, but supporting several (e.g. a
// permanent watermark track plus a captions track) costs nothing extra
// here.
func textTracksSortedByOrder(proj *models.Project) []models.Track {
	var tracks []models.Track
	for _, t := range proj.Tracks {
		if t.Type == models.TrackText && !t.Hidden {
			tracks = append(tracks, t)
		}
	}
	sort.Slice(tracks, func(i, j int) bool { return tracks[i].Order < tracks[j].Order })
	return tracks
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

	// --- Text layers: drawtext, always composited above every video
	// track. Text tracks are not range-checked against each other the
	// same way video tracks are in Phase 1 (overlapping captions are a
	// legitimate, common thing - e.g. a persistent watermark plus a
	// timed caption), so every text clip from every text track just
	// gets chained onto the video stream in track order.
	textTracks := textTracksSortedByOrder(proj)
	for _, track := range textTracks {
		for _, tc := range sortedTextClips(track) {
			nextVideoLabel := fmt.Sprintf("txt_%s", sanitizeLabel(tc.ID))
			drawtextFilter, err := buildDrawtextFilter(tc, settings)
			if err != nil {
				return nil, fmt.Errorf("text clip %s: %w", tc.ID, err)
			}
			filterParts = append(filterParts, fmt.Sprintf(
				"[%s]%s[%s]",
				currentVideoLabel, drawtextFilter, nextVideoLabel,
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

// --- Text rendering (drawtext) ---

// FontsDir is where bundled font files live, relative to the packaged
// app's working directory at runtime. Phase 1 ships a small, fixed set
// of fonts rather than resolving arbitrary system font names, for two
// reasons: (1) "Arial" or "Helvetica" may not exist, or may render
// subtly differently, across Windows/macOS/Linux, breaking the promise
// that export matches preview; (2) shipping our own font files means
// drawtext always has a real file to point at, with no installation-
// dependent failure mode. Set this from app.go's startup() to wherever
// the packaged app actually places its fonts/ folder.
var FontsDir = "fonts"

func fontRegistry() map[string]string {
	return map[string]string{
		"sans":       FontsDir + "/DejaVuSans.ttf",
		"sans-bold":  FontsDir + "/DejaVuSans-Bold.ttf",
		"serif":      FontsDir + "/DejaVuSerif.ttf",
		"serif-bold": FontsDir + "/DejaVuSerif-Bold.ttf",
		"mono":       FontsDir + "/DejaVuSansMono.ttf",
		"mono-bold":  FontsDir + "/DejaVuSansMono-Bold.ttf",
	}
}

// resolveFontFile picks a font file path from fontFamily + fontWeight,
// falling back to plain "sans" for any unrecognized family rather than
// failing the whole export over a styling mismatch - a missing/wrong
// font is a cosmetic problem, not a reason to lose someone's render.
func resolveFontFile(fontFamily, fontWeight string) string {
	registry := fontRegistry()
	key := fontFamily
	if fontWeight == "bold" {
		key = fontFamily + "-bold"
	}
	if path, ok := registry[key]; ok {
		return path
	}
	if path, ok := registry[fontFamily]; ok {
		return path
	}
	if fontWeight == "bold" {
		return registry["sans-bold"]
	}
	return registry["sans"]
}

// escapeDrawtextValue escapes a string for safe use as a drawtext
// filter option value, when the filter graph string is passed as ONE
// literal argv element (Go's exec.Command never invokes a shell, so no
// shell-level escaping is needed or wanted here - only ffmpeg's own
// filtergraph syntax matters).
//
// This was verified character-by-character against a real ffmpeg binary
// before being written here (see project notes) - in particular:
//   - backslash must be escaped first, or escaping the other characters
//     below would introduce new backslashes that then get re-escaped.
//   - colon must be escaped: it separates filter key=value options.
//   - single quote has no working escape inside a single-quoted
//     drawtext value, so it's substituted with a Unicode right single
//     quotation mark (’) instead - visually nearly identical, and avoids
//     a class of "unterminated quote" filter graph parse failures.
//   - percent sign needs NO escaping, provided the drawtext filter is
//     built with expansion=none (see buildDrawtextFilter) - ffmpeg's
//     default "normal" expansion mode treats % as the start of a
//     %{...} template token, and a stray one silently renders blank
//     text instead of erroring, which is a much worse failure mode than
//     requiring expansion=none everywhere text is drawn.
func escapeDrawtextValue(text string) string {
	text = strings.ReplaceAll(text, `\`, `\\`)
	text = strings.ReplaceAll(text, `:`, `\:`)
	text = strings.ReplaceAll(text, `'`, "\u2019")
	return text
}

// sanitizeLabel strips characters that aren't valid inside ffmpeg filter
// graph link labels (e.g. "[label]") from a clip ID, since UUIDs contain
// hyphens which are fine, but defensively stripping anything unexpected
// here is cheap insurance against a malformed/legacy ID breaking the
// entire filter graph string.
func sanitizeLabel(id string) string {
	var b strings.Builder
	for _, r := range id {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// buildDrawtextFilter constructs one drawtext filter clause (without the
// surrounding "[in]...[out]" link labels - the caller adds those) for a
// single TextClip. Position is converted from the clip's 0-100 percent
// coordinates into ffmpeg expressions referencing the actual output
// width/height, so positioning stays correct regardless of export
// resolution - this mirrors how the canvas preview computes position
// from the same percentages against whatever the live canvas size is.
func buildDrawtextFilter(tc models.TextClip, settings models.ExportSettings) (string, error) {
	if strings.TrimSpace(tc.Content) == "" {
		return "", fmt.Errorf("text content is empty")
	}

	fontFile := resolveFontFile(tc.FontFamily, tc.FontWeight)
	escapedText := escapeDrawtextValue(tc.Content)
	escapedFontFile := escapeDrawtextValue(fontFile)

	fontColor := tc.Color
	if fontColor == "" {
		fontColor = "#ffffff"
	}
	opacity := tc.Opacity
	if opacity <= 0 {
		opacity = 1.0
	}
	// drawtext takes color alpha as an @ suffix (e.g. "white@0.8"), not
	// a separate option - fold the clip's Opacity into the color value.
	fontColorWithAlpha := fmt.Sprintf("%s@%.3f", fontColor, opacity)

	// x/y position from percentage: the percentage marks the CENTER of
	// the text box, so subtract half the rendered text's own width/height
	// (text_w/text_h are expressions drawtext resolves at render time,
	// after it knows the actual rendered size of this specific string in
	// this specific font/size).
	xExpr := fmt.Sprintf("(w*%.4f)-(text_w/2)", tc.PositionXPercent/100.0)
	yExpr := fmt.Sprintf("(h*%.4f)-(text_h/2)", tc.PositionYPercent/100.0)

	parts := []string{
		"drawtext=expansion=none",
		"fontfile='" + escapedFontFile + "'",
		"text='" + escapedText + "'",
		fmt.Sprintf("fontsize=%d", tc.FontSize),
		"fontcolor='" + fontColorWithAlpha + "'",
		"x=" + xExpr,
		"y=" + yExpr,
		fmt.Sprintf("enable='between(t,%.6f,%.6f)'", tc.TimelineStartSec, tc.TimelineEndSec),
	}

	if tc.OutlineEnabled && tc.OutlineWidth > 0 {
		outlineColor := tc.OutlineColor
		if outlineColor == "" {
			outlineColor = "#000000"
		}
		parts = append(parts,
			"bordercolor='"+escapeDrawtextValue(outlineColor)+"'",
			fmt.Sprintf("borderw=%d", tc.OutlineWidth),
		)
	}

	if tc.ShadowEnabled {
		shadowColor := tc.ShadowColor
		if shadowColor == "" {
			shadowColor = "#000000@0.5"
		}
		parts = append(parts,
			"shadowcolor='"+escapeDrawtextValue(shadowColor)+"'",
			"shadowx=2",
			"shadowy=2",
		)
	}

	// settings is currently unused directly (position is resolved via
	// ffmpeg's own w/h expressions, which already refer to the actual
	// output frame size) - kept as a parameter for forward-compatibility
	// since font-size-as-percent-of-canvas-height scaling is a likely
	// near-future addition that would need it.
	_ = settings

	return strings.Join(parts, ":"), nil
}
