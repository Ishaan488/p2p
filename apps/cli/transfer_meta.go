package main

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"hash/crc32"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type persistedTransferMeta struct {
	ID          string   `json:"id"`
	Filename    string   `json:"filename"`
	TotalChunks int      `json:"totalChunks"`
	ChunkSize   int64    `json:"chunkSize"`
	TotalSize   int64    `json:"totalSize"`
	FilePath    string   `json:"filePath"`
	FinalPath   string   `json:"finalPath,omitempty"`
	State       string   `json:"state,omitempty"`
	Generation  int64    `json:"generation"`
	IsDownload  bool     `json:"isDownload"`
	IsFolder    bool     `json:"isFolder"`
	FolderName  string   `json:"folderName,omitempty"`
	LastActive  int64    `json:"lastActive"`
	Owner       string   `json:"owner"`
	Received    []bool   `json:"received"`
	ChunkHashes []string `json:"chunkHashes,omitempty"`
}

func getMetaPath(partPath string) string {
	return strings.TrimSuffix(partPath, ".part") + ".meta.json"
}

func getJournalPath(partPath string) string {
	return strings.TrimSuffix(partPath, ".part") + ".meta.journal"
}

func getDownloadMetaPath(id string) string {
	dir := getTempDir()
	sum := sha256.Sum256([]byte(id))
	return filepath.Join(dir, hex.EncodeToString(sum[:16])+".dlmeta.json")
}

func getDownloadJournalPath(id string) string {
	dir := getTempDir()
	sum := sha256.Sum256([]byte(id))
	return filepath.Join(dir, hex.EncodeToString(sum[:16])+".dlmeta.journal")
}

func (s *TransferState) appendChunkJournal(chunkIndex int, cHash string) error {
	if s == nil || s.FilePath == "" {
		return nil
	}
	s.metaMu.Lock()
	defer s.metaMu.Unlock()

	var jPath string
	if s.IsDownload {
		jPath = getDownloadJournalPath(s.ID)
	} else {
		jPath = getJournalPath(s.FilePath)
	}

	var rawHash [16]byte
	if b, err := hex.DecodeString(cHash); err == nil && len(b) == 16 {
		copy(rawHash[:], b)
	}

	var buf [24]byte
	binary.BigEndian.PutUint32(buf[0:4], uint32(chunkIndex))
	copy(buf[4:20], rawHash[:])
	crc := crc32.ChecksumIEEE(buf[0:20])
	binary.BigEndian.PutUint32(buf[20:24], crc)

	f, err := os.OpenFile(jPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		return err
	}
	defer f.Close()

	if _, err := f.Write(buf[:]); err != nil {
		return err
	}
	return f.Sync()
}

func (s *TransferState) saveMeta() error {
	if s == nil || s.FilePath == "" {
		return nil
	}
	s.metaMu.Lock()
	defer s.metaMu.Unlock()

	s.mu.Lock()
	s.generation++
	recCopy := make([]bool, len(s.received))
	copy(recCopy, s.received)
	hashCopy := make([]string, len(s.chunkHashes))
	copy(hashCopy, s.chunkHashes)
	stName := s.State
	if stName == "" {
		stName = "transferring"
	}
	meta := persistedTransferMeta{
		ID:          s.ID,
		Filename:    s.Filename,
		TotalChunks: s.TotalChunks,
		ChunkSize:   s.ChunkSize,
		TotalSize:   s.TotalSize,
		FilePath:    s.FilePath,
		FinalPath:   s.FinalPath,
		State:       stName,
		Generation:  s.generation,
		IsDownload:  s.IsDownload,
		IsFolder:    s.IsFolder,
		FolderName:  s.FolderName,
		LastActive:  time.Now().Unix(),
		Owner:       s.Owner,
		Received:    recCopy,
		ChunkHashes: hashCopy,
	}
	s.mu.Unlock()

	data, err := json.Marshal(&meta)
	if err != nil {
		return fmt.Errorf("marshal metadata: %w", err)
	}

	var metaPath string
	if s.IsDownload {
		metaPath = getDownloadMetaPath(s.ID)
	} else {
		metaPath = getMetaPath(s.FilePath)
	}
	tmpPath := fmt.Sprintf("%s.tmp.%d.%d", metaPath, os.Getpid(), time.Now().UnixNano())
	if err := os.WriteFile(tmpPath, data, 0600); err != nil {
		return fmt.Errorf("write metadata tmp: %w", err)
	}

	if err := os.Rename(tmpPath, metaPath); err != nil {
		_ = os.Remove(tmpPath)
		return fmt.Errorf("rename metadata to %s: %w", metaPath, err)
	}

	// Truncate/remove append-only journal now that full .meta.json checkpoint is safely committed
	var jPath string
	if s.IsDownload {
		jPath = getDownloadJournalPath(s.ID)
	} else {
		jPath = getJournalPath(s.FilePath)
	}
	_ = os.Remove(jPath)

	return nil
}

func (s *TransferState) removeMeta() {
	if s == nil {
		return
	}
	s.metaMu.Lock()
	defer s.metaMu.Unlock()

	var metaPath string
	var jPath string
	if s.IsDownload {
		if s.ID == "" {
			return
		}
		metaPath = getDownloadMetaPath(s.ID)
		jPath = getDownloadJournalPath(s.ID)
	} else {
		if s.FilePath == "" {
			return
		}
		metaPath = getMetaPath(s.FilePath)
		jPath = getJournalPath(s.FilePath)
	}

	_ = os.Remove(metaPath)
	_ = os.Remove(jPath)
	tmps, _ := filepath.Glob(metaPath + ".tmp*")
	for _, tp := range tmps {
		_ = os.Remove(tp)
	}
}

func replayJournal(jPath string, meta *persistedTransferMeta) {
	data, err := os.ReadFile(jPath)
	if err != nil || len(data) < 24 {
		return
	}
	if len(meta.ChunkHashes) != meta.TotalChunks {
		meta.ChunkHashes = make([]string, meta.TotalChunks)
	}
	for offset := 0; offset+24 <= len(data); offset += 24 {
		record := data[offset : offset+24]
		expectedCrc := binary.BigEndian.Uint32(record[20:24])
		actualCrc := crc32.ChecksumIEEE(record[0:20])
		if expectedCrc != actualCrc {
			continue // skip corrupted journal entry
		}
		idx := int(binary.BigEndian.Uint32(record[0:4]))
		if idx >= 0 && idx < meta.TotalChunks {
			meta.Received[idx] = true
			meta.ChunkHashes[idx] = hex.EncodeToString(record[4:20])
		}
	}
}

type metaCandidate struct {
	path    string
	meta    persistedTransferMeta
	count   int
	modTime time.Time
}

func parseMetaCandidate(path string, expectedPartPath string, now int64) (*metaCandidate, error) {
	b, err := os.ReadFile(path)
	if err != nil || len(b) == 0 {
		return nil, fmt.Errorf("read: %w", err)
	}
	var m persistedTransferMeta
	if err := json.Unmarshal(b, &m); err != nil {
		return nil, fmt.Errorf("json unmarshal: %w", err)
	}
	if m.ID == "" || m.TotalChunks <= 0 || m.TotalChunks > maxTransferChunks || m.TotalSize < 0 ||
		m.ChunkSize <= 0 || m.ChunkSize > maxChunkSize {
		return nil, fmt.Errorf("invalid dimensions")
	}
	if len(m.Received) != m.TotalChunks {
		return nil, fmt.Errorf("received length mismatch")
	}
	if m.FilePath != "" && m.FilePath != expectedPartPath {
		return nil, fmt.Errorf("filepath mismatch")
	}
	sum := sha256.Sum256([]byte(m.ID))
	expectedBase := hex.EncodeToString(sum[:16]) + ".part"
	if filepath.Base(expectedPartPath) != expectedBase {
		return nil, fmt.Errorf("transfer ID mismatch with part filename")
	}
	if now-m.LastActive > transferTTL {
		return nil, fmt.Errorf("manifest expired")
	}
	if partFi, err := os.Stat(expectedPartPath); err == nil {
		partSize := partFi.Size()
		for i, ok := range m.Received {
			if ok {
				chunkLen := m.ChunkSize
				if int64(i) == int64(m.TotalChunks-1) && m.TotalSize%m.ChunkSize != 0 {
					chunkLen = m.TotalSize % m.ChunkSize
				}
				if partSize < int64(i)*m.ChunkSize+chunkLen {
					m.Received[i] = false
				}
			}
		}
	}
	cnt := 0
	for _, ok := range m.Received {
		if ok {
			cnt++
		}
	}
	if cnt > m.TotalChunks {
		return nil, fmt.Errorf("count exceeds total chunks")
	}
	fi, _ := os.Stat(path)
	mt := time.Time{}
	if fi != nil {
		mt = fi.ModTime()
	}
	return &metaCandidate{
		path:    path,
		meta:    m,
		count:   cnt,
		modTime: mt,
	}, nil
}

// isBetterMeta implements defensible candidate ranking:
// 1. Monotonically increasing generation number (higher generation strictly wins).
// 2. Monotonic bitmap subsumption (if equal generation, strict superset wins).
// 3. Received chunk count (if equal generation and not a strict superset).
// 4. LastActive / File modification time (most recent wins).
func isBetterMeta(a, b *metaCandidate) bool {
	if a == nil {
		return false
	}
	if b == nil {
		return true
	}
	// 1. Generation sequence
	if a.meta.Generation != b.meta.Generation {
		return a.meta.Generation > b.meta.Generation
	}

	// 2. Monotonic bitmap superset check
	aHasAllB := true
	bHasAllA := true
	minLen := len(a.meta.Received)
	if len(b.meta.Received) < minLen {
		minLen = len(b.meta.Received)
	}
	for i := 0; i < minLen; i++ {
		if b.meta.Received[i] && !a.meta.Received[i] {
			aHasAllB = false
		}
		if a.meta.Received[i] && !b.meta.Received[i] {
			bHasAllA = false
		}
	}
	if aHasAllB && !bHasAllA {
		return true // A strictly subsumes B
	}
	if bHasAllA && !aHasAllB {
		return false // B strictly subsumes A
	}

	// 3. Received count
	if a.count != b.count {
		return a.count > b.count
	}

	// 4. LastActive
	if a.meta.LastActive != b.meta.LastActive {
		return a.meta.LastActive > b.meta.LastActive
	}

	// 5. Modification time
	return a.modTime.After(b.modTime)
}

// recoverOrSweepTempDir reloads valid, non-expired partial uploads that have a
// persisted .meta.json manifest (FR 19, NFR 16) and deletes orphaned/corrupt .part files.
func recoverOrSweepTempDir() int {
	dir := getTempDir()

	now := time.Now().Unix()
	recoveredCount := 0

	partFiles, _ := filepath.Glob(filepath.Join(dir, "*.part"))
	for _, partPath := range partFiles {
		metaPath := getMetaPath(partPath)

		// 1. Collect all candidate manifest paths (primary metaPath + any .tmp* files)
		var candidatePaths []string
		if _, err := os.Stat(metaPath); err == nil {
			candidatePaths = append(candidatePaths, metaPath)
		}
		tmps, _ := filepath.Glob(metaPath + ".tmp*")
		candidatePaths = append(candidatePaths, tmps...)

		// 2. Parse and validate each candidate
		var validCandidates []*metaCandidate
		for _, cp := range candidatePaths {
			if cand, err := parseMetaCandidate(cp, partPath, now); err == nil {
				validCandidates = append(validCandidates, cand)
			}
		}

		// 3. If no valid manifest exists, sweep orphaned .part and any corrupt/invalid metadata files
		if len(validCandidates) == 0 {
			_ = os.Remove(partPath)
			_ = os.Remove(metaPath)
			for _, tp := range tmps {
				_ = os.Remove(tp)
			}
			continue
		}

		// 4. Select the best manifest using defensible multi-attribute ranking
		best := validCandidates[0]
		for i := 1; i < len(validCandidates); i++ {
			if isBetterMeta(validCandidates[i], best) {
				best = validCandidates[i]
			}
		}

		// Merge confirmed chunk receipts and digests from all valid candidates into best manifest.
		// This guarantees monotonic chunk preservation (preventing chunk loss if a newer
		// generation snapshot missed an out-of-order chunk or equal-generation tiebreak occurs).
		if len(best.meta.ChunkHashes) != best.meta.TotalChunks {
			best.meta.ChunkHashes = make([]string, best.meta.TotalChunks)
		}
		for _, cand := range validCandidates {
			for i := 0; i < len(best.meta.Received) && i < len(cand.meta.Received); i++ {
				if cand.meta.Received[i] {
					best.meta.Received[i] = true
					if i < len(cand.meta.ChunkHashes) && cand.meta.ChunkHashes[i] != "" {
						best.meta.ChunkHashes[i] = cand.meta.ChunkHashes[i]
					}
				}
			}
		}

		// Replay append-only write-ahead chunk journal onto candidate metadata
		jPath := getJournalPath(partPath)
		replayJournal(jPath, &best.meta)

		// Adversarial Content Integrity Validation:
		// Verify that physical .part file bytes on disk match the cryptographic chunk hashes.
		// If unwritten sparse blocks, interrupted writes, or corruptions occurred, strip phantom chunks.
		if pf, err := os.Open(partPath); err == nil {
			buf := make([]byte, best.meta.ChunkSize)
			for i := 0; i < best.meta.TotalChunks; i++ {
				if best.meta.Received[i] && i < len(best.meta.ChunkHashes) && best.meta.ChunkHashes[i] != "" {
					wantLen := best.meta.ChunkSize
					if int64(i) == int64(best.meta.TotalChunks-1) && best.meta.TotalSize%best.meta.ChunkSize != 0 {
						wantLen = best.meta.TotalSize % best.meta.ChunkSize
					}
					n, rerr := pf.ReadAt(buf[:wantLen], int64(i)*best.meta.ChunkSize)
					if rerr != nil || int64(n) != wantLen {
						best.meta.Received[i] = false
						continue
					}
					sum := sha256.Sum256(buf[:wantLen])
					actualHash := hex.EncodeToString(sum[:16])
					if actualHash != best.meta.ChunkHashes[i] {
						best.meta.Received[i] = false
					}
				}
			}
			pf.Close()
		}

		best.count = 0
		for _, ok := range best.meta.Received {
			if ok {
				best.count++
			}
		}

		// 5. Save/promote best merged candidate to metaPath atomically
		mergedData, err := json.Marshal(&best.meta)
		if err == nil {
			tmpPromote := fmt.Sprintf("%s.tmp.%d.%d", metaPath, os.Getpid(), time.Now().UnixNano())
			if err := os.WriteFile(tmpPromote, mergedData, 0600); err == nil {
				_ = os.Rename(tmpPromote, metaPath)
			}
		} else if best.path != metaPath {
			_ = os.Rename(best.path, metaPath)
		}

		// Clean up all other temporary files for this transfer so they don't linger
		_ = os.Remove(jPath)
		for _, cand := range validCandidates {
			if cand.path != metaPath && cand.path != best.path {
				_ = os.Remove(cand.path)
			}
		}
		for _, tp := range tmps {
			if tp != metaPath && tp != best.path {
				_ = os.Remove(tp)
			}
		}

		meta := best.meta

		// 6. Handle Crash-Safe Finalization Recovery Transitions
		if meta.State == "finalizing" && meta.FinalPath != "" {
			// Case A: The file was already moved to destination before crash
			if fi, err := os.Stat(meta.FinalPath); err == nil && fi.Size() == meta.TotalSize {
				_ = os.Remove(partPath)
				_ = os.Remove(metaPath)
				recordTransfer(TransferRecord{
					ID:        meta.ID,
					Filename:  filepath.Base(meta.FinalPath),
					Size:      meta.TotalSize,
					Direction: "Received",
					Status:    "Completed",
				})
				continue
			}

			// Case B: Crash occurred before or during move; finish moving .part to FinalPath
			if _, err := os.Stat(partPath); err == nil {
				if err := moveToFinalPath(partPath, meta.FinalPath); err == nil {
					_ = os.Remove(metaPath)
					recordTransfer(TransferRecord{
						ID:        meta.ID,
						Filename:  filepath.Base(meta.FinalPath),
						Size:      meta.TotalSize,
						Direction: "Received",
						Status:    "Completed",
					})
					continue
				}
			}
		}

		// 7. Normal active transfer state recovery
		f, err := os.OpenFile(partPath, os.O_RDWR, 0644)
		if err != nil {
			_ = os.Remove(partPath)
			_ = os.Remove(metaPath)
			continue
		}

		st := &TransferState{
			ID:            meta.ID,
			Filename:      meta.Filename,
			TotalChunks:   meta.TotalChunks,
			ChunkSize:     meta.ChunkSize,
			TotalSize:     meta.TotalSize,
			File:          f,
			FilePath:      partPath,
			FinalPath:     meta.FinalPath,
			State:         meta.State,
			generation:    meta.Generation,
			IsDownload:    false,
			IsFolder:      meta.IsFolder,
			FolderName:    meta.FolderName,
			LastActive:    meta.LastActive,
			Owner:         meta.Owner,
			received:      meta.Received,
			chunkHashes:   meta.ChunkHashes,
			receivedCount: best.count,
		}

		transfersMu.Lock()
		transfers[st.ID] = st
		transfersMu.Unlock()
		recoveredCount++
	}

	// Also clean up any orphaned .meta.json or .meta.json.tmp* files that have no matching .part file
	metaFiles, _ := filepath.Glob(filepath.Join(dir, "*.meta.json*"))
	for _, mp := range metaFiles {
		idx := strings.Index(mp, ".meta.json")
		if idx > 0 {
			basePart := mp[:idx] + ".part"
			if _, err := os.Stat(basePart); os.IsNotExist(err) {
				// Check if this orphaned metadata was finalizing a completed file
				b, err := os.ReadFile(mp)
				if err == nil {
					var m persistedTransferMeta
					if json.Unmarshal(b, &m) == nil && m.State == "finalizing" && m.FinalPath != "" {
						if fi, err := os.Stat(m.FinalPath); err == nil && fi.Size() == m.TotalSize {
							recordTransfer(TransferRecord{
								ID:        m.ID,
								Filename:  filepath.Base(m.FinalPath),
								Size:      m.TotalSize,
								Direction: "Received",
								Status:    "Completed",
							})
						}
					}
				}
				_ = os.Remove(mp)
			}
		}
	}

	// Also clean up any orphaned .meta.journal files that have no matching .part file
	jFiles, _ := filepath.Glob(filepath.Join(dir, "*.meta.journal*"))
	for _, jp := range jFiles {
		idx := strings.Index(jp, ".meta.journal")
		if idx > 0 {
			basePart := jp[:idx] + ".part"
			if _, err := os.Stat(basePart); os.IsNotExist(err) {
				_ = os.Remove(jp)
			}
		}
	}

	// Recover active download transfers (PC sending to mobile)
	dlMetaFiles, _ := filepath.Glob(filepath.Join(dir, "*.dlmeta.json"))
	for _, dmp := range dlMetaFiles {
		data, err := os.ReadFile(dmp)
		if err != nil {
			_ = os.Remove(dmp)
			continue
		}
		var meta persistedTransferMeta
		if err := json.Unmarshal(data, &meta); err != nil {
			_ = os.Remove(dmp)
			continue
		}
		// Sweep if older than 24h
		if meta.LastActive > 0 && (now-meta.LastActive) > transferTTL {
			_ = os.Remove(dmp)
			if isGeneratedTempFile(meta.FilePath) {
				_ = os.Remove(meta.FilePath)
			}
			continue
		}
		// Check that the source file still exists and matches expected size
		fi, err := os.Stat(meta.FilePath)
		if err != nil || fi.IsDir() || fi.Size() != meta.TotalSize {
			_ = os.Remove(dmp)
			continue
		}

		st := restoreDownload(meta, meta.LastActive)

		transfersMu.Lock()
		transfers[st.ID] = st
		transfersMu.Unlock()
		recoveredCount++
	}

	// Clean up any stale *.dlmeta.json.tmp* files older than 10 minutes
	tmpDlFiles, _ := filepath.Glob(filepath.Join(dir, "*.dlmeta.json.tmp*"))
	for _, tmpP := range tmpDlFiles {
		if fi, err := os.Stat(tmpP); err == nil && now-fi.ModTime().Unix() > 600 {
			_ = os.Remove(tmpP)
		}
	}

	sweepGeneratedTempFiles(now)
	return recoveredCount
}
