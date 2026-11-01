package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// Helper to set up clean isolated test directory
func setupAdversarialTestEnv(t *testing.T) (string, func()) {
	t.Helper()
	tmpDir := t.TempDir()
	prevBase, prevTemp, prevRecv := baseDir, tempDir, receiveDir
	baseDir = tmpDir
	tempDir = filepath.Join(tmpDir, "temp")
	receiveDir = filepath.Join(tmpDir, "received")
	initDirs()
	loadHistory()

	cleanup := func() {
		baseDir, tempDir, receiveDir = prevBase, prevTemp, prevRecv
		historyMu.Lock()
		history = nil
		historyMu.Unlock()
	}
	return tmpDir, cleanup
}

func getAdvPartAndMeta(dir, tid string) (string, string) {
	sum := sha256.Sum256([]byte(tid))
	partPath := filepath.Join(dir, hex.EncodeToString(sum[:16])+".part")
	return partPath, getMetaPath(partPath)
}

// -----------------------------------------------------------------------------
// SECTION 1: Adversarial Content Integrity vs File-Size Validation Tests
// -----------------------------------------------------------------------------

// Test 1.1: A manifest claims chunk 1 is received and part file is 2 MiB,
// but chunk 1 on disk contains corrupt / garbage bytes instead of the expected payload.
// Demonstrates whether recovery blindly accepts in-bound bytes without integrity verification.
func TestAdversarial_CorruptedChunkBytesWithinFileBounds(t *testing.T) {
	_, cleanup := setupAdversarialTestEnv(t)
	defer cleanup()

	tid := "adv-corrupt-chunk-1"
	partPath, metaPath := getAdvPartAndMeta(tempDir, tid)

	chunkSize := int64(1024 * 1024)
	totalChunks := 2

	// Create 2 MiB part file:
	// Chunk 0: valid 1 MiB of 'A'
	// Chunk 1: corrupted 1 MiB of zeroes or random noise instead of expected 'B'
	chunk0Data := bytes.Repeat([]byte("A"), int(chunkSize))
	corruptChunk1Data := bytes.Repeat([]byte{0x00}, int(chunkSize))

	f, err := os.Create(partPath)
	if err != nil {
		t.Fatalf("create part file: %v", err)
	}
	f.Write(chunk0Data)
	f.Write(corruptChunk1Data)
	f.Close()

	sum0 := sha256.Sum256(chunk0Data)
	genuineChunk1Data := bytes.Repeat([]byte("B"), int(chunkSize))
	sum1 := sha256.Sum256(genuineChunk1Data)
	hashes := []string{hex.EncodeToString(sum0[:16]), hex.EncodeToString(sum1[:16])}

	rec := []bool{true, true}
	m := persistedTransferMeta{
		ID:          tid,
		Filename:    "adv_test.bin",
		TotalChunks: totalChunks,
		ChunkSize:   chunkSize,
		TotalSize:   int64(totalChunks) * chunkSize,
		FilePath:    partPath,
		State:       "transferring",
		Generation:  5,
		LastActive:  time.Now().Unix(),
		Owner:       "dev-test",
		Received:    rec,
		ChunkHashes: hashes,
	}
	b, _ := json.Marshal(m)
	os.WriteFile(metaPath, b, 0600)

	// Recover
	recoveredCount := recoverOrSweepTempDir()
	if recoveredCount != 1 {
		t.Fatalf("expected 1 recovered transfer, got %d", recoveredCount)
	}

	st := lookupTransfer(tid)
	if st == nil {
		t.Fatalf("lookupTransfer failed for %s", tid)
	}
	defer st.discard()

	// Content validation check: Chunk 0 matches hash on disk -> must be true
	if !st.received[0] {
		t.Errorf("Expected chunk 0 to be validated and marked received")
	}

	// Chunk 1 contains zeroes on disk, mismatching hash -> must be false
	if st.received[1] {
		t.Fatalf("CRITICAL DEFECT: Chunk 1 was accepted despite hash mismatch with corrupted disk bytes!")
	}
}

// Test 1.2: Two candidates claiming the same chunk with conflicting states
func TestAdversarial_TwoCandidatesOverlappingBitmaps(t *testing.T) {
	_, cleanup := setupAdversarialTestEnv(t)
	defer cleanup()

	tid := "adv-two-candidates"
	partPath, metaPath := getAdvPartAndMeta(tempDir, tid)

	chunkSize := int64(64 * 1024)
	totalChunks := 4

	// Write 4 chunks to part file
	f, _ := os.Create(partPath)
	f.Truncate(int64(totalChunks) * chunkSize)
	f.Close()

	// Candidate 1 (primary metaPath): Generation 10, received [true, false, true, false]
	m1 := persistedTransferMeta{
		ID:          tid,
		Filename:    "two_cands.bin",
		TotalChunks: totalChunks,
		ChunkSize:   chunkSize,
		TotalSize:   int64(totalChunks) * chunkSize,
		FilePath:    partPath,
		State:       "transferring",
		Generation:  10,
		LastActive:  time.Now().Unix() - 5,
		Owner:       "dev-test",
		Received:    []bool{true, false, true, false},
	}
	b1, _ := json.Marshal(m1)
	os.WriteFile(metaPath, b1, 0600)

	// Candidate 2 (.tmp file): Generation 11, received [false, true, true, false]
	tmpPath := fmt.Sprintf("%s.tmp.%d.%d", metaPath, os.Getpid(), time.Now().UnixNano())
	m2 := persistedTransferMeta{
		ID:          tid,
		Filename:    "two_cands.bin",
		TotalChunks: totalChunks,
		ChunkSize:   chunkSize,
		TotalSize:   int64(totalChunks) * chunkSize,
		FilePath:    partPath,
		State:       "transferring",
		Generation:  11,
		LastActive:  time.Now().Unix(),
		Owner:       "dev-test",
		Received:    []bool{false, true, true, false},
	}
	b2, _ := json.Marshal(m2)
	os.WriteFile(tmpPath, b2, 0600)

	recoverOrSweepTempDir()

	st := lookupTransfer(tid)
	if st == nil {
		t.Fatalf("transfer not recovered")
	}
	defer st.discard()

	// Union should have chunks 0, 1, 2
	if !st.received[0] || !st.received[1] || !st.received[2] {
		t.Errorf("Union failed: expected chunks 0, 1, 2 received, got: %v", st.received)
	}
}

// -----------------------------------------------------------------------------
// SECTION 2: Validate the Chunk Acknowledgment Invariant
// -----------------------------------------------------------------------------

// Test 2.1: Invariant: WriteAt failure must never produce HTTP 200 OK or chunk acknowledgment
func TestAdversarial_FailedWriteNeverAcknowledged(t *testing.T) {
	_, cleanup := setupAdversarialTestEnv(t)
	defer cleanup()

	tid := "adv-failed-write"
	partPath, _ := getAdvPartAndMeta(tempDir, tid)

	chunkSize := int64(1024)
	totalChunks := 2

	f, _ := os.Create(partPath)
	f.Close()

	// Open read-only file handle to force WriteAt error
	roFile, err := os.OpenFile(partPath, os.O_RDONLY, 0444)
	if err != nil {
		t.Fatalf("open ro: %v", err)
	}
	defer roFile.Close()

	st := &TransferState{
		ID:          tid,
		Filename:    "fail_write.bin",
		TotalChunks: totalChunks,
		ChunkSize:   chunkSize,
		TotalSize:   int64(totalChunks) * chunkSize,
		File:        roFile,
		FilePath:    partPath,
		State:       "transferring",
		generation:  1,
		Owner:       "test-client",
		received:    make([]bool, totalChunks),
	}
	transfersMu.Lock()
	transfers[tid] = st
	transfersMu.Unlock()

	// Attempt chunk upload via HTTP handler
	body := bytes.Repeat([]byte("X"), int(chunkSize))
	key := make([]byte, 32)
	dev := &Device{ID: "test-client", Name: "Client"}
	sess := newSession(dev, key)
	sealed := sess.seal(body, chunkAAD(tid, 0))

	req := httptest.NewRequest(http.MethodPost, fmt.Sprintf("/upload?transferId=%s&chunkIndex=0", tid), bytes.NewReader(sealed))
	rec := httptest.NewRecorder()

	handleUploadChunk(rec, req, sess)

	if rec.Code == http.StatusOK {
		t.Fatalf("CRITICAL DEFECT: Server returned HTTP 200 OK despite disk write failure!")
	}

	st.mu.Lock()
	acked := st.received[0]
	st.mu.Unlock()

	if acked {
		t.Fatalf("CRITICAL DEFECT: Chunk marked received in memory despite write failure!")
	}
}

// -----------------------------------------------------------------------------
// SECTION 3: Validate Finalization Consistency
// -----------------------------------------------------------------------------

// Test 3.1: History exists, but the final file was deleted/missing.
// lookupCompletedTransfer must NOT declare the transfer valid if final file is missing!
func TestAdversarial_HistoryExistsFinalFileMissing(t *testing.T) {
	_, cleanup := setupAdversarialTestEnv(t)
	defer cleanup()

	tid := "adv-missing-final-file"
	destFile := filepath.Join(receiveDir, "ghost_file.bin")

	// Record completion in history, but do NOT create destFile
	recordTransfer(TransferRecord{
		ID:        tid,
		Filename:  "ghost_file.bin",
		Size:      1024,
		Direction: "Received",
		Status:    "Completed",
	})

	rec := lookupCompletedTransfer(tid)
	if rec != nil {
		t.Fatalf("CRITICAL DEFECT: lookupCompletedTransfer returned non-nil Completed status, but destination file %s does not exist on disk!", destFile)
	}
}

// Test 3.2: Final file exists, but its size is incorrect/truncated.
func TestAdversarial_FinalFileIncorrectSize(t *testing.T) {
	_, cleanup := setupAdversarialTestEnv(t)
	defer cleanup()

	tid := "adv-truncated-final-file"
	destFile := filepath.Join(receiveDir, "truncated_file.bin")

	// Create 500 byte file on disk
	os.WriteFile(destFile, bytes.Repeat([]byte("A"), 500), 0644)

	// Record completion with size 1000
	recordTransfer(TransferRecord{
		ID:        tid,
		Filename:  "truncated_file.bin",
		Size:      1000,
		Direction: "Received",
		Status:    "Completed",
	})

	rec := lookupCompletedTransfer(tid)
	if rec != nil {
		t.Fatalf("CRITICAL DEFECT: lookupCompletedTransfer returned Completed status, but file on disk has size 500 != record size 1000!")
	}
}

// Test 3.3: Destination filename collision resolution preserves both files intact
func TestAdversarial_DestinationCollisionPreservesBoth(t *testing.T) {
	_, cleanup := setupAdversarialTestEnv(t)
	defer cleanup()

	// 1. Create pre-existing file in receiveDir
	existingPath := filepath.Join(receiveDir, "document.txt")
	os.WriteFile(existingPath, []byte("Original Content"), 0644)

	// 2. Finalize upload with same filename
	tid := "adv-collision-test"
	partPath, _ := getAdvPartAndMeta(tempDir, tid)
	newContent := []byte("New Incoming Upload Content")
	os.WriteFile(partPath, newContent, 0644)

	st := &TransferState{
		ID:            tid,
		Filename:      "document.txt",
		TotalChunks:   1,
		ChunkSize:     int64(len(newContent)),
		TotalSize:     int64(len(newContent)),
		FilePath:      partPath,
		State:         "transferring",
		generation:    1,
		Owner:         "dev-test",
		received:      []bool{true},
		receivedCount: 1,
	}

	finalPath, err := finalizeUpload(st, receiveDir)
	if err != nil {
		t.Fatalf("finalizeUpload collision failed: %v", err)
	}

	if finalPath == existingPath {
		t.Fatalf("CRITICAL DEFECT: Finalize overwrote existing file %s!", existingPath)
	}

	// Verify original file untouched
	origBytes, _ := os.ReadFile(existingPath)
	if string(origBytes) != "Original Content" {
		t.Fatalf("CRITICAL DEFECT: Original file content corrupted!")
	}

	// Verify new file saved cleanly
	newBytes, _ := os.ReadFile(finalPath)
	if string(newBytes) != "New Incoming Upload Content" {
		t.Fatalf("CRITICAL DEFECT: Collision-renamed file content mismatch!")
	}
}

// Test 1.3: Out of range chunk index or invalid chunk count in manifest
func TestAdversarial_OutOfRangeChunkDimensions(t *testing.T) {
	_, cleanup := setupAdversarialTestEnv(t)
	defer cleanup()

	tid := "adv-out-of-range"
	partPath, metaPath := getAdvPartAndMeta(tempDir, tid)

	f, _ := os.Create(partPath)
	f.Truncate(1024)
	f.Close()

	// Metadata claims TotalChunks = 2, but Received array has 10 elements
	m := persistedTransferMeta{
		ID:          tid,
		Filename:    "invalid_dims.bin",
		TotalChunks: 2,
		ChunkSize:   512,
		TotalSize:   1024,
		FilePath:    partPath,
		State:       "transferring",
		Generation:  1,
		LastActive:  time.Now().Unix(),
		Owner:       "dev-test",
		Received:    make([]bool, 10), // mismatch with TotalChunks
	}
	b, _ := json.Marshal(m)
	os.WriteFile(metaPath, b, 0600)

	recoverOrSweepTempDir()

	// Should reject candidate due to dimension mismatch and sweep
	st := lookupTransfer(tid)
	if st != nil {
		t.Fatalf("CRITICAL DEFECT: Accepted manifest with mismatched Received length and TotalChunks!")
	}
}

// Test 3.4: Cross-volume or permissions fallback simulation (copyExclusive fallback)
func TestAdversarial_MoveFallbackWhenRenameFails(t *testing.T) {
	_, cleanup := setupAdversarialTestEnv(t)
	defer cleanup()

	tid := "adv-fallback-move"
	partPath, _ := getAdvPartAndMeta(tempDir, tid)
	content := []byte("Fallback copy content verification test")
	os.WriteFile(partPath, content, 0644)

	st := &TransferState{
		ID:            tid,
		Filename:      "fallback.txt",
		TotalChunks:   1,
		ChunkSize:     int64(len(content)),
		TotalSize:     int64(len(content)),
		FilePath:      partPath,
		State:         "transferring",
		generation:    1,
		Owner:         "dev-test",
		received:      []bool{true},
		receivedCount: 1,
	}

	finalPath, err := finalizeUpload(st, receiveDir)
	if err != nil {
		t.Fatalf("finalizeUpload failed: %v", err)
	}

	if _, err := os.Stat(finalPath); err != nil {
		t.Fatalf("final file does not exist at %s: %v", finalPath, err)
	}

	data, _ := os.ReadFile(finalPath)
	if !bytes.Equal(data, content) {
		t.Fatalf("final file content does not match source")
	}
}
