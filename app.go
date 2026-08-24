// Package main is the Wails v2 application entrypoint. It wires together
// the project, media, and export backend services and exposes them to the
// React frontend as bound methods (every public method on App is callable
// from TypeScript via the generated wailsjs bindings).
package main

import (
	"bufio"
	"context"
	"embed"
	"encoding/base64"
	"fmt"
	"mime"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"

	"github.com/google/uuid"
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

// parentDir is optional (pass "" to use the configured default Projects
// location) - lets a single project be created somewhere other than the
// app-wide default, chosen via OpenDirectoryDialog in the New Project UI.
func (a *App) NewProject(name string, canvasWidth, canvasHeight int, fps float64, parentDir string) (*models.Project, error) {
	return a.projectSvc.NewProject(name, canvasWidth, canvasHeight, fps, parentDir)
}

func (a *App) OpenProject(projectDir string) (*models.Project, error) {
	return a.projectSvc.OpenProject(projectDir)
}

func (a *App) SaveProject() (*models.Project, error) {
	return a.projectSvc.SaveProject()
}

// ReplaceProject backs undo/redo - see Service.ReplaceProject doc comment.
func (a *App) ReplaceProject(proj *models.Project) (*models.Project, error) {
	return a.projectSvc.ReplaceProject(proj)
}

// parentDir is optional (pass "" to save alongside the app's default
// Projects location).
func (a *App) SaveProjectAs(newName, parentDir string) (*models.Project, error) {
	return a.projectSvc.SaveProjectAs(newName, parentDir)
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

// --- App settings (projects location) ---

func (a *App) GetSettings() (*project.AppSettings, error) {
	return a.projectSvc.GetSettings()
}

// SetProjectsRootDir updates where new projects are created by default.
// Called after the user picks a folder via OpenDirectoryDialog on first
// launch (or later from a settings screen) - pointing this at a synced
// folder (Dropbox, Google Drive, iCloud Drive, etc.) is how project.json
// files and their assets/cache/thumbnails end up shared across devices,
// since this app has no server-side sync of its own.
func (a *App) SetProjectsRootDir(dir string) (*project.AppSettings, error) {
	return a.projectSvc.SetProjectsRootDir(dir)
}

// OpenDirectoryDialog wraps the native OS folder picker, used for the
// first-launch "where should your projects live?" step and for a later
// "change projects location" settings action.
func (a *App) OpenDirectoryDialog() (string, error) {
	return runtime.OpenDirectoryDialog(a.ctx, runtime.OpenDialogOptions{
		Title: "Choose where to store your video projects",
	})
}

// GetProjectsRootDir is a convenience accessor so the frontend doesn't
// need to round-trip through GetSettings just to display the current
// location in a "Browse Projects" or settings view.
func (a *App) GetProjectsRootDir() string {
	return a.projectSvc.RootDir
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
	if proj.Tracks[targetIdx].Type != proj.Tracks[foundTrackIdx].Type {
		return nil, fmt.Errorf(
			"cannot move a %s clip onto a %s track", proj.Tracks[foundTrackIdx].Type, proj.Tracks[targetIdx].Type,
		)
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
// DuplicateClipResult wraps DuplicateClip's output. Wails v2 does not
// reliably marshal Go methods with more than two return values (a value
// + error) into something the JS side can destructure - a 3-value
// return like (*Project, string, error) can arrive on the frontend in a
// shape that isn't array-like, causing a confusing "is not iterable"
// error at the call site instead of a clean type mismatch. Wrapping the
// "extra" value in a struct alongside Project sidesteps this entirely:
// every bound method here follows the safe (value, error) or (*T, error)
// shape, never (*T, U, error).
type DuplicateClipResult struct {
	Project   *models.Project `json:"project"`
	NewClipID string          `json:"newClipId"`
}

func (a *App) DuplicateClip(clipID string) (*DuplicateClipResult, error) {
	proj := a.projectSvc.CurrentProject()
	if proj == nil {
		return nil, fmt.Errorf("no project is open")
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
					return nil, fmt.Errorf("no room to duplicate clip immediately after itself - move it first")
				}
			}

			proj.Tracks[i].Clips = append(proj.Tracks[i].Clips, copyClip)
			return &DuplicateClipResult{Project: proj, NewClipID: copyClip.ID}, nil
		}
	}
	return nil, fmt.Errorf("clip %s not found", clipID)
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

// --- Subtitle clip mutation ---
//
// Mirrors the text clip mutation methods above almost exactly -
// SubtitleClip is intentionally a smaller, fixed-styling sibling of
// TextClip (see models.SubtitleClip's doc comment), so its CRUD surface
// is correspondingly simpler: no per-clip font/color/position fields to
// validate or default.

func (a *App) AddSubtitleTrack(name string) (*models.Project, error) {
	proj := a.projectSvc.CurrentProject()
	if proj == nil {
		return nil, fmt.Errorf("no project is open")
	}
	if name == "" {
		name = fmt.Sprintf("Subtitles %d", countTracksByType(proj, models.TrackSubtitle)+1)
	}
	maxOrder := -1
	for _, t := range proj.Tracks {
		if t.Type == models.TrackSubtitle && t.Order > maxOrder {
			maxOrder = t.Order
		}
	}
	proj.Tracks = append(proj.Tracks, models.Track{
		ID:            newID(),
		Type:          models.TrackSubtitle,
		Name:          name,
		Order:         maxOrder + 1,
		SubtitleClips: []models.SubtitleClip{},
	})
	return proj, nil
}

func (a *App) AddSubtitleClip(trackID string, sc models.SubtitleClip) (*models.Project, error) {
	proj := a.projectSvc.CurrentProject()
	if proj == nil {
		return nil, fmt.Errorf("no project is open")
	}
	if strings.TrimSpace(sc.Content) == "" {
		return nil, fmt.Errorf("subtitle content cannot be empty")
	}
	if sc.TimelineEndSec <= sc.TimelineStartSec {
		return nil, fmt.Errorf("subtitle clip must have a positive duration")
	}
	for i := range proj.Tracks {
		if proj.Tracks[i].ID != trackID {
			continue
		}
		if proj.Tracks[i].Type != models.TrackSubtitle {
			return nil, fmt.Errorf("track %s is not a subtitle track", trackID)
		}
		if sc.ID == "" {
			sc.ID = newID()
		}
		sc.TrackID = trackID
		proj.Tracks[i].SubtitleClips = append(proj.Tracks[i].SubtitleClips, sc)
		return proj, nil
	}
	return nil, fmt.Errorf("track %s not found", trackID)
}

func (a *App) UpdateSubtitleClip(clipID string, updated models.SubtitleClip) (*models.Project, error) {
	proj := a.projectSvc.CurrentProject()
	if proj == nil {
		return nil, fmt.Errorf("no project is open")
	}
	if strings.TrimSpace(updated.Content) == "" {
		return nil, fmt.Errorf("subtitle content cannot be empty")
	}
	if updated.TimelineEndSec <= updated.TimelineStartSec {
		return nil, fmt.Errorf("subtitle clip must have a positive duration")
	}
	for i := range proj.Tracks {
		for j := range proj.Tracks[i].SubtitleClips {
			if proj.Tracks[i].SubtitleClips[j].ID != clipID {
				continue
			}
			updated.ID = clipID
			updated.TrackID = proj.Tracks[i].ID
			proj.Tracks[i].SubtitleClips[j] = updated
			return proj, nil
		}
	}
	return nil, fmt.Errorf("subtitle clip %s not found", clipID)
}

func (a *App) DeleteSubtitleClip(clipID string) (*models.Project, error) {
	proj := a.projectSvc.CurrentProject()
	if proj == nil {
		return nil, fmt.Errorf("no project is open")
	}
	for i := range proj.Tracks {
		before := len(proj.Tracks[i].SubtitleClips)
		out := make([]models.SubtitleClip, 0, before)
		for _, c := range proj.Tracks[i].SubtitleClips {
			if c.ID != clipID {
				out = append(out, c)
			}
		}
		proj.Tracks[i].SubtitleClips = out
		if len(out) != before {
			return proj, nil
		}
	}
	return nil, fmt.Errorf("subtitle clip %s not found", clipID)
}

// --- Effect mutation (on media clips) ---

// AddEffect appends a new effect to a clip's Effects list. Defaults
// Enabled to true and fills a starting Params map if the caller didn't
// send one, so a "quick add" from the frontend (just a type, no
// pre-tuned params) still produces a usable, visible effect.
func (a *App) AddEffect(clipID string, effect models.Effect) (*models.Project, error) {
	proj := a.projectSvc.CurrentProject()
	if proj == nil {
		return nil, fmt.Errorf("no project is open")
	}
	for i := range proj.Tracks {
		for j := range proj.Tracks[i].Clips {
			if proj.Tracks[i].Clips[j].ID != clipID {
				continue
			}
			if effect.ID == "" {
				effect.ID = newID()
			}
			effect.Enabled = true
			if effect.Params == nil {
				effect.Params = map[string]float64{}
			}
			proj.Tracks[i].Clips[j].Effects = append(proj.Tracks[i].Clips[j].Effects, effect)
			return proj, nil
		}
	}
	return nil, fmt.Errorf("clip %s not found", clipID)
}

// UpdateEffect replaces one effect's params/enabled state in place,
// identified by its own ID within the owning clip's Effects list.
func (a *App) UpdateEffect(clipID, effectID string, updated models.Effect) (*models.Project, error) {
	proj := a.projectSvc.CurrentProject()
	if proj == nil {
		return nil, fmt.Errorf("no project is open")
	}
	for i := range proj.Tracks {
		for j := range proj.Tracks[i].Clips {
			if proj.Tracks[i].Clips[j].ID != clipID {
				continue
			}
			for k := range proj.Tracks[i].Clips[j].Effects {
				if proj.Tracks[i].Clips[j].Effects[k].ID != effectID {
					continue
				}
				updated.ID = effectID
				proj.Tracks[i].Clips[j].Effects[k] = updated
				return proj, nil
			}
			return nil, fmt.Errorf("effect %s not found on clip %s", effectID, clipID)
		}
	}
	return nil, fmt.Errorf("clip %s not found", clipID)
}

// RemoveEffect deletes one effect from a clip's Effects list by ID.
func (a *App) RemoveEffect(clipID, effectID string) (*models.Project, error) {
	proj := a.projectSvc.CurrentProject()
	if proj == nil {
		return nil, fmt.Errorf("no project is open")
	}
	for i := range proj.Tracks {
		for j := range proj.Tracks[i].Clips {
			if proj.Tracks[i].Clips[j].ID != clipID {
				continue
			}
			clip := &proj.Tracks[i].Clips[j]
			before := len(clip.Effects)
			out := make([]models.Effect, 0, before)
			for _, e := range clip.Effects {
				if e.ID != effectID {
					out = append(out, e)
				}
			}
			clip.Effects = out
			if len(out) == before {
				return nil, fmt.Errorf("effect %s not found on clip %s", effectID, clipID)
			}
			return proj, nil
		}
	}
	return nil, fmt.Errorf("clip %s not found", clipID)
}

// --- Transition mutation ---

// SetTransition attaches a transition to the boundary between clipID
// and the clip immediately following it on the same track (nextClipID).
// Both clips must already be adjacent in time for the transition to
// make sense at export time (see export/transitions.go) - this method
// does not itself verify adjacency, since "adjacent" is a property of
// the current TimelineStartSec/TimelineEndSec values and could change
// later via a drag; the export builder validates timing at export time
// instead and returns a clear error there if a configured transition no
// longer fits.
func (a *App) SetTransition(clipID string, transition models.Transition) (*models.Project, error) {
	proj := a.projectSvc.CurrentProject()
	if proj == nil {
		return nil, fmt.Errorf("no project is open")
	}
	if transition.DurationSec <= 0 {
		return nil, fmt.Errorf("transition duration must be positive")
	}
	for i := range proj.Tracks {
		for j := range proj.Tracks[i].Clips {
			if proj.Tracks[i].Clips[j].ID != clipID {
				continue
			}
			if transition.ID == "" {
				transition.ID = newID()
			}
			proj.Tracks[i].Clips[j].Transition = &transition
			return proj, nil
		}
	}
	return nil, fmt.Errorf("clip %s not found", clipID)
}

// RemoveTransition clears any transition on the given clip (reverting
// the boundary with its next clip back to a hard cut).
func (a *App) RemoveTransition(clipID string) (*models.Project, error) {
	proj := a.projectSvc.CurrentProject()
	if proj == nil {
		return nil, fmt.Errorf("no project is open")
	}
	for i := range proj.Tracks {
		for j := range proj.Tracks[i].Clips {
			if proj.Tracks[i].Clips[j].ID != clipID {
				continue
			}
			proj.Tracks[i].Clips[j].Transition = nil
			return proj, nil
		}
	}
	return nil, fmt.Errorf("clip %s not found", clipID)
}

// --- Keyframe mutation ---

// AddKeyframe appends one keyframe to a clip's Keyframes list. Multiple
// keyframes on the same property are expected over a clip's lifetime
// (that's the whole point); this method does not deduplicate by
// TimeSec, since the export builder's buildKeyframeExpression sorts and
// processes whatever is there - if two keyframes on the same property
// land at the same TimeSec, the later one in the slice wins at export
// time, which mirrors "last edit wins" and avoids silently dropping data
// the person might want to clean up themselves.
func (a *App) AddKeyframe(clipID string, kf models.Keyframe) (*models.Project, error) {
	proj := a.projectSvc.CurrentProject()
	if proj == nil {
		return nil, fmt.Errorf("no project is open")
	}
	for i := range proj.Tracks {
		for j := range proj.Tracks[i].Clips {
			if proj.Tracks[i].Clips[j].ID != clipID {
				continue
			}
			if kf.ID == "" {
				kf.ID = newID()
			}
			if kf.Interpolation == "" {
				kf.Interpolation = models.InterpolationLinear
			}
			proj.Tracks[i].Clips[j].Keyframes = append(proj.Tracks[i].Clips[j].Keyframes, kf)
			return proj, nil
		}
	}
	return nil, fmt.Errorf("clip %s not found", clipID)
}

func (a *App) UpdateKeyframe(clipID, keyframeID string, updated models.Keyframe) (*models.Project, error) {
	proj := a.projectSvc.CurrentProject()
	if proj == nil {
		return nil, fmt.Errorf("no project is open")
	}
	for i := range proj.Tracks {
		for j := range proj.Tracks[i].Clips {
			if proj.Tracks[i].Clips[j].ID != clipID {
				continue
			}
			for k := range proj.Tracks[i].Clips[j].Keyframes {
				if proj.Tracks[i].Clips[j].Keyframes[k].ID != keyframeID {
					continue
				}
				updated.ID = keyframeID
				proj.Tracks[i].Clips[j].Keyframes[k] = updated
				return proj, nil
			}
			return nil, fmt.Errorf("keyframe %s not found on clip %s", keyframeID, clipID)
		}
	}
	return nil, fmt.Errorf("clip %s not found", clipID)
}

func (a *App) RemoveKeyframe(clipID, keyframeID string) (*models.Project, error) {
	proj := a.projectSvc.CurrentProject()
	if proj == nil {
		return nil, fmt.Errorf("no project is open")
	}
	for i := range proj.Tracks {
		for j := range proj.Tracks[i].Clips {
			if proj.Tracks[i].Clips[j].ID != clipID {
				continue
			}
			clip := &proj.Tracks[i].Clips[j]
			before := len(clip.Keyframes)
			out := make([]models.Keyframe, 0, before)
			for _, k := range clip.Keyframes {
				if k.ID != keyframeID {
					out = append(out, k)
				}
			}
			clip.Keyframes = out
			if len(out) == before {
				return nil, fmt.Errorf("keyframe %s not found on clip %s", keyframeID, clipID)
			}
			return proj, nil
		}
	}
	return nil, fmt.Errorf("clip %s not found", clipID)
}

// mimeOverrides fills gaps in Go's built-in mime.TypeByExtension, which
// on some platforms doesn't know common video/audio extensions at all
// (returning "" rather than a sensible default) - without this, some
// browsers/webviews refuse to play a data: URL that has no usable MIME
// type.
var mimeOverrides = map[string]string{
	".mp4":  "video/mp4",
	".m4v":  "video/mp4",
	".mov":  "video/quicktime",
	".webm": "video/webm",
	".mkv":  "video/x-matroska",
	".avi":  "video/x-msvideo",
	".mp3":  "audio/mpeg",
	".wav":  "audio/wav",
	".aac":  "audio/aac",
	".flac": "audio/flac",
	".m4a":  "audio/mp4",
	".ogg":  "audio/ogg",
	".jpg":  "image/jpeg",
	".jpeg": "image/jpeg",
	".png":  "image/png",
	".gif":  "image/gif",
	".webp": "image/webp",
}

func mimeTypeFor(path string) string {
	ext := strings.ToLower(filepath.Ext(path))
	if m, ok := mimeOverrides[ext]; ok {
		return m
	}
	if m := mime.TypeByExtension(ext); m != "" {
		return m
	}
	return "application/octet-stream"
}

// ReadMediaFileAsDataURL reads a local media file (video/audio/image)
// from disk and returns it as a data: URL.
//
// Why this exists: MediaAsset.FilePath/ThumbnailPath are plain absolute
// filesystem paths. That is not a URL any <video>/<audio>/<img> element
// or canvas can load - the Wails asset server only serves the embedded
// frontend bundle out of the box, it has no built-in route for
// arbitrary local files. Without something bridging that gap, every
// video and every thumbnail in the app renders as nothing (a
// permanently black canvas / broken image), regardless of anything else
// being correct - this was a real, previously-missing piece, not a
// hypothetical edge case.
//
// This goes through a bound Go method (IPC) rather than an HTTP route
// registered on the asset server specifically because IPC bindings work
// identically in `wails dev` and a built app, whereas HTTP asset routing
// differs between the two (dev mode proxies the frontend dev server
// directly, bypassing custom asset-server handlers) - so this is the
// one approach that doesn't need special-casing per run mode.
//
// It reads the whole file into memory, which is fine for the clip
// lengths this editor currently targets; if very large source files
// become a real use case, this should become a streamed, range-request
// capable HTTP approach instead.
func (a *App) ReadMediaFileAsDataURL(path string) (string, error) {
	info, err := os.Stat(path)
	if err != nil {
		return "", fmt.Errorf("reading media file: %w", err)
	}
	if info.IsDir() {
		return "", fmt.Errorf("%s is a directory, not a file", path)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("reading media file: %w", err)
	}
	return "data:" + mimeTypeFor(path) + ";base64," + base64.StdEncoding.EncodeToString(data), nil
}

// --- Media import (bound methods) ---

// ImportMediaFilesResult wraps ImportMediaFiles' output for the same
// reason as DuplicateClipResult above - Wails v2 does not reliably
// support more than (value, error) as a Go method's return shape on the
// JS side.
type ImportMediaFilesResult struct {
	Project *models.Project      `json:"project"`
	Results []media.ImportResult `json:"results"`
}

// ImportMediaFiles probes and generates thumbnails for the given file
// paths (typically from a native file-picker dialog or drag-and-drop drop
// event resolved to absolute paths by the frontend), appends successfully
// imported assets to the current project's Assets list, and returns the
// updated project plus any per-file errors.
func (a *App) ImportMediaFiles(filePaths []string) (*ImportMediaFilesResult, error) {
	proj := a.projectSvc.CurrentProject()
	if proj == nil {
		return nil, fmt.Errorf("no project is open")
	}

	projectDir := a.projectSvc.CurrentProjectDir()
	results := a.mediaSvc.ImportFiles(filePaths, projectDir)

	for _, r := range results {
		if r.Asset != nil {
			proj.Assets = append(proj.Assets, *r.Asset)
		}
	}

	return &ImportMediaFilesResult{Project: proj, Results: results}, nil
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

// newID generates a fresh short-ish unique ID for clip IDs from
// split/duplicate/add operations (Project/MediaAsset IDs use
// uuid.NewString() directly in their own packages).
//
// This used to hand-roll a random ID by reading 8 bytes from
// /dev/urandom. That path does not exist on Windows at all -
// os.Open("/dev/urandom") fails there, the code treated that failure as
// non-fatal ("best effort") and silently fell through with the
// all-zero byte buffer it started with, so randUint64() returned 0
// every single time on Windows. That made newID() return the exact
// same string, "id_0", for every clip - which meant every clip added
// via drag-and-drop/double-click/split/duplicate on Windows silently
// collided on ID with every other clip that had gone through the same
// path. Selecting, moving, or deleting "one" clip then actually
// selected/moved/deleted *every* clip sharing that ID, since
// removeClip and every clipID-based lookup match by equality - this
// was the actual cause of "selecting one selects all the corresponding
// clips" and "an operation on one clip removes another one" reported
// against the Windows build. uuid.NewString() has no such platform gap
// and is already a dependency used for Project/MediaAsset IDs, so this
// just makes clip IDs consistent with those instead of maintaining a
// second, platform-fragile ID scheme.
func newID() string {
	return "id_" + uuid.NewString()
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
