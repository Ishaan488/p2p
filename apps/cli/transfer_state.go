package main

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"time"
)

const (
	defaultChunkSize = 1 << 20 // 1 MiB
	minChunkSize     = 64 << 10
	maxChunkSize     = 8 << 20
	transferTTL      = 24 * 60 * 60 // seconds an idle (e.g. paused) transfer stays resumable
	janitorInterval  = 5 * time.Minute
)

// TransferState tracks one file moving between this PC and a device. Uploads
// (device -> PC) own a .part file; downloads (PC -> device) point at the source file.
type TransferState struct {
	ID          string
	Filename    string
	TotalChunks int
	ChunkSize   int64
	TotalSize   int64
	File        *os.File
	FilePath    string
	FinalPath   string // target path in receive directory once finalization begins
	State       string // "transferring", "finalizing", "completed"
	generation  int64  // monotonically increasing commit sequence
	IsDownload  bool   // true if Windows is sending to phone
	IsFolder    bool   // true if transfer is a streamed directory/folder
	FolderName  string // uncompressed directory name
	LastActive  int64  // Unix timestamp; guarded by transfersMu
	Owner       string // id of the device that owns it ("" = any device, downloads only)

	// fileMu lets chunks be written in parallel (RLock) while completion or
	// cancellation (Lock) waits for in-flight writes before closing the file.
	fileMu sync.RWMutex
	closed bool

	// metaMu serializes disk metadata persistence to prevent stale snapshot overwrites,
	// lost updates, and temporary file collision races under concurrent worker uploads.
	metaMu sync.Mutex

	mu            sync.Mutex // guards received/receivedCount
	received      []bool
	receivedCount int
	chunkHashes   []string // 16-byte truncated SHA-256 digests for recovery verification
}

var (
	transfers   = make(map[string]*TransferState)
	transfersMu sync.Mutex
)

func randomID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic("crypto/rand unavailable: " + err.Error()) // unrecoverable: ids and keys depend on it
	}
	return hex.EncodeToString(b)
}

// Transfer ids come from the client, so never use them as a path component directly.
func getTempPath(id string) string {
	sum := sha256.Sum256([]byte(id))
	return filepath.Join(getTempDir(), hex.EncodeToString(sum[:16])+".part")
}

// cleanTempDir recovers any non-expired pending transfers that have a valid
// .meta.json manifest (FR 19, NFR 16), and sweeps any orphaned .part files.
func cleanTempDir() {
	recoverOrSweepTempDir()
}

var janitorOnce sync.Once

// startTransferJanitor periodically drops abandoned transfers so they cannot
// leak file descriptors or disk space.
func startTransferJanitor() {
	janitorOnce.Do(func() {
		go func() {
			for {
				time.Sleep(janitorInterval)
				sweepStaleTransfers(time.Now().Unix())
			}
		}()
	})
}

// sweepStaleTransfers removes transfers idle for longer than transferTTL.
func sweepStaleTransfers(now int64) {
	transfersMu.Lock()
	var stale []*TransferState
	for id, t := range transfers {
		if now-t.LastActive > transferTTL {
			stale = append(stale, t)
			delete(transfers, id)
		}
	}
	transfersMu.Unlock()

	for _, t := range stale {
		if t.IsDownload {
			t.cleanupDownload()
		} else {
			t.discard()
		}
		printAsync(Yellow, "○ Cleanup", t.Filename, "stale transfer removed")
	}
	sweepGeneratedTempFiles(now)
}

// sweepGeneratedTempFiles deletes clipboard images and folder archives that
// were created for transfers long gone.
func sweepGeneratedTempFiles(now int64) {
	inUse := make(map[string]bool)
	transfersMu.Lock()
	for _, t := range transfers {
		if t.IsDownload {
			inUse[filepath.Clean(t.FilePath)] = true
		}
	}
	transfersMu.Unlock()

	dir := getTempDir()
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, e := range entries {
		p := filepath.Join(dir, e.Name())
		if e.IsDir() || inUse[p] || !isGeneratedTempFile(p) {
			continue
		}
		if info, err := e.Info(); err == nil && now-info.ModTime().Unix() > transferTTL {
			_ = os.Remove(p)
		}
	}
}

// discard closes an upload and deletes its partial data and manifest.
func (s *TransferState) discard() {
	if s.IsDownload {
		return
	}
	s.fileMu.Lock()
	defer s.fileMu.Unlock()
	if !s.closed {
		s.closed = true
		if s.File != nil {
			s.File.Close()
		}
		os.Remove(s.FilePath)
		s.removeMeta()
	}
}

// cleanupDownload forgets a download: its manifest and, when the source is a
// file this program generated (folder archive, clipboard image), the file itself.
// User files are never touched.
func (s *TransferState) cleanupDownload() {
	if !s.IsDownload {
		return
	}
	s.removeMeta()
	if isGeneratedTempFile(s.FilePath) {
		_ = os.Remove(s.FilePath)
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

// restoreDownload rebuilds an in-memory download from its persisted manifest.
func restoreDownload(meta persistedTransferMeta, lastActive int64) *TransferState {
	return &TransferState{
		ID:          meta.ID,
		Filename:    meta.Filename,
		TotalChunks: meta.TotalChunks,
		ChunkSize:   meta.ChunkSize,
		TotalSize:   meta.TotalSize,
		FilePath:    meta.FilePath,
		FinalPath:   meta.FinalPath,
		State:       meta.State,
		generation:  meta.Generation,
		IsDownload:  true,
		IsFolder:    meta.IsFolder,
		FolderName:  meta.FolderName,
		LastActive:  lastActive,
		Owner:       meta.Owner,
		received:    meta.Received,
		chunkHashes: meta.ChunkHashes,
	}
}

// lookupTransfer returns the live transfer with the given id, refreshing its
// idle timer. Downloads that survived a restart are reloaded from disk.
func lookupTransfer(id string) *TransferState {
	transfersMu.Lock()
	defer transfersMu.Unlock()
	if state := transfers[id]; state != nil {
		state.LastActive = time.Now().Unix()
		return state
	}

	// Disk fallback: check if it was persisted as a download (.dlmeta.json)
	data, err := os.ReadFile(getDownloadMetaPath(id))
	if err != nil {
		return nil
	}
	var meta persistedTransferMeta
	if json.Unmarshal(data, &meta) != nil || meta.ID != id || !meta.IsDownload {
		return nil
	}
	if fi, err := os.Stat(meta.FilePath); err != nil || fi.IsDir() || fi.Size() != meta.TotalSize {
		return nil
	}
	st := restoreDownload(meta, time.Now().Unix())
	transfers[id] = st
	return st
}

// lookupUpload returns an in-progress upload, but only to the device that started it.
func lookupUpload(id string, s *Session) *TransferState {
	state := lookupTransfer(id)
	if state == nil || state.IsDownload || state.Owner != s.Device.ID {
		return nil
	}
	return state
}

// lookupDownload returns a download the session's device may fetch: one
// addressed to it, or one sent to all devices.
func lookupDownload(id string, s *Session) *TransferState {
	state := lookupTransfer(id)
	if state == nil || !state.IsDownload {
		return nil
	}
	if state.Owner != "" && state.Owner != s.Device.ID {
		return nil
	}
	return state
}

// uploadLimitReached reports whether too many uploads are already open.
// Callers hold transfersMu.
func uploadLimitReached() bool {
	n := 0
	for _, t := range transfers {
		if !t.IsDownload {
			n++
		}
	}
	return n >= maxOpenUploads
}

const maxOpenUploads = 1024
