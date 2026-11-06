package main

import (
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

// Locations of application data on disk.
//
//	baseDir     state.json, history.json, TLS material      (default ~/P2P)
//	receiveDir  finished uploads from other devices
//	tempDir     in-flight uploads (.part), their manifests and journals
var (
	baseDir    = defaultBaseDir()
	dirsMu     sync.RWMutex // guards receiveDir and tempDir
	receiveDir = filepath.Join(baseDir, "received")
	tempDir    = filepath.Join(baseDir, "temp")
)

func defaultBaseDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		home = "."
	}
	return filepath.Join(home, "P2P")
}

func getReceiveDir() string {
	dirsMu.RLock()
	defer dirsMu.RUnlock()
	return receiveDir
}

func getTempDir() string {
	dirsMu.RLock()
	defer dirsMu.RUnlock()
	return tempDir
}

// initDirs makes sure the receive and temp directories exist.
func initDirs() {
	for _, dir := range []string{getReceiveDir(), getTempDir()} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			fmt.Printf("%sCould not create %s: %v%s\n", Red, dir, err, Reset)
		}
	}
}

// setReceiveDir switches the folder for received files. The temp directory
// lives inside it so finished uploads are moved with a cheap atomic rename.
// The new location must be writable, otherwise nothing changes.
func setReceiveDir(newDir string) error {
	absPath, err := filepath.Abs(newDir)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(absPath, 0o755); err != nil {
		return err
	}
	newTemp := filepath.Join(absPath, ".temp")
	if err := os.MkdirAll(newTemp, 0o755); err != nil {
		return err
	}
	probe, err := os.CreateTemp(newTemp, ".write-test-*")
	if err != nil {
		return fmt.Errorf("directory is not writable: %w", err)
	}
	probe.Close()
	_ = os.Remove(probe.Name())

	dirsMu.Lock()
	receiveDir = absPath
	tempDir = newTemp
	dirsMu.Unlock()
	resetDedupIndex()
	return nil
}

// persistReceiveDir remembers the current receive directory across restarts.
func persistReceiveDir() {
	dir := getReceiveDir()
	stateMu.Lock()
	state.CustomReceiveDir = dir
	saveStateLocked()
	stateMu.Unlock()
}
