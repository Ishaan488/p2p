package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// Device -> PC transfers: init/resume, chunk upload, completion and cancel.

const (
	maxTransferBytes  = int64(5) << 40
	maxTransferChunks = 5_000_000
)

type uploadInitRequest struct {
	TransferID  string `json:"transferId"`
	Filename    string `json:"filename"`
	TotalSize   int64  `json:"totalSize"`
	ChunkSize   int64  `json:"chunkSize"`
	TotalChunks int    `json:"totalChunks"`
}

type uploadStatus struct {
	TransferID  string   `json:"transferId"`
	ChunkSize   int64    `json:"chunkSize"`
	TotalChunks int      `json:"totalChunks"`
	Received    [][2]int `json:"received"`
}

type transferRef struct {
	TransferID string `json:"transferId"`
	Reason     string `json:"reason,omitempty"`
}

// validateUploadLayout checks the sizes a client announced.
func validateUploadLayout(req uploadInitRequest) string {
	if req.ChunkSize < minChunkSize || req.ChunkSize > maxChunkSize || req.TotalSize < 0 {
		return "Invalid chunk layout"
	}
	if req.TotalSize > maxTransferBytes || req.TotalChunks < 0 || req.TotalChunks > maxTransferChunks {
		return "File size or chunk count exceeds limit"
	}
	var expectedChunks int64
	if req.TotalSize > 0 {
		expectedChunks = (req.TotalSize + req.ChunkSize - 1) / req.ChunkSize
	}
	if int64(req.TotalChunks) != expectedChunks {
		return "Invalid chunk layout"
	}
	return ""
}

// handleUploadInit starts an upload, or resumes it when the same transfer id
// is announced again: the response lists the chunks the server already has.
func handleUploadInit(w http.ResponseWriter, r *http.Request, s *Session) {
	var req uploadInitRequest
	if err := s.readRequest(r, &req); err != nil || req.TransferID == "" || len(req.TransferID) > 256 {
		httpError(w, http.StatusBadRequest, "Invalid request")
		return
	}
	if msg := validateUploadLayout(req); msg != "" {
		httpError(w, http.StatusBadRequest, msg)
		return
	}

	state, status, errMsg := openUpload(req, s)
	if state == nil {
		httpError(w, status, errMsg)
		return
	}

	if err := state.saveMeta(); err != nil {
		printAsync(Red, "! Meta Error", state.Filename, fmt.Sprintf("initial metadata persistence failed: %v", err))
		httpError(w, http.StatusInternalServerError, "Failed to persist transfer metadata")
		return
	}

	s.writeResponse(w, r, uploadStatus{
		TransferID:  state.ID,
		ChunkSize:   state.ChunkSize,
		TotalChunks: state.TotalChunks,
		Received:    state.receivedRanges(),
	})
}

// openUpload returns the existing upload for req.TransferID, or creates it after
// asking the PC owner for approval when the device is not trusted.
func openUpload(req uploadInitRequest, s *Session) (state *TransferState, status int, errMsg string) {
	conflicts := func(t *TransferState) bool {
		return t.IsDownload || t.Owner != s.Device.ID || t.TotalSize != req.TotalSize || t.ChunkSize != req.ChunkSize
	}

	transfersMu.Lock()
	if t, ok := transfers[req.TransferID]; ok {
		defer transfersMu.Unlock()
		if conflicts(t) {
			return nil, http.StatusConflict, "Transfer id already in use"
		}
		t.LastActive = time.Now().Unix()
		return t, 0, ""
	}
	if uploadLimitReached() {
		transfersMu.Unlock()
		return nil, http.StatusServiceUnavailable, "Too many transfers in progress"
	}
	transfersMu.Unlock()

	cleanName := sanitizeFilename(filepath.Base(filepath.Clean(req.Filename)))

	if !s.Device.Trusted {
		allow, always := askTransferApproval(s.Device, cleanName, req.TotalSize)
		if !allow {
			recordTransfer(TransferRecord{
				ID:        req.TransferID,
				Filename:  cleanName,
				Size:      req.TotalSize,
				Direction: "Received",
				Device:    s.Device.DisplayName(),
				Status:    "Rejected",
			})
			return nil, http.StatusForbidden, "Transfer rejected by user"
		}
		if always {
			setDeviceTrust(s.Device.ID, true)
			printAsync(Green, "● Trusted", s.Device.DisplayName(), "transfers auto-accepted")
		}
	}

	initDirs()
	path := getTempPath(req.TransferID)
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR|os.O_TRUNC, 0o600)
	if err != nil {
		printAsync(Red, "! Disk Error", cleanName, fmt.Sprintf("cannot create temp file: %v", err))
		return nil, http.StatusInternalServerError, "Failed to create file"
	}

	transfersMu.Lock()
	defer transfersMu.Unlock()
	// A concurrent init for the same id may have won while approval was pending.
	if t, ok := transfers[req.TransferID]; ok {
		f.Close()
		if conflicts(t) {
			return nil, http.StatusConflict, "Transfer id already in use"
		}
		t.LastActive = time.Now().Unix()
		return t, 0, ""
	}
	state = &TransferState{
		ID:          req.TransferID,
		Filename:    cleanName,
		TotalChunks: req.TotalChunks,
		ChunkSize:   req.ChunkSize,
		TotalSize:   req.TotalSize,
		File:        f,
		FilePath:    path,
		State:       "transferring",
		generation:  1,
		LastActive:  time.Now().Unix(),
		Owner:       s.Device.ID,
		received:    make([]bool, req.TotalChunks),
		chunkHashes: make([]string, req.TotalChunks),
	}
	transfers[req.TransferID] = state
	return state, 0, ""
}

func handleUploadChunk(w http.ResponseWriter, r *http.Request, s *Session) {
	// Phone uploading to Windows
	state := lookupUpload(r.URL.Query().Get("transferId"), s)
	if state == nil {
		httpError(w, http.StatusNotFound, "Unknown transfer")
		return
	}
	chunkIndex, err := strconv.Atoi(r.URL.Query().Get("chunkIndex"))
	if err != nil || chunkIndex < 0 || chunkIndex >= state.TotalChunks {
		httpError(w, http.StatusBadRequest, "Invalid chunk index")
		return
	}

	want := state.chunkLength(chunkIndex)
	sealed, err := io.ReadAll(http.MaxBytesReader(w, r.Body, want+sealOverhead+1))
	if err != nil {
		httpError(w, http.StatusBadRequest, "Chunk size mismatch")
		return
	}
	// The chunk is encrypted for this exact transfer and position.
	body, err := s.open(sealed, chunkAAD(state.ID, chunkIndex))
	if err != nil || int64(len(body)) != want {
		httpError(w, http.StatusBadRequest, "Chunk rejected")
		return
	}

	// Enforce bandwidth limit if configured (FR 54)
	waitForBandwidth(int64(len(body)))

	// Write chunk exactly at its designated offset (robust against out-of-order chunks)
	state.fileMu.RLock()
	if state.closed {
		state.fileMu.RUnlock()
		httpError(w, http.StatusNotFound, "Unknown transfer")
		return
	}
	_, err = state.File.WriteAt(body, int64(chunkIndex)*state.ChunkSize)
	state.fileMu.RUnlock()
	if err != nil {
		printAsync(Red, "! Disk Error", state.Filename, fmt.Sprintf("write failed: %v", err))
		httpError(w, http.StatusInsufficientStorage, "Disk write failed / Insufficient storage")
		return
	}

	// Record chunk cryptographic digest for crash-consistent content verification
	sum := sha256.Sum256(body)
	cHash := hex.EncodeToString(sum[:16])

	state.mu.Lock()
	if len(state.chunkHashes) != state.TotalChunks {
		state.chunkHashes = make([]string, state.TotalChunks)
	}
	state.chunkHashes[chunkIndex] = cHash
	if !state.received[chunkIndex] {
		state.received[chunkIndex] = true
		state.receivedCount++
	}
	count := state.receivedCount
	state.mu.Unlock()

	// Persist chunk receipt to fast append-only write-ahead journal before acknowledging HTTP 200
	if err := state.appendChunkJournal(chunkIndex, cHash); err != nil {
		printAsync(Red, "! Journal Error", state.Filename, fmt.Sprintf("chunk journal write failed: %v", err))
		httpError(w, http.StatusInternalServerError, "Failed to persist transfer chunk receipt")
		return
	}

	// Periodic full metadata checkpoint every 64 chunks or on transfer completion
	if count%64 == 0 || count == state.TotalChunks {
		state.fileMu.RLock()
		if !state.closed && state.File != nil {
			_ = state.File.Sync()
		}
		state.fileMu.RUnlock()
		if err := state.saveMeta(); err != nil {
			printAsync(Red, "! Meta Error", state.Filename, fmt.Sprintf("metadata checkpoint failed: %v", err))
		}
	}

	w.WriteHeader(http.StatusOK)
	printProgressBar(state.Filename, count, state.TotalChunks)
}

func printProgressBar(filename string, current, total int) {
	if total <= 0 {
		return
	}
	percent := float64(current) / float64(total) * 100
	const barWidth = 14
	completed := int((percent / 100.0) * barWidth)
	if completed > barWidth {
		completed = barWidth
	}
	bar := strings.Repeat("█", completed) + strings.Repeat("░", barWidth-completed)

	// Truncate long filenames to prevent line-wrapping on 80-column terminals
	displayName := printableText(filename, 0)
	if r := []rune(displayName); len(r) > 22 {
		ext := filepath.Ext(displayName)
		base := []rune(strings.TrimSuffix(displayName, ext))
		if len(base) > 15 {
			base = append(base[:12], []rune("...")...)
		}
		displayName = string(base) + ext
	}

	// \r first, then \033[2K to clear entire line cleanly without adding a newline
	fmt.Printf("\r\033[2K  %s%s%s  %s↓ Receiving%s %-22s %s[%s]%s %3.0f%%",
		Dim, nowStamp(), Reset, Cyan, Reset, displayName, Dim, bar, Reset, percent)
}

// handleUploadComplete moves a fully received upload into the receive directory.
func handleUploadComplete(w http.ResponseWriter, r *http.Request, s *Session) {
	var req transferRef
	if err := s.readRequest(r, &req); err != nil {
		httpError(w, http.StatusBadRequest, "Invalid request")
		return
	}
	state := lookupUpload(req.TransferID, s)
	if state == nil {
		// Idempotent retry: check if transfer already completed (e.g. client retrying after lost response)
		if rec := lookupCompletedTransfer(req.TransferID); rec != nil {
			s.writeResponse(w, r, map[string]string{"filename": rec.Filename})
			return
		}
		httpError(w, http.StatusNotFound, "Unknown transfer")
		return
	}

	state.mu.Lock()
	missing := state.TotalChunks - state.receivedCount
	state.mu.Unlock()
	if missing > 0 {
		writeJSON(w, http.StatusConflict, map[string]interface{}{
			"error":    fmt.Sprintf("%d chunks missing", missing),
			"received": state.receivedRanges(),
		})
		return
	}

	state.fileMu.Lock()
	if state.closed {
		state.fileMu.Unlock()
		if rec := lookupCompletedTransfer(req.TransferID); rec != nil {
			s.writeResponse(w, r, map[string]string{"filename": rec.Filename})
			return
		}
		httpError(w, http.StatusNotFound, "Unknown transfer")
		return
	}
	state.closed = true
	if state.File != nil {
		state.File.Close()
	}
	state.fileMu.Unlock()

	finalPath, err := finalizeUpload(state, getReceiveDir())
	if err != nil {
		printAsync(Red, "! Error", state.Filename, fmt.Sprintf("save failed: %v", err))
		state.reopenAfterFailedCommit()
		httpError(w, http.StatusInternalServerError, "Failed to save file: "+err.Error())
		return
	}

	transfersMu.Lock()
	delete(transfers, state.ID)
	transfersMu.Unlock()

	printAsync(Green, "↓ File", state.Filename, fmt.Sprintf("%s · saved to received\\", formatSize(state.TotalSize)))
	go func(p string, sz int64, nm string) {
		if h, err := computeFileSHA256(p); err == nil {
			recordFileHash(h, p, sz, nm)
		}
	}(finalPath, state.TotalSize, state.Filename)
	recordTransfer(TransferRecord{
		ID:        state.ID,
		Filename:  filepath.Base(finalPath),
		Size:      state.TotalSize,
		Direction: "Received",
		Device:    s.Device.DisplayName(),
		Status:    "Completed",
	})
	s.writeResponse(w, r, map[string]string{"filename": filepath.Base(finalPath)})
}

// reopenAfterFailedCommit makes an upload usable again after saving it failed
// (disk full, permissions...), so the client can simply retry completion. If the
// partial file is gone the transfer is dropped and the client starts over.
func (s *TransferState) reopenAfterFailedCommit() {
	s.fileMu.Lock()
	f, err := os.OpenFile(s.FilePath, os.O_RDWR, 0o600)
	if err == nil {
		s.File = f
		s.closed = false
	}
	s.fileMu.Unlock()

	if err != nil {
		transfersMu.Lock()
		delete(transfers, s.ID)
		transfersMu.Unlock()
		s.removeMeta()
		return
	}
	s.mu.Lock()
	s.State = "transferring"
	s.FinalPath = ""
	s.mu.Unlock()
	_ = s.saveMeta()
}

func handleUploadCancel(w http.ResponseWriter, r *http.Request, s *Session) {
	var req transferRef
	if err := s.readRequest(r, &req); err != nil {
		httpError(w, http.StatusBadRequest, "Invalid request")
		return
	}

	status, label, detail := "Cancelled", "○ Cancelled", ""
	if req.Reason == "rejected" {
		status, label, detail = "Rejected", "○ Rejected", "rejected by remote device"
	}

	var t *TransferState
	direction := "Received"
	if t = lookupUpload(req.TransferID, s); t == nil {
		if t = lookupDownload(req.TransferID, s); t != nil {
			direction = "Sent"
		}
	}
	if t != nil {
		transfersMu.Lock()
		delete(transfers, req.TransferID)
		transfersMu.Unlock()
		if t.IsDownload {
			t.cleanupDownload()
		} else {
			t.discard()
		}
		printAsync(Yellow, label, t.Filename, detail)
		recordTransfer(TransferRecord{
			ID:        t.ID,
			Filename:  t.Filename,
			Size:      t.TotalSize,
			Direction: direction,
			Device:    s.Device.DisplayName(),
			Status:    status,
		})
	}
	s.writeResponse(w, r, map[string]bool{"ok": true})
}

// finalizeUpload atomically commits an upload to the receive directory with crash-safe recovery.
func finalizeUpload(state *TransferState, dir string) (string, error) {
	moveMu.Lock()
	defer moveMu.Unlock()

	cleanDir, err := absDir(dir)
	if err != nil {
		return "", err
	}
	cleanFilename := sanitizeFilename(filepath.Base(filepath.Clean(state.Filename)))

	var finalPath string
	for counter := 0; counter < 10000; counter++ {
		p, err := destCandidate(cleanDir, cleanFilename, counter)
		if err != nil {
			return "", err
		}
		if exists(p) {
			continue
		}
		finalPath = p
		break
	}
	if finalPath == "" {
		return "", fmt.Errorf("could not find unique destination path")
	}

	// 1. Record State = "finalizing" and FinalPath in metadata before moving the .part file
	state.mu.Lock()
	state.State = "finalizing"
	state.FinalPath = finalPath
	state.mu.Unlock()

	// Ensure all chunk data blocks are durable on disk before finalization
	if f, err := os.OpenFile(state.FilePath, os.O_RDWR, 0o600); err == nil {
		_ = f.Sync()
		f.Close()
	}

	if err := state.saveMeta(); err != nil {
		return "", fmt.Errorf("persist finalization metadata: %w", err)
	}

	// 2. Move file
	if err := moveFile(state.FilePath, finalPath); err != nil {
		return "", fmt.Errorf("move file to destination: %w", err)
	}

	// 3. File is safely in receiveDir; record completion to history BEFORE removing metadata
	// to prevent any crash window where neither metadata nor history records the transfer.
	recordTransfer(TransferRecord{
		ID:        state.ID,
		Filename:  filepath.Base(finalPath),
		Size:      state.TotalSize,
		Direction: "Received",
		Status:    "Completed",
	})

	// 4. File is safely recorded in transfer history; safely remove metadata
	state.removeMeta()

	return finalPath, nil
}
