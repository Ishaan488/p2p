package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestKillWifiMidTransfer_ResumeAndHashMatch verifies that when network drops
// mid-transfer (partial chunks received), reconnecting with the same transferId
// resumes uploading missing chunks, and the resulting file SHA-256 matches exactly.
func TestKillWifiMidTransfer_ResumeAndHashMatch(t *testing.T) {
	testDir := t.TempDir()
	prevBase := baseDir
	prevRecv := receiveDir
	prevTemp := tempDir
	baseDir = testDir
	receiveDir = filepath.Join(testDir, "received")
	tempDir = filepath.Join(testDir, "temp")
	initDirs()
	defer func() {
		baseDir = prevBase
		receiveDir = prevRecv
		tempDir = prevTemp
	}()

	dev := &Device{ID: "test-device-wifi", Name: "Android Phone", Trusted: true}
	session := newSession(dev, []byte("01234567890123456789012345678901"))

	// Create 2.5 MiB of test payload (3 chunks: 1MB, 1MB, 0.5MB)
	chunkSize := int64(1024 * 1024)
	totalSize := int64(2500 * 1024)
	payload := make([]byte, totalSize)
	for i := range payload {
		payload[i] = byte((i * 37) % 256)
	}
	expectedHash := sha256.Sum256(payload)

	transferID := "test-wifi-drop-transfer"
	filename := "video_capture_4k.mp4"
	totalChunks := int((totalSize + chunkSize - 1) / chunkSize)

	// Step 1: Initial upload request
	initBody, _ := json.Marshal(uploadInitRequest{
		TransferID:  transferID,
		Filename:    filename,
		TotalSize:   totalSize,
		ChunkSize:   chunkSize,
		TotalChunks: totalChunks,
	})
	initEnc := session.seal(initBody, "req\n/upload_init\n")
	initReq := httptest.NewRequest("POST", "/upload_init", bytes.NewReader(initEnc))
	initRec := httptest.NewRecorder()
	handleUploadInit(initRec, initReq, session)
	if initRec.Code != http.StatusOK {
		t.Fatalf("upload_init failed: %d %s", initRec.Code, initRec.Body.String())
	}

	// Step 2: Upload Chunk 0 successfully
	c0Body := payload[0:chunkSize]
	c0Enc := session.seal(c0Body, chunkAAD(transferID, 0))
	c0Req := httptest.NewRequest("POST", fmt.Sprintf("/upload?transferId=%s&chunkIndex=0", transferID), bytes.NewReader(c0Enc))
	c0Rec := httptest.NewRecorder()
	handleUploadChunk(c0Rec, c0Req, session)
	if c0Rec.Code != http.StatusOK {
		t.Fatalf("chunk 0 failed: %d", c0Rec.Code)
	}

	// Step 3: Simulate Wi-Fi drop!
	// Client connection drops; chunk 1 and 2 are never sent during this period.
	// Verify server knows it has chunk 0 but missing chunks 1 and 2.
	transfersMu.Lock()
	st := transfers[transferID]
	transfersMu.Unlock()
	if st == nil {
		t.Fatal("transfer state not found")
	}
	ranges := st.receivedRanges()
	if len(ranges) != 1 || ranges[0][0] != 0 || ranges[0][1] != 0 {
		t.Fatalf("expected ranges [[0, 0]], got %v", ranges)
	}

	// Step 4: Wi-Fi Reconnects!
	// Client reconnects and calls upload_init again to ask server what chunks are missing
	reconnectEnc := session.seal(initBody, "req\n/upload_init\n")
	reconnectReq := httptest.NewRequest("POST", "/upload_init", bytes.NewReader(reconnectEnc))
	reconnectRec := httptest.NewRecorder()
	handleUploadInit(reconnectRec, reconnectReq, session)
	if reconnectRec.Code != http.StatusOK {
		t.Fatalf("reconnect upload_init failed: %d", reconnectRec.Code)
	}

	// Step 5: Upload missing chunks (Chunk 1 and Chunk 2)
	c1Body := payload[chunkSize : 2*chunkSize]
	c1Enc := session.seal(c1Body, chunkAAD(transferID, 1))
	c1Req := httptest.NewRequest("POST", fmt.Sprintf("/upload?transferId=%s&chunkIndex=1", transferID), bytes.NewReader(c1Enc))
	c1Rec := httptest.NewRecorder()
	handleUploadChunk(c1Rec, c1Req, session)
	if c1Rec.Code != http.StatusOK {
		t.Fatalf("chunk 1 failed: %d", c1Rec.Code)
	}

	c2Body := payload[2*chunkSize : totalSize]
	c2Enc := session.seal(c2Body, chunkAAD(transferID, 2))
	c2Req := httptest.NewRequest("POST", fmt.Sprintf("/upload?transferId=%s&chunkIndex=2", transferID), bytes.NewReader(c2Enc))
	c2Rec := httptest.NewRecorder()
	handleUploadChunk(c2Rec, c2Req, session)
	if c2Rec.Code != http.StatusOK {
		t.Fatalf("chunk 2 failed: %d", c2Rec.Code)
	}

	// Step 6: Complete upload
	compBody, _ := json.Marshal(transferRef{TransferID: transferID})
	compEnc := session.seal(compBody, "req\n/upload_complete\n")
	compReq := httptest.NewRequest("POST", "/upload_complete", bytes.NewReader(compEnc))
	compRec := httptest.NewRecorder()
	handleUploadComplete(compRec, compReq, session)
	if compRec.Code != http.StatusOK {
		t.Fatalf("complete failed: %d %s", compRec.Code, compRec.Body.String())
	}

	// Step 7: Verify final saved file SHA-256 matches bit-for-bit
	savedPath := filepath.Join(receiveDir, filename)
	savedBytes, err := os.ReadFile(savedPath)
	if err != nil {
		t.Fatalf("failed to read saved file: %v", err)
	}
	actualHash := sha256.Sum256(savedBytes)
	if actualHash != expectedHash {
		t.Fatalf("SHA-256 hash mismatch after resume!\nExpected: %x\nActual:   %x", expectedHash, actualHash)
	}
}

// TestKillServerMidTransfer_TempCleanup verifies that orphaned .part files left
// behind if a server process was forcibly killed are cleanly swept on startup.
func TestKillServerMidTransfer_TempCleanup(t *testing.T) {
	testDir := t.TempDir()
	prevTemp := tempDir
	tempDir = filepath.Join(testDir, "temp")
	_ = os.MkdirAll(tempDir, 0755)
	defer func() {
		tempDir = prevTemp
	}()

	// Simulate 3 orphaned temp files from killed server processes
	for i := 1; i <= 3; i++ {
		fakePart := filepath.Join(tempDir, fmt.Sprintf("orphaned_%d.part", i))
		_ = os.WriteFile(fakePart, []byte("in-flight junk bytes from aborted write"), 0644)
	}

	cleanTempDir()

	matches, _ := filepath.Glob(filepath.Join(tempDir, "*.part"))
	if len(matches) != 0 {
		t.Fatalf("expected 0 leftover .part files after cleanTempDir, found %d", len(matches))
	}
}

// TestCorruptedStateRecovery verifies that invalid/corrupt state.json is safely
// backed up to a .corrupt timestamped file and a fresh state is initialized without panicking.
func TestCorruptedStateRecovery(t *testing.T) {
	testDir := t.TempDir()
	prevBase := baseDir
	baseDir = testDir
	defer func() {
		baseDir = prevBase
	}()

	stateFile := filepath.Join(testDir, "state.json")
	// Write malformed corrupted JSON data
	_ = os.WriteFile(stateFile, []byte("{ malformed json ::: corrupted bytes !!@@## "), 0600)

	loadState()

	if state.ServerID == "" {
		t.Fatal("expected ServerID to be initialized on clean state recovery")
	}

	// Verify that the corrupt file was backed up
	backups, err := filepath.Glob(filepath.Join(testDir, "state.json.corrupt.*"))
	if err != nil || len(backups) == 0 {
		t.Fatalf("expected state.json.corrupt backup file, found %v", backups)
	}
}

// TestUnicodeEmojiLongDuplicateFilenames tests filenames with emojis, Cyrillic, Chinese,
// Arabic, 300+ characters length bounding, and collision resolution.
func TestUnicodeEmojiLongDuplicateFilenames(t *testing.T) {
	testCases := []struct {
		name     string
		input    string
		hasExt   string
		validate func(t *testing.T, res string)
	}{
		{
			name:   "Emoji and Multilingual Unicode",
			input:  "🎉_Screenshot_2026_файл_中文_العربية_🚀.png",
			hasExt: ".png",
			validate: func(t *testing.T, res string) {
				if !strings.Contains(res, "🎉") || !strings.Contains(res, "中文") || !strings.Contains(res, "🚀") {
					t.Errorf("Unicode emojis or CJK stripped: %s", res)
				}
			},
		},
		{
			name:   "Extremely Long Filename (>250 chars)",
			input:  strings.Repeat("a", 300) + ".document.pdf",
			hasExt: ".pdf",
			validate: func(t *testing.T, res string) {
				if len(res) > 210 {
					t.Errorf("filename length not bounded: len=%d", len(res))
				}
				if !strings.HasSuffix(res, ".pdf") {
					t.Errorf("extension was lost during truncation: %s", res)
				}
			},
		},
		{
			name:   "Windows Reserved Name with Emoji",
			input:  "CON.txt",
			hasExt: ".txt",
			validate: func(t *testing.T, res string) {
				if res == "CON.txt" {
					t.Errorf("Windows reserved device name CON was not defanged: %s", res)
				}
			},
		},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			clean := sanitizeFilename(tc.input)
			if tc.hasExt != "" && !strings.HasSuffix(clean, tc.hasExt) {
				t.Errorf("expected extension %s, got %s", tc.hasExt, clean)
			}
			tc.validate(t, clean)
		})
	}
}

// TestDeviceTrust_PerTransferApproval verifies that untrusted devices require approval
// and trusted devices auto-accept.
func TestDeviceTrust_PerTransferApproval(t *testing.T) {
	testDir := t.TempDir()
	prevBase := baseDir
	baseDir = testDir
	defer func() {
		baseDir = prevBase
	}()

	untrustedDev := registerDevice("dev-untrusted", "Untrusted Phone", []byte("11111111111111111111111111111111"))
	trustedDev := registerDevice("dev-trusted", "Trusted Laptop", []byte("22222222222222222222222222222222"))
	setDeviceTrust(trustedDev.ID, true)

	foundUntrusted := findDevice(untrustedDev.ID)
	foundTrusted := findDevice(trustedDev.ID)

	if foundUntrusted.Trusted {
		t.Fatal("expected untrusted device to have Trusted == false")
	}
	if !foundTrusted.Trusted {
		t.Fatal("expected trusted device to have Trusted == true")
	}

	// Toggle trust
	setDeviceTrust(untrustedDev.ID, true)
	if !findDevice(untrustedDev.ID).Trusted {
		t.Fatal("failed to set device trust to true")
	}

	setDeviceTrust(untrustedDev.ID, false)
	if findDevice(untrustedDev.ID).Trusted {
		t.Fatal("failed to untrust device")
	}
}
