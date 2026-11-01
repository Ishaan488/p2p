package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestDownloadTransferPersistenceAndRecovery(t *testing.T) {
	tmpDir := t.TempDir()
	origTemp := tempDir
	transfersMu.Lock()
	tempDir = tmpDir
	transfersMu.Unlock()
	defer func() {
		transfersMu.Lock()
		tempDir = origTemp
		transfersMu.Unlock()
	}()

	// Create a dummy source file that the PC is sending
	sourceFile := filepath.Join(tmpDir, "sample_video.mp4")
	data := []byte("hello p2p stream chunk test data")
	if err := os.WriteFile(sourceFile, data, 0644); err != nil {
		t.Fatalf("failed to write test file: %v", err)
	}

	transferID := "test-dl-" + randomID()
	state := &TransferState{
		ID:          transferID,
		Filename:    "sample_video.mp4",
		TotalChunks: 2,
		ChunkSize:   16,
		TotalSize:   int64(len(data)),
		FilePath:    sourceFile,
		IsDownload:  true,
		Owner:       "dev-phone-123",
		LastActive:  time.Now().Unix(),
	}

	transfersMu.Lock()
	transfers[transferID] = state
	transfersMu.Unlock()

	// 1. Save metadata
	if err := state.saveMeta(); err != nil {
		t.Fatalf("saveMeta failed: %v", err)
	}

	// Verify .dlmeta.json exists on disk
	metaPath := getDownloadMetaPath(transferID)
	if _, err := os.Stat(metaPath); err != nil {
		t.Fatalf("expected dlmeta file at %s: %v", metaPath, err)
	}

	// 2. Simulate server restart: clear memory
	transfersMu.Lock()
	delete(transfers, transferID)
	transfersMu.Unlock()

	if lookupTransfer(transferID) != nil {
		t.Fatalf("expected transfer to be gone from memory before recovery")
	}

	// 3. Run recovery
	recovered := recoverOrSweepTempDir()
	if recovered < 1 {
		t.Fatalf("expected at least 1 recovered transfer, got %d", recovered)
	}

	recoveredState := lookupTransfer(transferID)
	if recoveredState == nil {
		t.Fatalf("failed to recover download transfer %s", transferID)
	}
	if !recoveredState.IsDownload {
		t.Fatalf("expected IsDownload=true, got %v", recoveredState.IsDownload)
	}
	if recoveredState.Filename != "sample_video.mp4" {
		t.Fatalf("expected filename sample_video.mp4, got %s", recoveredState.Filename)
	}
	if recoveredState.TotalSize != int64(len(data)) {
		t.Fatalf("expected totalSize %d, got %d", len(data), recoveredState.TotalSize)
	}

	// 4. Test cleanup / sweep if source file deleted
	os.Remove(sourceFile)
	transfersMu.Lock()
	delete(transfers, transferID)
	transfersMu.Unlock()

	recoverOrSweepTempDir()
	if lookupTransfer(transferID) != nil {
		t.Fatalf("expected missing source file transfer NOT to be recovered")
	}
	if _, err := os.Stat(metaPath); !os.IsNotExist(err) {
		t.Fatalf("expected dlmeta file to be swept when source file is missing")
	}
}

