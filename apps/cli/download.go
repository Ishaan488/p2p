package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"time"
)

// PC -> device transfers: announcing a file, serving its chunks.

// handleDownloadChunk serves one encrypted chunk of a file the PC is sending.
func handleDownloadChunk(w http.ResponseWriter, r *http.Request, s *Session) {
	state := lookupDownload(r.URL.Query().Get("transferId"), s)
	if state == nil {
		httpError(w, http.StatusNotFound, "Unknown transfer")
		return
	}

	chunkIndex, err := strconv.Atoi(r.URL.Query().Get("chunkIndex"))
	if err != nil || chunkIndex < 0 || chunkIndex >= state.TotalChunks {
		httpError(w, http.StatusBadRequest, "Invalid chunk index")
		return
	}

	file, err := os.Open(filepath.Clean(state.FilePath))
	if err != nil {
		httpError(w, http.StatusGone, "File is no longer available")
		return
	}
	defer file.Close()

	length := state.chunkLength(chunkIndex)
	if length < 0 || length > maxChunkSize {
		httpError(w, http.StatusGone, "File changed since it was sent")
		return
	}
	buf := make([]byte, length)
	if _, err := io.ReadFull(io.NewSectionReader(file, int64(chunkIndex)*state.ChunkSize, length), buf); err != nil {
		httpError(w, http.StatusGone, "File changed since it was sent")
		return
	}

	// Enforce bandwidth limit if configured (FR 54)
	waitForBandwidth(int64(len(buf)))

	w.Header().Set("Content-Type", "application/octet-stream")
	_, _ = w.Write(s.seal(buf, chunkAAD(state.ID, chunkIndex)))
}

// handleDownloadFull streams a file the PC is sending without encryption, for
// the phone's own download manager (which cannot decrypt). http.ServeFile
// honours Range requests, so that download can pause and resume.
func handleDownloadFull(w http.ResponseWriter, r *http.Request, s *Session) {
	state := lookupDownload(r.URL.Query().Get("transferId"), s)
	if state == nil {
		http.Error(w, "Unknown transfer", http.StatusNotFound)
		return
	}

	cleanPath := filepath.Clean(state.FilePath)
	cleanName := sanitizeFilename(state.Filename)

	stat, err := os.Stat(cleanPath)
	if err != nil || stat.IsDir() {
		http.Error(w, "File is no longer available", http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": cleanName}))
	http.ServeFile(w, r, cleanPath)
}

// computeFileTransferID derives a stable id so announcing the same unchanged
// file to the same target again resumes the same transfer.
func computeFileTransferID(filePath string, totalSize int64, modTime int64, ownerID string) string {
	sum := sha256.Sum256([]byte(fmt.Sprintf("%s:%d:%d:%s", filepath.Clean(filePath), totalSize, modTime, ownerID)))
	return "dl-" + hex.EncodeToString(sum[:12])
}

func chunkCount(totalSize, chunkSize int64) int {
	if totalSize <= 0 {
		return 0
	}
	return int((totalSize + chunkSize - 1) / chunkSize)
}

// startSendTransferTargeted announces a file (or folder) to one device, or to
// every device when targetDevice is nil. Offline devices get it when they connect.
func startSendTransferTargeted(filePath string, targetDevice *Device) error {
	absPath, err := filepath.Abs(filepath.Clean(filePath))
	if err != nil {
		return err
	}
	stat, err := os.Stat(absPath)
	if err != nil {
		return err
	}
	if stat.IsDir() {
		return startSendFolderTransferTargeted(absPath, targetDevice)
	}
	if !stat.Mode().IsRegular() {
		return fmt.Errorf("%s is not a regular file", filepath.Base(absPath))
	}

	filename := sanitizeFilename(filepath.Base(absPath))
	totalSize := stat.Size()
	ownerID := ""
	if targetDevice != nil {
		ownerID = targetDevice.ID
	}
	transferID := computeFileTransferID(absPath, totalSize, stat.ModTime().Unix(), ownerID)
	chunkSize := int64(defaultChunkSize)
	totalChunks := chunkCount(totalSize, chunkSize)

	state := &TransferState{
		ID:          transferID,
		Filename:    filename,
		TotalChunks: totalChunks,
		ChunkSize:   chunkSize,
		TotalSize:   totalSize,
		FilePath:    absPath,
		IsDownload:  true,
		Owner:       ownerID,
		LastActive:  time.Now().Unix(),
	}

	transfersMu.Lock()
	if existing, ok := transfers[transferID]; ok && existing.IsDownload {
		existing.LastActive = time.Now().Unix()
		state = existing
	} else {
		transfers[transferID] = state
	}
	transfersMu.Unlock()

	// Persist download state so desktop terminal restarts don't cause 404 for mobile
	if err := state.saveMeta(); err != nil {
		printSync(Yellow, "! Warning", "failed to persist download state", err.Error())
	}

	announceDownload(state, targetDevice, map[string]interface{}{
		"mimeType": "application/octet-stream",
	})
	return nil
}

// announceDownload notifies the target device(s) that a file is ready to fetch
// and logs the transfer. extra adds message fields (folder details).
func announceDownload(state *TransferState, targetDevice *Device, extra map[string]interface{}) {
	payload := map[string]interface{}{
		"transferId":  state.ID,
		"filename":    state.Filename,
		"totalSize":   state.TotalSize,
		"chunkSize":   state.ChunkSize,
		"totalChunks": state.TotalChunks,
	}
	for k, v := range extra {
		payload[k] = v
	}
	msg := Message{
		Version:   1,
		Type:      "file_start",
		ID:        "msg-" + state.ID,
		Timestamp: time.Now().Unix(),
		Payload:   payload,
	}
	targetLabel := "all devices"
	if targetDevice != nil {
		msg.TargetDeviceID = targetDevice.ID
		targetLabel = targetDevice.DisplayName()
	}

	icon := "↑ File"
	if state.IsFolder {
		icon = "📁 Folder"
	}
	if broadcastMessage(msg) > 0 {
		printSync(Cyan, icon, state.Filename, fmt.Sprintf("%s → %s", formatSize(state.TotalSize), targetLabel))
	} else {
		printSync(Yellow, icon, state.Filename, fmt.Sprintf("%s · queued for %s", formatSize(state.TotalSize), targetLabel))
	}
	recordTransfer(TransferRecord{
		ID:        state.ID,
		Filename:  state.Filename,
		Size:      state.TotalSize,
		Direction: "Sent",
		Device:    targetLabel,
		Status:    "Completed",
	})
}
