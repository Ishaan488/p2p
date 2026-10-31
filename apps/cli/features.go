package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// ============================================================================
// 1. Bandwidth Rate Limiter (Token Bucket — FR 54)
// ============================================================================

var (
	bandwidthLimitBps int64 // atomic: bytes per second (0 = unlimited)
	bucketMu          sync.Mutex
	bucketTokens      float64
	bucketLastRefill  time.Time
)

func setBandwidthLimitBps(bps int64) {
	if bps < 0 {
		bps = 0
	}
	atomic.StoreInt64(&bandwidthLimitBps, bps)
	bucketMu.Lock()
	bucketTokens = float64(bps)
	bucketLastRefill = time.Now()
	bucketMu.Unlock()
}

func getBandwidthLimitBps() int64 {
	return atomic.LoadInt64(&bandwidthLimitBps)
}

// waitForBandwidth blocks until the requested number of bytes is permitted by the rate limiter.
// When bandwidthLimitBps == 0 (Unlimited), it returns immediately with zero lock contention.
func waitForBandwidth(n int64) {
	limit := atomic.LoadInt64(&bandwidthLimitBps)
	if limit <= 0 || n <= 0 {
		return
	}

	// Slice large chunks into 64 KB sub-permits so pacing is smooth
	const maxStep = 64 * 1024
	remaining := n
	for remaining > 0 {
		limit = atomic.LoadInt64(&bandwidthLimitBps)
		if limit <= 0 {
			return
		}
		step := remaining
		if step > maxStep {
			step = maxStep
		}

		bucketMu.Lock()
		now := time.Now()
		if bucketLastRefill.IsZero() {
			bucketLastRefill = now
			bucketTokens = float64(limit)
		} else {
			elapsed := now.Sub(bucketLastRefill).Seconds()
			if elapsed > 0 {
				bucketTokens += elapsed * float64(limit)
				maxBurst := float64(limit) * 1.5
				if bucketTokens > maxBurst {
					bucketTokens = maxBurst
				}
				bucketLastRefill = now
			}
		}

		needed := float64(step)
		if bucketTokens >= needed {
			bucketTokens -= needed
			bucketMu.Unlock()
			remaining -= step
			continue
		}

		deficit := needed - bucketTokens
		bucketTokens = 0
		bucketLastRefill = now
		waitDur := time.Duration((deficit / float64(limit)) * float64(time.Second))
		bucketMu.Unlock()

		if waitDur > 0 {
			if waitDur > 2*time.Second {
				waitDur = 2 * time.Second
			}
			time.Sleep(waitDur)
		}
		remaining -= step
	}
}

// ============================================================================
// 2. Sensitive Clipboard Detection & Configurable Sync (FR 35 & FR 36)
// ============================================================================

var (
	rePrivateKey = regexp.MustCompile(`(?i)-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----`)
	reJWT        = regexp.MustCompile(`\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b`)
	reAPIToken   = regexp.MustCompile(`\b(ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|xox[baprs]-[A-Za-z0-9-]{10,})\b`)
	reSecretKV   = regexp.MustCompile(`(?i)\b(password|passwd|pwd|secret|api_key|apikey|access_token|auth_token|private_key)\s*[:=]\s*\S{4,}`)
	reCardCandidate = regexp.MustCompile(`\b(?:\d[ -]*?){13,19}\b`)
)

func isClipboardSyncEnabled() bool {
	if *noClipboard {
		return false
	}
	stateMu.Lock()
	defer stateMu.Unlock()
	return !state.ClipboardSyncDisabled
}

func setClipboardSyncEnabled(enabled bool) {
	stateMu.Lock()
	state.ClipboardSyncDisabled = !enabled
	saveStateLocked()
	stateMu.Unlock()
}

func isSensitiveClipboardFilterEnabled() bool {
	stateMu.Lock()
	defer stateMu.Unlock()
	return !state.SensitiveFilterDisabled
}

func setSensitiveClipboardFilterEnabled(enabled bool) {
	stateMu.Lock()
	state.SensitiveFilterDisabled = !enabled
	saveStateLocked()
	stateMu.Unlock()
}

// passesLuhn verifies whether a string of digits satisfies the Luhn checksum (ISO/IEC 7812).
func passesLuhn(digits string) bool {
	if len(digits) < 13 || len(digits) > 19 {
		return false
	}
	allSame := true
	for i := 1; i < len(digits); i++ {
		if digits[i] != digits[0] {
			allSame = false
			break
		}
	}
	if allSame {
		return false
	}
	sum := 0
	alt := false
	for i := len(digits) - 1; i >= 0; i-- {
		d := int(digits[i] - '0')
		if d < 0 || d > 9 {
			return false
		}
		if alt {
			d *= 2
			if d > 9 {
				d -= 9
			}
		}
		sum += d
		alt = !alt
	}
	return sum%10 == 0
}

// isSensitiveClipboard checks if clipboard text contains sensitive credentials, keys,
// tokens, or payment card numbers that should not be automatically broadcast (FR 36).
func isSensitiveClipboard(text string) (bool, string) {
	trimmed := strings.TrimSpace(text)
	if trimmed == "" {
		return false, ""
	}
	if rePrivateKey.MatchString(trimmed) {
		return true, "cryptographic private key"
	}
	if reJWT.MatchString(trimmed) {
		return true, "JWT authentication token"
	}
	if reAPIToken.MatchString(trimmed) {
		return true, "API secret key/token"
	}
	if reSecretKV.MatchString(trimmed) {
		return true, "credential assignment"
	}
	for _, match := range reCardCandidate.FindAllString(trimmed, -1) {
		var digits strings.Builder
		for _, ch := range match {
			if ch >= '0' && ch <= '9' {
				digits.WriteRune(ch)
			}
		}
		if passesLuhn(digits.String()) {
			return true, "payment card number"
		}
	}
	return false, ""
}

// ============================================================================
// 3. Persistent Transfer Manifest Recovery Across Restarts (FR 19, NFR 16)
// ============================================================================

type persistedTransferMeta struct {
	ID          string `json:"id"`
	Filename    string `json:"filename"`
	TotalChunks int    `json:"totalChunks"`
	ChunkSize   int64  `json:"chunkSize"`
	TotalSize   int64  `json:"totalSize"`
	FilePath    string `json:"filePath"`
	IsDownload  bool   `json:"isDownload"`
	IsFolder    bool   `json:"isFolder"`
	FolderName  string `json:"folderName,omitempty"`
	LastActive  int64  `json:"lastActive"`
	Owner       string `json:"owner"`
	Received    []bool `json:"received"`
}

func getMetaPath(partPath string) string {
	return strings.TrimSuffix(partPath, ".part") + ".meta.json"
}

func (s *TransferState) saveMeta() {
	if s == nil || s.IsDownload || s.FilePath == "" {
		return
	}
	s.mu.Lock()
	recCopy := make([]bool, len(s.received))
	copy(recCopy, s.received)
	meta := persistedTransferMeta{
		ID:          s.ID,
		Filename:    s.Filename,
		TotalChunks: s.TotalChunks,
		ChunkSize:   s.ChunkSize,
		TotalSize:   s.TotalSize,
		FilePath:    s.FilePath,
		IsDownload:  s.IsDownload,
		IsFolder:    s.IsFolder,
		FolderName:  s.FolderName,
		LastActive:  time.Now().Unix(),
		Owner:       s.Owner,
		Received:    recCopy,
	}
	s.mu.Unlock()

	data, err := json.Marshal(&meta)
	if err != nil {
		return
	}
	metaPath := getMetaPath(s.FilePath)
	tmpPath := metaPath + ".tmp"
	if err := os.WriteFile(tmpPath, data, 0600); err == nil {
		_ = os.Rename(tmpPath, metaPath)
	}
}

func (s *TransferState) removeMeta() {
	if s == nil || s.FilePath == "" {
		return
	}
	metaPath := getMetaPath(s.FilePath)
	_ = os.Remove(metaPath)
	_ = os.Remove(metaPath + ".tmp")
}

// recoverOrSweepTempDir reloads valid, non-expired partial uploads that have a
// persisted .meta.json manifest (FR 19, NFR 16) and deletes orphaned/corrupt .part files.
func recoverOrSweepTempDir() int {
	transfersMu.Lock()
	dir := tempDir
	transfersMu.Unlock()

	now := time.Now().Unix()
	recoveredCount := 0

	partFiles, _ := filepath.Glob(filepath.Join(dir, "*.part"))
	for _, partPath := range partFiles {
		metaPath := getMetaPath(partPath)
		metaBytes, err := os.ReadFile(metaPath)
		if err != nil {
			// No sidecar metadata -> orphaned .part file from an ungraceful abort; sweep it
			_ = os.Remove(partPath)
			continue
		}

		var meta persistedTransferMeta
		if err := json.Unmarshal(metaBytes, &meta); err != nil ||
			meta.ID == "" ||
			meta.TotalChunks <= 0 ||
			len(meta.Received) != meta.TotalChunks ||
			now-meta.LastActive > transferTTL {
			_ = os.Remove(partPath)
			_ = os.Remove(metaPath)
			continue
		}

		f, err := os.OpenFile(partPath, os.O_RDWR, 0644)
		if err != nil {
			_ = os.Remove(partPath)
			_ = os.Remove(metaPath)
			continue
		}

		recCount := 0
		for _, ok := range meta.Received {
			if ok {
				recCount++
			}
		}

		st := &TransferState{
			ID:            meta.ID,
			Filename:      meta.Filename,
			TotalChunks:   meta.TotalChunks,
			ChunkSize:     meta.ChunkSize,
			TotalSize:     meta.TotalSize,
			File:          f,
			FilePath:      partPath,
			IsDownload:    false,
			IsFolder:      meta.IsFolder,
			FolderName:    meta.FolderName,
			LastActive:    meta.LastActive,
			Owner:         meta.Owner,
			received:      meta.Received,
			receivedCount: recCount,
		}

		transfersMu.Lock()
		transfers[st.ID] = st
		transfersMu.Unlock()
		recoveredCount++
	}

	// Also clean up any orphaned .meta.json files that have no matching .part file
	metaFiles, _ := filepath.Glob(filepath.Join(dir, "*.meta.json"))
	for _, mp := range metaFiles {
		pp := strings.TrimSuffix(mp, ".meta.json") + ".part"
		if _, err := os.Stat(pp); os.IsNotExist(err) {
			_ = os.Remove(mp)
		}
	}

	return recoveredCount
}

// ============================================================================
// 4. Device Alias & Preferences Endpoints (FR 4, FR 24, FR 35, FR 36, FR 54)
// ============================================================================

type aliasUpdateRequest struct {
	DeviceID    string `json:"deviceId,omitempty"`
	DeviceAlias string `json:"deviceAlias,omitempty"`
	PCAlias     string `json:"pcAlias,omitempty"`
}

func handleDeviceAlias(w http.ResponseWriter, r *http.Request, s *Session) {
	var req aliasUpdateRequest
	if err := s.readRequest(r, &req); err != nil {
		httpError(w, http.StatusBadRequest, "Invalid request")
		return
	}

	targetID := s.Device.ID
	if req.DeviceID != "" {
		targetID = req.DeviceID
	}

	var updatedDeviceName string
	if dev, ok := setDeviceAlias(targetID, req.DeviceAlias); ok {
		updatedDeviceName = dev.DisplayName()
	}

	if req.PCAlias != "" || r.URL.Query().Get("updatePc") == "1" {
		setServerAlias(req.PCAlias)
	}

	s.writeResponse(w, r, map[string]interface{}{
		"ok":          true,
		"deviceName":  updatedDeviceName,
		"deviceAlias": s.Device.Alias,
		"pcName":      getServerName(),
	})
}

type settingsPayload struct {
	BandwidthLimitBps       int64  `json:"bandwidthLimitBps"`
	MaxConcurrency          int    `json:"maxConcurrency"`
	ClipboardSyncEnabled    bool   `json:"clipboardSyncEnabled"`
	SensitiveFilterEnabled  bool   `json:"sensitiveFilterEnabled"`
	ReceiveDir              string `json:"receiveDir"`
	PCAlias                 string `json:"pcAlias"`
	DeviceAlias             string `json:"deviceAlias"`
	ContextMenuEnabled      bool   `json:"contextMenuEnabled"`
	AutostartEnabled        bool   `json:"autostartEnabled"`
}

type settingsUpdateRequest struct {
	BandwidthLimitBps      *int64  `json:"bandwidthLimitBps,omitempty"`
	MaxConcurrency         *int    `json:"maxConcurrency,omitempty"`
	ClipboardSyncEnabled   *bool   `json:"clipboardSyncEnabled,omitempty"`
	SensitiveFilterEnabled *bool   `json:"sensitiveFilterEnabled,omitempty"`
	ReceiveDir             *string `json:"receiveDir,omitempty"`
	PCAlias                *string `json:"pcAlias,omitempty"`
	DeviceAlias            *string `json:"deviceAlias,omitempty"`
	ContextMenuEnabled     *bool   `json:"contextMenuEnabled,omitempty"`
	AutostartEnabled       *bool   `json:"autostartEnabled,omitempty"`
}

func handleSettings(w http.ResponseWriter, r *http.Request, s *Session) {
	if r.Method == http.MethodPost {
		var req settingsUpdateRequest
		if err := s.readRequest(r, &req); err != nil {
			httpError(w, http.StatusBadRequest, "Invalid settings payload")
			return
		}
		if req.BandwidthLimitBps != nil {
			bps := *req.BandwidthLimitBps
			if bps < 0 {
				bps = 0
			}
			setBandwidthLimitBps(bps)
			stateMu.Lock()
			state.BandwidthLimitBps = bps
			saveStateLocked()
			stateMu.Unlock()
		}
		if req.MaxConcurrency != nil {
			c := *req.MaxConcurrency
			if c < 0 {
				c = 0
			}
			if c > 16 {
				c = 16
			}
			stateMu.Lock()
			state.MaxConcurrency = c
			saveStateLocked()
			stateMu.Unlock()
		}
		if req.ClipboardSyncEnabled != nil {
			setClipboardSyncEnabled(*req.ClipboardSyncEnabled)
		}
		if req.SensitiveFilterEnabled != nil {
			setSensitiveClipboardFilterEnabled(*req.SensitiveFilterEnabled)
		}
		if req.ReceiveDir != nil && strings.TrimSpace(*req.ReceiveDir) != "" {
			if err := setReceiveDir(strings.TrimSpace(*req.ReceiveDir)); err == nil {
				stateMu.Lock()
				state.CustomReceiveDir = receiveDir
				saveStateLocked()
				stateMu.Unlock()
			}
		}
		if req.PCAlias != nil {
			setServerAlias(*req.PCAlias)
		}
		if req.DeviceAlias != nil {
			setDeviceAlias(s.Device.ID, *req.DeviceAlias)
		}
		if req.ContextMenuEnabled != nil {
			if *req.ContextMenuEnabled {
				_ = installExplorerContextMenu()
			} else {
				_ = uninstallExplorerContextMenu()
			}
		}
		if req.AutostartEnabled != nil {
			_ = setOSAutostart(*req.AutostartEnabled)
		}
	}

	stateMu.Lock()
	maxConc := state.MaxConcurrency
	pcAlias := state.ServerAlias
	devAlias := s.Device.Alias
	stateMu.Unlock()

	transfersMu.Lock()
	currDir := receiveDir
	transfersMu.Unlock()

	resp := settingsPayload{
		BandwidthLimitBps:      getBandwidthLimitBps(),
		MaxConcurrency:         maxConc,
		ClipboardSyncEnabled:   isClipboardSyncEnabled(),
		SensitiveFilterEnabled: isSensitiveClipboardFilterEnabled(),
		ReceiveDir:             currDir,
		PCAlias:                pcAlias,
		DeviceAlias:            devAlias,
		ContextMenuEnabled:     isExplorerContextMenuInstalled(),
		AutostartEnabled:       isOSAutostartEnabled(),
	}
	s.writeResponse(w, r, resp)
}

// ============================================================================
// 5. Loopback IPC for Context-Menu & Quick-Send Without Opening App (FR 42, 46, 48)
// ============================================================================

var localIPCToken string

func localTokenFilePath() string {
	return filepath.Join(baseDir, ".local_ipc_token")
}

func initLocalIPCToken() {
	localIPCToken = randomID()
	_ = os.MkdirAll(baseDir, 0755)
	_ = os.WriteFile(localTokenFilePath(), []byte(localIPCToken), 0600)
}

type localSendRequest struct {
	Path   string `json:"path"`
	Target string `json:"target,omitempty"`
}

func handleLocalSend(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		httpError(w, http.StatusMethodNotAllowed, "POST required")
		return
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	ip := net.ParseIP(host)
	if ip == nil || !ip.IsLoopback() {
		httpError(w, http.StatusForbidden, "Loopback access only")
		return
	}

	token := r.Header.Get("X-Local-Token")
	if localIPCToken == "" || token != localIPCToken {
		httpError(w, http.StatusUnauthorized, "Invalid local IPC token")
		return
	}

	var req localSendRequest
	if err := readJSONBody(r, &req); err != nil || strings.TrimSpace(req.Path) == "" {
		httpError(w, http.StatusBadRequest, "Invalid path")
		return
	}

	var targetDev *Device
	if strings.TrimSpace(req.Target) != "" {
		targetDev = findDeviceByQuery(strings.TrimSpace(req.Target))
		if targetDev == nil {
			httpError(w, http.StatusNotFound, fmt.Sprintf("Device %q not found", req.Target))
			return
		}
	}

	if err := startSendTransferTargeted(req.Path, targetDev); err != nil {
		httpError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"ok":   true,
		"path": req.Path,
	})
}

// trySendViaRunningInstance attempts to hand off a file/folder send request to an already
// running local P2P Link instance (FR 42, FR 46). Returns true if delivered.
func trySendViaRunningInstance(filePath, target string, port int) bool {
	tokenBytes, err := os.ReadFile(localTokenFilePath())
	if err != nil || len(tokenBytes) == 0 {
		return false
	}
	payload, _ := json.Marshal(localSendRequest{
		Path:   filePath,
		Target: target,
	})
	url := fmt.Sprintf("http://127.0.0.1:%d/local/send", port)
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(payload))
	if err != nil {
		return false
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Local-Token", strings.TrimSpace(string(tokenBytes)))

	client := &http.Client{Timeout: 2 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	return resp.StatusCode == http.StatusOK
}

