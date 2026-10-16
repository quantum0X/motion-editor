package main

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"testing"

	"videoeditor/backend/models"
	"videoeditor/backend/project"
)

func newTestAppWithAsset(t *testing.T) (*App, string) {
	t.Helper()
	dir := t.TempDir()
	svc, err := project.NewService(filepath.Join(dir, "data"))
	if err != nil {
		t.Fatal(err)
	}
	proj, err := svc.NewProject("Test", 1920, 1080, 30, dir)
	if err != nil {
		t.Fatal(err)
	}

	mediaPath := filepath.Join(dir, "clip.mp4")
	if err := os.WriteFile(mediaPath, []byte("0123456789abcdef"), 0o644); err != nil {
		t.Fatal(err)
	}
	proj.Assets = append(proj.Assets, models.MediaAsset{ID: "a1", FilePath: mediaPath})
	return &App{projectSvc: svc}, mediaPath
}

func serveMedia(app *App, path, rangeHeader string) *httptest.ResponseRecorder {
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusTeapot) })
	req := httptest.NewRequest(http.MethodGet, "/localmedia?path="+url.QueryEscape(path), nil)
	if rangeHeader != "" {
		req.Header.Set("Range", rangeHeader)
	}
	rec := httptest.NewRecorder()
	app.mediaMiddleware(next).ServeHTTP(rec, req)
	return rec
}

func TestMediaMiddlewareServesProjectAssetWithRanges(t *testing.T) {
	app, mediaPath := newTestAppWithAsset(t)

	rec := serveMedia(app, mediaPath, "")
	if rec.Code != http.StatusOK || rec.Body.String() != "0123456789abcdef" {
		t.Fatalf("full read: got %d %q", rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); ct != "video/mp4" {
		t.Errorf("content type = %q, want video/mp4", ct)
	}

	rec = serveMedia(app, mediaPath, "bytes=4-7")
	if rec.Code != http.StatusPartialContent || rec.Body.String() != "4567" {
		t.Fatalf("range read: got %d %q", rec.Code, rec.Body.String())
	}
}

func TestMediaMiddlewareRejectsFilesOutsideProject(t *testing.T) {
	app, mediaPath := newTestAppWithAsset(t)
	other := filepath.Join(filepath.Dir(mediaPath), "secret.txt")
	if err := os.WriteFile(other, []byte("nope"), 0o644); err != nil {
		t.Fatal(err)
	}
	if rec := serveMedia(app, other, ""); rec.Code != http.StatusNotFound {
		t.Fatalf("unreferenced file: got %d, want 404", rec.Code)
	}
}

func TestMediaMiddlewarePassesThroughOtherPaths(t *testing.T) {
	app, _ := newTestAppWithAsset(t)
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusTeapot) })
	rec := httptest.NewRecorder()
	app.mediaMiddleware(next).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/assets/index.js", nil))
	if rec.Code != http.StatusTeapot {
		t.Fatalf("non-media path should reach the asset server, got %d", rec.Code)
	}
}
