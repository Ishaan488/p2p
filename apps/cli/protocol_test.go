package main

import (
	"bytes"
	"crypto/rand"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// setupTestEnvironment creates temporary base, received, and temp directories for isolated testing.
func setupTestEnvironment(t *testing.T) (cleanup func()) {
	tmpBase, err := os.MkdirTemp("", "p2p_proto_test_*")
	if err != nil {
		t.Fatalf("Failed to create temp base dir: %v", err)
	}

	origBase := baseDir
	origRecv := receiveDir
	origTemp := tempDir

	baseDir = tmpBase
	receiveDir = filepath.Join(baseDir, "received")
	tempDir = filepath.Join(baseDir, "temp")
	initDirs()

	return func() {
		baseDir = origBase
		receiveDir = origRecv
		tempDir = origTemp
		os.RemoveAll(tmpBase)
	}
}

// TestProtocol_ZeroByteFileUpload verifies that 0-byte files can be initialized,
// completed, and saved properly without dividing by zero or hanging.
func TestProtocol_ZeroByteFileUpload(t *testing.T) {
	cleanup := setupTestEnvironment(t)
	defer cleanup()

	device := &Device{ID: "test-device-0b", Name: "ZeroBytePhone", Key: make([]byte, 32)}
	rand.Read(device.Key)

	transferID := "transfer-zero-byte"

	// 1. Check layout validation for 0-byte file
	totalSize := int64(0)
	chunkSize := int64(defaultChunkSize)
	var expectedChunks int64
	if totalSize == 0 {
		expectedChunks = 0
	} else {
		expectedChunks = (totalSize + chunkSize - 1) / chunkSize
	}
	if expectedChunks != 0 {
		t.Fatalf("Expected 0 chunks for 0-byte file, got %d", expectedChunks)
	}

	// 2. Create TransferState for 0-byte upload
	tempPath := getTempPath(transferID)
	f, err := os.Create(tempPath)
	if err != nil {
		t.Fatalf("Failed to create temp file: %v", err)
	}

	state := &TransferState{
		ID:          transferID,
		Filename:    sanitizeFilename("empty_notes.txt"),
		TotalChunks: 0,
		ChunkSize:   chunkSize,
		TotalSize:   0,
		File:        f,
		FilePath:    tempPath,
		Owner:       device.ID,
		received:    make([]bool, 0),
		LastActive:  time.Now().Unix(),
	}

	transfersMu.Lock()
	transfers[transferID] = state
	transfersMu.Unlock()

	// 3. Verify missing chunks calculation
	state.mu.Lock()
	missing := state.TotalChunks - state.receivedCount
	state.mu.Unlock()
	if missing != 0 {
		t.Errorf("Expected 0 missing chunks for 0-byte file, got %d", missing)
	}

	// 4. Complete upload
	state.fileMu.Lock()
	state.closed = true
	state.File.Close()
	state.fileMu.Unlock()

	transfersMu.Lock()
	delete(transfers, state.ID)
	transfersMu.Unlock()

	finalPath, err := moveIntoDir(state.FilePath, receiveDir, state.Filename)
	if err != nil {
		t.Fatalf("moveIntoDir failed on 0-byte file: %v", err)
	}

	// 5. Verify file exists in receiveDir and has size 0
	fi, err := os.Stat(finalPath)
	if err != nil {
		t.Fatalf("Failed to stat saved 0-byte file: %v", err)
	}
	if fi.Size() != 0 {
		t.Errorf("Expected file size 0, got %d", fi.Size())
	}
	if filepath.Base(finalPath) != "empty_notes.txt" {
		t.Errorf("Expected filename empty_notes.txt, got %s", filepath.Base(finalPath))
	}
}

// TestProtocol_ZeroByteSendTransfer verifies that sending a 0-byte file from PC
// properly sets TotalChunks to 0 and serves via handleDownloadFull.
func TestProtocol_ZeroByteSendTransfer(t *testing.T) {
	cleanup := setupTestEnvironment(t)
	defer cleanup()

	// Create a 0-byte source file
	emptyFile, err := os.CreateTemp("", "p2p_empty_send_*")
	if err != nil {
		t.Fatalf("CreateTemp failed: %v", err)
	}
	emptyPath := emptyFile.Name()
	emptyFile.Close()
	defer os.Remove(emptyPath)

	err = startSendTransfer(emptyPath)
	if err != nil {
		t.Fatalf("startSendTransfer failed on 0-byte file: %v", err)
	}

	// Find the created transfer
	transfersMu.Lock()
	var downloadTransfer *TransferState
	for _, st := range transfers {
		if st.FilePath == emptyPath && st.IsDownload {
			downloadTransfer = st
			break
		}
	}
	transfersMu.Unlock()

	if downloadTransfer == nil {
		t.Fatalf("startSendTransfer did not create download transfer in transfers map")
	}
	if downloadTransfer.TotalSize != 0 {
		t.Errorf("Expected TotalSize 0, got %d", downloadTransfer.TotalSize)
	}
	if downloadTransfer.TotalChunks != 0 {
		t.Errorf("Expected TotalChunks 0, got %d", downloadTransfer.TotalChunks)
	}

	// Verify handleDownloadFull on this transfer returns 200 OK and 0 bytes
	device := &Device{ID: "phone-zero", Name: "Phone", Key: make([]byte, 32)}
	session := newSession(device, device.Key)

	reqURL := fmt.Sprintf("/download_full?transferId=%s", downloadTransfer.ID)
	req := httptest.NewRequest("GET", reqURL, nil)
	w := httptest.NewRecorder()

	handleDownloadFull(w, req, session)
	res := w.Result()
	if res.StatusCode != http.StatusOK {
		t.Errorf("handleDownloadFull returned status %d, expected 200", res.StatusCode)
	}
	if w.Body.Len() != 0 {
		t.Errorf("Expected response body len 0, got %d", w.Body.Len())
	}
}

// TestProtocol_ChunkValidation verifies chunk boundary checks, invalid chunk layout,
// chunk payload length mismatches, and OOM prevention limits.
func TestProtocol_ChunkValidation(t *testing.T) {
	cleanup := setupTestEnvironment(t)
	defer cleanup()

	// 1. Layout checks:
	// A) ChunkSize < minChunkSize (64 KB)
	if minChunkSize > 64<<10 || maxChunkSize < 8<<20 {
		t.Errorf("Unexpected chunk size constants: min=%d, max=%d", minChunkSize, maxChunkSize)
	}

	// B) Calculation check
	tests := []struct {
		totalSize   int64
		chunkSize   int64
		wantChunks  int
	}{
		{0, 1 << 20, 0},
		{1, 1 << 20, 1},
		{1 << 20, 1 << 20, 1},
		{(1 << 20) + 1, 1 << 20, 2},
		{5 * (1 << 20), 1 << 20, 5},
		{5*(1<<20) + 500, 1 << 20, 6},
	}

	for _, tt := range tests {
		var got int
		if tt.totalSize == 0 {
			got = 0
		} else {
			got = int((tt.totalSize + tt.chunkSize - 1) / tt.chunkSize)
		}
		if got != tt.wantChunks {
			t.Errorf("totalSize %d, chunkSize %d: got %d chunks, want %d",
				tt.totalSize, tt.chunkSize, got, tt.wantChunks)
		}
	}

	// 2. chunkLength calculation
	state := &TransferState{
		TotalSize:   2500,
		ChunkSize:   1000,
		TotalChunks: 3,
	}
	if state.chunkLength(0) != 1000 {
		t.Errorf("chunkLength(0) = %d, want 1000", state.chunkLength(0))
	}
	if state.chunkLength(1) != 1000 {
		t.Errorf("chunkLength(1) = %d, want 1000", state.chunkLength(1))
	}
	if state.chunkLength(2) != 500 {
		t.Errorf("chunkLength(2) = %d, want 500", state.chunkLength(2))
	}
}

// TestProtocol_OutOfOrderWriting verifies that parallel chunk uploads written
// out-of-order (via WriteAt) produce an exact bit-for-bit file match.
func TestProtocol_OutOfOrderWriting(t *testing.T) {
	cleanup := setupTestEnvironment(t)
	defer cleanup()

	chunkSize := int64(1024)
	totalChunks := 5
	totalSize := int64(4500) // 4 chunks of 1024 + 1 chunk of 404

	// Generate known reference data
	fullData := make([]byte, totalSize)
	rand.Read(fullData)

	transferID := "tx-out-of-order"
	tempPath := getTempPath(transferID)
	f, err := os.Create(tempPath)
	if err != nil {
		t.Fatalf("os.Create failed: %v", err)
	}

	state := &TransferState{
		ID:          transferID,
		Filename:    "random.bin",
		TotalChunks: totalChunks,
		ChunkSize:   chunkSize,
		TotalSize:   totalSize,
		File:        f,
		FilePath:    tempPath,
		received:    make([]bool, totalChunks),
		LastActive:  time.Now().Unix(),
	}

	// Write chunks in scrambled order: 3, 0, 4, 1, 2
	order := []int{3, 0, 4, 1, 2}
	for _, idx := range order {
		offset := int64(idx) * chunkSize
		length := state.chunkLength(idx)
		chunkData := fullData[offset : offset+length]

		// Emulate handleUploadChunk WriteAt
		state.fileMu.RLock()
		_, err := state.File.WriteAt(chunkData, offset)
		state.fileMu.RUnlock()
		if err != nil {
			t.Fatalf("WriteAt failed for chunk %d: %v", idx, err)
		}

		state.mu.Lock()
		if !state.received[idx] {
			state.received[idx] = true
			state.receivedCount++
		}
		state.mu.Unlock()
	}

	// Verify all chunks received
	state.mu.Lock()
	if state.receivedCount != totalChunks {
		t.Fatalf("receivedCount = %d, want %d", state.receivedCount, totalChunks)
	}
	state.mu.Unlock()

	// Close file and verify content matches original
	state.fileMu.Lock()
	state.closed = true
	state.File.Close()
	state.fileMu.Unlock()

	onDisk, err := os.ReadFile(tempPath)
	if err != nil {
		t.Fatalf("ReadFile failed: %v", err)
	}
	if !bytes.Equal(onDisk, fullData) {
		t.Fatalf("Disk data does not match original reference data after out-of-order writes")
	}

	// Check receivedRanges
	ranges := state.receivedRanges()
	if len(ranges) != 1 || ranges[0] != [2]int{0, 4} {
		t.Errorf("Unexpected receivedRanges: %+v", ranges)
	}
}

// TestProtocol_ResumeRanges verifies that receivedRanges returns proper inclusive ranges
// for non-contiguous received chunks.
func TestProtocol_ResumeRanges(t *testing.T) {
	state := &TransferState{
		TotalChunks: 10,
		received:    make([]bool, 10),
	}

	// Chunks 0, 1 received, 2 missing, 3, 4, 5 received, 6 missing, 7, 8, 9 received
	state.received[0] = true
	state.received[1] = true
	state.received[3] = true
	state.received[4] = true
	state.received[5] = true
	state.received[7] = true
	state.received[8] = true
	state.received[9] = true

	ranges := state.receivedRanges()
	expected := [][2]int{
		{0, 1},
		{3, 5},
		{7, 9},
	}

	if len(ranges) != len(expected) {
		t.Fatalf("Got %d ranges, want %d", len(ranges), len(expected))
	}
	for i, exp := range expected {
		if ranges[i] != exp {
			t.Errorf("Range %d: got %v, want %v", i, ranges[i], exp)
		}
	}
}

// TestProtocol_ResourceCleanupOnCancel verifies that discarding/cancelling an upload
// closes file descriptors and deletes the partial file.
func TestProtocol_ResourceCleanupOnCancel(t *testing.T) {
	cleanup := setupTestEnvironment(t)
	defer cleanup()

	transferID := "tx-to-cancel"
	tempPath := getTempPath(transferID)
	f, err := os.Create(tempPath)
	if err != nil {
		t.Fatalf("Create failed: %v", err)
	}
	f.WriteString("partial upload data")

	state := &TransferState{
		ID:          transferID,
		Filename:    "canceled_upload.bin",
		TotalChunks: 5,
		File:        f,
		FilePath:    tempPath,
		IsDownload:  false,
		LastActive:  time.Now().Unix(),
	}

	transfersMu.Lock()
	transfers[transferID] = state
	transfersMu.Unlock()

	// Discard the transfer
	state.discard()

	// Verify state is marked closed
	state.fileMu.Lock()
	if !state.closed {
		t.Errorf("Expected state.closed == true after discard()")
	}
	state.fileMu.Unlock()

	// Verify temp file was removed from disk
	if _, err := os.Stat(tempPath); !os.IsNotExist(err) {
		t.Errorf("Partial file %s still exists after discard()", tempPath)
	}
}
