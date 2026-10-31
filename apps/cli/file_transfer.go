package main

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	defaultChunkSize = 1 << 20 // 1 MiB
	minChunkSize     = 64 << 10
	maxChunkSize     = 8 << 20
	transferTTL      = 24 * 60 * 60 // seconds an idle (e.g. paused) transfer stays resumable
)

var (
	baseDir    = defaultBaseDir()
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

type TransferState struct {
	ID          string
	Filename    string
	TotalChunks int
	ChunkSize   int64
	TotalSize   int64
	File        *os.File
	FilePath    string
	IsDownload  bool   // true if Windows is sending to phone
	LastActive  int64  // Unix timestamp
	Owner       string // id of the device uploading it

	// fileMu lets chunks be written in parallel (RLock) while completion or
	// cancellation (Lock) waits for in-flight writes before closing the file.
	fileMu sync.RWMutex
	closed bool

	mu            sync.Mutex // guards received/receivedCount
	received      []bool
	receivedCount int
}

var (
	transfers   = make(map[string]*TransferState)
	transfersMu sync.Mutex
)

func initDirs() {
	os.MkdirAll(receiveDir, 0755)
	os.MkdirAll(tempDir, 0755)
}

// Partial uploads are only resumable while the server is running (the chunk
// map lives in memory), so anything left over from a previous run is garbage.
func cleanTempDir() {
	transfersMu.Lock()
	dir := tempDir
	transfersMu.Unlock()
	leftovers, _ := filepath.Glob(filepath.Join(dir, "*.part"))
	for _, p := range leftovers {
		os.Remove(p)
	}
}

func randomID() string {
	b := make([]byte, 16)
	rand.Read(b)
	return hex.EncodeToString(b)
}

// Background janitor to clean up abandoned transfers (file descriptor leaks)
func startTransferJanitor() {
	go func() {
		for {
			time.Sleep(5 * time.Minute)
			now := time.Now().Unix()

			transfersMu.Lock()
			var stale []*TransferState
			for id, state := range transfers {
				if now-state.LastActive > transferTTL {
					stale = append(stale, state)
					delete(transfers, id)
				}
			}
			transfersMu.Unlock()

			for _, state := range stale {
				state.discard()
				fmt.Printf("\n%s[System]:%s Cleaned up stale transfer %s\n> ", Yellow, Reset, state.Filename)
			}
		}
	}()
}

// discard closes an upload and deletes its partial data.
func (s *TransferState) discard() {
	if s.IsDownload {
		return
	}
	s.fileMu.Lock()
	defer s.fileMu.Unlock()
	if !s.closed {
		s.closed = true
		s.File.Close()
		os.Remove(s.FilePath)
	}
}

// receivedRanges returns the chunks already on disk as inclusive [first, last] pairs.
func (s *TransferState) receivedRanges() [][2]int {
	s.mu.Lock()
	defer s.mu.Unlock()
	ranges := [][2]int{}
	start := -1
	for i, ok := range s.received {
		if ok && start < 0 {
			start = i
		}
		if !ok && start >= 0 {
			ranges = append(ranges, [2]int{start, i - 1})
			start = -1
		}
	}
	if start >= 0 {
		ranges = append(ranges, [2]int{start, len(s.received) - 1})
	}
	return ranges
}

func (s *TransferState) chunkLength(index int) int64 {
	if index == s.TotalChunks-1 {
		return s.TotalSize - int64(index)*s.ChunkSize
	}
	return s.ChunkSize
}

func getUniqueFilePath(dir, filename string) string {
	ext := filepath.Ext(filename)
	name := strings.TrimSuffix(filename, ext)
	path := filepath.Join(dir, filename)

	counter := 1
	for {
		if _, err := os.Stat(path); os.IsNotExist(err) {
			break
		}
		path = filepath.Join(dir, fmt.Sprintf("%s (%d)%s", name, counter, ext))
		counter++
	}
	return path
}

// Transfer ids come from the client, so never use them as a path component directly.
func getTempPath(id string) string {
	sum := sha256.Sum256([]byte(id))
	return filepath.Join(tempDir, hex.EncodeToString(sum[:16])+".part")
}

var windowsReservedNames = map[string]bool{
	"CON": true, "PRN": true, "AUX": true, "NUL": true,
	"COM1": true, "COM2": true, "COM3": true, "COM4": true,
	"COM5": true, "COM6": true, "COM7": true, "COM8": true, "COM9": true,
	"LPT1": true, "LPT2": true, "LPT3": true, "LPT4": true,
	"LPT5": true, "LPT6": true, "LPT7": true, "LPT8": true, "LPT9": true,
}

// sanitizeFilename strips any directory components a client may have sent,
// removes Windows reserved chars, defangs device names, trims trailing dots/spaces,
// and bounds the filename length.
func sanitizeFilename(name string) string {
	name = strings.ReplaceAll(name, "\\", "/")
	if idx := strings.LastIndex(name, "/"); idx >= 0 {
		name = name[idx+1:]
	}
	name = strings.Map(func(r rune) rune {
		if r < 32 || strings.ContainsRune(`<>:"|?*`, r) {
			return '_'
		}
		return r
	}, name)
	name = strings.Trim(name, " \t\r\n.")
	if name == "" || name == "." || name == ".." {
		return "unnamed"
	}

	// Truncate overly long filenames while preserving extension
	const maxLen = 200
	if len(name) > maxLen {
		ext := filepath.Ext(name)
		base := strings.TrimSuffix(name, ext)
		if len(ext) > 50 {
			ext = ext[:50]
		}
		maxBase := maxLen - len(ext)
		if maxBase < 1 {
			maxBase = 1
		}
		if len(base) > maxBase {
			base = base[:maxBase]
		}
		name = base + ext
	}

	// Defang Windows reserved device names (CON, PRN, AUX, NUL, COM1-9, LPT1-9)
	root := strings.ToUpper(strings.Split(name, ".")[0])
	if windowsReservedNames[root] {
		name = "_" + name
	}

	return name
}

func setReceiveDir(newDir string) error {
	absPath, err := filepath.Abs(newDir)
	if err != nil {
		return err
	}
	err = os.MkdirAll(absPath, 0755)
	if err != nil {
		return err
	}

	newTemp := filepath.Join(absPath, ".temp")
	err = os.MkdirAll(newTemp, 0755)
	if err != nil {
		return err
	}

	transfersMu.Lock()
	receiveDir = absPath
	tempDir = newTemp
	transfersMu.Unlock()
	return nil
}

func enableCORS(w http.ResponseWriter, r *http.Request) bool {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
	if r.Method == "OPTIONS" {
		w.WriteHeader(http.StatusOK)
		return true
	}
	return false
}

func writeJSON(w http.ResponseWriter, status int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func httpError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

// readJSONBody is for the two endpoints that run before a session exists.
func readJSONBody(r *http.Request, v interface{}) error {
	return json.NewDecoder(io.LimitReader(r.Body, 64<<10)).Decode(v)
}

func lookupTransfer(id string) *TransferState {
	transfersMu.Lock()
	defer transfersMu.Unlock()
	state := transfers[id]
	if state != nil {
		state.LastActive = time.Now().Unix()
	}
	return state
}

// lookupUpload returns an in-progress upload, but only to the device that started it.
func lookupUpload(id string, s *Session) *TransferState {
	state := lookupTransfer(id)
	if state == nil || state.IsDownload || state.Owner != s.Device.ID {
		return nil
	}
	return state
}

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

// handleUploadInit starts an upload, or resumes it when the same transfer id
// is announced again: the response lists the chunks the server already has.
func handleUploadInit(w http.ResponseWriter, r *http.Request, s *Session) {
	var req uploadInitRequest
	if err := s.readRequest(r, &req); err != nil || req.TransferID == "" {
		httpError(w, http.StatusBadRequest, "Invalid request")
		return
	}
	if req.ChunkSize < minChunkSize || req.ChunkSize > maxChunkSize || req.TotalSize < 0 {
		httpError(w, http.StatusBadRequest, "Invalid chunk layout")
		return
	}
	if req.TotalSize > (int64(5)<<40) || req.TotalChunks > 5000000 {
		httpError(w, http.StatusBadRequest, "File size or chunk count exceeds limit")
		return
	}
	var expectedChunks int64
	if req.TotalSize == 0 {
		expectedChunks = 0
	} else {
		expectedChunks = (req.TotalSize + req.ChunkSize - 1) / req.ChunkSize
	}
	if int64(req.TotalChunks) != expectedChunks {
		httpError(w, http.StatusBadRequest, "Invalid chunk layout")
		return
	}

	transfersMu.Lock()
	state, exists := transfers[req.TransferID]
	if exists && (state.IsDownload || state.Owner != s.Device.ID || state.TotalSize != req.TotalSize || state.ChunkSize != req.ChunkSize) {
		transfersMu.Unlock()
		httpError(w, http.StatusConflict, "Transfer id already in use")
		return
	}
	if !exists {
		cleanName := filepath.Base(filepath.Clean(req.Filename))
		cleanName = sanitizeFilename(cleanName)

		if !s.Device.Trusted {
			transfersMu.Unlock()
			allow, always := askTransferApproval(s.Device, cleanName, req.TotalSize)
			if !allow {
				recordTransfer(TransferRecord{
					ID:        req.TransferID,
					Filename:  cleanName,
					Size:      req.TotalSize,
					Direction: "Received",
					Device:    s.Device.Name,
					Status:    "Rejected",
				})
				httpError(w, http.StatusForbidden, "Transfer rejected by user")
				return
			}
			if always {
				setDeviceTrust(s.Device.ID, true)
				printAsync(Green, "● Trusted", s.Device.Name, "transfers auto-accepted")
			}
			transfersMu.Lock()
		}

		initDirs()
		path := getTempPath(req.TransferID)
		f, err := os.Create(path)
		if err != nil {
			transfersMu.Unlock()
			fmt.Println("Error creating temp file:", err)
			httpError(w, http.StatusInternalServerError, "Failed to create file")
			return
		}
		state = &TransferState{
			ID:          req.TransferID,
			Filename:    cleanName,
			TotalChunks: req.TotalChunks,
			ChunkSize:   req.ChunkSize,
			TotalSize:   req.TotalSize,
			File:        f,
			FilePath:    path,
			Owner:       s.Device.ID,
			received:    make([]bool, req.TotalChunks),
		}
		transfers[req.TransferID] = state
	}
	state.LastActive = time.Now().Unix()
	transfersMu.Unlock()

	s.writeResponse(w, r, uploadStatus{
		TransferID:  state.ID,
		ChunkSize:   state.ChunkSize,
		TotalChunks: state.TotalChunks,
		Received:    state.receivedRanges(),
	})
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

	// Write chunk exactly at its designated offset (100% robust against out-of-order chunks)
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
		httpError(w, 507, "Disk write failed / Insufficient storage")
		return
	}

	state.mu.Lock()
	if !state.received[chunkIndex] {
		state.received[chunkIndex] = true
		state.receivedCount++
	}
	count := state.receivedCount
	state.mu.Unlock()

	w.WriteHeader(http.StatusOK)

	// Beautiful progress bar
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
	displayName := filename
	if len(displayName) > 22 {
		ext := filepath.Ext(displayName)
		base := strings.TrimSuffix(displayName, ext)
		if len(base) > 15 {
			base = base[:12] + "..."
		}
		displayName = base + ext
	}

	// \r first, then \033[2K to clear entire line cleanly without adding a newline
	fmt.Printf("\r\033[2K  %s%s%s  %s↓ Receiving%s %-22s %s[%s]%s %3.0f%%",
		Dim, nowStamp(), Reset, Cyan, Reset, displayName, Dim, bar, Reset, percent)
}

type transferRef struct {
	TransferID string `json:"transferId"`
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
		httpError(w, http.StatusNotFound, "Unknown transfer")
		return
	}
	state.closed = true
	state.File.Close()
	state.fileMu.Unlock()

	transfersMu.Lock()
	delete(transfers, state.ID)
	dir := receiveDir
	transfersMu.Unlock()

	finalPath, err := moveIntoDir(state.FilePath, dir, state.Filename)
	if err != nil {
		os.Remove(state.FilePath)
		printAsync(Red, "! Error", state.Filename, fmt.Sprintf("save failed: %v", err))
		httpError(w, http.StatusInternalServerError, "Failed to save file")
		return
	}
	printAsync(Green, "↓ File", state.Filename, fmt.Sprintf("%s · saved to received\\", formatSize(state.TotalSize)))
	recordTransfer(TransferRecord{
		ID:        state.ID,
		Filename:  state.Filename,
		Size:      state.TotalSize,
		Direction: "Received",
		Device:    s.Device.Name,
		Status:    "Completed",
	})
	s.writeResponse(w, r, map[string]string{"filename": filepath.Base(finalPath)})
}

func handleUploadCancel(w http.ResponseWriter, r *http.Request, s *Session) {
	var req transferRef
	if err := s.readRequest(r, &req); err != nil {
		httpError(w, http.StatusBadRequest, "Invalid request")
		return
	}

	state := lookupUpload(req.TransferID, s)
	if state != nil {
		transfersMu.Lock()
		delete(transfers, req.TransferID)
		transfersMu.Unlock()
		state.discard()
		printAsync(Yellow, "○ Cancelled", state.Filename, "")
		recordTransfer(TransferRecord{
			ID:        state.ID,
			Filename:  state.Filename,
			Size:      state.TotalSize,
			Direction: "Received",
			Device:    s.Device.Name,
			Status:    "Cancelled",
		})
	}
	s.writeResponse(w, r, map[string]bool{"ok": true})
}

var moveMu sync.Mutex

// moveIntoDir moves src into dir under a collision-free name and returns the final path.
func moveIntoDir(src, dir, filename string) (string, error) {
	moveMu.Lock()
	defer moveMu.Unlock()

	cleanDir, err := filepath.Abs(dir)
	if err != nil {
		cleanDir = filepath.Clean(dir)
	}
	if err := os.MkdirAll(cleanDir, 0755); err != nil {
		return "", err
	}
	cleanFilename := sanitizeFilename(filepath.Base(filepath.Clean(filename)))

	ext := filepath.Ext(cleanFilename)
	name := strings.TrimSuffix(cleanFilename, ext)

	for counter := 0; counter < 10000; counter++ {
		candidate := cleanFilename
		if counter > 0 {
			candidate = fmt.Sprintf("%s (%d)%s", name, counter, ext)
		}
		finalPath := filepath.Join(cleanDir, candidate)

		// Path traversal check: verify finalPath is strictly contained within cleanDir
		rel, err := filepath.Rel(cleanDir, finalPath)
		if err != nil || strings.HasPrefix(rel, "..") || rel == "." {
			return "", fmt.Errorf("invalid destination path: %s", finalPath)
		}

		// If destination already exists, try next counter
		if _, err := os.Stat(finalPath); err == nil {
			continue
		}

		// Try atomic rename
		if err := os.Rename(src, finalPath); err == nil {
			return finalPath, nil
		}

		// Fallback to exclusive copy across partitions (guarantees no overwrite)
		if err := copyExclusive(src, finalPath); err == nil {
			os.Remove(src)
			return finalPath, nil
		}
	}
	return "", fmt.Errorf("could not find unique filename after multiple attempts")
}

func copyExclusive(src, dest string) error {
	srcFile, err := os.Open(src)
	if err != nil {
		return err
	}
	defer srcFile.Close()

	destFile, err := os.OpenFile(dest, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0644)
	if err != nil {
		return err
	}
	defer destFile.Close()

	if _, err := io.Copy(destFile, srcFile); err != nil {
		os.Remove(dest)
		return err
	}
	return nil
}

// handleDownloadChunk serves one encrypted chunk of a file the PC is sending.
func handleDownloadChunk(w http.ResponseWriter, r *http.Request, s *Session) {
	state := lookupTransfer(r.URL.Query().Get("transferId"))
	if state == nil || !state.IsDownload {
		httpError(w, http.StatusNotFound, "Unknown transfer")
		return
	}
	chunkIndex, err := strconv.Atoi(r.URL.Query().Get("chunkIndex"))
	if err != nil || chunkIndex < 0 || chunkIndex >= state.TotalChunks {
		httpError(w, http.StatusBadRequest, "Invalid chunk index")
		return
	}

	cleanPath := filepath.Clean(state.FilePath)
	file, err := os.Open(cleanPath)
	if err != nil {
		httpError(w, http.StatusGone, "File is no longer available")
		return
	}
	defer file.Close()

	buf := make([]byte, state.chunkLength(chunkIndex))
	if _, err := io.ReadFull(io.NewSectionReader(file, int64(chunkIndex)*state.ChunkSize, int64(len(buf))), buf); err != nil {
		httpError(w, http.StatusGone, "File changed since it was sent")
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Write(s.seal(buf, chunkAAD(state.ID, chunkIndex)))
}

// handleDownloadFull streams a file the PC is sending without encryption, for
// the phone's own download manager (which cannot decrypt). http.ServeFile
// honours Range requests, so that download can pause and resume.
func handleDownloadFull(w http.ResponseWriter, r *http.Request, s *Session) {
	state := lookupTransfer(r.URL.Query().Get("transferId"))
	if state == nil || !state.IsDownload {
		http.Error(w, "Unknown transfer", http.StatusNotFound)
		return
	}

	cleanPath := filepath.Clean(state.FilePath)
	cleanName := filepath.Base(filepath.Clean(state.Filename))
	if cleanName == "." || cleanName == "" || cleanName == "/" || cleanName == "\\" {
		cleanName = "download"
	}

	stat, err := os.Stat(cleanPath)
	if err != nil || stat.IsDir() {
		http.Error(w, "File is no longer available", http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": cleanName}))
	http.ServeFile(w, r, cleanPath)
}

func startSendTransfer(filePath string) error {
	cleanPath := filepath.Clean(filePath)
	absPath, err := filepath.Abs(cleanPath)
	if err != nil {
		return err
	}
	stat, err := os.Stat(absPath)
	if err != nil {
		return err
	}
	if stat.IsDir() {
		return fmt.Errorf("%s is a directory", absPath)
	}

	filename := filepath.Base(absPath)
	filename = sanitizeFilename(filename)
	transferId := randomID()
	totalSize := stat.Size()
	chunkSize := int64(defaultChunkSize)
	var totalChunks int
	if totalSize == 0 {
		totalChunks = 0
	} else {
		totalChunks = int((totalSize + chunkSize - 1) / chunkSize)
	}

	transfersMu.Lock()
	transfers[transferId] = &TransferState{
		ID:          transferId,
		Filename:    filename,
		TotalChunks: totalChunks,
		ChunkSize:   chunkSize,
		TotalSize:   totalSize,
		FilePath:    absPath,
		IsDownload:  true,
		LastActive:  time.Now().Unix(),
	}
	transfersMu.Unlock()

	// Notify phone to start download
	msg := Message{
		Version:   1,
		Type:      "file_start",
		ID:        "msg-" + transferId,
		Timestamp: time.Now().Unix(),
		Payload: map[string]interface{}{
			"transferId":  transferId,
			"filename":    filename,
			"mimeType":    "application/octet-stream",
			"totalSize":   totalSize,
			"chunkSize":   chunkSize,
			"totalChunks": totalChunks,
		},
	}
	delivered := broadcastMessage(msg)
	if delivered > 0 {
		printSync(Cyan, "↑ File", filename, formatSize(totalSize))
	} else {
		printSync(Yellow, "↑ File", filename, fmt.Sprintf("%s · queued — waiting for phone", formatSize(totalSize)))
	}
	recordTransfer(TransferRecord{
		ID:        transferId,
		Filename:  filename,
		Size:      totalSize,
		Direction: "Sent",
		Device:    "Phone",
		Status:    "Completed",
	})
	return nil
}
