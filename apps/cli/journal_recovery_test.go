package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestJournalCrashDurability(t *testing.T) {
	tmpDir := t.TempDir()
	prevBase, prevTemp, prevRecv := baseDir, tempDir, receiveDir
	baseDir = tmpDir
	tempDir = filepath.Join(tmpDir, "temp")
	receiveDir = filepath.Join(tmpDir, "received")
	initDirs()
	defer func() { baseDir, tempDir, receiveDir = prevBase, prevTemp, prevRecv }()

	tid := "tx-journal-crash-test"
	totalChunks := 10
	chunkSize := int64(64 * 1024)
	totalSize := int64(totalChunks) * chunkSize

	sum := sha256.Sum256([]byte(tid))
	partPath := filepath.Join(tempDir, hex.EncodeToString(sum[:16])+".part")
	metaPath := getMetaPath(partPath)

	partFile, err := os.OpenFile(partPath, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		t.Fatalf("create part file: %v", err)
	}
	_ = partFile.Truncate(totalSize)

	// Step 1: Initial state checkpoint with only chunk 0 and chunk 1 confirmed
	chunkBytes := make([][]byte, totalChunks)
	chunkHashes := make([]string, totalChunks)
	for i := 0; i < totalChunks; i++ {
		b := make([]byte, chunkSize)
		for j := range b {
			b[j] = byte((i*31 + j) % 251)
		}
		chunkBytes[i] = b
		s := sha256.Sum256(b)
		chunkHashes[i] = hex.EncodeToString(s[:16])
	}

	// Write chunk 0 and 1 into partFile
	_, _ = partFile.WriteAt(chunkBytes[0], 0)
	_, _ = partFile.WriteAt(chunkBytes[1], chunkSize)

	initialMeta := persistedTransferMeta{
		ID:          tid,
		Filename:    "journal_test.bin",
		TotalChunks: totalChunks,
		ChunkSize:   chunkSize,
		TotalSize:   totalSize,
		FilePath:    partPath,
		State:       "transferring",
		Generation:  1,
		LastActive:  time.Now().Unix(),
		Received:    make([]bool, totalChunks),
		ChunkHashes: make([]string, totalChunks),
	}
	initialMeta.Received[0] = true
	initialMeta.Received[1] = true
	initialMeta.ChunkHashes[0] = chunkHashes[0]
	initialMeta.ChunkHashes[1] = chunkHashes[1]

	metaBytes, _ := json.Marshal(&initialMeta)
	if err := os.WriteFile(metaPath, metaBytes, 0600); err != nil {
		t.Fatalf("write initial meta: %v", err)
	}

	// Step 2: Simulate streaming transfer writing chunks 2, 3, 4, 5
	// Chunks are written to partFile and receipts appended to .meta.journal.
	// Process crashes BEFORE saveMeta() is called, so .meta.json remains at Generation 1 (chunks 0 and 1 only).
	st := &TransferState{
		ID:          tid,
		Filename:    "journal_test.bin",
		TotalChunks: totalChunks,
		ChunkSize:   chunkSize,
		TotalSize:   totalSize,
		FilePath:    partPath,
		State:       "transferring",
		generation:  1,
		received:    make([]bool, totalChunks),
		chunkHashes: make([]string, totalChunks),
		File:        partFile,
	}
	st.received[0] = true
	st.received[1] = true
	st.chunkHashes[0] = chunkHashes[0]
	st.chunkHashes[1] = chunkHashes[1]

	for i := 2; i <= 5; i++ {
		_, err := partFile.WriteAt(chunkBytes[i], int64(i)*chunkSize)
		if err != nil {
			t.Fatalf("write chunk %d: %v", i, err)
		}
		if err := st.appendChunkJournal(i, chunkHashes[i]); err != nil {
			t.Fatalf("append chunk journal %d: %v", i, err)
		}
	}
	partFile.Close()

	// Step 3: Simulate power cut leaving corrupted trailing bytes at the end of the journal
	jPath := getJournalPath(partPath)
	jf, err := os.OpenFile(jPath, os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		t.Fatalf("open journal for corrupt append: %v", err)
	}
	_, _ = jf.Write([]byte{0xDE, 0xAD, 0xBE, 0xEF, 0x01, 0x02, 0x03, 0x04}) // partial 8-byte garbage
	jf.Close()

	// Step 4: Simulate sudden crash and reboot
	transfersMu.Lock()
	transfers = make(map[string]*TransferState)
	transfersMu.Unlock()

	// Run recovery
	recovered := recoverOrSweepTempDir()
	if recovered != 1 {
		t.Fatalf("expected 1 recovered transfer, got %d", recovered)
	}

	transfersMu.Lock()
	recSt, ok := transfers[tid]
	transfersMu.Unlock()
	if !ok {
		t.Fatalf("expected transfer %s to be recovered in active transfers map", tid)
	}

	// Verify all chunks 0 through 5 are recovered
	for i := 0; i <= 5; i++ {
		if !recSt.received[i] {
			t.Errorf("expected chunk %d to be marked received after journal replay, got false", i)
		}
		if recSt.chunkHashes[i] != chunkHashes[i] {
			t.Errorf("chunk %d hash mismatch: want %s, got %s", i, chunkHashes[i], recSt.chunkHashes[i])
		}
	}
	for i := 6; i < totalChunks; i++ {
		if recSt.received[i] {
			t.Errorf("expected chunk %d to NOT be received, got true", i)
		}
	}

	if recSt.receivedCount != 6 {
		t.Errorf("expected receivedCount 6, got %d", recSt.receivedCount)
	}

	// Verify the promoted .meta.json now reflects all 6 chunks
	promotedBytes, err := os.ReadFile(metaPath)
	if err != nil {
		t.Fatalf("read promoted meta: %v", err)
	}
	var promotedMeta persistedTransferMeta
	if err := json.Unmarshal(promotedBytes, &promotedMeta); err != nil {
		t.Fatalf("unmarshal promoted meta: %v", err)
	}
	if !promotedMeta.Received[5] {
		t.Errorf("expected promoted meta to have chunk 5 marked true")
	}

	// Verify the journal was cleaned up after recovery promotion
	if _, err := os.Stat(jPath); !os.IsNotExist(err) {
		t.Errorf("expected journal file %s to be removed after recovery promotion", jPath)
	}

	if recSt.File != nil {
		_ = recSt.File.Close()
	}
}

// Test scenario: Journal contains out-of-bounds chunk indices and conflicting entries for the same chunk.
// System must safely ignore out-of-bounds indices, accept the latest valid hash, and never panic.
func TestJournalRecovery_OutOfBoundsAndConflictingEntries(t *testing.T) {
	tmpDir := t.TempDir()
	prevBase, prevTemp, prevRecv := baseDir, tempDir, receiveDir
	baseDir = tmpDir
	tempDir = filepath.Join(tmpDir, "temp")
	receiveDir = filepath.Join(tmpDir, "received")
	initDirs()
	defer func() { baseDir, tempDir, receiveDir = prevBase, prevTemp, prevRecv }()

	tid := "tx-journal-oob-test"
	totalChunks := 5
	chunkSize := int64(32 * 1024)
	totalSize := int64(totalChunks) * chunkSize

	sum := sha256.Sum256([]byte(tid))
	partPath := filepath.Join(tempDir, hex.EncodeToString(sum[:16])+".part")
	metaPath := getMetaPath(partPath)

	partFile, err := os.OpenFile(partPath, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		t.Fatalf("create part file: %v", err)
	}
	_ = partFile.Truncate(totalSize)

	// Chunk data
	chunk2Bytes := make([]byte, chunkSize)
	for i := range chunk2Bytes {
		chunk2Bytes[i] = 0xAA
	}
	sum2 := sha256.Sum256(chunk2Bytes)
	hash2 := hex.EncodeToString(sum2[:16])
	_, _ = partFile.WriteAt(chunk2Bytes, 2*chunkSize)
	partFile.Close()

	// Initial meta: zero chunks received
	initialMeta := persistedTransferMeta{
		ID:          tid,
		Filename:    "oob_test.bin",
		TotalChunks: totalChunks,
		ChunkSize:   chunkSize,
		TotalSize:   totalSize,
		FilePath:    partPath,
		State:       "transferring",
		Generation:  1,
		LastActive:  time.Now().Unix(),
		Received:    make([]bool, totalChunks),
		ChunkHashes: make([]string, totalChunks),
	}
	b, _ := json.Marshal(&initialMeta)
	_ = os.WriteFile(metaPath, b, 0600)

	st := &TransferState{
		ID:          tid,
		FilePath:    partPath,
		TotalChunks: totalChunks,
		ChunkSize:   chunkSize,
		TotalSize:   totalSize,
	}

	// 1. Append valid entry for chunk 2
	_ = st.appendChunkJournal(2, hash2)

	// 2. Append out-of-bounds entry (index 9999 for a 5-chunk file)
	_ = st.appendChunkJournal(9999, "0123456789abcdef0123456789abcdef")

	// 3. Append conflicting entry for chunk 2 with different hash
	_ = st.appendChunkJournal(2, "ffffffffffffffffffffffffffffffff")

	// 4. Append the true hash for chunk 2 again
	_ = st.appendChunkJournal(2, hash2)

	// Run recovery
	transfersMu.Lock()
	transfers = make(map[string]*TransferState)
	transfersMu.Unlock()

	recovered := recoverOrSweepTempDir()
	if recovered != 1 {
		t.Fatalf("expected 1 recovered transfer, got %d", recovered)
	}

	transfersMu.Lock()
	recSt := transfers[tid]
	transfersMu.Unlock()
	if recSt == nil {
		t.Fatalf("expected recovered state for %s", tid)
	}
	defer func() {
		if recSt.File != nil {
			_ = recSt.File.Close()
		}
	}()

	// Chunk 2 must be confirmed because the physical bytes match hash2
	if !recSt.received[2] {
		t.Errorf("expected chunk 2 to be received")
	}
	if recSt.chunkHashes[2] != hash2 {
		t.Errorf("expected chunk 2 hash %s, got %s", hash2, recSt.chunkHashes[2])
	}
	if len(recSt.received) != totalChunks {
		t.Errorf("expected received slice length %d, got %d", totalChunks, len(recSt.received))
	}
}

// Test scenario: Journal records a chunk receipt, but the physical bytes on disk in .part
// are zeroes or corrupted (e.g. page cache lost or disk error).
// Recovery MUST NOT trust the journal blindly; it must reject the phantom chunk!
func TestJournalRecovery_PhysicalPartMismatchRejectsJournal(t *testing.T) {
	tmpDir := t.TempDir()
	prevBase, prevTemp, prevRecv := baseDir, tempDir, receiveDir
	baseDir = tmpDir
	tempDir = filepath.Join(tmpDir, "temp")
	receiveDir = filepath.Join(tmpDir, "received")
	initDirs()
	defer func() { baseDir, tempDir, receiveDir = prevBase, prevTemp, prevRecv }()

	tid := "tx-journal-mismatch-test"
	totalChunks := 4
	chunkSize := int64(32 * 1024)
	totalSize := int64(totalChunks) * chunkSize

	sum := sha256.Sum256([]byte(tid))
	partPath := filepath.Join(tempDir, hex.EncodeToString(sum[:16])+".part")
	metaPath := getMetaPath(partPath)

	// Create .part file with all zeroes
	partFile, err := os.OpenFile(partPath, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		t.Fatalf("create part file: %v", err)
	}
	_ = partFile.Truncate(totalSize)
	partFile.Close()

	// Initial meta: 0 chunks received
	initialMeta := persistedTransferMeta{
		ID:          tid,
		Filename:    "mismatch.bin",
		TotalChunks: totalChunks,
		ChunkSize:   chunkSize,
		TotalSize:   totalSize,
		FilePath:    partPath,
		State:       "transferring",
		Generation:  1,
		LastActive:  time.Now().Unix(),
		Received:    make([]bool, totalChunks),
		ChunkHashes: make([]string, totalChunks),
	}
	b, _ := json.Marshal(&initialMeta)
	_ = os.WriteFile(metaPath, b, 0600)

	st := &TransferState{
		ID:          tid,
		FilePath:    partPath,
		TotalChunks: totalChunks,
		ChunkSize:   chunkSize,
		TotalSize:   totalSize,
	}

	// Journal claims chunk 1 was received with hash "11112222333344445555666677778888"
	_ = st.appendChunkJournal(1, "11112222333344445555666677778888")

	// Run recovery
	transfersMu.Lock()
	transfers = make(map[string]*TransferState)
	transfersMu.Unlock()

	recovered := recoverOrSweepTempDir()
	if recovered != 1 {
		t.Fatalf("expected 1 recovered transfer, got %d", recovered)
	}

	transfersMu.Lock()
	recSt := transfers[tid]
	transfersMu.Unlock()
	if recSt == nil {
		t.Fatalf("expected recovered state for %s", tid)
	}
	defer func() {
		if recSt.File != nil {
			_ = recSt.File.Close()
		}
	}()

	// Chunk 1 MUST be rejected because actual bytes on disk are zeroes, not matching the journal hash!
	if recSt.received[1] {
		t.Errorf("CRITICAL DEFECT: recovery accepted phantom chunk whose physical bytes did not match journal hash!")
	}
	if recSt.receivedCount != 0 {
		t.Errorf("expected receivedCount 0, got %d", recSt.receivedCount)
	}
}

// Workstream 2 Durability Test 1:
// Acknowledged chunk lost before physical checkpoint is safely detected and re-requested.
func TestDurability_AcknowledgedChunkSafelyReRequestedWhenLost(t *testing.T) {
	tmpDir := t.TempDir()
	prevBase, prevTemp, prevRecv := baseDir, tempDir, receiveDir
	baseDir = tmpDir
	tempDir = filepath.Join(tmpDir, "temp")
	receiveDir = filepath.Join(tmpDir, "received")
	initDirs()
	defer func() { baseDir, tempDir, receiveDir = prevBase, prevTemp, prevRecv }()

	tid := "tx-durability-rerequest"
	totalChunks := 3
	chunkSize := int64(16 * 1024)
	totalSize := int64(totalChunks) * chunkSize

	sum := sha256.Sum256([]byte(tid))
	partPath := filepath.Join(tempDir, hex.EncodeToString(sum[:16])+".part")
	metaPath := getMetaPath(partPath)

	partFile, err := os.OpenFile(partPath, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		t.Fatalf("create part file: %v", err)
	}
	_ = partFile.Truncate(totalSize)

	// Chunk 0 is valid and durable
	chunk0 := make([]byte, chunkSize)
	for i := range chunk0 {
		chunk0[i] = 0x11
	}
	sum0 := sha256.Sum256(chunk0)
	hash0 := hex.EncodeToString(sum0[:16])
	_, _ = partFile.WriteAt(chunk0, 0)

	// Chunk 1 was acknowledged by server and written to journal,
	// but before disk checkpoint, power dropped and sector was not persisted (zeroes)
	chunk1Hash := hex.EncodeToString([]byte("0123456789abcdef")) // expected hash
	// do NOT write chunk1 data to partFile (remains zeroes)

	partFile.Close()

	// Initial metadata checkpoint (generation 1)
	initialMeta := persistedTransferMeta{
		ID:          tid,
		Filename:    "rerequest.bin",
		TotalChunks: totalChunks,
		ChunkSize:   chunkSize,
		TotalSize:   totalSize,
		FilePath:    partPath,
		State:       "transferring",
		Generation:  1,
		LastActive:  time.Now().Unix(),
		Received:    make([]bool, totalChunks),
		ChunkHashes: make([]string, totalChunks),
	}
	initialMeta.Received[0] = true
	initialMeta.ChunkHashes[0] = hash0

	metaBytes, _ := json.Marshal(&initialMeta)
	_ = os.WriteFile(metaPath, metaBytes, 0600)

	// Journal record for chunk 1 was appended
	st := &TransferState{
		ID:          tid,
		FilePath:    partPath,
		TotalChunks: totalChunks,
		ChunkSize:   chunkSize,
		TotalSize:   totalSize,
	}
	_ = st.appendChunkJournal(1, chunk1Hash)

	// Recovery runs after reboot
	transfersMu.Lock()
	transfers = make(map[string]*TransferState)
	transfersMu.Unlock()

	recoverOrSweepTempDir()

	transfersMu.Lock()
	recSt := transfers[tid]
	transfersMu.Unlock()
	if recSt == nil {
		t.Fatalf("expected transfer %s to be recovered", tid)
	}
	defer func() {
		if recSt.File != nil {
			_ = recSt.File.Close()
		}
	}()

	// Chunk 0 must be durable
	if !recSt.received[0] {
		t.Errorf("chunk 0 should be marked received")
	}
	// Chunk 1 failed verification and must NOT be marked received
	if recSt.received[1] {
		t.Errorf("chunk 1 must NOT be marked received because data was lost prior to checkpoint")
	}

	// Client re-requests state via upload_init / chunk check:
	// Verify that recSt informs the client chunk 1 is missing so client re-transmits it
	if recSt.received[1] != false {
		t.Errorf("expected missing chunk 1 to be safely re-requestable (received=false)")
	}
}

// Workstream 2 Durability Test 2:
// Checkpointed chunk data and metadata are synchronized and survive restart.
func TestDurability_CheckpointedChunkDurableAndValidated(t *testing.T) {
	tmpDir := t.TempDir()
	prevBase, prevTemp, prevRecv := baseDir, tempDir, receiveDir
	baseDir = tmpDir
	tempDir = filepath.Join(tmpDir, "temp")
	receiveDir = filepath.Join(tmpDir, "received")
	initDirs()
	defer func() { baseDir, tempDir, receiveDir = prevBase, prevTemp, prevRecv }()

	tid := "tx-durability-checkpointed"
	totalChunks := 4
	chunkSize := int64(16 * 1024)
	totalSize := int64(totalChunks) * chunkSize

	sum := sha256.Sum256([]byte(tid))
	partPath := filepath.Join(tempDir, hex.EncodeToString(sum[:16])+".part")
	metaPath := getMetaPath(partPath)

	partFile, err := os.OpenFile(partPath, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		t.Fatalf("create part file: %v", err)
	}
	_ = partFile.Truncate(totalSize)

	chunkData := make([]byte, chunkSize)
	for i := range chunkData {
		chunkData[i] = 0x42
	}
	s := sha256.Sum256(chunkData)
	h := hex.EncodeToString(s[:16])

	// Chunks 0, 1, 2 written and synced (checkpointed)
	for i := 0; i < 3; i++ {
		_, _ = partFile.WriteAt(chunkData, int64(i)*chunkSize)
	}
	_ = partFile.Sync()
	partFile.Close()

	// Checkpoint saved to meta.json with generation 2
	meta := persistedTransferMeta{
		ID:          tid,
		Filename:    "checkpointed.bin",
		TotalChunks: totalChunks,
		ChunkSize:   chunkSize,
		TotalSize:   totalSize,
		FilePath:    partPath,
		State:       "transferring",
		Generation:  2,
		LastActive:  time.Now().Unix(),
		Received:    []bool{true, true, true, false},
		ChunkHashes: []string{h, h, h, ""},
	}
	b, _ := json.Marshal(&meta)
	_ = os.WriteFile(metaPath, b, 0600)

	// Reboot and recover
	transfersMu.Lock()
	transfers = make(map[string]*TransferState)
	transfersMu.Unlock()

	recoverOrSweepTempDir()

	transfersMu.Lock()
	recSt := transfers[tid]
	transfersMu.Unlock()
	if recSt == nil {
		t.Fatalf("expected state recovered")
	}
	defer func() {
		if recSt.File != nil {
			_ = recSt.File.Close()
		}
	}()

	for i := 0; i < 3; i++ {
		if !recSt.received[i] {
			t.Errorf("checkpointed chunk %d should be received", i)
		}
		if recSt.chunkHashes[i] != h {
			t.Errorf("chunk %d hash mismatch", i)
		}
	}
	if recSt.received[3] {
		t.Errorf("uncheckpointed chunk 3 should not be received")
	}
}

// Workstream 2 Durability Test 3:
// Incomplete finalization never reported as successful in history or received directory.
func TestDurability_IncompleteFinalizationNeverReportedSuccessful(t *testing.T) {
	tmpDir := t.TempDir()
	prevBase, prevTemp, prevRecv := baseDir, tempDir, receiveDir
	baseDir = tmpDir
	tempDir = filepath.Join(tmpDir, "temp")
	receiveDir = filepath.Join(tmpDir, "received")
	initDirs()
	defer func() { baseDir, tempDir, receiveDir = prevBase, prevTemp, prevRecv }()

	tid := "tx-durability-incomplete-fin"
	totalChunks := 2
	chunkSize := int64(8 * 1024)
	totalSize := int64(totalChunks) * chunkSize
	finalFilename := "final_test.bin"
	finalDest := filepath.Join(receiveDir, finalFilename)

	sum := sha256.Sum256([]byte(tid))
	partPath := filepath.Join(tempDir, hex.EncodeToString(sum[:16])+".part")
	metaPath := getMetaPath(partPath)

	partFile, err := os.OpenFile(partPath, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		t.Fatalf("create part file: %v", err)
	}
	_ = partFile.Truncate(totalSize)

	chunk0 := make([]byte, chunkSize)
	chunk1 := make([]byte, chunkSize)
	s0 := sha256.Sum256(chunk0)
	s1 := sha256.Sum256(chunk1)
	_, _ = partFile.WriteAt(chunk0, 0)
	_, _ = partFile.WriteAt(chunk1, chunkSize)
	_ = partFile.Sync()
	partFile.Close()

	// Metadata says all chunks received, but State is still "transferring"
	// (Crash happened right before rename / history recording)
	meta := persistedTransferMeta{
		ID:          tid,
		Filename:    finalFilename,
		TotalChunks: totalChunks,
		ChunkSize:   chunkSize,
		TotalSize:   totalSize,
		FilePath:    partPath,
		State:       "transferring",
		Generation:  2,
		LastActive:  time.Now().Unix(),
		Received:    []bool{true, true},
		ChunkHashes: []string{hex.EncodeToString(s0[:16]), hex.EncodeToString(s1[:16])},
	}
	b, _ := json.Marshal(&meta)
	_ = os.WriteFile(metaPath, b, 0600)

	// History file does NOT contain the transfer
	loadHistory()
	historyMu.Lock()
	for _, entry := range history {
		if entry.ID == tid {
			historyMu.Unlock()
			t.Fatalf("precondition failed: transfer already in history")
		}
	}
	historyMu.Unlock()

	// Reboot and recover
	transfersMu.Lock()
	transfers = make(map[string]*TransferState)
	transfersMu.Unlock()

	recoverOrSweepTempDir()

	// 1. Destination file in receivedDir must NOT exist yet
	if _, err := os.Stat(finalDest); !os.IsNotExist(err) {
		t.Errorf("destination file %s should not exist prior to completed atomic finalization", finalDest)
	}

	// 2. History must still NOT have this transfer recorded as completed
	loadHistory()
	historyMu.Lock()
	for _, entry := range history {
		if entry.ID == tid && entry.Status == "Completed" {
			t.Errorf("transfer %s must NOT be in history as completed", tid)
		}
	}
	historyMu.Unlock()

	// 3. State in transfers map must be resumed as transferring, ready for finalize or additional verification
	transfersMu.Lock()
	recSt := transfers[tid]
	transfersMu.Unlock()
	if recSt == nil {
		t.Fatalf("expected state to be recovered in active transfers")
	}
	if recSt.File != nil {
		_ = recSt.File.Close()
	}
	if recSt.State != "transferring" {
		t.Errorf("state should still be transferring, got %s", recSt.State)
	}
}
