package main

import (
	"bytes"
	"crypto/hmac"
	"crypto/rand"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// TestSanitizeFilename_PathTraversal verifies that malicious filenames cannot escape
// the intended directory or retain directory traversal sequences.
func TestSanitizeFilename_PathTraversal(t *testing.T) {
	cases := []struct {
		input    string
		expected string
	}{
		{"../../evil.sh", "evil.sh"},
		{"..\\..\\evil.bat", "evil.bat"},
		{"/etc/passwd", "passwd"},
		{"C:\\Windows\\System32\\cmd.exe", "cmd.exe"},
		{"..\\..\\..\\..\\boot.ini", "boot.ini"},
		{"/", "unnamed"},
		{"\\", "unnamed"},
		{".", "unnamed"},
		{"..", "unnamed"},
		{"...", "unnamed"},
		{"....", "unnamed"},
		{"   ..   ", "unnamed"},
		{".. ..", "unnamed"},
		{"a/b/c/test.txt", "test.txt"},
		{"a\\b\\c\\test.txt", "test.txt"},
		{"/test.txt", "test.txt"},
		{"\\test.txt", "test.txt"},
	}

	for _, tc := range cases {
		got := sanitizeFilename(tc.input)
		if got != tc.expected {
			t.Errorf("sanitizeFilename(%q) = %q, expected %q", tc.input, got, tc.expected)
		}
		if strings.Contains(got, "/") || strings.Contains(got, "\\") || strings.Contains(got, "..") {
			t.Errorf("sanitizeFilename(%q) = %q contains traversal characters", tc.input, got)
		}
	}
}

// TestSanitizeFilename_WindowsReservedNames verifies that Windows device names
// (CON, PRN, AUX, NUL, COM1-9, LPT1-9) with or without extensions are safely defanged.
func TestSanitizeFilename_WindowsReservedNames(t *testing.T) {
	reserved := []string{
		"CON", "con", "CON.txt", "con.tar.gz",
		"PRN", "prn.pdf", "AUX", "aux.h",
		"NUL", "nul.iso", "COM1", "com1.log",
		"COM9.txt", "LPT1", "lpt1.bin", "LPT9.png",
	}

	for _, name := range reserved {
		got := sanitizeFilename(name)
		if !strings.HasPrefix(got, "_") {
			t.Errorf("sanitizeFilename(%q) = %q was not defanged with leading underscore", name, got)
		}

		// Verify that a file with the sanitized name can actually be created on Windows filesystem
		tmpDir, err := os.MkdirTemp("", "p2p_reserved_test_*")
		if err != nil {
			t.Fatalf("Failed to create temp dir: %v", err)
		}
		testPath := filepath.Join(tmpDir, got)
		f, err := os.Create(testPath)
		if err != nil {
			t.Errorf("Failed to create defanged file %q: %v", got, err)
		} else {
			f.Close()
		}
		os.RemoveAll(tmpDir)
	}
}

// TestSanitizeFilename_SpecialCharsAndLength verifies handling of Windows illegal characters,
// null bytes, trailing dots/spaces, long filenames, and non-ASCII / Unicode characters.
func TestSanitizeFilename_SpecialCharsAndLength(t *testing.T) {
	// 1. Windows illegal characters: < > : " / \ | ? *
	illegal := `file<name>:with"quotes"|and?stars*`
	gotIllegal := sanitizeFilename(illegal)
	if strings.ContainsAny(gotIllegal, `<>:"|?*`) {
		t.Errorf("sanitizeFilename did not strip illegal characters: %q", gotIllegal)
	}

	// 2. Control characters & null bytes
	withNull := "evil\x00file\x1fname.txt"
	gotNull := sanitizeFilename(withNull)
	if strings.ContainsAny(gotNull, "\x00\x1f") {
		t.Errorf("sanitizeFilename allowed control / null bytes: %q", gotNull)
	}

	// 3. Trailing dots and spaces
	trailing := "photo.jpg. . "
	gotTrailing := sanitizeFilename(trailing)
	if strings.HasSuffix(gotTrailing, " ") || strings.HasSuffix(gotTrailing, ".") {
		t.Errorf("sanitizeFilename allowed trailing dots or spaces: %q", gotTrailing)
	}
	if gotTrailing != "photo.jpg" {
		t.Errorf("expected photo.jpg, got %q", gotTrailing)
	}

	// 4. Overly long filename (> 260 chars)
	longBase := strings.Repeat("a", 300)
	longFile := longBase + ".tar.gz"
	gotLong := sanitizeFilename(longFile)
	if len(gotLong) > 200 {
		t.Errorf("sanitizeFilename length %d > 200", len(gotLong))
	}
	if !strings.HasSuffix(gotLong, ".gz") {
		t.Errorf("sanitizeFilename lost extension: %q", gotLong)
	}

	// 5. Unicode and emoji filenames
	unicodeNames := []string{
		"写真.jpg",
		"🚀rocket_presentation.pdf",
		"résumé_2026.docx",
		"한국어_문서.txt",
	}
	for _, uName := range unicodeNames {
		gotUnicode := sanitizeFilename(uName)
		if gotUnicode != uName {
			t.Errorf("sanitizeFilename altered valid unicode filename %q -> %q", uName, gotUnicode)
		}
	}
}

// TestMoveIntoDir_PathTraversalPrevention verifies that moveIntoDir refuses to escape
// the designated destination directory.
func TestMoveIntoDir_PathTraversalPrevention(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "p2p_move_dest_*")
	if err != nil {
		t.Fatalf("MkdirTemp failed: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	srcFile, err := os.CreateTemp("", "p2p_src_*")
	if err != nil {
		t.Fatalf("CreateTemp failed: %v", err)
	}
	srcPath := srcFile.Name()
	srcFile.WriteString("test content")
	srcFile.Close()
	defer os.Remove(srcPath)

	// Attempt path traversal with ../../outside.txt
	destPath, err := moveIntoDir(srcPath, tmpDir, "../../outside.txt")
	if err != nil {
		t.Fatalf("moveIntoDir error: %v", err)
	}

	// Must be contained strictly inside tmpDir
	cleanTmp, _ := filepath.Abs(tmpDir)
	cleanDest, _ := filepath.Abs(destPath)
	rel, err := filepath.Rel(cleanTmp, cleanDest)
	if err != nil || strings.HasPrefix(rel, "..") {
		t.Errorf("Path traversal escaped directory! rel: %s, dest: %s, base: %s", rel, cleanDest, cleanTmp)
	}
	if filepath.Base(destPath) != "outside.txt" {
		t.Errorf("Expected filename outside.txt, got %s", filepath.Base(destPath))
	}
}

// TestMoveIntoDir_DuplicateCollisionResolution verifies that duplicate filenames
// automatically append (1), (2), etc. and do not overwrite existing files.
func TestMoveIntoDir_DuplicateCollisionResolution(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "p2p_collision_test_*")
	if err != nil {
		t.Fatalf("MkdirTemp failed: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	// Create 3 temporary source files with different content
	contents := []string{
		"first version of file",
		"second version of file",
		"third version of file",
	}

	paths := make([]string, len(contents))
	for i, c := range contents {
		sf, err := os.CreateTemp("", fmt.Sprintf("p2p_src_%d_*", i))
		if err != nil {
			t.Fatalf("CreateTemp failed: %v", err)
		}
		sf.WriteString(c)
		sf.Close()

		p, err := moveIntoDir(sf.Name(), tmpDir, "document.txt")
		if err != nil {
			t.Fatalf("moveIntoDir failed for %d: %v", i, err)
		}
		paths[i] = p
	}

	// Verify expected filenames
	expectedNames := []string{"document.txt", "document (1).txt", "document (2).txt"}
	for i, exp := range expectedNames {
		if filepath.Base(paths[i]) != exp {
			t.Errorf("File %d has name %q, expected %q", i, filepath.Base(paths[i]), exp)
		}
		// Verify content remained intact
		data, err := os.ReadFile(paths[i])
		if err != nil {
			t.Errorf("ReadFile failed for %s: %v", paths[i], err)
		} else if string(data) != contents[i] {
			t.Errorf("File %d content was overwritten! got %q, expected %q", i, string(data), contents[i])
		}
	}
}

// TestMoveIntoDir_ConcurrentCollisionResolution verifies that concurrent uploads
// with identical filenames do not collide, overwrite, or fail.
func TestMoveIntoDir_ConcurrentCollisionResolution(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "p2p_concurrent_col_*")
	if err != nil {
		t.Fatalf("MkdirTemp failed: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	const numWorkers = 10
	var wg sync.WaitGroup
	errCh := make(chan error, numWorkers)
	savedPaths := make([]string, numWorkers)

	for i := 0; i < numWorkers; i++ {
		wg.Add(1)
		go func(workerID int) {
			defer wg.Done()

			sf, err := os.CreateTemp("", fmt.Sprintf("p2p_worker_%d_*", workerID))
			if err != nil {
				errCh <- err
				return
			}
			data := fmt.Sprintf("Worker payload %d", workerID)
			sf.WriteString(data)
			sf.Close()

			saved, err := moveIntoDir(sf.Name(), tmpDir, "shared_asset.dat")
			if err != nil {
				errCh <- err
				return
			}
			savedPaths[workerID] = saved
		}(i)
	}

	wg.Wait()
	close(errCh)

	for err := range errCh {
		t.Errorf("Concurrent move failed: %v", err)
	}

	// Verify all saved paths exist and are unique
	seen := make(map[string]bool)
	for i, path := range savedPaths {
		if path == "" {
			t.Errorf("Worker %d got empty path", i)
			continue
		}
		if seen[path] {
			t.Errorf("Duplicate path returned across workers: %s", path)
		}
		seen[path] = true

		if _, err := os.Stat(path); err != nil {
			t.Errorf("Saved path %s does not exist on disk: %v", path, err)
		}
	}
}

// TestCrypto_HMACAndAESIntegrity verifies AES-256-GCM authenticated encryption,
// context binding (AAD), and request signature HMAC integrity.
func TestCrypto_HMACAndAESIntegrity(t *testing.T) {
	device := &Device{
		ID:   "device-test-123",
		Name: "Test Device",
		Key:  make([]byte, 32),
	}
	rand.Read(device.Key)

	sessionKey := make([]byte, 32)
	rand.Read(sessionKey)

	session := newSession(device, sessionKey)

	plaintext := []byte("Sensitive peer-to-peer payload data")
	aad := "chunk\ntransfer-abc\n42"

	// 1. Encryption and Decryption with matching AAD
	sealed := session.seal(plaintext, aad)
	decrypted, err := session.open(sealed, aad)
	if err != nil {
		t.Fatalf("Decryption failed: %v", err)
	}
	if !bytes.Equal(decrypted, plaintext) {
		t.Fatalf("Decrypted plaintext mismatch: got %q, want %q", decrypted, plaintext)
	}

	// 2. Decryption with wrong AAD (e.g. wrong chunk index) MUST fail
	wrongAAD := "chunk\ntransfer-abc\n43"
	if _, err := session.open(sealed, wrongAAD); err == nil {
		t.Errorf("Decryption succeeded with wrong AAD! Expected authentication failure")
	}

	// 3. Tampered ciphertext MUST fail GCM authentication
	tampered := make([]byte, len(sealed))
	copy(tampered, sealed)
	tampered[len(tampered)-1] ^= 0x01 // flip a bit in the auth tag
	if _, err := session.open(tampered, aad); err == nil {
		t.Errorf("Decryption succeeded with tampered auth tag! Expected authentication failure")
	}

	// 4. Truncated sealed data MUST fail
	if _, err := session.open(sealed[:sealOverhead-1], aad); err == nil {
		t.Errorf("Decryption succeeded with truncated sealed data! Expected failure")
	}

	// 5. Request signature HMAC verification
	reqURL, _ := url.Parse("http://localhost:8080/upload?chunkIndex=3&n=abc12345&sid=session-1&transferId=tx-99")
	req, _ := http.NewRequest("POST", reqURL.String(), nil)

	sig := requestSignature(session.Key, req)
	if len(sig) != 32 {
		t.Errorf("Expected 32-byte HMAC signature, got %d", len(sig))
	}

	// Verify that changing any query parameter changes the signature
	reqTamperedURL, _ := url.Parse("http://localhost:8080/upload?chunkIndex=4&n=abc12345&sid=session-1&transferId=tx-99")
	reqTampered, _ := http.NewRequest("POST", reqTamperedURL.String(), nil)
	sigTampered := requestSignature(session.Key, reqTampered)
	if hmac.Equal(sig, sigTampered) {
		t.Errorf("HMAC signature did not change when query parameters were modified")
	}
}
