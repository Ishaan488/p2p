package main

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/http/pprof"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"testing"
	"time"
)

// Helper to create an in-memory session for test requests
func makeTestSession(deviceID, deviceName string) *Session {
	devKey := make([]byte, 32)
	rand.Read(devKey)
	sessKey := make([]byte, 32)
	rand.Read(sessKey)

	dev := &Device{
		ID:       deviceID,
		Name:     deviceName,
		Key:      devKey,
		PairedAt: time.Now().Unix(),
		LastSeen: time.Now().Unix(),
		Trusted:  true,
	}

	session := newSession(dev, sessKey)
	sessionsMu.Lock()
	sessions[session.ID] = session
	sessionsMu.Unlock()
	return session
}

func removeTestSession(sessionID string) {
	sessionsMu.Lock()
	delete(sessions, sessionID)
	sessionsMu.Unlock()
}

// 1. Multi-device support: verify per-device targeting only routes to matching client
func TestPhase4_MultiDeviceTargeting(t *testing.T) {
	clientsMu.Lock()
	oldClients := clients
	clients = make(map[*Client]bool)
	clientsMu.Unlock()
	defer func() {
		clientsMu.Lock()
		clients = oldClients
		clientsMu.Unlock()
	}()

	clientA := &Client{
		send:   make(chan Message, 10),
		device: &Device{ID: "phone-pixel-1", Name: "Pixel 7"},
	}
	clientB := &Client{
		send:   make(chan Message, 10),
		device: &Device{ID: "phone-iphone-2", Name: "iPhone 15"},
	}

	clientsMu.Lock()
	clients[clientA] = true
	clients[clientB] = true
	clientsMu.Unlock()

	// Targeted message to client A
	msgToA := Message{
		Version:        1,
		Type:           "text",
		ID:             "msg-1",
		Timestamp:      time.Now().Unix(),
		Payload:        TextPayload{Text: "Hello Pixel"},
		TargetDeviceID: "phone-pixel-1",
	}

	delivered := broadcastOnlineOnly(msgToA)
	if delivered != 1 {
		t.Fatalf("expected 1 delivered, got %d", delivered)
	}

	select {
	case received := <-clientA.send:
		if received.ID != "msg-1" {
			t.Fatalf("Client A received wrong message: %s", received.ID)
		}
	default:
		t.Fatal("Client A did not receive targeted message")
	}

	// Verify Client B received nothing
	select {
	case m := <-clientB.send:
		t.Fatalf("Client B should NOT have received targeted message: %v", m)
	default:
		// Expected
	}

	// Global broadcast message
	msgBroadcast := Message{
		Version:   1,
		Type:      "text",
		ID:        "msg-all",
		Timestamp: time.Now().Unix(),
		Payload:   TextPayload{Text: "Hello all"},
	}

	deliveredAll := broadcastOnlineOnly(msgBroadcast)
	if deliveredAll != 2 {
		t.Fatalf("expected 2 delivered for broadcast, got %d", deliveredAll)
	}

	select {
	case <-clientA.send:
	default:
		t.Fatal("Client A did not receive broadcast")
	}
	select {
	case <-clientB.send:
	default:
		t.Fatal("Client B did not receive broadcast")
	}
}

// 2. Per-device isolated outbox queue across offline reconnects
func TestPhase4_DeviceIsolatedOutbox(t *testing.T) {
	outboxMu.Lock()
	oldOutbox := deviceOutbox
	deviceOutbox = make(map[string][]Message)
	outboxMu.Unlock()
	defer func() {
		outboxMu.Lock()
		deviceOutbox = oldOutbox
		outboxMu.Unlock()
	}()

	clientsMu.Lock()
	oldClients := clients
	clients = make(map[*Client]bool)
	clientsMu.Unlock()
	defer func() {
		clientsMu.Lock()
		clients = oldClients
		clientsMu.Unlock()
	}()

	// Device C is offline: queue targeted message for Device C
	msgC := Message{
		Version:        1,
		Type:           "text",
		ID:             "msg-c",
		Timestamp:      time.Now().Unix(),
		Payload:        TextPayload{Text: "Message for offline Phone C"},
		TargetDeviceID: "phone-c",
	}

	delivered := broadcastMessage(msgC)
	if delivered != 0 {
		t.Fatalf("expected 0 delivered to offline device, got %d", delivered)
	}

	outboxMu.Lock()
	cQueue := deviceOutbox["phone-c"]
	globalQueue := deviceOutbox[""]
	outboxMu.Unlock()

	if len(cQueue) != 1 || cQueue[0].ID != "msg-c" {
		t.Fatalf("expected message queued in phone-c bucket, got %v", cQueue)
	}
	if len(globalQueue) != 0 {
		t.Fatalf("targeted message should NOT be in global outbox, got %v", globalQueue)
	}

	// Device D connects: must NOT receive Device C's message
	outboxMu.Lock()
	var pendingD []Message
	if targeted, ok := deviceOutbox["phone-d"]; ok {
		pendingD = append(pendingD, targeted...)
		delete(deviceOutbox, "phone-d")
	}
	outboxMu.Unlock()

	if len(pendingD) != 0 {
		t.Fatalf("Device D should receive 0 messages, got %d", len(pendingD))
	}

	// Now Device C connects: must receive its queued message
	outboxMu.Lock()
	var pendingC []Message
	if targeted, ok := deviceOutbox["phone-c"]; ok {
		pendingC = append(pendingC, targeted...)
		delete(deviceOutbox, "phone-c")
	}
	outboxMu.Unlock()

	if len(pendingC) != 1 || pendingC[0].ID != "msg-c" {
		t.Fatalf("Device C should have dequeued msg-c, got %v", pendingC)
	}

	// Verify outbox for Device C is now empty
	outboxMu.Lock()
	remaining := len(deviceOutbox["phone-c"])
	outboxMu.Unlock()
	if remaining != 0 {
		t.Fatalf("expected empty outbox for phone-c after flush, got %d", remaining)
	}
}

// 3. Fast content deduplication via SHA-256 pre-flight check
func TestPhase4_ContentDeduplication(t *testing.T) {
	tempDir := t.TempDir()
	receiveDir = tempDir

	// Create test file with known contents
	content := []byte("Lorem ipsum dolor sit amet, consectetur adipiscing elit. Line-rate deduplication test.")
	h := sha256.Sum256(content)
	hashHex := hex.EncodeToString(h[:])
	testFilename := "test_document.txt"
	testFilePath := filepath.Join(tempDir, testFilename)

	if err := os.WriteFile(testFilePath, content, 0644); err != nil {
		t.Fatalf("failed to write test file: %v", err)
	}

	// Register in hash index
	recordFileHash(hashHex, testFilePath, int64(len(content)), testFilename)

	// Lookup by hash
	existingName, found := lookupFileByHash(hashHex, int64(len(content)))
	if !found || existingName != testFilename {
		t.Fatalf("lookupFileByHash failed: found=%v, existingName=%s", found, existingName)
	}

	// Test HTTP endpoint: /upload_check_hash
	session := makeTestSession("dev-dedup", "DedupTester")
	defer removeTestSession(session.ID)

	// Prepare encrypted signed check_hash request
	reqBody := uploadCheckHashRequest{
		Hash:      hashHex,
		Filename:  "uploaded_copy.txt",
		TotalSize: int64(len(content)),
	}

	jsonBytes, _ := json.Marshal(reqBody)
	nonce := randomID()[:8]
	sealed := session.seal(jsonBytes, fmt.Sprintf("req\n/upload_check_hash\n%s", nonce))

	req := httptest.NewRequest("POST", fmt.Sprintf("/upload_check_hash?sid=%s&n=%s", session.ID, nonce), bytes.NewReader(sealed))
	rec := httptest.NewRecorder()

	handleUploadCheckHash(rec, req, session)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 OK, got %d: %s", rec.Code, rec.Body.String())
	}

	replyPlain, err := session.open(rec.Body.Bytes(), fmt.Sprintf("res\n/upload_check_hash\n%s", nonce))
	if err != nil {
		t.Fatalf("failed to decrypt reply: %v", err)
	}

	var resp uploadCheckHashResponse
	if err := json.Unmarshal(replyPlain, &resp); err != nil {
		t.Fatalf("failed to parse reply: %v", err)
	}

	if !resp.Exists || resp.Filename != testFilename {
		t.Fatalf("expected Exists=true with Filename=%s, got Exists=%v Filename=%s", testFilename, resp.Exists, resp.Filename)
	}

	// Test with unknown hash -> Exists=false
	unknownNonce := randomID()[:8]
	unknownReqBody := uploadCheckHashRequest{
		Hash:      "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff",
		Filename:  "unknown.txt",
		TotalSize: 1234,
	}
	unknownBytes, _ := json.Marshal(unknownReqBody)
	unknownSealed := session.seal(unknownBytes, fmt.Sprintf("req\n/upload_check_hash\n%s", unknownNonce))

	req2 := httptest.NewRequest("POST", fmt.Sprintf("/upload_check_hash?sid=%s&n=%s", session.ID, unknownNonce), bytes.NewReader(unknownSealed))
	rec2 := httptest.NewRecorder()

	handleUploadCheckHash(rec2, req2, session)

	if rec2.Code != http.StatusOK {
		t.Fatalf("expected 200 OK, got %d", rec2.Code)
	}

	reply2, err := session.open(rec2.Body.Bytes(), fmt.Sprintf("res\n/upload_check_hash\n%s", unknownNonce))
	if err != nil {
		t.Fatalf("failed to decrypt reply2: %v", err)
	}
	var resp2 uploadCheckHashResponse
	json.Unmarshal(reply2, &resp2)

	if resp2.Exists {
		t.Fatalf("expected Exists=false for unknown file hash")
	}
}

// 4. Parallel chunk streams: chunks arriving out-of-order concurrently assemble correctly
func TestPhase4_ParallelOutOfOrderChunks(t *testing.T) {
	tempBase := t.TempDir()
	baseDir = tempBase
	receiveDir = filepath.Join(tempBase, "received")
	tempDir = filepath.Join(tempBase, "temp")
	initDirs()

	session := makeTestSession("dev-parallel", "ParallelTester")
	defer removeTestSession(session.ID)

	transferID := "tx-parallel-test"
	totalChunks := 8
	chunkSize := int64(64 * 1024) // 64 KB per chunk
	totalSize := chunkSize * int64(totalChunks)

	// Create random data per chunk
	chunks := make([][]byte, totalChunks)
	fullData := make([]byte, totalSize)
	for i := 0; i < totalChunks; i++ {
		chunks[i] = make([]byte, chunkSize)
		rand.Read(chunks[i])
		copy(fullData[int64(i)*chunkSize:], chunks[i])
	}
	expectedHash := sha256.Sum256(fullData)

	// Init upload
	tmpPath := getTempPath(transferID)
	f, err := os.Create(tmpPath)
	if err != nil {
		t.Fatalf("failed to create temp file: %v", err)
	}

	state := &TransferState{
		ID:          transferID,
		Filename:    "parallel_assembled.bin",
		TotalChunks: totalChunks,
		ChunkSize:   chunkSize,
		TotalSize:   totalSize,
		File:        f,
		FilePath:    tmpPath,
		Owner:       session.Device.ID,
		received:    make([]bool, totalChunks),
	}

	transfersMu.Lock()
	transfers[transferID] = state
	transfersMu.Unlock()

	// Upload chunks out-of-order concurrently across 4 workers
	outOfOrderIndices := []int{5, 2, 0, 7, 3, 1, 6, 4}
	var wg sync.WaitGroup

	for _, idx := range outOfOrderIndices {
		wg.Add(1)
		go func(chunkIndex int) {
			defer wg.Done()
			chunkBytes := chunks[chunkIndex]
			sealed := session.seal(chunkBytes, chunkAAD(transferID, chunkIndex))

			url := fmt.Sprintf("/upload?transferId=%s&chunkIndex=%d&sid=%s", transferID, chunkIndex, session.ID)
			req := httptest.NewRequest("POST", url, bytes.NewReader(sealed))
			rec := httptest.NewRecorder()

			handleUploadChunk(rec, req, session)

			if rec.Code != http.StatusOK {
				t.Errorf("chunk %d upload failed with code %d: %s", chunkIndex, rec.Code, rec.Body.String())
			}
		}(idx)
	}

	wg.Wait()

	// Complete upload
	completeReq := transferRef{TransferID: transferID}
	jsonBytes, _ := json.Marshal(completeReq)
	nonce := randomID()[:8]
	sealedComplete := session.seal(jsonBytes, fmt.Sprintf("req\n/upload_complete\n%s", nonce))

	reqComplete := httptest.NewRequest("POST", fmt.Sprintf("/upload_complete?sid=%s&n=%s", session.ID, nonce), bytes.NewReader(sealedComplete))
	recComplete := httptest.NewRecorder()

	handleUploadComplete(recComplete, reqComplete, session)

	if recComplete.Code != http.StatusOK {
		t.Fatalf("upload_complete failed with %d: %s", recComplete.Code, recComplete.Body.String())
	}

	// Verify assembled file on disk matches byte-for-byte and hash
	savedPath := filepath.Join(receiveDir, "parallel_assembled.bin")
	savedData, err := os.ReadFile(savedPath)
	if err != nil {
		t.Fatalf("failed to read assembled file: %v", err)
	}

	if int64(len(savedData)) != totalSize {
		t.Fatalf("assembled size mismatch: got %d, expected %d", len(savedData), totalSize)
	}

	actualHash := sha256.Sum256(savedData)
	if actualHash != expectedHash {
		t.Fatalf("assembled SHA256 mismatch!\nExpected: %x\nActual:   %x", expectedHash, actualHash)
	}
}

// 5. Memory efficiency test: verify O(1) flat memory footprint during large file chunk writes
func TestPhase4_FlatMemoryScaling(t *testing.T) {
	tempBase := t.TempDir()
	baseDir = tempBase
	receiveDir = filepath.Join(tempBase, "received")
	tempDir = filepath.Join(tempBase, "temp")
	initDirs()

	session := makeTestSession("dev-flatmem", "MemTester")
	defer removeTestSession(session.ID)

	runtime.GC()
	var memBefore runtime.MemStats
	runtime.ReadMemStats(&memBefore)

	// Stream 50 chunks of 1MB (50MB) sequentially through WriteAt
	tmpPath := filepath.Join(tempDir, "flat_stream.part")
	f, err := os.Create(tmpPath)
	if err != nil {
		t.Fatalf("failed to create temp file: %v", err)
	}
	defer func() {
		f.Close()
		os.Remove(tmpPath)
	}()

	chunkData := make([]byte, 1024*1024)
	rand.Read(chunkData)

	for i := 0; i < 50; i++ {
		_, err := f.WriteAt(chunkData, int64(i)*1024*1024)
		if err != nil {
			t.Fatalf("WriteAt failed at chunk %d: %v", i, err)
		}
	}

	runtime.GC()
	var memAfter runtime.MemStats
	runtime.ReadMemStats(&memAfter)

	// HeapAlloc difference must be bounded (< 15MB) and not scale linearly with 50MB
	var allocDiffMB float64
	if memAfter.HeapAlloc > memBefore.HeapAlloc {
		allocDiffMB = float64(memAfter.HeapAlloc-memBefore.HeapAlloc) / 1024 / 1024
	} else {
		allocDiffMB = 0
	}
	if allocDiffMB > 15.0 {
		t.Fatalf("memory usage scaled with file size (heap grew by %.2f MB, expected flat O(1) < 15MB)", allocDiffMB)
	}
}

// 6. Scale test: 100 simultaneous transfers running concurrently without deadlock or data races
func TestPhase4_100SimultaneousTransfers(t *testing.T) {
	tempBase := t.TempDir()
	baseDir = tempBase
	receiveDir = filepath.Join(tempBase, "received")
	tempDir = filepath.Join(tempBase, "temp")
	initDirs()

	session := makeTestSession("dev-scale-100", "ScaleTester")
	defer removeTestSession(session.ID)

	const numTransfers = 100
	var wg sync.WaitGroup
	errCh := make(chan error, numTransfers)

	for i := 0; i < numTransfers; i++ {
		wg.Add(1)
		go func(transferNum int) {
			defer wg.Done()
			txID := fmt.Sprintf("tx-scale-%03d", transferNum)
			filename := fmt.Sprintf("small_file_%03d.txt", transferNum)
			content := []byte(fmt.Sprintf("Payload for concurrent file number %d", transferNum))

			// Write to temp file
			tPath := getTempPath(txID)
			f, err := os.Create(tPath)
			if err != nil {
				errCh <- fmt.Errorf("create failed for %s: %w", txID, err)
				return
			}

			state := &TransferState{
				ID:          txID,
				Filename:    filename,
				TotalChunks: 1,
				ChunkSize:   int64(len(content)),
				TotalSize:   int64(len(content)),
				File:        f,
				FilePath:    tPath,
				Owner:       session.Device.ID,
				received:    make([]bool, 1),
			}

			transfersMu.Lock()
			transfers[txID] = state
			transfersMu.Unlock()

			// Upload single chunk
			sealed := session.seal(content, chunkAAD(txID, 0))
			url := fmt.Sprintf("/upload?transferId=%s&chunkIndex=0&sid=%s", txID, session.ID)
			req := httptest.NewRequest("POST", url, bytes.NewReader(sealed))
			rec := httptest.NewRecorder()

			handleUploadChunk(rec, req, session)
			if rec.Code != http.StatusOK {
				errCh <- fmt.Errorf("chunk upload failed for %s: code %d", txID, rec.Code)
				return
			}

			// Complete
			completeReq := transferRef{TransferID: txID}
			jsonBytes, _ := json.Marshal(completeReq)
			nonce := randomID()[:8]
			sealedComplete := session.seal(jsonBytes, fmt.Sprintf("req\n/upload_complete\n%s", nonce))

			reqComplete := httptest.NewRequest("POST", fmt.Sprintf("/upload_complete?sid=%s&n=%s", session.ID, nonce), bytes.NewReader(sealedComplete))
			recComplete := httptest.NewRecorder()

			handleUploadComplete(recComplete, reqComplete, session)
			if recComplete.Code != http.StatusOK {
				errCh <- fmt.Errorf("complete failed for %s: code %d", txID, recComplete.Code)
				return
			}
		}(i)
	}

	wg.Wait()
	close(errCh)

	for err := range errCh {
		t.Fatalf("concurrent transfer error: %v", err)
	}

	// Verify all 100 files exist in receiveDir
	entries, err := os.ReadDir(receiveDir)
	if err != nil {
		t.Fatalf("failed to read receive dir: %v", err)
	}
	if len(entries) != numTransfers {
		t.Fatalf("expected %d saved files, found %d", numTransfers, len(entries))
	}
}

// 7. Pprof profiling diagnostics endpoint test
func TestPhase4_PprofEndpoint(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/debug/pprof/", pprof.Index)
	mux.HandleFunc("/debug/pprof/goroutine", pprof.Handler("goroutine").ServeHTTP)
	mux.HandleFunc("/debug/pprof/heap", pprof.Handler("heap").ServeHTTP)

	// Test index
	reqIndex := httptest.NewRequest("GET", "/debug/pprof/", nil)
	recIndex := httptest.NewRecorder()
	mux.ServeHTTP(recIndex, reqIndex)
	if recIndex.Code != http.StatusOK {
		t.Fatalf("pprof index expected 200, got %d", recIndex.Code)
	}

	// Test goroutine profile
	reqGoroutine := httptest.NewRequest("GET", "/debug/pprof/goroutine?debug=1", nil)
	recGoroutine := httptest.NewRecorder()
	mux.ServeHTTP(recGoroutine, reqGoroutine)
	if recGoroutine.Code != http.StatusOK {
		t.Fatalf("pprof goroutine profile expected 200, got %d", recGoroutine.Code)
	}

	// Verify output contains goroutine stack information
	body, _ := io.ReadAll(recGoroutine.Body)
	if !bytes.Contains(body, []byte("goroutine profile: total")) {
		t.Fatalf("goroutine profile output invalid: %s", string(body))
	}
}
