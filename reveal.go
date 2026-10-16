package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	goruntime "runtime"
)

// RevealInFileManager opens the OS file manager at path - selecting the
// file when path is a file, or opening the folder when it's a directory.
// An empty path means the currently open project's folder. Backs
// File > Show Project Folder and the export panel's "Show in folder".
func (a *App) RevealInFileManager(path string) error {
	if path == "" && a.projectSvc != nil {
		path = a.projectSvc.CurrentProjectDir()
	}
	if path == "" {
		return fmt.Errorf("no project is open")
	}
	info, err := os.Stat(path)
	if err != nil {
		return fmt.Errorf("cannot open %s: %w", path, err)
	}

	var cmd *exec.Cmd
	switch goruntime.GOOS {
	case "windows":
		if info.IsDir() {
			cmd = exec.Command("explorer", path)
		} else {
			cmd = exec.Command("explorer", "/select,", path)
		}
	case "darwin":
		if info.IsDir() {
			cmd = exec.Command("open", path)
		} else {
			cmd = exec.Command("open", "-R", path)
		}
	default:
		dir := path
		if !info.IsDir() {
			dir = filepath.Dir(path)
		}
		cmd = exec.Command("xdg-open", dir)
	}
	// Start, not Run: the file manager can outlive this call (and
	// explorer.exe returns a non-zero exit code even on success). Wait in
	// the background only to reap the process.
	if err := cmd.Start(); err != nil {
		return err
	}
	go func() { _ = cmd.Wait() }()
	return nil
}
