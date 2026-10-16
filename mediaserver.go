package main

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// mediaRoutePrefix is the URL path the frontend uses to stream local
// media files (see frontend/src/utils/mediaUrl.ts). Kept in sync by hand.
const mediaRoutePrefix = "/localmedia"

// mediaMiddleware serves a project's source media and thumbnails straight
// from disk over the Wails asset server, e.g.
// `/localmedia?path=C%3A%5Cclips%5Ca.mp4`.
//
// This replaces shipping whole files over IPC as base64 data: URLs
// (ReadMediaFileAsDataURL), which held every source video fully in
// memory - ~1.33x its size as a JS string, plus the decoded copy - and
// blocked the preview until the entire file had crossed the bridge.
// http.ServeContent answers Range requests, so <video> elements can seek
// and stream just the bytes they need.
//
// A middleware (rather than AssetServer.Handler) is used because Wails
// applies it in both `wails dev` (in front of the Vite proxy) and a built
// app, so one code path works in both run modes.
//
// Only files referenced by the currently open project's assets are
// served, so this can't be used to read arbitrary files off disk.
func (a *App) mediaMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != mediaRoutePrefix && r.URL.Path != mediaRoutePrefix+"/" {
			next.ServeHTTP(w, r)
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}

		path := r.URL.Query().Get("path")
		if path == "" || !a.isProjectMediaPath(path) {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}

		f, err := os.Open(path)
		if err != nil {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		defer f.Close()

		info, err := f.Stat()
		if err != nil || info.IsDir() {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}

		w.Header().Set("Content-Type", mimeTypeFor(path))
		w.Header().Set("Cache-Control", "no-cache")
		http.ServeContent(w, r, info.Name(), info.ModTime(), f)
	})
}

// isProjectMediaPath reports whether path is the source file or thumbnail
// of an asset in the currently open project.
func (a *App) isProjectMediaPath(path string) bool {
	if a.projectSvc == nil {
		return false
	}
	proj := a.projectSvc.CurrentProject()
	if proj == nil {
		return false
	}
	want := normalizeMediaPath(path)
	for _, asset := range proj.Assets {
		if normalizeMediaPath(asset.FilePath) == want || (asset.ThumbnailPath != "" && normalizeMediaPath(asset.ThumbnailPath) == want) {
			return true
		}
	}
	return false
}

func normalizeMediaPath(p string) string {
	p = filepath.Clean(p)
	if filepath.Separator == '\\' {
		// Windows paths are case-insensitive.
		p = strings.ToLower(p)
	}
	return p
}
