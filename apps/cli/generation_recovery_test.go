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

// Helper to create a dummy valid .part file with at least requiredSize
func createDummyPartFile(t *testing.T, dir, tid string, size int64) string {
	sum := sha256.Sum256([]byte(tid))
	partPath := filepath.Join(dir, hex.EncodeToString(sum[:16])+".part")
	f, err := os.Create(partPath)
	if err != nil {
		t.Fatalf("create part file: %v", err)
	}
	if size > 0 {
		_ = f.Truncate(size)
	}
	f.Close()
	return partPath
}

// Test A: Generation 50 contains chunks 0..9 (10 chunks); Generation 51 contains chunks 0..8 and 10 (10 chunks).
// Chunk 9 was acknowledged in Gen 50; Gen 51 must not silently drop chunk 9!
func TestGenerationRecovery_ScenarioA_NonSupersetNewerGeneration(t *testing.T) {
	tmpDir := t.TempDir()
	prevBase, prevTemp, prevRecv := baseDir, tempDir, receiveDir
	baseDir = tmpDir
	tempDir = filepath.Join(tmpDir, "temp")
	receiveDir = filepath.Join(tmpDir, "received")
	initDirs()
	defer func() { baseDir, tempDir, receiveDir = prevBase, prevTemp, prevRecv }()

	tid := "tx-gen-test-A"
	totalChunks := 20
	chunkSize := int64(1024 * 1024)
	partPath := createDummyPartFile(t, tempDir, tid, int64(totalChunks)*chunkSize)
	metaPath := getMetaPath(partPath)

	// Gen 50: chunks 0..9
	rec50 := make([]bool, totalChunks)
	for i := 0; i < 10; i++ {
		rec50[i] = true
	}
	m50 := persistedTransferMeta{
		ID:          tid,
		Filename:    "testA.bin",
		TotalChunks: totalChunks,
		ChunkSize:   chunkSize,
		TotalSize:   int64(totalChunks) * chunkSize,
		FilePath:    partPath,
		State:       "transferring",
		Generation:  50,
		LastActive:  time.Now().Unix() - 10,
		Owner:       "dev-test",
		Received:    rec50,
	}
	b50, _ := json.Marshal(m50)
	os.WriteFile(metaPath+".tmp.gen50", b50, 0600)

	// Gen 51: chunks 0..8 and 10 (missing chunk 9!)
	rec51 := make([]bool, totalChunks)
	for i := 0; i < 9; i++ {
		rec51[i] = true
	}
	rec51[10] = true
	m51 := persistedTransferMeta{
		ID:          tid,
		Filename:    "testA.bin",
		TotalChunks: totalChunks,
		ChunkSize:   chunkSize,
		TotalSize:   int64(totalChunks) * chunkSize,
		FilePath:    partPath,
		State:       "transferring",
		Generation:  51,
		LastActive:  time.Now().Unix(),
		Owner:       "dev-test",
		Received:    rec51,
	}
	b51, _ := json.Marshal(m51)
	os.WriteFile(metaPath, b51, 0600) // primary is Gen 51

	cleanTempDir()

	st := lookupTransfer(tid)
	if st == nil {
		t.Fatalf("expected transfer %s to be recovered", tid)
	}
	defer st.discard()

	// Verify that chunk 9 (from Gen 50) AND chunk 10 (from Gen 51) are both preserved!
	if !st.received[9] {
		t.Errorf("DEFECT IDENTIFIED: Chunk 9 from Generation 50 was silently lost by Generation 51!")
	}
	if !st.received[10] {
		t.Errorf("Chunk 10 from Generation 51 was lost!")
	}
}

// Test B: Generation 50 contains chunks 0..9; Generation 51 contains chunks 0..10.
// Generation 51 is a strict superset.
func TestGenerationRecovery_ScenarioB_StrictSupersetGeneration(t *testing.T) {
	tmpDir := t.TempDir()
	prevBase, prevTemp, prevRecv := baseDir, tempDir, receiveDir
	baseDir = tmpDir
	tempDir = filepath.Join(tmpDir, "temp")
	receiveDir = filepath.Join(tmpDir, "received")
	initDirs()
	defer func() { baseDir, tempDir, receiveDir = prevBase, prevTemp, prevRecv }()

	tid := "tx-gen-test-B"
	totalChunks := 20
	chunkSize := int64(1024 * 1024)
	partPath := createDummyPartFile(t, tempDir, tid, int64(totalChunks)*chunkSize)
	metaPath := getMetaPath(partPath)

	rec50 := make([]bool, totalChunks)
	for i := 0; i < 10; i++ {
		rec50[i] = true
	}
	m50 := persistedTransferMeta{
		ID:          tid,
		Filename:    "testB.bin",
		TotalChunks: totalChunks,
		ChunkSize:   chunkSize,
		TotalSize:   int64(totalChunks) * chunkSize,
		FilePath:    partPath,
		State:       "transferring",
		Generation:  50,
		LastActive:  time.Now().Unix() - 10,
		Owner:       "dev-test",
		Received:    rec50,
	}
	b50, _ := json.Marshal(m50)
	os.WriteFile(metaPath+".tmp.gen50", b50, 0600)

	rec51 := make([]bool, totalChunks)
	for i := 0; i < 11; i++ {
		rec51[i] = true
	}
	m51 := persistedTransferMeta{
		ID:          tid,
		Filename:    "testB.bin",
		TotalChunks: totalChunks,
		ChunkSize:   chunkSize,
		TotalSize:   int64(totalChunks) * chunkSize,
		FilePath:    partPath,
		State:       "transferring",
		Generation:  51,
		LastActive:  time.Now().Unix(),
		Owner:       "dev-test",
		Received:    rec51,
	}
	b51, _ := json.Marshal(m51)
	os.WriteFile(metaPath, b51, 0600)

	cleanTempDir()

	st := lookupTransfer(tid)
	if st == nil {
		t.Fatalf("expected transfer %s to be recovered", tid)
	}
	defer st.discard()

	for i := 0; i < 11; i++ {
		if !st.received[i] {
			t.Errorf("expected chunk %d to be recovered", i)
		}
	}
	if st.receivedCount != 11 {
		t.Errorf("expected receivedCount 11, got %d", st.receivedCount)
	}
}

// Test C: Two manifests have the same generation but different bitmaps.
func TestGenerationRecovery_ScenarioC_EqualGenerationIncomparableBitmaps(t *testing.T) {
	tmpDir := t.TempDir()
	prevBase, prevTemp, prevRecv := baseDir, tempDir, receiveDir
	baseDir = tmpDir
	tempDir = filepath.Join(tmpDir, "temp")
	receiveDir = filepath.Join(tmpDir, "received")
	initDirs()
	defer func() { baseDir, tempDir, receiveDir = prevBase, prevTemp, prevRecv }()

	tid := "tx-gen-test-C"
	totalChunks := 20
	chunkSize := int64(1024 * 1024)
	partPath := createDummyPartFile(t, tempDir, tid, int64(totalChunks)*chunkSize)
	metaPath := getMetaPath(partPath)

	// Manifest A: Gen 50, chunks 0, 1, 2
	recA := make([]bool, totalChunks)
	recA[0], recA[1], recA[2] = true, true, true
	mA := persistedTransferMeta{
		ID:          tid,
		Filename:    "testC.bin",
		TotalChunks: totalChunks,
		ChunkSize:   chunkSize,
		TotalSize:   int64(totalChunks) * chunkSize,
		FilePath:    partPath,
		State:       "transferring",
		Generation:  50,
		LastActive:  time.Now().Unix() - 5,
		Owner:       "dev-test",
		Received:    recA,
	}
	bA, _ := json.Marshal(mA)
	os.WriteFile(metaPath+".tmp.A", bA, 0600)

	// Manifest B: Gen 50, chunks 1, 2, 3
	recB := make([]bool, totalChunks)
	recB[1], recB[2], recB[3] = true, true, true
	mB := persistedTransferMeta{
		ID:          tid,
		Filename:    "testC.bin",
		TotalChunks: totalChunks,
		ChunkSize:   chunkSize,
		TotalSize:   int64(totalChunks) * chunkSize,
		FilePath:    partPath,
		State:       "transferring",
		Generation:  50,
		LastActive:  time.Now().Unix(),
		Owner:       "dev-test",
		Received:    recB,
	}
	bB, _ := json.Marshal(mB)
	os.WriteFile(metaPath, bB, 0600)

	cleanTempDir()

	st := lookupTransfer(tid)
	if st == nil {
		t.Fatalf("expected transfer %s to be recovered", tid)
	}
	defer st.discard()

	// Both chunk 0 (from A) and chunk 3 (from B) should be preserved
	if !st.received[0] {
		t.Errorf("DEFECT IDENTIFIED: Chunk 0 from Manifest A was lost in equal-generation tiebreak!")
	}
	if !st.received[3] {
		t.Errorf("DEFECT IDENTIFIED: Chunk 3 from Manifest B was lost in equal-generation tiebreak!")
	}
}

// Test D: The primary manifest is corrupted but a valid temporary manifest exists.
func TestGenerationRecovery_ScenarioD_CorruptedPrimaryValidTmp(t *testing.T) {
	tmpDir := t.TempDir()
	prevBase, prevTemp, prevRecv := baseDir, tempDir, receiveDir
	baseDir = tmpDir
	tempDir = filepath.Join(tmpDir, "temp")
	receiveDir = filepath.Join(tmpDir, "received")
	initDirs()
	defer func() { baseDir, tempDir, receiveDir = prevBase, prevTemp, prevRecv }()

	tid := "tx-gen-test-D"
	totalChunks := 10
	chunkSize := int64(1024 * 1024)
	partPath := createDummyPartFile(t, tempDir, tid, int64(totalChunks)*chunkSize)
	metaPath := getMetaPath(partPath)

	// Primary is non-empty corrupted JSON
	os.WriteFile(metaPath, []byte(`{"id":"tx-gen-test-D", "corrupt_json: truncated`), 0600)

	// Valid temporary manifest exists
	rec := make([]bool, totalChunks)
	rec[0], rec[1], rec[2] = true, true, true
	mTmp := persistedTransferMeta{
		ID:          tid,
		Filename:    "testD.bin",
		TotalChunks: totalChunks,
		ChunkSize:   chunkSize,
		TotalSize:   int64(totalChunks) * chunkSize,
		FilePath:    partPath,
		State:       "transferring",
		Generation:  15,
		LastActive:  time.Now().Unix(),
		Owner:       "dev-test",
		Received:    rec,
	}
	bTmp, _ := json.Marshal(mTmp)
	os.WriteFile(metaPath+".tmp.valid", bTmp, 0600)

	cleanTempDir()

	st := lookupTransfer(tid)
	if st == nil {
		t.Fatalf("expected transfer %s to be recovered from valid .tmp manifest", tid)
	}
	defer st.discard()

	if st.receivedCount != 3 {
		t.Errorf("expected receivedCount 3, got %d", st.receivedCount)
	}
}

// Test E: Several valid temporary manifests exist with different generations.
func TestGenerationRecovery_ScenarioE_MultipleGenerationsHighestWins(t *testing.T) {
	tmpDir := t.TempDir()
	prevBase, prevTemp, prevRecv := baseDir, tempDir, receiveDir
	baseDir = tmpDir
	tempDir = filepath.Join(tmpDir, "temp")
	receiveDir = filepath.Join(tmpDir, "received")
	initDirs()
	defer func() { baseDir, tempDir, receiveDir = prevBase, prevTemp, prevRecv }()

	tid := "tx-gen-test-E"
	totalChunks := 20
	chunkSize := int64(1024 * 1024)
	partPath := createDummyPartFile(t, tempDir, tid, int64(totalChunks)*chunkSize)
	metaPath := getMetaPath(partPath)

	writeCand := func(suffix string, gen int64, chunkCount int) {
		rec := make([]bool, totalChunks)
		for i := 0; i < chunkCount; i++ {
			rec[i] = true
		}
		m := persistedTransferMeta{
			ID:          tid,
			Filename:    "testE.bin",
			TotalChunks: totalChunks,
			ChunkSize:   chunkSize,
			TotalSize:   int64(totalChunks) * chunkSize,
			FilePath:    partPath,
			State:       "transferring",
			Generation:  gen,
			LastActive:  time.Now().Unix(),
			Owner:       "dev-test",
			Received:    rec,
		}
		b, _ := json.Marshal(m)
		os.WriteFile(metaPath+suffix, b, 0600)
	}

	writeCand(".tmp.g10", 10, 4)
	writeCand(".tmp.g50", 50, 16) // Highest generation!
	writeCand(".tmp.g20", 20, 8)
	writeCand(".tmp.g5", 5, 2)

	cleanTempDir()

	st := lookupTransfer(tid)
	if st == nil {
		t.Fatalf("expected transfer %s to be recovered", tid)
	}
	defer st.discard()

	if st.generation != 50 {
		t.Errorf("expected generation 50, got %d", st.generation)
	}
	if st.receivedCount != 16 {
		t.Errorf("expected receivedCount 16 from generation 50, got %d", st.receivedCount)
	}
}

// Test F: Metadata cannot claim a chunk is received when the corresponding file contents are missing (file truncated)
func TestGenerationRecovery_ScenarioF_TruncatedPartFileRejectsUnallocatedChunks(t *testing.T) {
	tmpDir := t.TempDir()
	prevBase, prevTemp, prevRecv := baseDir, tempDir, receiveDir
	baseDir = tmpDir
	tempDir = filepath.Join(tmpDir, "temp")
	receiveDir = filepath.Join(tmpDir, "received")
	initDirs()
	defer func() { baseDir, tempDir, receiveDir = prevBase, prevTemp, prevRecv }()

	tid := "tx-gen-test-F"
	totalChunks := 10
	chunkSize := int64(1024 * 1024)
	// Part file on disk has size 2 MiB (only holds chunk 0 and chunk 1)
	partPath := createDummyPartFile(t, tempDir, tid, 2*chunkSize)
	metaPath := getMetaPath(partPath)

	// Metadata claims chunk 0, 1, AND chunk 5 (offset 5 MiB) were received!
	rec := make([]bool, totalChunks)
	rec[0], rec[1], rec[5] = true, true, true
	m := persistedTransferMeta{
		ID:          tid,
		Filename:    "testF.bin",
		TotalChunks: totalChunks,
		ChunkSize:   chunkSize,
		TotalSize:   int64(totalChunks) * chunkSize,
		FilePath:    partPath,
		State:       "transferring",
		Generation:  10,
		LastActive:  time.Now().Unix(),
		Owner:       "dev-test",
		Received:    rec,
	}
	b, _ := json.Marshal(m)
	os.WriteFile(metaPath, b, 0600)

	cleanTempDir()

	st := lookupTransfer(tid)
	if st != nil {
		if st.received[5] {
			t.Errorf("DEFECT IDENTIFIED: Metadata claimed chunk 5 was received even though part file size (%d) < chunk 5 offset (%d)!", 2*chunkSize, 5*chunkSize)
		}
		st.discard()
	}
}
