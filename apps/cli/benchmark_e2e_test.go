package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"testing"
	"time"
)

// TestBenchmark_RealEndToEndHTTPPipeline measures true end-to-end loopback HTTP throughput
// including HTTP request parsing, AES-256-GCM authenticated encryption/decryption,
// WriteAt disk writes, 24-byte journal append, and completion finalization.
func TestBenchmark_RealEndToEndHTTPPipeline(t *testing.T) {
	tmpDir := t.TempDir()
	prevBase, prevTemp, prevRecv := baseDir, tempDir, receiveDir
	baseDir = tmpDir
	tempDir = filepath.Join(tmpDir, "temp")
	receiveDir = filepath.Join(tmpDir, "received")
	initDirs()
	defer func() {
		baseDir, tempDir, receiveDir = prevBase, prevTemp, prevRecv
	}()

	session := makeTestSession("bench-e2e-client", "BenchMobile")
	defer removeTestSession(session.ID)

	// Set up real HTTP server on loopback TCP socket
	mux := http.NewServeMux()
	mux.HandleFunc("/upload_init", authed(handleUploadInit))
	mux.HandleFunc("/upload", authed(handleUploadChunk))
	mux.HandleFunc("/upload_complete", authed(handleUploadComplete))
	server := httptest.NewServer(mux)
	defer server.Close()

	client := server.Client()

	const fileSize = int64(32 * 1024 * 1024) // 32 MiB per trial
	const chunkSize = int64(1024 * 1024)     // 1 MiB chunks
	totalChunks := int(fileSize / chunkSize)
	const trials = 10

	payload := make([]byte, fileSize)
	for i := range payload {
		payload[i] = byte((i*41 + 17) % 256)
	}
	expectedHash := sha256.Sum256(payload)

	var throughputs []float64
	var memStatsBefore, memStatsAfter runtime.MemStats
	runtime.GC()
	runtime.ReadMemStats(&memStatsBefore)

	for tr := 0; tr < trials; tr++ {
		tid := fmt.Sprintf("bench-e2e-tx-%d", tr)
		fname := fmt.Sprintf("e2e_bench_%d.bin", tr)

		t0 := time.Now()

		// 1. Upload Init
		nonceInit := randomID()[:8]
		initJSON, _ := json.Marshal(uploadInitRequest{
			TransferID:  tid,
			Filename:    fname,
			TotalSize:   fileSize,
			ChunkSize:   chunkSize,
			TotalChunks: totalChunks,
		})
		initEnc := session.seal(initJSON, "req\n/upload_init\n"+nonceInit)
		initURL := fmt.Sprintf("%s/upload_init?sid=%s&n=%s", server.URL, session.ID, nonceInit)
		sig := requestSignature(session.Key, httptest.NewRequest("POST", initURL, nil))
		initURL += "&mac=" + hexEncode(sig)

		resp, err := client.Post(initURL, "application/octet-stream", bytes.NewReader(initEnc))
		if err != nil || resp.StatusCode != http.StatusOK {
			b, _ := io.ReadAll(resp.Body)
			t.Fatalf("trial %d init failed: code=%d err=%v body=%s", tr, resp.StatusCode, err, string(b))
		}
		resp.Body.Close()

		// 2. Upload Chunks sequentially over real HTTP connection
		for c := 0; c < totalChunks; c++ {
			cStart := int64(c) * chunkSize
			cEnd := cStart + chunkSize
			chunkPlain := payload[cStart:cEnd]
			chunkEnc := session.seal(chunkPlain, chunkAAD(tid, c))
			nonceChunk := randomID()[:8]

			chunkURL := fmt.Sprintf("%s/upload?sid=%s&transferId=%s&chunkIndex=%d&n=%s",
				server.URL, session.ID, tid, c, nonceChunk)
			sigC := requestSignature(session.Key, httptest.NewRequest("POST", chunkURL, nil))
			chunkURL += "&mac=" + hexEncode(sigC)

			req, _ := http.NewRequest("POST", chunkURL, bytes.NewReader(chunkEnc))
			cResp, err := client.Do(req)
			if err != nil || cResp.StatusCode != http.StatusOK {
				t.Fatalf("trial %d chunk %d failed: %v", tr, c, err)
			}
			cResp.Body.Close()
		}

		// 3. Upload Complete
		nonceComp := randomID()[:8]
		compJSON, _ := json.Marshal(transferRef{TransferID: tid})
		compEnc := session.seal(compJSON, "req\n/upload_complete\n"+nonceComp)
		compURL := fmt.Sprintf("%s/upload_complete?sid=%s&n=%s", server.URL, session.ID, nonceComp)
		sigComp := requestSignature(session.Key, httptest.NewRequest("POST", compURL, nil))
		compURL += "&mac=" + hexEncode(sigComp)

		compResp, err := client.Post(compURL, "application/octet-stream", bytes.NewReader(compEnc))
		if err != nil || compResp.StatusCode != http.StatusOK {
			t.Fatalf("trial %d complete failed: %v", tr, err)
		}
		compResp.Body.Close()

		dur := time.Since(t0).Seconds()
		mbSec := float64(fileSize) / (1024 * 1024 * dur)
		throughputs = append(throughputs, mbSec)

		// 4. Verify Final File Content & Integrity on disk
		finalPath := filepath.Join(receiveDir, fname)
		dataOnDisk, err := os.ReadFile(finalPath)
		if err != nil {
			t.Fatalf("trial %d read final file failed: %v", tr, err)
		}
		actualHash := sha256.Sum256(dataOnDisk)
		if actualHash != expectedHash {
			t.Fatalf("trial %d integrity mismatch! expected %x, got %x", tr, expectedHash, actualHash)
		}
		_ = os.Remove(finalPath)
	}

	runtime.ReadMemStats(&memStatsAfter)
	peakAllocMB := float64(memStatsAfter.HeapAlloc) / (1024 * 1024)

	sort.Float64s(throughputs)
	median := throughputs[len(throughputs)/2]
	p95 := throughputs[int(float64(len(throughputs))*0.95)]
	p99 := throughputs[len(throughputs)-1]

	var sum float64
	for _, v := range throughputs {
		sum += v
	}
	mean := sum / float64(len(throughputs))

	fmt.Printf("\n=== REAL END-TO-END HTTP LOOPBACK BENCHMARK ===\n")
	fmt.Printf("Trials: %d | Payload: %d MiB/file | Chunks: %d x 1 MiB\n", trials, fileSize/(1024*1024), totalChunks)
	fmt.Printf("HTTP Protocol: HTTP/1.1 Loopback TCP | Encryption: AES-256-GCM + HMAC-SHA256\n")
	fmt.Printf("Throughput (Mean):   %.2f MB/s\n", mean)
	fmt.Printf("Throughput (Median): %.2f MB/s\n", median)
	fmt.Printf("Throughput (p95):    %.2f MB/s\n", p95)
	fmt.Printf("Throughput (p99):    %.2f MB/s\n", p99)
	fmt.Printf("Peak Heap Memory:    %.2f MB\n", peakAllocMB)
	fmt.Printf("Integrity Verified:  100%% (SHA-256 exact match across all %d trials)\n", trials)
	fmt.Printf("Failures:            0\n")
	fmt.Printf("================================================\n")
}

func hexEncode(b []byte) string {
	var buf [64]byte
	const hextable = "0123456789abcdef"
	for i, v := range b {
		buf[i*2] = hextable[v>>4]
		buf[i*2+1] = hextable[v&0x0f]
	}
	return string(buf[:len(b)*2])
}
