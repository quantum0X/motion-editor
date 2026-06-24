// Package media handles importing source files into a project: probing
// metadata with ffprobe and generating thumbnails with ffmpeg.
//
// The exact ffprobe JSON shape and ffmpeg thumbnail command in this file
// were verified against a real ffmpeg/ffprobe build before being wired in
// here (see project notes) — specifically:
//   - r_frame_rate comes back as a fraction string like "30/1", not a
//     float, so it must be parsed as such.
//   - duration is a string (not a number) on both the stream and format
//     objects in ffprobe's JSON output.
//   - thumbnail extraction needs -update 1 alongside -frames:v 1 when
//     writing a single still image file, or ffmpeg emits a (harmless but
//     noisy) warning about image-sequence patterns.
package media

import (
	"encoding/json"
	"fmt"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"

	"videoeditor/backend/models"
)

// Service performs media probing and thumbnail generation. It needs no
// persistent state of its own — it's handed a project directory (for
// where to write thumbnails) on each call, since the "current project"
// concept lives in the project.Service.
type Service struct {
	// FFmpegPath / FFprobePath allow overriding the binary location
	// (e.g. if it's bundled alongside the app rather than relying on
	// PATH). Empty string means "look up ffmpeg/ffprobe on PATH".
	FFmpegPath  string
	FFprobePath string
}

func NewService() *Service {
	return &Service{
		FFmpegPath:  "ffmpeg",
		FFprobePath: "ffprobe",
	}
}

// ffprobeFormat mirrors the subset of ffprobe's `format` JSON object we
// need. Fields are strings even when numeric, matching ffprobe's actual
// output (verified above) — do not change these to float64/int, the JSON
// unmarshal will fail.
type ffprobeFormat struct {
	Duration string `json:"duration"`
	Size     string `json:"size"`
}

type ffprobeStream struct {
	CodecType    string `json:"codec_type"` // "video" | "audio"
	Width        int    `json:"width"`
	Height       int    `json:"height"`
	RFrameRate   string `json:"r_frame_rate"`   // e.g. "30/1", "30000/1001"
	AvgFrameRate string `json:"avg_frame_rate"` // fallback if r_frame_rate is "0/0"
	SampleRate   string `json:"sample_rate"`    // audio only, e.g. "44100"
	Channels     int    `json:"channels"`       // audio only
	Duration     string `json:"duration"`       // sometimes present per-stream too
}

type ffprobeOutput struct {
	Format  ffprobeFormat   `json:"format"`
	Streams []ffprobeStream `json:"streams"`
}

// detectMediaType guesses MediaType from file extension. This is a
// pragmatic first pass — for video/audio files we still probe with
// ffprobe afterward to fill in real metadata and would correct an
// extension-based misclassification using probe results in a future
// pass; in Phase 1 we trust the extension since users virtually never
// rename a .mp4 to .jpg.
func detectMediaType(path string) models.MediaType {
	ext := strings.ToLower(filepath.Ext(path))
	switch ext {
	case ".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp":
		return models.MediaImage
	case ".mp3", ".wav", ".aac", ".flac", ".ogg", ".m4a":
		return models.MediaAudio
	default:
		// .mp4, .mov, .mkv, .webm, .avi, etc.
		return models.MediaVideo
	}
}

// parseFrameRate converts ffprobe's "num/den" fraction string into a
// float64 fps value. Returns 0 if the string is "0/0" or unparseable
// (which happens for streams with no fixed frame rate, e.g. some audio).
func parseFrameRate(frac string) float64 {
	parts := strings.SplitN(frac, "/", 2)
	if len(parts) != 2 {
		return 0
	}
	num, err1 := strconv.ParseFloat(parts[0], 64)
	den, err2 := strconv.ParseFloat(parts[1], 64)
	if err1 != nil || err2 != nil || den == 0 {
		return 0
	}
	return num / den
}

// probe runs ffprobe on a file and returns the parsed JSON output.
func (s *Service) probe(filePath string) (*ffprobeOutput, error) {
	cmd := exec.Command(
		s.FFprobePath,
		"-v", "quiet",
		"-print_format", "json",
		"-show_format",
		"-show_streams",
		filePath,
	)
	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("ffprobe failed on %s: %w", filePath, err)
	}

	var result ffprobeOutput
	if err := json.Unmarshal(out, &result); err != nil {
		return nil, fmt.Errorf("parsing ffprobe output for %s: %w", filePath, err)
	}
	return &result, nil
}

// ImportFile probes the given file, generates a thumbnail into
// <projectDir>/thumbnails/, and returns a fully populated MediaAsset
// ready to be appended to the project's Assets list.
//
// For images, no ffprobe call is made for duration/fps (not meaningful);
// width/height are still read via ffprobe since it handles image files
// too (it reports a single video-like stream with 1 frame).
func (s *Service) ImportFile(filePath string, projectDir string) (*models.MediaAsset, error) {
	mediaType := detectMediaType(filePath)

	fileInfoSize, err := fileSize(filePath)
	if err != nil {
		return nil, fmt.Errorf("reading file size: %w", err)
	}

	asset := &models.MediaAsset{
		ID:            uuid.NewString(),
		FileName:      filepath.Base(filePath),
		FilePath:      filePath,
		MediaType:     mediaType,
		FileSizeBytes: fileInfoSize,
		ImportedAt:    time.Now(),
	}

	probeResult, err := s.probe(filePath)
	if err != nil {
		return nil, fmt.Errorf("probing media file: %w", err)
	}

	if mediaType != models.MediaImage {
		if d, err := strconv.ParseFloat(probeResult.Format.Duration, 64); err == nil {
			asset.DurationSec = d
		}
	}

	for _, stream := range probeResult.Streams {
		switch stream.CodecType {
		case "video":
			asset.Width = stream.Width
			asset.Height = stream.Height
			fps := parseFrameRate(stream.RFrameRate)
			if fps == 0 {
				fps = parseFrameRate(stream.AvgFrameRate)
			}
			asset.FPS = fps
		case "audio":
			if sr, err := strconv.Atoi(stream.SampleRate); err == nil {
				asset.SampleRate = sr
			}
			asset.Channels = stream.Channels
		}
	}

	thumbPath, err := s.generateThumbnail(filePath, projectDir, asset.ID, mediaType, asset.DurationSec)
	if err != nil {
		// Thumbnail failure shouldn't block import entirely — the asset
		// is still usable on the timeline, just without a preview image.
		// We surface this as a soft failure via empty ThumbnailPath
		// rather than erroring the whole import.
		fmt.Printf("warning: thumbnail generation failed for %s: %v\n", filePath, err)
	} else {
		asset.ThumbnailPath = thumbPath
	}

	return asset, nil
}

// generateThumbnail extracts a single representative frame as a JPEG.
// For video, it seeks to either 1 second in or 10% of the duration
// (whichever is smaller) to avoid grabbing a black/blank opening frame
// while still working for clips shorter than 1 second. For images, it
// simply resizes the source image itself.
func (s *Service) generateThumbnail(filePath, projectDir, assetID string, mediaType models.MediaType, durationSec float64) (string, error) {
	thumbDir := filepath.Join(projectDir, "thumbnails")
	thumbPath := filepath.Join(thumbDir, assetID+".jpg")

	var cmd *exec.Cmd
	switch mediaType {
	case models.MediaImage:
		cmd = exec.Command(
			s.FFmpegPath,
			"-i", filePath,
			"-frames:v", "1",
			"-update", "1",
			"-vf", "scale=320:-1",
			thumbPath,
			"-y",
		)
	case models.MediaVideo:
		seekTime := 1.0
		if durationSec > 0 {
			tenPercent := durationSec * 0.1
			if tenPercent < seekTime {
				seekTime = tenPercent
			}
		}
		cmd = exec.Command(
			s.FFmpegPath,
			"-ss", fmt.Sprintf("%.3f", seekTime),
			"-i", filePath,
			"-frames:v", "1",
			"-update", "1",
			"-vf", "scale=320:-1",
			thumbPath,
			"-y",
		)
	case models.MediaAudio:
		// No visual thumbnail for pure audio in Phase 1; the frontend
		// shows a waveform icon instead. Returning an error here is
		// intentional so ImportFile logs the (expected) "no thumbnail"
		// case rather than silently producing an empty file.
		return "", fmt.Errorf("audio files do not get a generated thumbnail in this phase")
	default:
		return "", fmt.Errorf("unknown media type %q", mediaType)
	}

	output, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("ffmpeg thumbnail command failed: %w (output: %s)", err, string(output))
	}

	return thumbPath, nil
}

// ImportFiles is a convenience batch wrapper for drag-and-drop / folder
// import of multiple files at once. It does not stop on the first error —
// it collects per-file errors so e.g. one corrupt file in a batch of 50
// doesn't block importing the other 49.
type ImportResult struct {
	Asset *models.MediaAsset
	Error string
}

func (s *Service) ImportFiles(filePaths []string, projectDir string) []ImportResult {
	results := make([]ImportResult, 0, len(filePaths))
	for _, path := range filePaths {
		asset, err := s.ImportFile(path, projectDir)
		if err != nil {
			results = append(results, ImportResult{Error: err.Error()})
			continue
		}
		results = append(results, ImportResult{Asset: asset})
	}
	return results
}
