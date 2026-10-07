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
	IsDownload  bool  // true if Windows is sending to phone
	LastActive  int64 // Unix timestamp

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
	leftovers, _ := filepath.Glob(filepath.Join(tempDir, "*.part"))
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

// sanitizeFilename strips any directory components a client may have sent.
func sanitizeFilename(name string) string {
	name = strings.ReplaceAll(name, "\\", "/")
	name = name[strings.LastIndex(name, "/")+1:]
	name = strings.Map(func(r rune) rune {
		if r < 32 || strings.ContainsRune(`<>:"|?*`, r) {
			return '_'
		}
		return r
	}, name)
	name = strings.TrimRight(strings.TrimSpace(name), ".")
	if name == "" {
		return "unnamed"
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
func handleUploadInit(w http.ResponseWriter, r *http.Request) {
	if enableCORS(w, r) {
		return
	}
	var req uploadInitRequest
	if err := readJSONBody(r, &req); err != nil || req.TransferID == "" {
		httpError(w, http.StatusBadRequest, "Invalid request")
		return
	}
	if req.ChunkSize < minChunkSize || req.ChunkSize > maxChunkSize || req.TotalSize < 0 ||
		int64(req.TotalChunks) != (req.TotalSize+req.ChunkSize-1)/req.ChunkSize {
		httpError(w, http.StatusBadRequest, "Invalid chunk layout")
		return
	}

	transfersMu.Lock()
	state, exists := transfers[req.TransferID]
	if exists && (state.IsDownload || state.TotalSize != req.TotalSize || state.ChunkSize != req.ChunkSize) {
		transfersMu.Unlock()
		httpError(w, http.StatusConflict, "Transfer id already in use")
		return
	}
	if !exists {
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
			Filename:    sanitizeFilename(req.Filename),
			TotalChunks: req.TotalChunks,
			ChunkSize:   req.ChunkSize,
			TotalSize:   req.TotalSize,
			File:        f,
			FilePath:    path,
			received:    make([]bool, req.TotalChunks),
		}
		transfers[req.TransferID] = state
	}
	state.LastActive = time.Now().Unix()
	transfersMu.Unlock()

	if exists {
		fmt.Printf("%s%s[Resuming file]:%s %s\n", ClearLine, Cyan, Reset, state.Filename)
	} else {
		fmt.Printf("%s%s[Receiving file]:%s %s\n", ClearLine, Cyan, Reset, state.Filename)
	}

	writeJSON(w, http.StatusOK, uploadStatus{
		TransferID:  state.ID,
		ChunkSize:   state.ChunkSize,
		TotalChunks: state.TotalChunks,
		Received:    state.receivedRanges(),
	})
}

func handleUploadChunk(w http.ResponseWriter, r *http.Request) {
	if enableCORS(w, r) {
		return
	}

	// Phone uploading to Windows
	state := lookupTransfer(r.URL.Query().Get("transferId"))
	if state == nil || state.IsDownload {
		httpError(w, http.StatusNotFound, "Unknown transfer")
		return
	}
	chunkIndex, err := strconv.Atoi(r.URL.Query().Get("chunkIndex"))
	if err != nil || chunkIndex < 0 || chunkIndex >= state.TotalChunks {
		httpError(w, http.StatusBadRequest, "Invalid chunk index")
		return
	}

	want := state.chunkLength(chunkIndex)
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, want+1))
	if err != nil || int64(len(body)) != want {
		httpError(w, http.StatusBadRequest, "Chunk size mismatch")
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
		httpError(w, http.StatusInternalServerError, "Failed to write")
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
	percent := float64(current) / float64(total) * 100
	completed := int(percent / 5) // 20 blocks total
	if completed > 20 {
		completed = 20
	}
	bar := strings.Repeat("█", completed) + strings.Repeat("░", 20-completed)
	// \r first, then \033[K to clear from cursor to end of line
	fmt.Printf("\r\033[K%s[Receiving]%s %s %s %.1f%%", Cyan, Reset, filename, bar, percent)
	if current == total {
		fmt.Print("\n> ")
	}
}

type transferRef struct {
	TransferID string `json:"transferId"`
}

// handleUploadComplete moves a fully received upload into the receive directory.
func handleUploadComplete(w http.ResponseWriter, r *http.Request) {
	if enableCORS(w, r) {
		return
	}
	var req transferRef
	if err := readJSONBody(r, &req); err != nil {
		httpError(w, http.StatusBadRequest, "Invalid request")
		return
	}
	state := lookupTransfer(req.TransferID)
	if state == nil || state.IsDownload {
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
		fmt.Printf("%s%s[Error saving file]:%s %v\n> ", ClearLine, Red, Reset, err)
		httpError(w, http.StatusInternalServerError, "Failed to save file")
		return
	}
	fmt.Printf("%s%s[File Received]:%s %s saved to %s\n> ", ClearLine, Green, Reset, state.Filename, finalPath)
	writeJSON(w, http.StatusOK, map[string]string{"filename": filepath.Base(finalPath)})
}

func handleUploadCancel(w http.ResponseWriter, r *http.Request) {
	if enableCORS(w, r) {
		return
	}
	var req transferRef
	if err := readJSONBody(r, &req); err != nil {
		httpError(w, http.StatusBadRequest, "Invalid request")
		return
	}

	transfersMu.Lock()
	state, exists := transfers[req.TransferID]
	if exists && !state.IsDownload {
		delete(transfers, req.TransferID)
	}
	transfersMu.Unlock()

	if exists && !state.IsDownload {
		state.discard()
		fmt.Printf("%s%s[Transfer cancelled]:%s %s\n> ", ClearLine, Yellow, Reset, state.Filename)
	}
	w.WriteHeader(http.StatusOK)
}

// moveIntoDir moves src into dir under a collision-free name and returns the final path.
func moveIntoDir(src, dir, filename string) (string, error) {
	if err := os.MkdirAll(dir, 0755); err != nil {
		return "", err
	}
	finalPath := getUniqueFilePath(dir, filename)
	if err := os.Rename(src, finalPath); err == nil {
		return finalPath, nil
	}

	// Fallback to copy if rename fails across partitions
	srcFile, err := os.Open(src)
	if err != nil {
		return "", err
	}
	defer srcFile.Close()
	destFile, err := os.Create(finalPath)
	if err != nil {
		return "", err
	}
	_, err = io.Copy(destFile, srcFile)
	if closeErr := destFile.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		os.Remove(finalPath)
		return "", err
	}
	srcFile.Close()
	os.Remove(src)
	return finalPath, nil
}

// handleDownloadFull streams a file the PC is sending. http.ServeFile honours
// Range requests, so the phone's download manager can pause and resume.
func handleDownloadFull(w http.ResponseWriter, r *http.Request) {
	if enableCORS(w, r) {
		return
	}

	state := lookupTransfer(r.URL.Query().Get("transferId"))
	if state == nil || !state.IsDownload {
		http.Error(w, "Unknown transfer", 404)
		return
	}

	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": state.Filename}))
	http.ServeFile(w, r, state.FilePath)
}

func startSendTransfer(filePath string) error {
	stat, err := os.Stat(filePath)
	if err != nil {
		return err
	}
	if stat.IsDir() {
		return fmt.Errorf("%s is a directory", filePath)
	}

	filename := filepath.Base(filePath)
	transferId := randomID()
	totalSize := stat.Size()
	chunkSize := int64(defaultChunkSize)
	totalChunks := int((totalSize + chunkSize - 1) / chunkSize)

	transfersMu.Lock()
	transfers[transferId] = &TransferState{
		ID:          transferId,
		Filename:    filename,
		TotalChunks: totalChunks,
		ChunkSize:   chunkSize,
		TotalSize:   totalSize,
		FilePath:    filePath,
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
	broadcastMessage(msg)
	fmt.Printf("%s%s[Sending file]:%s %s (Waiting for phone to download)\n", ClearLine, Cyan, Reset, filename)
	return nil
}
