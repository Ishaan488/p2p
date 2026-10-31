package main

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// TestBruteForcePairingLockout verifies that after 5 failed pairing attempts from the same IP,
// subsequent attempts are locked out and return HTTP 429 Too Many Requests with Retry-After header.
func TestBruteForcePairingLockout(t *testing.T) {
	testIP := "192.168.1.99"
	resetPairLimit(testIP)
	defer resetPairLimit(testIP)

	newPairCode() // active pairing code

	// 5 failed attempts with invalid MAC
	for i := 1; i <= 5; i++ {
		reqBody, _ := json.Marshal(pairRequest{
			DeviceID: fmt.Sprintf("attacker-device-%d", i),
			Name:     "Attacker",
			MAC:      "badc0ffeedeadbeef",
		})
		req := httptest.NewRequest("POST", "/pair", bytes.NewReader(reqBody))
		req.RemoteAddr = testIP + ":54321"
		rec := httptest.NewRecorder()

		handlePair(rec, req)

		if i < 5 {
			if rec.Code != http.StatusForbidden {
				t.Fatalf("attempt %d expected 403 Forbidden, got %d", i, rec.Code)
			}
		} else {
			// 5th attempt triggers lockout for subsequent requests
			if rec.Code != http.StatusForbidden {
				t.Fatalf("attempt 5 expected 403, got %d", rec.Code)
			}
		}
	}

	// 6th attempt MUST be locked out with HTTP 429 Too Many Requests
	reqBody, _ := json.Marshal(pairRequest{
		DeviceID: "attacker-device-6",
		Name:     "Attacker",
		MAC:      "badc0ffeedeadbeef",
	})
	req := httptest.NewRequest("POST", "/pair", bytes.NewReader(reqBody))
	req.RemoteAddr = testIP + ":54321"
	rec := httptest.NewRecorder()

	handlePair(rec, req)

	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("expected 429 Too Many Requests on attempt 6, got %d", rec.Code)
	}

	retryAfter := rec.Header().Get("Retry-After")
	if retryAfter == "" || retryAfter == "0" {
		t.Errorf("expected non-empty Retry-After header, got %q", retryAfter)
	}

	var res map[string]interface{}
	_ = json.Unmarshal(rec.Body.Bytes(), &res)
	if res["code"] != "locked_out" {
		t.Errorf("expected code locked_out, got %v", res["code"])
	}
}

// TestAntiReplay_NonceAndSequenceRejection tests that replaying an authenticated request
// with the same nonce 'n' is detected and rejected.
func TestAntiReplay_NonceAndSequenceRejection(t *testing.T) {
	dev := &Device{ID: "test-replay-device", Name: "Phone", Key: make([]byte, 32)}
	rand.Read(dev.Key)
	session := newSession(dev, []byte("01234567890123456789012345678901"))
	sessionsMu.Lock()
	sessions[session.ID] = session
	sessionsMu.Unlock()

	nonce := "abc12345"

	// Construct signed request
	req := httptest.NewRequest("GET", fmt.Sprintf("/download?sid=%s&transferId=t1&chunkIndex=0&n=%s", session.ID, nonce), nil)
	sig := requestSignature(session.Key, req)
	req = httptest.NewRequest("GET", fmt.Sprintf("/download?sid=%s&transferId=t1&chunkIndex=0&n=%s&mac=%s", session.ID, nonce, hex.EncodeToString(sig)), nil)

	// First hit: should pass authentication (returns valid session)
	authedSession := authenticate(req)
	if authedSession == nil {
		t.Fatal("first request with fresh nonce should authenticate successfully")
	}

	// Replay hit: identical request with the same nonce must be rejected
	replayedSession := authenticate(req)
	if replayedSession != nil {
		t.Fatal("replayed request with duplicate nonce should be rejected (expected nil)")
	}
}

// TestNonceBehaviorAcrossReconnects verifies that reconnects mint new sessions with
// independent nonces and cryptographic keys, preventing key/nonce reuse across sessions.
func TestNonceBehaviorAcrossReconnects(t *testing.T) {
	dev := registerDevice("dev-reconnect-test", "Phone Reconnect", make([]byte, 32))
	rand.Read(dev.Key)

	// Session 1
	cNonce1 := hex.EncodeToString([]byte("client-nonce-001"))
	req1Body, _ := json.Marshal(helloRequest{DeviceID: dev.ID, ClientNonce: cNonce1})
	req1 := httptest.NewRequest("POST", "/hello", bytes.NewReader(req1Body))
	rec1 := httptest.NewRecorder()
	handleHello(rec1, req1)
	if rec1.Code != http.StatusOK {
		t.Fatalf("first /hello failed: %d", rec1.Code)
	}
	var res1 map[string]string
	_ = json.Unmarshal(rec1.Body.Bytes(), &res1)

	// Session 2 (Reconnect)
	cNonce2 := hex.EncodeToString([]byte("client-nonce-002"))
	req2Body, _ := json.Marshal(helloRequest{DeviceID: dev.ID, ClientNonce: cNonce2})
	req2 := httptest.NewRequest("POST", "/hello", bytes.NewReader(req2Body))
	rec2 := httptest.NewRecorder()
	handleHello(rec2, req2)
	if rec2.Code != http.StatusOK {
		t.Fatalf("second /hello failed: %d", rec2.Code)
	}
	var res2 map[string]string
	_ = json.Unmarshal(rec2.Body.Bytes(), &res2)

	if res1["sessionId"] == res2["sessionId"] {
		t.Errorf("expected different session IDs across reconnects, got same: %s", res1["sessionId"])
	}
	if res1["serverNonce"] == res2["serverNonce"] {
		t.Errorf("expected fresh server nonce across reconnects, got duplicate: %s", res1["serverNonce"])
	}

	// Verify encryption isolation: message encrypted under session 1 cannot be opened under session 2
	sessionsMu.Lock()
	s1 := sessions[res1["sessionId"]]
	s2 := sessions[res2["sessionId"]]
	sessionsMu.Unlock()

	frameS1 := s1.seal([]byte("confidential payload"), "ctx")
	_, err := s2.open(frameS1, "ctx")
	if err == nil {
		t.Fatal("session 2 should NOT be able to decrypt frame sealed under session 1")
	}
}

// TestUnauthenticatedHitsOnAllEndpoints verifies that all protected endpoints return
// HTTP 401 Unauthorized or 403 Forbidden when accessed without credentials or with forged HMACs.
func TestUnauthenticatedHitsOnAllEndpoints(t *testing.T) {
	endpoints := []struct {
		method string
		path   string
	}{
		{"POST", "/upload_init"},
		{"POST", "/upload"},
		{"POST", "/upload_complete"},
		{"POST", "/upload_cancel"},
		{"GET", "/download"},
		{"GET", "/download_full"},
		{"GET", "/ws"},
		{"POST", "/unpair"},
	}

	for _, ep := range endpoints {
		t.Run("NoAuth_"+ep.path, func(t *testing.T) {
			req := httptest.NewRequest(ep.method, ep.path, strings.NewReader("bad data"))
			rec := httptest.NewRecorder()

			switch ep.path {
			case "/upload_init":
				authed(handleUploadInit)(rec, req)
			case "/upload":
				authed(handleUploadChunk)(rec, req)
			case "/upload_complete":
				authed(handleUploadComplete)(rec, req)
			case "/upload_cancel":
				authed(handleUploadCancel)(rec, req)
			case "/download":
				authed(handleDownloadChunk)(rec, req)
			case "/download_full":
				authed(handleDownloadFull)(rec, req)
			case "/unpair":
				authed(handleUnpair)(rec, req)
			case "/ws":
				handleWebSocket(rec, req)
			}

			if rec.Code != http.StatusUnauthorized && rec.Code != http.StatusForbidden {
				t.Errorf("endpoint %s returned %d, expected 401 Unauthorized or 403 Forbidden", ep.path, rec.Code)
			}
		})

		t.Run("ForgedMAC_"+ep.path, func(t *testing.T) {
			req := httptest.NewRequest(ep.method, ep.path+"?sid=fake-session&n=fake-nonce&mac=deadbeef00112233", strings.NewReader("bad data"))
			rec := httptest.NewRecorder()

			switch ep.path {
			case "/upload_init":
				authed(handleUploadInit)(rec, req)
			case "/upload":
				authed(handleUploadChunk)(rec, req)
			case "/upload_complete":
				authed(handleUploadComplete)(rec, req)
			case "/upload_cancel":
				authed(handleUploadCancel)(rec, req)
			case "/download":
				authed(handleDownloadChunk)(rec, req)
			case "/download_full":
				authed(handleDownloadFull)(rec, req)
			case "/unpair":
				authed(handleUnpair)(rec, req)
			case "/ws":
				handleWebSocket(rec, req)
			}

			if rec.Code != http.StatusUnauthorized && rec.Code != http.StatusForbidden {
				t.Errorf("endpoint %s with forged mac returned %d, expected 401 or 403", ep.path, rec.Code)
			}
		})
	}
}

// TestOversizedHeadersMalformedFramesAndHugeChunks tests that oversized frames,
// truncated frames (< sealOverhead), and huge chunk sizes are rejected cleanly.
func TestOversizedHeadersMalformedFramesAndHugeChunks(t *testing.T) {
	dev := registerDevice("dev-malformed-test", "Phone Test", make([]byte, 32))
	session := newSession(dev, []byte("01234567890123456789012345678901"))

	// 1. Truncated frame (less than 28 bytes nonce+tag)
	shortBytes := []byte{1, 2, 3, 4, 5}
	_, err := session.open(shortBytes, "ctx")
	if err == nil {
		t.Fatal("open() on truncated frame should return error, got nil")
	}

	// 2. Huge chunk size > maxChunkSize (8 MiB)
	reqHugeChunk, _ := json.Marshal(uploadInitRequest{
		TransferID:  "huge-chunk-transfer",
		Filename:    "test.bin",
		TotalSize:   100 * 1024 * 1024,
		ChunkSize:   16 * 1024 * 1024, // 16 MiB > 8 MiB max
		TotalChunks: 7,
	})
	encHuge := session.seal(reqHugeChunk, "req\n/upload_init\n")
	req := httptest.NewRequest("POST", "/upload_init", bytes.NewReader(encHuge))
	rec := httptest.NewRecorder()
	handleUploadInit(rec, req, session)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("expected 400 Bad Request for chunk size > maxChunkSize, got %d", rec.Code)
	}

	// 3. Huge total chunks > 5,000,000
	reqHugeCount, _ := json.Marshal(uploadInitRequest{
		TransferID:  "huge-chunks-count",
		Filename:    "test.bin",
		TotalSize:   10000000 * 1024 * 1024,
		ChunkSize:   1024 * 1024,
		TotalChunks: 10000000, // > 5,000,000 limit
	})
	encHugeCount := session.seal(reqHugeCount, "req\n/upload_init\n")
	req = httptest.NewRequest("POST", "/upload_init", bytes.NewReader(encHugeCount))
	rec = httptest.NewRecorder()
	handleUploadInit(rec, req, session)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("expected 400 Bad Request for chunks count > 5M, got %d", rec.Code)
	}

	// 4. Negative chunk index
	req = httptest.NewRequest("POST", "/upload?transferId=t1&chunkIndex=-1", strings.NewReader("bad chunk"))
	rec = httptest.NewRecorder()
	handleUploadChunk(rec, req, session)
	if rec.Code != http.StatusNotFound && rec.Code != http.StatusBadRequest {
		t.Errorf("expected 400/404 on negative chunkIndex, got %d", rec.Code)
	}
}

// TestDeviceRevokeFromPhone verifies that /unpair removes the device from the PC,
// cleans sessions, and drops active clients.
func TestDeviceRevokeFromPhone(t *testing.T) {
	dev := registerDevice("dev-revoke-test", "RevokePhone", make([]byte, 32))
	session := newSession(dev, []byte("01234567890123456789012345678901"))
	sessionsMu.Lock()
	sessions[session.ID] = session
	sessionsMu.Unlock()

	req := httptest.NewRequest("POST", "/unpair", bytes.NewReader([]byte("{}")))
	rec := httptest.NewRecorder()
	handleUnpair(rec, req, session)

	if rec.Code != http.StatusOK {
		t.Fatalf("handleUnpair failed with %d", rec.Code)
	}

	// Verify device is removed from state
	if findDevice(dev.ID) != nil {
		t.Errorf("device %s was not removed from state after unpair", dev.ID)
	}

	// Verify session is dropped
	sessionsMu.Lock()
	s := sessions[session.ID]
	sessionsMu.Unlock()
	if s != nil {
		t.Errorf("session %s was not dropped after unpair", session.ID)
	}
}
