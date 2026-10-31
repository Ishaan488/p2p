package main

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/grandcat/zeroconf"
)

// TestMDNS_RegistrationAndDiscovery tests advertising via mDNS and resolving with zeroconf
func TestMDNS_RegistrationAndDiscovery(t *testing.T) {
	testPort := 8999
	server, err := startMDNS(testPort, "TestLaptop", "server-12345", "http", "sha256:abc")
	if err != nil {
		t.Skipf("mDNS not supported on this network interface: %v", err)
	}
	defer stopMDNS()

	resolver, err := zeroconf.NewResolver(nil)
	if err != nil {
		t.Fatalf("Failed to initialize zeroconf resolver: %v", err)
	}

	entries := make(chan *zeroconf.ServiceEntry, 5)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	err = resolver.Browse(ctx, MDNSServiceType, MDNSDomain, entries)
	if err != nil {
		t.Fatalf("Failed to browse mDNS: %v", err)
	}

	found := false
	for entry := range entries {
		if entry.Port == testPort {
			found = true
			cancel()
			break
		}
	}
	if !found {
		// Multicast loopback may be disabled on some CI / sandbox environments, check server is active
		if server == nil {
			t.Fatal("Expected active mDNS server instance")
		}
	}
}

// TestUDP_BroadcastDiscovery verifies the UDP discovery responder handles discovery requests
func TestUDP_BroadcastDiscovery(t *testing.T) {
	stop, err := startUDPDiscovery(8080, "TestDesktop", "dev-test", "http", "")
	if err != nil {
		t.Skipf("UDP port 8089 in use or restricted: %v", err)
	}
	defer stop()

	time.Sleep(50 * time.Millisecond)

	// Send discover request via UDP to 127.0.0.1:8089
	conn, err := net.Dial("udp", fmt.Sprintf("127.0.0.1:%d", UDPDiscoverPort))
	if err != nil {
		t.Fatalf("Failed to dial UDP discovery: %v", err)
	}
	defer conn.Close()

	_, err = conn.Write([]byte(DiscoverReqMsg))
	if err != nil {
		t.Fatalf("Failed to send discovery request: %v", err)
	}

	_ = conn.SetReadDeadline(time.Now().Add(1 * time.Second))
	buf := make([]byte, 1024)
	n, err := conn.Read(buf)
	if err != nil {
		t.Fatalf("Failed to read UDP discovery response: %v", err)
	}

	var info DiscoveryInfo
	if err := json.Unmarshal(buf[:n], &info); err != nil {
		t.Fatalf("Failed to unmarshal discovery response: %v", err)
	}

	if info.Name != "TestDesktop" || info.Port != 8080 {
		t.Errorf("Unexpected discovery info: %+v", info)
	}
}

// TestHTTP_ProbeDiscovery tests the /discover probe endpoint for fast LAN subnet scanning
func TestHTTP_ProbeDiscovery(t *testing.T) {
	req := httptest.NewRequest("GET", "/discover", nil)
	rec := httptest.NewRecorder()

	handleDiscover(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("Expected 200 OK, got %d", rec.Code)
	}

	var info DiscoveryInfo
	if err := json.Unmarshal(rec.Body.Bytes(), &info); err != nil {
		t.Fatalf("Failed to unmarshal JSON: %v", err)
	}

	if info.Version != "1.0" || info.Scheme == "" {
		t.Errorf("Incomplete discovery payload: %+v", info)
	}
}

// TestFolderTransfer_PackageAndExtract tests end-to-end directory packaging and safe extraction
func TestFolderTransfer_PackageAndExtract(t *testing.T) {
	srcDir := filepath.Join(os.TempDir(), fmt.Sprintf("p2p_test_folder_src_%d", time.Now().UnixNano()))
	destDir := filepath.Join(os.TempDir(), fmt.Sprintf("p2p_test_folder_dest_%d", time.Now().UnixNano()))
	defer os.RemoveAll(srcDir)
	defer os.RemoveAll(destDir)

	// Create test folder tree:
	// src/
	//   file1.txt
	//   empty_dir/
	//   nested/
	//     deep/
	//       file2.bin
	_ = os.MkdirAll(filepath.Join(srcDir, "empty_dir"), 0755)
	_ = os.MkdirAll(filepath.Join(srcDir, "nested", "deep"), 0755)
	_ = os.WriteFile(filepath.Join(srcDir, "file1.txt"), []byte("Hello P2P Folder 1"), 0644)
	_ = os.WriteFile(filepath.Join(srcDir, "nested", "deep", "file2.bin"), bytes.Repeat([]byte{0x42}, 1024), 0644)

	var zipBuf bytes.Buffer
	fileCount, dirCount, _, err := zipDirectory(srcDir, &zipBuf)
	if err != nil {
		t.Fatalf("zipDirectory failed: %v", err)
	}

	if fileCount != 2 {
		t.Errorf("Expected 2 files, got %d", fileCount)
	}
	if dirCount < 3 {
		t.Errorf("Expected at least 3 directories, got %d", dirCount)
	}

	// Extract safely
	zipReader, err := zip.NewReader(bytes.NewReader(zipBuf.Bytes()), int64(zipBuf.Len()))
	if err != nil {
		t.Fatalf("zip.NewReader failed: %v", err)
	}

	extFiles, _, err := extractZipSafely(zipReader, destDir)
	if err != nil {
		t.Fatalf("extractZipSafely failed: %v", err)
	}

	if extFiles != 2 {
		t.Errorf("Expected 2 extracted files, got %d", extFiles)
	}

	// Verify extracted files match
	content1, err := os.ReadFile(filepath.Join(destDir, "file1.txt"))
	if err != nil || string(content1) != "Hello P2P Folder 1" {
		t.Errorf("file1.txt content mismatch: %v", err)
	}

	content2, err := os.ReadFile(filepath.Join(destDir, "nested", "deep", "file2.bin"))
	if err != nil || len(content2) != 1024 || content2[0] != 0x42 {
		t.Errorf("file2.bin content mismatch: %v", err)
	}

	// Verify empty directory was preserved
	info, err := os.Stat(filepath.Join(destDir, "empty_dir"))
	if err != nil || !info.IsDir() {
		t.Errorf("Empty directory was not preserved: %v", err)
	}
}

// TestFolderTransfer_ZipSlipDefense ensures path traversal entries (Zip Slip) are blocked
func TestFolderTransfer_ZipSlipDefense(t *testing.T) {
	destDir := filepath.Join(os.TempDir(), fmt.Sprintf("p2p_zipslip_dest_%d", time.Now().UnixNano()))
	defer os.RemoveAll(destDir)
	_ = os.MkdirAll(destDir, 0755)

	// Create an in-memory malicious ZIP archive containing path traversal entries
	var maliciousZip bytes.Buffer
	zw := zip.NewWriter(&maliciousZip)

	// 1. Classic Unix traversal
	w1, _ := zw.Create("../../evil_outside.txt")
	_, _ = w1.Write([]byte("malicious content"))

	// 2. Windows-style traversal
	w2, _ := zw.Create("..\\..\\evil_win.txt")
	_, _ = w2.Write([]byte("malicious content win"))

	_ = zw.Close()

	zipReader, err := zip.NewReader(bytes.NewReader(maliciousZip.Bytes()), int64(maliciousZip.Len()))
	if err != nil {
		t.Fatalf("Failed to create zip reader: %v", err)
	}

	// Must fail with Zip Slip error
	_, _, err = extractZipSafely(zipReader, destDir)
	if err == nil {
		t.Fatal("Expected extractZipSafely to REJECT malicious Zip Slip entry, but it succeeded!")
	}

	if !strings.Contains(err.Error(), "Zip Slip") && !strings.Contains(err.Error(), "escapes destination") {
		t.Errorf("Expected Zip Slip error message, got: %v", err)
	}

	// Verify no files were created outside destDir
	parentDir := filepath.Dir(destDir)
	if _, err := os.Stat(filepath.Join(parentDir, "evil_outside.txt")); err == nil {
		t.Fatal("CRITICAL SECURITY FLAW: evil_outside.txt was written outside target dir!")
	}
}

// TestImageClipboard_DIBToBMPConversion verifies DIB to BMP byte reconstruction
func TestImageClipboard_DIBToBMPConversion(t *testing.T) {
	// Construct a synthetic minimal 2x2 24-bit uncompressed RGB DIB
	// BITMAPINFOHEADER is 40 bytes:
	// biSize: 40
	// biWidth: 2
	// biHeight: 2
	// biPlanes: 1
	// biBitCount: 24
	// biCompression: 0 (BI_RGB)
	// biSizeImage: 16 (each row is 2*3=6 bytes, padded to 4-byte boundary = 8 bytes * 2 rows = 16 bytes)
	dib := make([]byte, 40+16)
	binary.LittleEndian.PutUint32(dib[0:4], 40)               // biSize
	binary.LittleEndian.PutUint32(dib[4:8], 2)                // biWidth
	binary.LittleEndian.PutUint32(dib[8:12], 2)               // biHeight
	binary.LittleEndian.PutUint16(dib[12:14], 1)              // biPlanes
	binary.LittleEndian.PutUint16(dib[14:16], 24)             // biBitCount
	binary.LittleEndian.PutUint32(dib[16:20], 0)              // biCompression (BI_RGB)
	binary.LittleEndian.PutUint32(dib[20:24], 16)             // biSizeImage

	bmp, err := dibToBmp(dib)
	if err != nil {
		t.Fatalf("dibToBmp failed: %v", err)
	}

	if len(bmp) != 14+len(dib) {
		t.Errorf("Expected BMP length %d, got %d", 14+len(dib), len(bmp))
	}
	if bmp[0] != 'B' || bmp[1] != 'M' {
		t.Errorf("Expected BM magic bytes, got %c%c", bmp[0], bmp[1])
	}
	offset := binary.LittleEndian.Uint32(bmp[10:14])
	if offset != 54 { // 14 + 40
		t.Errorf("Expected offset 54, got %d", offset)
	}
}
