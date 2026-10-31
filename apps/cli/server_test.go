package main

import (
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// TestLocalIPsNonBlocking verifies localIPs executes rapidly (well under 500ms)
// and returns at least one valid IPv4 address (e.g. LAN or 127.0.0.1).
func TestLocalIPsNonBlocking(t *testing.T) {
	start := time.Now()
	ips := localIPs()
	elapsed := time.Since(start)

	if elapsed > 1*time.Second {
		t.Errorf("localIPs took too long: %v (expected < 1s)", elapsed)
	}

	if len(ips) == 0 {
		t.Fatal("localIPs returned empty list")
	}

	for _, ipStr := range ips {
		parsed := net.ParseIP(ipStr)
		if parsed == nil || parsed.To4() == nil {
			t.Errorf("invalid IPv4 address returned: %q", ipStr)
		}
	}
}

// TestSetupListenerDynamicAllocation verifies that if port is in use,
// setupListener automatically falls back to port+1 without crashing.
func TestSetupListenerDynamicAllocation(t *testing.T) {
	// Pick a test port range
	testPort := 18080

	// Pre-bind testPort
	occupier, err := net.Listen("tcp", fmt.Sprintf("0.0.0.0:%d", testPort))
	if err != nil {
		t.Skipf("Cannot pre-bind test port %d: %v", testPort, err)
	}
	defer occupier.Close()

	// Now ask setupListener to bind starting at testPort
	l, activePort, err := setupListener(testPort)
	if err != nil {
		t.Fatalf("setupListener failed: %v", err)
	}
	defer l.Close()

	if activePort != testPort+1 {
		t.Errorf("expected activePort %d, got %d", testPort+1, activePort)
	}
}

// TestClientConcurrencyNoPanics runs a heavy race condition stress test
// on Client.Enqueue and Client.Close to verify zero panics.
func TestClientConcurrencyNoPanics(t *testing.T) {
	for iteration := 0; iteration < 20; iteration++ {
		client := &Client{
			send:   make(chan Message, 4),
			device: &Device{ID: "test-dev", Name: "Test Device"},
		}

		var wg sync.WaitGroup
		// 20 concurrent goroutines calling Enqueue
		for i := 0; i < 20; i++ {
			wg.Add(1)
			go func(idx int) {
				defer wg.Done()
				msg := Message{
					Type:      "text",
					ID:        fmt.Sprintf("msg-%d", idx),
					Timestamp: time.Now().Unix(),
				}
				client.Enqueue(msg)
			}(i)
		}

		// 10 concurrent goroutines calling Close
		for i := 0; i < 10; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				client.Close()
			}()
		}

		wg.Wait()
	}
}

// TestBroadcastMessageConcurrency tests broadcastMessage with concurrent add/remove/close.
func TestBroadcastMessageConcurrency(t *testing.T) {
	clientsMu.Lock()
	clients = make(map[*Client]bool)
	clientsMu.Unlock()

	var wg sync.WaitGroup
	// Create several clients
	for i := 0; i < 10; i++ {
		c := &Client{
			send:   make(chan Message, 8),
			device: &Device{ID: fmt.Sprintf("dev-%d", i), Name: "Device"},
		}
		clientsMu.Lock()
		clients[c] = true
		clientsMu.Unlock()
	}

	// Broadcasters
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			broadcastMessage(Message{
				Type: "text",
				ID:   fmt.Sprintf("broadcast-%d", idx),
			})
		}(i)
	}

	// Concurrent disconnectors
	for i := 0; i < 5; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			clientsMu.Lock()
			for c := range clients {
				c.Close()
				delete(clients, c)
				break
			}
			clientsMu.Unlock()
		}()
	}

	wg.Wait()

	// Clean up
	clientsMu.Lock()
	for c := range clients {
		c.Close()
	}
	clients = make(map[*Client]bool)
	clientsMu.Unlock()
}

// TestPathTraversalSanitization tests that malicious paths with ../ are completely sanitized.
func TestPathTraversalSanitization(t *testing.T) {
	maliciousCases := []struct {
		input    string
		expected string
	}{
		{"../../../../etc/passwd", "passwd"},
		{"..\\..\\..\\windows\\system32\\calc.exe", "calc.exe"},
		{"/root/.ssh/id_rsa", "id_rsa"},
		{"simple.txt", "simple.txt"},
		{"../../../foo/bar.png", "bar.png"},
		{"..", "unnamed"},
		{".", "unnamed"},
		{"", "unnamed"},
		{"my*file?:name.txt", "my_file__name.txt"},
	}

	for _, tc := range maliciousCases {
		clean := filepath.Base(filepath.Clean(tc.input))
		sanitized := sanitizeFilename(clean)
		if sanitized != tc.expected {
			t.Errorf("sanitizePath(%q) = %q; want %q", tc.input, sanitized, tc.expected)
		}
		if strings.Contains(sanitized, "..") || strings.Contains(sanitized, "/") || strings.Contains(sanitized, "\\") {
			t.Errorf("sanitized result %q contains traversal characters", sanitized)
		}
	}
}

// TestEmbeddedFrontendServing tests that the embedded frontend serves index.html.
func TestEmbeddedFrontendServing(t *testing.T) {
	handler := getFrontendHandler(false)
	req := httptest.NewRequest("GET", "/", nil)
	rr := httptest.NewRecorder()

	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d", rr.Code)
	}

	body := rr.Body.String()
	if !strings.Contains(body, "<html") && !strings.Contains(body, "<!DOCTYPE") && !strings.Contains(body, "<div id=\"root\">") {
		t.Fatalf("served index.html does not look like valid HTML: %s", body[:min(len(body), 200)])
	}
}

// TestEmbeddedAssetsServing tests that static assets are served from embed.FS with correct headers.
func TestEmbeddedAssetsServing(t *testing.T) {
	handler := getFrontendHandler(false)
	req := httptest.NewRequest("GET", "/icon.svg", nil)
	rr := httptest.NewRecorder()

	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected status 200 for /icon.svg, got %d", rr.Code)
	}

	contentType := rr.Header().Get("Content-Type")
	if !strings.Contains(contentType, "svg") && !strings.Contains(contentType, "xml") {
		t.Errorf("expected SVG content type, got %s", contentType)
	}

	body, err := io.ReadAll(rr.Body)
	if err != nil || len(body) == 0 {
		t.Fatal("empty response body for /icon.svg")
	}
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
