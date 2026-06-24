// Package project handles all on-disk persistence for editor projects:
// creating the project folder structure, saving/loading project.json,
// autosave, and tracking recently opened projects.
//
// On-disk layout for a project named "MyProject" (matches the spec):
//
//	Projects/
//	  MyProject/
//	    project.json
//	    cache/
//	    thumbnails/
//	    proxies/
//	    exports/
//	    assets/        (currently unused for copying media in Phase 1 —
//	                    we reference original file paths directly; this
//	                    folder is reserved for a future "collect assets"
//	                    / relink feature, and for imported images that the
//	                    user drags in without a stable source path, e.g.
//	                    pasted images.)
package project

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"time"

	"github.com/google/uuid"

	"videoeditor/backend/models"
)

const (
	projectFileName      = "project.json"
	currentFormatVersion = 1
)

// Service exposes project lifecycle operations. It is constructed once at
// app startup (see app.go) and its methods are bound to the frontend via
// Wails, so every exported method here is callable from TypeScript as
// window.go.project.Service.<MethodName>(...).
type Service struct {
	// RootDir is the top-level "Projects" folder under which every
	// individual project gets its own subfolder. Defaults to a
	// per-OS user data directory; see NewService.
	RootDir string

	// recentProjectsPath is a small JSON file (outside any single
	// project folder) tracking recently opened project paths.
	recentProjectsPath string

	// current holds the in-memory state of whichever project is open.
	// All mutating timeline operations (in the timeline service) act on
	// this pointer, and SaveProject persists it.
	current    *models.Project
	currentDir string
}

// RecentEntry is one row in recent_projects.json. Exported because
// app.go's RecentProjects binding returns these directly to the frontend.
type RecentEntry struct {
	ProjectDir string    `json:"projectDir"`
	Name       string    `json:"name"`
	LastOpened time.Time `json:"lastOpened"`
}

// NewService creates the project service, ensuring the root "Projects"
// directory and the recent-projects index file exist.
//
// baseDataDir should be an OS-appropriate app data directory (e.g. from
// Wails: os.UserConfigDir() + "/VideoEditor"); passing it in rather than
// computing it here keeps this package testable without touching the
// real filesystem location.
func NewService(baseDataDir string) (*Service, error) {
	root := filepath.Join(baseDataDir, "Projects")
	if err := os.MkdirAll(root, 0o755); err != nil {
		return nil, fmt.Errorf("creating projects root dir: %w", err)
	}

	s := &Service{
		RootDir:            root,
		recentProjectsPath: filepath.Join(baseDataDir, "recent_projects.json"),
	}

	if _, err := os.Stat(s.recentProjectsPath); os.IsNotExist(err) {
		if err := writeJSON(s.recentProjectsPath, []RecentEntry{}); err != nil {
			return nil, fmt.Errorf("initializing recent projects index: %w", err)
		}
	}

	return s, nil
}

// projectSubdirs lists every folder created under a new project directory.
func projectSubdirs() []string {
	return []string{"cache", "thumbnails", "proxies", "exports", "assets"}
}

// NewProject creates a new project folder on disk (Projects/<name>/...),
// initializes an empty Project model with one video and one audio track
// (a sensible default so the timeline isn't empty on first open), saves
// it, and makes it the currently open project.
func (s *Service) NewProject(name string, canvasWidth, canvasHeight int, fps float64) (*models.Project, error) {
	if name == "" {
		return nil, fmt.Errorf("project name cannot be empty")
	}
	if canvasWidth <= 0 || canvasHeight <= 0 {
		canvasWidth, canvasHeight = 1920, 1080
	}
	if fps <= 0 {
		fps = 30
	}

	dir, err := s.uniqueProjectDir(name)
	if err != nil {
		return nil, err
	}

	for _, sub := range projectSubdirs() {
		if err := os.MkdirAll(filepath.Join(dir, sub), 0o755); err != nil {
			return nil, fmt.Errorf("creating project subdir %s: %w", sub, err)
		}
	}

	now := time.Now()
	proj := &models.Project{
		ID:            uuid.NewString(),
		Name:          name,
		CreatedAt:     now,
		ModifiedAt:    now,
		FormatVersion: currentFormatVersion,
		CanvasWidth:   canvasWidth,
		CanvasHeight:  canvasHeight,
		FPS:           fps,
		Tracks: []models.Track{
			{ID: uuid.NewString(), Type: models.TrackVideo, Name: "Video 1", Order: 0, Clips: []models.Clip{}},
			{ID: uuid.NewString(), Type: models.TrackAudio, Name: "Audio 1", Order: 0, Clips: []models.Clip{}},
		},
		Assets: []models.MediaAsset{},
	}

	if err := writeJSON(filepath.Join(dir, projectFileName), proj); err != nil {
		return nil, fmt.Errorf("writing initial project.json: %w", err)
	}

	s.current = proj
	s.currentDir = dir

	if err := s.touchRecent(dir, name); err != nil {
		// Non-fatal: recent list is a convenience feature, not core data.
		fmt.Printf("warning: failed to update recent projects list: %v\n", err)
	}

	return proj, nil
}

// uniqueProjectDir returns Projects/<name>, appending " (2)", " (3)", etc.
// if a folder with that name already exists, so NewProject never silently
// overwrites an existing project folder.
func (s *Service) uniqueProjectDir(name string) (string, error) {
	base := filepath.Join(s.RootDir, sanitizeFolderName(name))
	candidate := base
	for i := 2; ; i++ {
		if _, err := os.Stat(candidate); os.IsNotExist(err) {
			return candidate, nil
		}
		candidate = fmt.Sprintf("%s (%d)", base, i)
		if i > 1000 {
			return "", fmt.Errorf("could not find a free project folder name for %q", name)
		}
	}
}

// OpenProject loads project.json from the given project directory and
// makes it the current project.
func (s *Service) OpenProject(projectDir string) (*models.Project, error) {
	path := filepath.Join(projectDir, projectFileName)
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("reading project file: %w", err)
	}

	var proj models.Project
	if err := json.Unmarshal(data, &proj); err != nil {
		return nil, fmt.Errorf("parsing project.json (it may be corrupted - check %s.bak): %w", path, err)
	}

	s.current = &proj
	s.currentDir = projectDir

	if err := s.touchRecent(projectDir, proj.Name); err != nil {
		fmt.Printf("warning: failed to update recent projects list: %v\n", err)
	}

	return &proj, nil
}

// SaveProject persists the in-memory current project to project.json,
// updating ModifiedAt. Before overwriting, it copies the existing file to
// project.json.bak as a single-level safety net against a crash or bad
// write leaving the project unreadable (see also AutoSave).
func (s *Service) SaveProject() (*models.Project, error) {
	if s.current == nil || s.currentDir == "" {
		return nil, fmt.Errorf("no project is currently open")
	}

	s.current.ModifiedAt = time.Now()

	mainPath := filepath.Join(s.currentDir, projectFileName)
	backupPath := mainPath + ".bak"
	if _, err := os.Stat(mainPath); err == nil {
		// Best-effort backup; do not fail the save if this fails.
		if data, readErr := os.ReadFile(mainPath); readErr == nil {
			_ = os.WriteFile(backupPath, data, 0o644)
		}
	}

	if err := writeJSON(mainPath, s.current); err != nil {
		return nil, fmt.Errorf("writing project.json: %w", err)
	}

	return s.current, nil
}

// SaveProjectAs copies the current project to a new project folder under
// a new name, switches the current project to that new copy, and saves
// it. The original project on disk is left untouched.
func (s *Service) SaveProjectAs(newName string) (*models.Project, error) {
	if s.current == nil {
		return nil, fmt.Errorf("no project is currently open")
	}

	newDir, err := s.uniqueProjectDir(newName)
	if err != nil {
		return nil, err
	}
	for _, sub := range projectSubdirs() {
		if err := os.MkdirAll(filepath.Join(newDir, sub), 0o755); err != nil {
			return nil, fmt.Errorf("creating project subdir %s: %w", sub, err)
		}
	}

	// Reassign ID so this is treated as a distinct project, not an alias
	// of the original (important once recent-projects / autosave keys
	// off project dir + ID).
	s.current.ID = uuid.NewString()
	s.current.Name = newName
	s.currentDir = newDir

	return s.SaveProject()
}

// AutoSave writes the current project to <projectDir>/cache/autosave.json
// rather than overwriting project.json directly. This means an autosave
// can never corrupt the user's last explicit save; recovery (below)
// explicitly offers the autosave as a choice rather than loading it
// silently.
func (s *Service) AutoSave() error {
	if s.current == nil || s.currentDir == "" {
		return fmt.Errorf("no project is currently open")
	}
	autosavePath := filepath.Join(s.currentDir, "cache", "autosave.json")
	return writeJSON(autosavePath, s.current)
}

// RecoveryInfo describes an autosave found on disk that is newer than the
// last explicit save, so the frontend can prompt "recover unsaved
// changes?" on open.
type RecoveryInfo struct {
	HasRecovery  bool      `json:"hasRecovery"`
	AutosaveTime time.Time `json:"autosaveTime"`
}

// CheckRecovery compares the mtime of cache/autosave.json against
// project.json for the given project directory.
func (s *Service) CheckRecovery(projectDir string) (*RecoveryInfo, error) {
	autosavePath := filepath.Join(projectDir, "cache", "autosave.json")
	mainPath := filepath.Join(projectDir, projectFileName)

	autoInfo, err := os.Stat(autosavePath)
	if os.IsNotExist(err) {
		return &RecoveryInfo{HasRecovery: false}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("checking autosave file: %w", err)
	}

	mainInfo, err := os.Stat(mainPath)
	if err != nil {
		// No main project.json but an autosave exists - still offer recovery.
		return &RecoveryInfo{HasRecovery: true, AutosaveTime: autoInfo.ModTime()}, nil
	}

	if autoInfo.ModTime().After(mainInfo.ModTime()) {
		return &RecoveryInfo{HasRecovery: true, AutosaveTime: autoInfo.ModTime()}, nil
	}
	return &RecoveryInfo{HasRecovery: false}, nil
}

// RecoverFromAutosave loads cache/autosave.json instead of project.json
// and makes it the current project (the user must still explicitly Save
// to commit the recovered state to project.json).
func (s *Service) RecoverFromAutosave(projectDir string) (*models.Project, error) {
	autosavePath := filepath.Join(projectDir, "cache", "autosave.json")
	data, err := os.ReadFile(autosavePath)
	if err != nil {
		return nil, fmt.Errorf("reading autosave file: %w", err)
	}
	var proj models.Project
	if err := json.Unmarshal(data, &proj); err != nil {
		return nil, fmt.Errorf("parsing autosave file: %w", err)
	}
	s.current = &proj
	s.currentDir = projectDir
	return &proj, nil
}

// RecentProjects returns the recent-projects list, most recently opened
// first, skipping any entries whose project.json no longer exists on disk
// (e.g. the folder was deleted or moved outside the app).
func (s *Service) RecentProjects() ([]RecentEntry, error) {
	var entries []RecentEntry
	if err := readJSON(s.recentProjectsPath, &entries); err != nil {
		return nil, fmt.Errorf("reading recent projects index: %w", err)
	}

	valid := make([]RecentEntry, 0, len(entries))
	for _, e := range entries {
		if _, err := os.Stat(filepath.Join(e.ProjectDir, projectFileName)); err == nil {
			valid = append(valid, e)
		}
	}

	sort.Slice(valid, func(i, j int) bool {
		return valid[i].LastOpened.After(valid[j].LastOpened)
	})

	return valid, nil
}

// touchRecent adds or bumps an entry in the recent-projects index.
func (s *Service) touchRecent(dir, name string) error {
	var entries []RecentEntry
	if err := readJSON(s.recentProjectsPath, &entries); err != nil {
		entries = []RecentEntry{}
	}

	found := false
	for i := range entries {
		if entries[i].ProjectDir == dir {
			entries[i].LastOpened = time.Now()
			entries[i].Name = name
			found = true
			break
		}
	}
	if !found {
		entries = append(entries, RecentEntry{ProjectDir: dir, Name: name, LastOpened: time.Now()})
	}

	// Cap the list so it doesn't grow unbounded over months of use.
	const maxRecent = 20
	sort.Slice(entries, func(i, j int) bool { return entries[i].LastOpened.After(entries[j].LastOpened) })
	if len(entries) > maxRecent {
		entries = entries[:maxRecent]
	}

	return writeJSON(s.recentProjectsPath, entries)
}

// CurrentProject returns the in-memory project currently open, or nil.
func (s *Service) CurrentProject() *models.Project {
	return s.current
}

// CurrentProjectDir returns the folder of the project currently open.
// Other services (media import, export) need this to know where
// thumbnails/proxies/exports should be written.
func (s *Service) CurrentProjectDir() string {
	return s.currentDir
}

// --- helpers ---

func writeJSON(path string, v interface{}) error {
	data, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return fmt.Errorf("marshaling JSON: %w", err)
	}
	// Write to a temp file then rename, so a crash mid-write can't leave
	// a truncated/corrupt project.json behind.
	tmpPath := path + ".tmp"
	if err := os.WriteFile(tmpPath, data, 0o644); err != nil {
		return fmt.Errorf("writing temp file: %w", err)
	}
	if err := os.Rename(tmpPath, path); err != nil {
		return fmt.Errorf("renaming temp file into place: %w", err)
	}
	return nil
}

func readJSON(path string, v interface{}) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, v)
}

// sanitizeFolderName strips characters that are invalid in Windows/macOS/
// Linux folder names, since the project name comes directly from user
// input and is used as-is for the folder name.
func sanitizeFolderName(name string) string {
	invalid := []rune{'/', '\\', ':', '*', '?', '"', '<', '>', '|'}
	runes := []rune(name)
	out := make([]rune, 0, len(runes))
	for _, r := range runes {
		isInvalid := false
		for _, bad := range invalid {
			if r == bad {
				isInvalid = true
				break
			}
		}
		if !isInvalid {
			out = append(out, r)
		}
	}
	result := string(out)
	if result == "" {
		result = "Untitled Project"
	}
	return result
}
