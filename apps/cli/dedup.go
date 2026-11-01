package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"
)

type HashIndexEntry struct {
	FilePath  string `json:"filePath"`
	Size      int64  `json:"size"`
	Filename  string `json:"filename"`
	UpdatedAt int64  `json:"updatedAt"`
}

var (
	hashIndexMu sync.RWMutex
	hashIndex   = make(map[string]HashIndexEntry) // SHA256 hex -> HashIndexEntry
	sizeIndex   = make(map[int64]int)             // file size -> count of files
	sizeIndexed bool
)

// resetDedupIndexForTesting clears both indexes for isolated test runs.
func resetDedupIndexForTesting() {
	hashIndexMu.Lock()
	defer hashIndexMu.Unlock()
	hashIndex = make(map[string]HashIndexEntry)
	sizeIndex = make(map[int64]int)
	sizeIndexed = false
}

func ensureSizeIndexLoadedLocked() {
	if sizeIndexed {
		return
	}
	sizeIndexed = true
	entries, err := os.ReadDir(receiveDir)
	if err != nil {
		return
	}
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		if info, err := e.Info(); err == nil && info.Size() > 0 {
			sizeIndex[info.Size()]++
		}
	}
}

type uploadCheckHashRequest struct {
	Hash      string `json:"hash"`
	Filename  string `json:"filename"`
	TotalSize int64  `json:"totalSize"`
}

type uploadCheckHashResponse struct {
	Exists       bool   `json:"exists"`
	HasCandidate bool   `json:"hasCandidate,omitempty"`
	Filename     string `json:"filename,omitempty"`
}

// computeFileSHA256 streams the file in bounded 1MB buffers with strictly O(1) memory.
func computeFileSHA256(filePath string) (string, error) {
	f, err := os.Open(filePath)
	if err != nil {
		return "", err
	}
	defer f.Close()

	hasher := sha256.New()
	buf := make([]byte, 1024*1024)
	if _, err := io.CopyBuffer(hasher, f, buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(hasher.Sum(nil)), nil
}

// recordFileHash registers a completed file in the hash index.
func recordFileHash(hash string, filePath string, size int64, filename string) {
	if hash == "" || filePath == "" {
		return
	}
	hashIndexMu.Lock()
	defer hashIndexMu.Unlock()
	ensureSizeIndexLoadedLocked()
	hashIndex[hash] = HashIndexEntry{
		FilePath:  filePath,
		Size:      size,
		Filename:  filename,
		UpdatedAt: time.Now().Unix(),
	}
	if size > 0 {
		sizeIndex[size]++
	}
}

// hasCandidateBySize checks whether any existing file on the PC matches totalSize in O(1) time
// using the in-memory size index, eliminating O(N) directory scans on every client probe.
func hasCandidateBySize(totalSize int64) bool {
	if totalSize <= 0 {
		return false
	}
	hashIndexMu.Lock()
	ensureSizeIndexLoadedLocked()
	count := sizeIndex[totalSize]
	hashIndexMu.Unlock()
	return count > 0
}

// lookupFileByHash checks if an identical file already exists on the PC.
func lookupFileByHash(hash string, totalSize int64) (string, bool) {
	if hash == "" {
		return "", false
	}
	hashIndexMu.RLock()
	entry, found := hashIndex[hash]
	hashIndexMu.RUnlock()

	if found && entry.Size == totalSize {
		if stat, err := os.Stat(entry.FilePath); err == nil && stat.Size() == totalSize {
			return entry.Filename, true
		}
	}

	// If no file of this size exists in sizeIndex, bypass disk scan completely
	if !hasCandidateBySize(totalSize) {
		return "", false
	}

	// Cold scan of receiveDir for candidate files matching totalSize if not yet computed in hashIndex
	entries, err := os.ReadDir(receiveDir)
	if err != nil {
		return "", false
	}

	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		info, err := e.Info()
		if err != nil || info.Size() != totalSize {
			continue
		}

		p := filepath.Join(receiveDir, e.Name())
		if computed, err := computeFileSHA256(p); err == nil {
			recordFileHash(computed, p, info.Size(), e.Name())
			if computed == hash {
				return e.Name(), true
			}
		}
	}

	return "", false
}

func handleUploadCheckHash(w http.ResponseWriter, r *http.Request, s *Session) {
	var req uploadCheckHashRequest
	if err := s.readRequest(r, &req); err != nil {
		httpError(w, http.StatusBadRequest, "Invalid request")
		return
	}

	cleanName := sanitizeFilename(req.Filename)

	// Probe mode: Client is asking if any file with this TotalSize exists on PC
	// before spending CPU computing full SHA-256 on multi-gigabyte files.
	if req.Hash == "" {
		if req.TotalSize <= 0 {
			s.writeResponse(w, r, uploadCheckHashResponse{Exists: false, HasCandidate: false})
			return
		}
		hasCand := hasCandidateBySize(req.TotalSize)
		s.writeResponse(w, r, uploadCheckHashResponse{
			Exists:       false,
			HasCandidate: hasCand,
		})
		return
	}

	existingFilename, exists := lookupFileByHash(req.Hash, req.TotalSize)
	if exists {
		// Log deduplication skip
		printAsync(Green, "★ Dedup", cleanName, fmt.Sprintf("%s · skipped (already exists as %s)", formatSize(req.TotalSize), existingFilename))
		recordTransfer(TransferRecord{
			ID:        fmt.Sprintf("dedup-%d", time.Now().UnixNano()),
			Filename:  cleanName,
			Size:      req.TotalSize,
			Direction: "Received",
			Device:    s.Device.Name,
			Status:    "Deduplicated (Skipped)",
		})
		s.writeResponse(w, r, uploadCheckHashResponse{
			Exists:       true,
			HasCandidate: true,
			Filename:     existingFilename,
		})
		return
	}

	s.writeResponse(w, r, uploadCheckHashResponse{
		Exists:       false,
		HasCandidate: false,
	})
}
