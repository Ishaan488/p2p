package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// TestDeviceAliasAndResolution verifies FR 4 (custom device aliases) and FR 48 (quick-send index resolution).
func TestDeviceAliasAndResolution(t *testing.T) {
	tmpDir := t.TempDir()
	prevBase := baseDir
	baseDir = tmpDir
	defer func() { baseDir = prevBase }()

	stateMu.Lock()
	state = appState{ServerID: "srv-alias-test"}
	stateMu.Unlock()

	dev := registerDevice("dev-alias-1", "Pixel-8-Pro", make([]byte, 32))
	if dev.DisplayName() != "Pixel-8-Pro" {
		t.Fatalf("expected initial DisplayName Pixel-8-Pro, got %q", dev.DisplayName())
	}

	updated, ok := setDeviceAlias("Pixel-8-Pro", "Ishan's Phone")
	if !ok || updated == nil {
		t.Fatalf("expected setDeviceAlias to succeed")
	}
	if updated.DisplayName() != "Ishan's Phone" {
		t.Fatalf("expected DisplayName Ishan's Phone, got %q", updated.DisplayName())
	}

	// Verify lookup by alias, original name, and quick-send #1 index
	byAlias := findDeviceByQuery("ishan's phone")
	if byAlias == nil || byAlias.ID != "dev-alias-1" {
		t.Fatalf("expected lookup by alias to match dev-alias-1")
	}
	byOrig := findDeviceByQuery("Pixel-8-Pro")
	if byOrig == nil || byOrig.ID != "dev-alias-1" {
		t.Fatalf("expected lookup by original name to still match dev-alias-1")
	}
	byIndex := resolveDeviceTarget("#1")
	if byIndex == nil || byIndex.ID != "dev-alias-1" {
		t.Fatalf("expected quick-send #1 index resolution to match dev-alias-1")
	}

	// Verify server alias
	setServerAlias("Ishan Workstation")
	defer setServerAlias("")
	if getServerName() != "Ishan Workstation" {
		t.Fatalf("expected getServerName to return custom PC alias, got %q", getServerName())
	}
}

// TestRestartTransferRecovery verifies FR 19 & NFR 16: pending chunked uploads
// with a persisted .meta.json manifest survive server restarts and resume from the last verified chunk.
func TestRestartTransferRecovery(t *testing.T) {
	tmpDir := t.TempDir()
	prevBase, prevTemp, prevRecv := baseDir, tempDir, receiveDir
	baseDir = tmpDir
	tempDir = filepath.Join(tmpDir, "temp")
	receiveDir = filepath.Join(tmpDir, "received")
	initDirs()
	defer func() {
		baseDir, tempDir, receiveDir = prevBase, prevTemp, prevRecv
	}()

	dev := registerDevice("dev-restart-1", "RestartPhone", make([]byte, 32))
	dev.Trusted = true

	partPath := getTempPath("tx-restart-recover-1")
	f, err := os.Create(partPath)
	if err != nil {
		t.Fatalf("create part file: %v", err)
	}
	chunk0 := bytes.Repeat([]byte("A"), 64*1024)
	if _, err := f.WriteAt(chunk0, 0); err != nil {
		t.Fatalf("write chunk0: %v", err)
	}

	st := &TransferState{
		ID:            "tx-restart-recover-1",
		Filename:      "resumable_archive.zip",
		TotalChunks:   2,
		ChunkSize:     64 * 1024,
		TotalSize:     128 * 1024,
		File:          f,
		FilePath:      partPath,
		Owner:         dev.ID,
		LastActive:    time.Now().Unix(),
		received:      []bool{true, false},
		receivedCount: 1,
	}
	st.saveMeta()
	f.Close()

	// Simulate server restart: clear in-memory transfers map and run cleanTempDir()
	transfersMu.Lock()
	transfers = make(map[string]*TransferState)
	transfersMu.Unlock()

	cleanTempDir()

	recovered := lookupTransfer("tx-restart-recover-1")
	if recovered == nil {
		t.Fatalf("expected transfer tx-restart-recover-1 to be recovered after restart")
	}
	defer recovered.discard()

	ranges := recovered.receivedRanges()
	if len(ranges) != 1 || ranges[0] != [2]int{0, 0} {
		t.Fatalf("expected recovered chunk range [[0,0]], got %v", ranges)
	}
}

// TestSensitiveClipboardFilter verifies FR 36 (blocking sensitive credentials, keys, JWTs, and credit cards).
func TestSensitiveClipboardFilter(t *testing.T) {
	cases := []struct {
		text          string
		wantSensitive bool
	}{
		{"Hello world, check out https://example.com", false},
		{"Meeting at 4:30 PM in Room 204", false},
		{"-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmU=", true},
		{"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U", true},
		{"ghp_1234567890abcdefghijklmnopqrstuvwxyzABCD", true},
		{"password = SuperSecret123!", true},
		{"4532 0151 1283 0366", true}, // Valid Visa Luhn test number
	}

	for _, tc := range cases {
		got, _ := isSensitiveClipboard(tc.text)
		if got != tc.wantSensitive {
			t.Errorf("isSensitiveClipboard(%q) = %v, want %v", tc.text, got, tc.wantSensitive)
		}
	}
}

// TestBandwidthLimiter verifies FR 54 token-bucket rate limiting.
func TestBandwidthLimiter(t *testing.T) {
	defer setBandwidthLimitBps(0)

	// Set 512 KB/s limit, burst starts at 512 KB; requesting 640 KB should wait ~200-300ms
	setBandwidthLimitBps(512 * 1024)
	start := time.Now()
	waitForBandwidth(640 * 1024)
	elapsed := time.Since(start)
	if elapsed < 100*time.Millisecond {
		t.Fatalf("expected bandwidth limiter to throttle 640KB at 512KB/s, but finished in %v", elapsed)
	}
}

// TestLocalIPCSendEndpoint verifies FR 42 & FR 46 loopback context-menu file send.
func TestLocalIPCSendEndpoint(t *testing.T) {
	tmpDir := t.TempDir()
	prevBase := baseDir
	baseDir = tmpDir
	defer func() { baseDir = prevBase }()

	initLocalIPCToken()

	sampleFile := filepath.Join(tmpDir, "context_menu_doc.txt")
	_ = os.WriteFile(sampleFile, []byte("sent via explorer context menu"), 0644)

	body, _ := json.Marshal(localSendRequest{Path: sampleFile})
	req := httptest.NewRequest(http.MethodPost, "http://127.0.0.1:8080/local/send", bytes.NewReader(body))
	req.RemoteAddr = "127.0.0.1:54321"
	req.Header.Set("X-Local-Token", localIPCToken)

	w := httptest.NewRecorder()
	handleLocalSend(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected status 200 OK from handleLocalSend, got %d (%s)", w.Code, w.Body.String())
	}
}
