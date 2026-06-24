// Package main is the Wails v2 application entrypoint. It wires together
// the project, media, and export backend services and exposes them to the
// React frontend as bound methods (every public method on App is callable
// from TypeScript via the generated wailsjs bindings).
package main

import (
	"bufio"
	"context"
	"embed"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/runtime"

	"videoeditor/backend/export"
	"videoeditor/backend/media"
	"videoeditor/backend/models"
	"videoeditor/backend/project"
)

//go:embed frontend/dist
var assets embed.FS

// App is the root Wails-bound struct. Every exported method becomes
// callable from the frontend. Keep this struct as a thin coordination
// layer — actual logic lives in backend/project, backend/media, and
// backend/export; App just adapts those into the request/response and
// event shapes the frontend expects.
type App struct {
	ctx context.Context

	projectSvc    *project.Service
	mediaSvc      *media.Service
	exportBuilder *export.Builder

	// exportMu guards exportCancel so only one export can run at a time
	// in Phase 1 (running two ffmpeg renders concurrently is supported
	// by ffmpeg itself, but doubles CPU/memory pressure on what's
	// already typically a CPU-bound machine; we serialize for now and
	// can revisit with a job queue once exports are fast/reliable).
	exportMu     sync.Mutex
	exportCancel context.CancelFunc
}

func NewApp() *App {
	return &App{}
}

// startup is called by Wails once the frontend is ready. This is where we
// construct backend services, since they may need the Wails runtime
// context (e.g. for emitting events) which doesn't exist before this
// point.
func (a *App) startup(ctx context.Context) {
	a.ctx = ctx

	baseDir, err := os.UserConfigDir()
	if err != nil {
		// Fall back to a local folder next to the executable if the OS
		// can't give us a standard config dir (rare, but better than
		// crashing on startup).
		baseDir = "."
	}
	baseDataDir := filepath.Join(baseDir, "VideoEditor")

	projectSvc, err := project.NewService(baseDataDir)
	if err != nil {
		runtime.LogErrorf(ctx, "failed to initialize project service: %v", err)
		// We deliberately don't os.Exit here - a broken project service
		// means New/Open/Save will return errors to the frontend, which
		// can surface them in the UI rather than the app silently dying.
	}
	a.projectSvc = projectSvc
	a.mediaSvc = media.NewService()
	a.exportBuilder = export.NewBuilder()
}

// --- Project lifecycle (bound methods) ---

func (a *App) NewProject(name string, canvasWidth, canvasHeight int, fps float64) (*models.Project, error) {
	return a.projectSvc.NewProject(name, canvasWidth, canvasHeight, fps)
}

func (a *App) OpenProject(projectDir string) (*models.Project, error) {
	return a.projectSvc.OpenProject(projectDir)
}

func (a *App) SaveProject() (*models.Project, error) {
	return a.projectSvc.SaveProject()
}

func (a *App) SaveProjectAs(newName string) (*models.Project, error) {
	return a.projectSvc.SaveProjectAs(newName)
}

func (a *App) AutoSave() error {
	return a.projectSvc.AutoSave()
}

func (a *App) CheckRecovery(projectDir string) (*project.RecoveryInfo, error) {
	return a.projectSvc.CheckRecovery(projectDir)
}

func (a *App) RecoverFromAutosave(projectDir string) (*models.Project, error) {
	return a.projectSvc.RecoverFromAutosave(projectDir)
}

func (a *App) RecentProjects() ([]project.RecentEntry, error) {
	return a.projectSvc.RecentProjects()
}

func (a *App) GetCurrentProject() *models.Project {
	return a.projectSvc.CurrentProject()
}

// --- Project mutation: timeline edits ---
//
// These methods mutate the in-memory current project directly (via
// pointer through projectSvc.CurrentProject()) and return the updated
// project so the frontend's Zustand store can resync. Phase 1 keeps
// timeline mutation logic here rather than in its own package, since it's
// currently a handful of straightforward slice operations; if this grows
// (keyframes, multi-select bulk ops, etc.) it should move to
// backend/timeline the same way media/export got their own packages.

// AddClipToTrack appends a new clip referencing an already-imported asset
// onto the given track, after validating the asset exists and the
// timeline range doesn't overlap an existing clip on that track.
func (a *App) AddClipToTrack(trackID string, clip models.Clip) (*models.Project, error) {
	proj := a.projectSvc.CurrentProject()
	if proj == nil {
		return nil, fmt.Errorf("no project is open")
	}

	assetExists := false
	for _, asset := range proj.Assets {
		if asset.ID == clip.AssetID {
			assetExists = true
			break
		}
	}
	if !assetExists {
		return nil, fmt.Errorf("asset %s not found in project", clip.AssetID)
	}

	for i := range proj.Tracks {
		if proj.Tracks[i].ID != trackID {
			continue
		}
		for _, existing := range proj.Tracks[i].Clips {
			if clip.TimelineStartSec < existing.TimelineEndSec && clip.TimelineEndSec > existing.TimelineStartSec {
				return nil, fmt.Errorf("clip overlaps an existing clip on this track at %.2fs-%.2fs", existing.TimelineStartSec, existing.TimelineEndSec)
			}
		}
		if clip.ID == "" {
			clip.ID = newID()
		}
		if clip.Opacity == 0 {
			clip.Opacity = 1.0
		}
		if clip.Volume == 0 {
			clip.Volume = 1.0
		}
		if clip.Speed == 0 {
			clip.Speed = 1.0
		}
		proj.Tracks[i].Clips = append(proj.Tracks[i].Clips, clip)
		return proj, nil
	}
	return nil, fmt.Errorf("track %s not found", trackID)
}

// MoveClip repositions an existing clip (drag on the timeline) to a new
// start time, optionally onto a different track (drag between tracks).
// The duration (end - start) is preserved.
func (a *App) MoveClip(clipID, newTrackID string, newStartSec float64) (*models.Project, error) {
	proj := a.projectSvc.CurrentProject()
	if proj == nil {
		return nil, fmt.Errorf("no project is open")
	}

	var found *models.Clip
	var foundTrackIdx int
	for i := range proj.Tracks {
		for j := range proj.Tracks[i].Clips {
			if proj.Tracks[i].Clips[j].ID == clipID {
				found = &proj.Tracks[i].Clips[j]
				foundTrackIdx = i
				break
			}
		}
	}
	if found == nil {
		return nil, fmt.Errorf("clip %s not found", clipID)
	}

	duration := found.TimelineEndSec - found.TimelineStartSec
	newEnd := newStartSec + duration

	targetIdx := -1
	for i := range proj.Tracks {
		if proj.Tracks[i].ID == newTrackID {
			targetIdx = i
			break
		}
	}
	if targetIdx == -1 {
		return nil, fmt.Errorf("target track %s not found", newTrackID)
	}

	for _, existing := range proj.Tracks[targetIdx].Clips {
		if existing.ID == clipID {
			continue // moving within the same slot, ignore self
		}
		if newStartSec < existing.TimelineEndSec && newEnd > existing.TimelineStartSec {
			return nil, fmt.Errorf("move would overlap an existing clip at %.2fs-%.2fs", existing.TimelineStartSec, existing.TimelineEndSec)
		}
	}

	// Remove from old track, insert into new (possibly same) track.
	clipCopy := *found
	clipCopy.TrackID = newTrackID
	clipCopy.TimelineStartSec = newStartSec
	clipCopy.TimelineEndSec = newEnd

	proj.Tracks[foundTrackIdx].Clips = removeClip(proj.Tracks[foundTrackIdx].Clips, clipID)
	proj.Tracks[targetIdx].Clips = append(proj.Tracks[targetIdx].Clips, clipCopy)

	return proj, nil
}

// TrimClip adjusts a clip's in/out points (dragging the left or right
// edge on the timeline). Either edge may be omitted (pass -1) to leave it
// unchanged. Trimming the left edge shifts SourceInSec by the same amount
// as TimelineStartSec so the visible content "stays put" while its
// duration shrinks/grows — standard NLE trim behavior.
func (a *App) TrimClip(clipID string, newTimelineStart, newTimelineEnd float64) (*models.Project, error) {
	proj := a.projectSvc.CurrentProject()
	if proj == nil {
		return nil, fmt.Errorf("no project is open")
	}

	for i := range proj.Tracks {
		for j := range proj.Tracks[i].Clips {
			clip := &proj.Tracks[i].Clips[j]
			if clip.ID != clipID {
				continue
			}

			if newTimelineStart >= 0 {
				delta := newTimelineStart - clip.TimelineStartSec
				clip.TimelineStartSec = newTimelineStart
				clip.SourceInSec += delta
			}
			if newTimelineEnd >= 0 {
				delta := newTimelineEnd - clip.TimelineEndSec
				clip.TimelineEndSec = newTimelineEnd
				clip.SourceOutSec += delta
			}

			if clip.TimelineEndSec <= clip.TimelineStartSec {
				return nil, fmt.Errorf("trim would result in zero or negative duration")
			}
			if clip.SourceOutSec <= clip.SourceInSec {
				return nil, fmt.Errorf("trim would result in zero or negative source range")
			}

			return proj, nil
		}
	}
	return nil, fmt.Errorf("clip %s not found", clipID)
}

// SplitClip cuts one clip into two at the given timeline time (the "S" /
// split-at-playhead operation). Returns the updated project; the new
// second clip gets a freshly generated ID.
func (a *App) SplitClip(clipID string, splitAtSec float64) (*models.Project, error) {
	proj := a.projectSvc.CurrentProject()
	if proj == nil {
		return nil, fmt.Errorf("no project is open")
	}

	for i := range proj.Tracks {
		for j := range proj.Tracks[i].Clips {
			clip := proj.Tracks[i].Clips[j]
			if clip.ID != clipID {
				continue
			}
			if splitAtSec <= clip.TimelineStartSec || splitAtSec >= clip.TimelineEndSec {
				return nil, fmt.Errorf("split point must be strictly inside the clip's range")
			}

			sourceSplitPoint := clip.SourceInSec + (splitAtSec - clip.TimelineStartSec)

			left := clip
			left.TimelineEndSec = splitAtSec
			left.SourceOutSec = sourceSplitPoint

			right := clip
			right.ID = newID()
			right.TimelineStartSec = splitAtSec
			right.SourceInSec = sourceSplitPoint

			newClips := make([]models.Clip, 0, len(proj.Tracks[i].Clips)+1)
			for k, c := range proj.Tracks[i].Clips {
				if k == j {
					newClips = append(newClips, left, right)
				} else {
					newClips = append(newClips, c)
				}
			}
			proj.Tracks[i].Clips = newClips
			return proj, nil
		}
	}
	return nil, fmt.Errorf("clip %s not found", clipID)
}

// DeleteClip removes a clip from whichever track it's on.
func (a *App) DeleteClip(clipID string) (*models.Project, error) {
	proj := a.projectSvc.CurrentProject()
	if proj == nil {
		return nil, fmt.Errorf("no project is open")
	}
	for i := range proj.Tracks {
		before := len(proj.Tracks[i].Clips)
		proj.Tracks[i].Clips = removeClip(proj.Tracks[i].Clips, clipID)
		if len(proj.Tracks[i].Clips) != before {
			return proj, nil
		}
	}
	return nil, fmt.Errorf("clip %s not found", clipID)
}

// DuplicateClip copies a clip onto the same track immediately after its
// own end point (a common "duplicate" shortcut behavior), returning the
// new clip's ID along with the updated project so the frontend can
// immediately select the new copy.
func (a *App) DuplicateClip(clipID string) (*models.Project, string, error) {
	proj := a.projectSvc.CurrentProject()
	if proj == nil {
		return nil, "", fmt.Errorf("no project is open")
	}
	for i := range proj.Tracks {
		for _, clip := range proj.Tracks[i].Clips {
			if clip.ID != clipID {
				continue
			}
			duration := clip.TimelineEndSec - clip.TimelineStartSec
			copyClip := clip
			copyClip.ID = newID()
			copyClip.TimelineStartSec = clip.TimelineEndSec
			copyClip.TimelineEndSec = clip.TimelineEndSec + duration

			for _, existing := range proj.Tracks[i].Clips {
				if copyClip.TimelineStartSec < existing.TimelineEndSec && copyClip.TimelineEndSec > existing.TimelineStartSec {
					return nil, "", fmt.Errorf("no room to duplicate clip immediately after itself - move it first")
				}
			}

			proj.Tracks[i].Clips = append(proj.Tracks[i].Clips, copyClip)
			return proj, copyClip.ID, nil
		}
	}
	return nil, "", fmt.Errorf("clip %s not found", clipID)
}

func removeClip(clips []models.Clip, id string) []models.Clip {
	out := make([]models.Clip, 0, len(clips))
	for _, c := range clips {
		if c.ID != id {
			out = append(out, c)
		}
	}
	return out
}

// --- Text clip mutation ---
//
// Text clips are simpler than media clips: no asset reference, no
// source-in/out trimming, and (in Phase 1) overlapping text clips on
// different text tracks are allowed since stacked captions/watermarks
// are a legitimate use case (see export/builder.go's comment on this).
// They still get the same not-found/no-project error handling as the
// other mutation methods for a consistent frontend error-handling story.

// AddTextClip creates a new text clip on the given text track. Sensible
// defaults are filled in for any zero-valued styling fields so the
// frontend can send a minimal payload (e.g. just content + timing) for
// a "quick add" flow and still get a clip that's visible and legible.
func (a *App) AddTextClip(trackID string, tc models.TextClip) (*models.Project, error) {
	proj := a.projectSvc.CurrentProject()
	if proj == nil {
		return nil, fmt.Errorf("no project is open")
	}

	if strings.TrimSpace(tc.Content) == "" {
		return nil, fmt.Errorf("text content cannot be empty")
	}
	if tc.TimelineEndSec <= tc.TimelineStartSec {
		return nil, fmt.Errorf("text clip must have a positive duration")
	}

	for i := range proj.Tracks {
		if proj.Tracks[i].ID != trackID {
			continue
		}
		if proj.Tracks[i].Type != models.TrackText {
			return nil, fmt.Errorf("track %s is not a text track", trackID)
		}

		if tc.ID == "" {
			tc.ID = newID()
		}
		tc.TrackID = trackID
		if tc.FontFamily == "" {
			tc.FontFamily = "sans"
		}
		if tc.FontWeight == "" {
			tc.FontWeight = "bold"
		}
		if tc.FontSize == 0 {
			tc.FontSize = 32
		}
		if tc.Color == "" {
			tc.Color = "#ffffff"
		}
		if tc.PositionXPercent == 0 {
			tc.PositionXPercent = 50
		}
		if tc.PositionYPercent == 0 {
			tc.PositionYPercent = 85 // lower-third default - the most common caption position
		}
		if tc.Alignment == "" {
			tc.Alignment = "center"
		}
		if tc.Opacity == 0 {
			tc.Opacity = 1.0
		}

		proj.Tracks[i].TextClips = append(proj.Tracks[i].TextClips, tc)
		return proj, nil
	}
	return nil, fmt.Errorf("track %s not found", trackID)
}

// UpdateTextClip replaces an existing text clip's full content/styling
// in place (the frontend's properties panel sends the complete updated
// object on every edit, rather than per-field patches - simpler to
// reason about and the payload is small).
func (a *App) UpdateTextClip(clipID string, updated models.TextClip) (*models.Project, error) {
	proj := a.projectSvc.CurrentProject()
	if proj == nil {
		return nil, fmt.Errorf("no project is open")
	}
	if strings.TrimSpace(updated.Content) == "" {
		return nil, fmt.Errorf("text content cannot be empty")
	}
	if updated.TimelineEndSec <= updated.TimelineStartSec {
		return nil, fmt.Errorf("text clip must have a positive duration")
	}

	for i := range proj.Tracks {
		for j := range proj.Tracks[i].TextClips {
			if proj.Tracks[i].TextClips[j].ID != clipID {
				continue
			}
			updated.ID = clipID
			updated.TrackID = proj.Tracks[i].ID
			proj.Tracks[i].TextClips[j] = updated
			return proj, nil
		}
	}
	return nil, fmt.Errorf("text clip %s not found", clipID)
}

// DeleteTextClip removes a text clip from whichever text track it's on.
func (a *App) DeleteTextClip(clipID string) (*models.Project, error) {
	proj := a.projectSvc.CurrentProject()
	if proj == nil {
		return nil, fmt.Errorf("no project is open")
	}
	for i := range proj.Tracks {
		before := len(proj.Tracks[i].TextClips)
		proj.Tracks[i].TextClips = removeTextClip(proj.Tracks[i].TextClips, clipID)
		if len(proj.Tracks[i].TextClips) != before {
			return proj, nil
		}
	}
	return nil, fmt.Errorf("text clip %s not found", clipID)
}

// MoveTextClip repositions a text clip in time (drag on the timeline),
// preserving its duration - mirrors MoveClip's semantics for media
// clips, minus the cross-track-overlap rejection, since text tracks
// intentionally allow overlap.
func (a *App) MoveTextClip(clipID string, newStartSec float64) (*models.Project, error) {
	proj := a.projectSvc.CurrentProject()
	if proj == nil {
		return nil, fmt.Errorf("no project is open")
	}
	for i := range proj.Tracks {
		for j := range proj.Tracks[i].TextClips {
			tc := &proj.Tracks[i].TextClips[j]
			if tc.ID != clipID {
				continue
			}
			duration := tc.TimelineEndSec - tc.TimelineStartSec
			tc.TimelineStartSec = newStartSec
			tc.TimelineEndSec = newStartSec + duration
			return proj, nil
		}
	}
	return nil, fmt.Errorf("text clip %s not found", clipID)
}

func removeTextClip(clips []models.TextClip, id string) []models.TextClip {
	out := make([]models.TextClip, 0, len(clips))
	for _, c := range clips {
		if c.ID != id {
			out = append(out, c)
		}
	}
	return out
}

// AddTextTrack creates a new text track (analogous to how NewProject
// seeds default video/audio tracks, but text tracks are added on demand
// rather than always present, since not every project needs captions).
func (a *App) AddTextTrack(name string) (*models.Project, error) {
	proj := a.projectSvc.CurrentProject()
	if proj == nil {
		return nil, fmt.Errorf("no project is open")
	}
	if name == "" {
		name = fmt.Sprintf("Text %d", countTracksByType(proj, models.TrackText)+1)
	}

	maxOrder := -1
	for _, t := range proj.Tracks {
		if t.Type == models.TrackText && t.Order > maxOrder {
			maxOrder = t.Order
		}
	}

	proj.Tracks = append(proj.Tracks, models.Track{
		ID:        newID(),
		Type:      models.TrackText,
		Name:      name,
		Order:     maxOrder + 1,
		TextClips: []models.TextClip{},
	})
	return proj, nil
}

func countTracksByType(proj *models.Project, t models.TrackType) int {
	count := 0
	for _, track := range proj.Tracks {
		if track.Type == t {
			count++
		}
	}
	return count
}

// --- Media import (bound methods) ---

// ImportMediaFiles probes and generates thumbnails for the given file
// paths (typically from a native file-picker dialog or drag-and-drop drop
// event resolved to absolute paths by the frontend), appends successfully
// imported assets to the current project's Assets list, and returns the
// updated project plus any per-file errors.
func (a *App) ImportMediaFiles(filePaths []string) (*models.Project, []media.ImportResult, error) {
	proj := a.projectSvc.CurrentProject()
	if proj == nil {
		return nil, nil, fmt.Errorf("no project is open")
	}

	projectDir := a.projectSvc.CurrentProjectDir()
	results := a.mediaSvc.ImportFiles(filePaths, projectDir)

	for _, r := range results {
		if r.Asset != nil {
			proj.Assets = append(proj.Assets, *r.Asset)
		}
	}

	return proj, results, nil
}

// OpenFileDialog wraps the native OS file picker, restricted to media
// file extensions, for the "Import Media" button. Returns absolute paths;
// empty slice (not an error) if the user cancels.
func (a *App) OpenFileDialog() ([]string, error) {
	return runtime.OpenMultipleFilesDialog(a.ctx, runtime.OpenDialogOptions{
		Title: "Import Media",
		Filters: []runtime.FileFilter{
			{DisplayName: "Media Files", Pattern: "*.mp4;*.mov;*.mkv;*.webm;*.avi;*.mp3;*.wav;*.aac;*.flac;*.m4a;*.jpg;*.jpeg;*.png;*.gif"},
		},
	})
}

// --- Export (bound methods + progress streaming) ---
//
// Export runs as a background goroutine so the Wails-bound call returns
// immediately (the frontend gets a jobID back right away); progress and
// completion are pushed to the frontend via Wails events
// ("export:progress", "export:done", "export:error") rather than the
// frontend polling, since ffmpeg's own -progress output arrives as a
// stream, not a single final value.

func (a *App) StartExport(settings models.ExportSettings) (string, error) {
	proj := a.projectSvc.CurrentProject()
	if proj == nil {
		return "", fmt.Errorf("no project is open")
	}

	a.exportMu.Lock()
	if a.exportCancel != nil {
		a.exportMu.Unlock()
		return "", fmt.Errorf("an export is already running - cancel it before starting another")
	}

	plan, err := export.Plan(proj, settings)
	if err != nil {
		a.exportMu.Unlock()
		return "", fmt.Errorf("building export plan: %w", err)
	}

	if err := os.MkdirAll(filepath.Dir(settings.OutputPath), 0o755); err != nil {
		a.exportMu.Unlock()
		return "", fmt.Errorf("creating output directory: %w", err)
	}

	jobID := newID()
	ctx, cancel := context.WithCancel(a.ctx)
	a.exportCancel = cancel
	a.exportMu.Unlock()

	go a.runExport(ctx, jobID, plan, settings)

	return jobID, nil
}

func (a *App) CancelExport() {
	a.exportMu.Lock()
	defer a.exportMu.Unlock()
	if a.exportCancel != nil {
		a.exportCancel()
		a.exportCancel = nil
	}
}

func (a *App) runExport(ctx context.Context, jobID string, plan *export.ExportPlan, settings models.ExportSettings) {
	defer func() {
		a.exportMu.Lock()
		a.exportCancel = nil
		a.exportMu.Unlock()
	}()

	runtime.EventsEmit(a.ctx, "export:progress", models.ExportProgress{
		JobID: jobID, PercentDone: 0, CurrentStage: "preparing",
	})

	cmd := export.BuildCommand(ctx, a.exportBuilder.FFmpegPath, plan, settings)

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		runtime.EventsEmit(a.ctx, "export:error", models.ExportProgress{
			JobID: jobID, CurrentStage: "error", ErrorMessage: fmt.Sprintf("failed to attach to ffmpeg output: %v", err),
		})
		return
	}
	// ffmpeg writes its human-readable log to stderr; we don't parse it
	// for progress (that's what -progress pipe:1 / stdout is for) but we
	// do capture it so a failure can include a meaningful error message
	// rather than just an exit code.
	var stderrBuf strings.Builder
	cmd.Stderr = &stderrBuf

	if err := cmd.Start(); err != nil {
		runtime.EventsEmit(a.ctx, "export:error", models.ExportProgress{
			JobID: jobID, CurrentStage: "error", ErrorMessage: fmt.Sprintf("failed to start ffmpeg: %v", err),
		})
		return
	}

	runtime.EventsEmit(a.ctx, "export:progress", models.ExportProgress{
		JobID: jobID, PercentDone: 1, CurrentStage: "rendering",
	})

	scanner := bufio.NewScanner(stdout)
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "out_time_ms=") {
			continue
		}
		valueStr := strings.TrimPrefix(line, "out_time_ms=")
		outTimeUs, err := strconv.ParseInt(valueStr, 10, 64)
		if err != nil {
			continue // ffmpeg sometimes emits "N/A" for this field early on; skip rather than crash the scanner
		}
		elapsedSec := float64(outTimeUs) / 1_000_000.0
		percent := (elapsedSec / plan.TotalDuration) * 100
		if percent > 99 {
			percent = 99 // reserve 100% for actual completion, set after cmd.Wait() succeeds
		}
		runtime.EventsEmit(a.ctx, "export:progress", models.ExportProgress{
			JobID: jobID, PercentDone: percent, CurrentStage: "rendering",
		})
	}

	err = cmd.Wait()
	if ctx.Err() != nil {
		runtime.EventsEmit(a.ctx, "export:error", models.ExportProgress{
			JobID: jobID, CurrentStage: "error", ErrorMessage: "export cancelled",
		})
		return
	}
	if err != nil {
		runtime.EventsEmit(a.ctx, "export:error", models.ExportProgress{
			JobID: jobID, CurrentStage: "error",
			ErrorMessage: fmt.Sprintf("ffmpeg exited with an error: %v\n%s", err, lastLines(stderrBuf.String(), 20)),
		})
		return
	}

	runtime.EventsEmit(a.ctx, "export:progress", models.ExportProgress{
		JobID: jobID, PercentDone: 100, CurrentStage: "done",
	})
}

// lastLines returns at most n trailing lines of s, used to keep error
// messages sent to the frontend readable instead of dumping ffmpeg's
// entire (often very long) stderr log.
func lastLines(s string, n int) string {
	lines := strings.Split(strings.TrimRight(s, "\n"), "\n")
	if len(lines) <= n {
		return s
	}
	return strings.Join(lines[len(lines)-n:], "\n")
}

// newID generates a short random-ish ID without pulling in the uuid
// package for every call site that just needs a fresh string ID (clip
// IDs from split/duplicate, export job IDs). Not used for MediaAsset or
// Project IDs, which use uuid.NewString() in their respective packages
// for stronger uniqueness guarantees across longer-lived persisted data.
func newID() string {
	return fmt.Sprintf("id_%d", randUint64())
}

func randUint64() uint64 {
	// Minimal, dependency-free pseudo-random source sufficient for
	// short-lived in-session IDs (clip/job IDs). Not cryptographically
	// secure and not intended to be - if this becomes a correctness
	// concern (e.g. collision risk in a very long session), switch to
	// uuid.NewString() like the project/media packages do.
	var b [8]byte
	f, err := os.Open("/dev/urandom")
	if err == nil {
		defer f.Close()
		_, _ = f.Read(b[:])
	}
	var v uint64
	for i := 0; i < 8; i++ {
		v = v<<8 | uint64(b[i])
	}
	return v
}

func main() {
	app := NewApp()

	err := wails.Run(&options.App{
		Title:  "VideoEditor",
		Width:  1440,
		Height: 900,
		AssetServer: &assetserver.Options{
			Assets: assets,
		},
		BackgroundColour: &options.RGBA{R: 18, G: 18, B: 20, A: 1},
		OnStartup:        app.startup,
		Bind: []interface{}{
			app,
		},
	})

	if err != nil {
		fmt.Println("Error running app:", err.Error())
		os.Exit(1)
	}
}
