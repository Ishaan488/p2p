package main

import (
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
	"unicode/utf8"
)

// Regression tests for the hardening pass: each one pins a defect that used to exist.

func TestPrintableText_StripsTerminalEscapes(t *testing.T) {
	got := printableText("hi\x1b[2J\x1b]0;pwned\x07 there\r\nnext", 0)
	if strings.ContainsAny(got, "\x1b\x07") {
		t.Fatalf("control characters survived: %q", got)
	}
	if !strings.Contains(got, "hi") || !strings.Contains(got, "next") {
		t.Fatalf("visible text was lost: %q", got)
	}
	if got := printableText(strings.Repeat("é", 100), 10); utf8.RuneCountInString(got) != 10 {
		t.Fatalf("truncation must count runes, got %d", utf8.RuneCountInString(got))
	}
}

func TestSanitizeFilename_NeverProducesInvalidUTF8(t *testing.T) {
	for _, name := range []string{
		strings.Repeat("日", 120) + ".txt",
		strings.Repeat("é", 150) + "." + strings.Repeat("ü", 40),
		strings.Repeat("a", 400),
	} {
		got := sanitizeFilename(name)
		if !utf8.ValidString(got) {
			t.Errorf("sanitizeFilename produced invalid UTF-8 for %.20q...", name)
		}
		if len(got) > maxFilenameBytes {
			t.Errorf("name is %d bytes, limit is %d", len(got), maxFilenameBytes)
		}
	}
}

func TestDeviceLookup_EmptyQueryMatchesNothing(t *testing.T) {
	cleanup := setupTestEnvironment(t)
	defer cleanup()
	stateMu.Lock()
	savedDevices := state.Devices
	state.Devices = nil // other tests leave paired devices behind
	stateMu.Unlock()
	defer func() {
		stateMu.Lock()
		state.Devices = savedDevices
		stateMu.Unlock()
	}()
	registerDevice("device-aaaaaaaa", "Phone", make([]byte, 32))

	if d := findDeviceByQuery(""); d != nil {
		t.Fatalf("empty query matched %q", d.Name)
	}
	if d := resolveDeviceTarget("   "); d != nil {
		t.Fatalf("blank target matched %q", d.Name)
	}
	if _, ok := setDeviceAlias("", "x"); ok {
		t.Fatal("empty query must not rename a device")
	}
	if setDeviceTrust("", true) {
		t.Fatal("empty query must not trust a device")
	}
	// A "#1" index (as advertised by the `devices` tip) resolves.
	if d := resolveDeviceTarget("#1"); d == nil || d.Name != "Phone" {
		t.Fatalf("#1 should resolve to the first device, got %v", d)
	}
}

func TestDownload_OnlyTheTargetDeviceMayFetch(t *testing.T) {
	cleanup := setupTestEnvironment(t)
	defer cleanup()

	src := filepath.Join(t.TempDir(), "secret.txt")
	if err := os.WriteFile(src, []byte("for A only"), 0o600); err != nil {
		t.Fatal(err)
	}
	owner := &Device{ID: "device-owner-1", Name: "Owner", Key: make([]byte, 32)}
	if err := startSendTransferTargeted(src, owner); err != nil {
		t.Fatal(err)
	}
	var id string
	transfersMu.Lock()
	for tid, st := range transfers {
		if st.FilePath == src {
			id = tid
		}
	}
	transfersMu.Unlock()
	if id == "" {
		t.Fatal("download was not registered")
	}

	other := newSession(&Device{ID: "device-other-2", Name: "Other", Key: make([]byte, 32)}, make([]byte, 32))
	mine := newSession(owner, make([]byte, 32))

	for _, tc := range []struct {
		name    string
		session *Session
		want    int
	}{{"other device", other, http.StatusNotFound}, {"target device", mine, http.StatusOK}} {
		for _, h := range []struct {
			path string
			fn   func(http.ResponseWriter, *http.Request, *Session)
		}{{"/download_full", handleDownloadFull}, {"/download", handleDownloadChunk}} {
			url := fmt.Sprintf("%s?transferId=%s&chunkIndex=0", h.path, id)
			w := httptest.NewRecorder()
			h.fn(w, httptest.NewRequest("GET", url, nil), tc.session)
			if w.Code != tc.want {
				t.Errorf("%s %s: status %d, want %d", tc.name, h.path, w.Code, tc.want)
			}
		}
	}
}

func TestMux_DoesNotExposePprof(t *testing.T) {
	// Importing net/http/pprof registers handlers on http.DefaultServeMux; the
	// LAN-facing server must not use it.
	w := httptest.NewRecorder()
	newMux(false).ServeHTTP(w, httptest.NewRequest("GET", "/debug/pprof/heap?debug=1", nil))
	if body := w.Body.String(); strings.Contains(body, "heap profile") || strings.Contains(body, "Types of profiles") {
		t.Fatal("pprof is reachable through the application mux")
	}
}

func TestHTTPServer_HasHeaderTimeout(t *testing.T) {
	srv := newHTTPServer(http.NewServeMux())
	if srv.ReadHeaderTimeout <= 0 {
		t.Fatal("ReadHeaderTimeout must be set to defeat slow-header clients")
	}
	if srv.ReadTimeout != 0 || srv.WriteTimeout != 0 {
		t.Fatal("Read/WriteTimeout would abort large transfers and must stay unset")
	}
}

func TestOutbox_IsBounded(t *testing.T) {
	cleanup := setupTestEnvironment(t)
	defer cleanup()
	outboxMu.Lock()
	deviceOutbox = make(map[string][]Message)
	outboxMu.Unlock()

	for i := 0; i < maxOutboxPerQueue*3; i++ {
		queueOffline(Message{Type: "text", ID: fmt.Sprint(i), TargetDeviceID: "dev"})
	}
	got := takeOutbox("dev")
	if len(got) != maxOutboxPerQueue {
		t.Fatalf("queue held %d messages, want cap %d", len(got), maxOutboxPerQueue)
	}
	if last := got[len(got)-1].ID; last != fmt.Sprint(maxOutboxPerQueue*3-1) {
		t.Fatalf("newest message must be kept, last is %s", last)
	}
	if len(takeOutbox("dev")) != 0 {
		t.Fatal("taking the outbox must empty it")
	}
}

func TestStartDiscovery_StaysRunningUntilStopped(t *testing.T) {
	probe, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4zero, Port: UDPDiscoverPort})
	if err != nil {
		t.Skipf("discovery port busy: %v", err)
	}
	probe.Close()

	cleanup := setupTestEnvironment(t)
	defer cleanup()
	discoveryMu.Lock()
	discoveryOff = false
	discoveryMu.Unlock()

	go startDiscovery(8080, "TestPC", "server-id", "http", "")
	defer stopDiscovery()

	// The old code closed the socket as soon as startup finished.
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		time.Sleep(300 * time.Millisecond)
		conn, err := net.Dial("udp4", fmt.Sprintf("127.0.0.1:%d", UDPDiscoverPort))
		if err != nil {
			continue
		}
		_, _ = conn.Write([]byte(DiscoverReqMsg))
		_ = conn.SetReadDeadline(time.Now().Add(500 * time.Millisecond))
		buf := make([]byte, 2048)
		n, err := conn.Read(buf)
		conn.Close()
		if err == nil && strings.Contains(string(buf[:n]), `"server-id"`) {
			return
		}
	}
	t.Fatal("UDP discovery does not answer requests")
}

func TestLocalIPCEndpoint_RoundTrip(t *testing.T) {
	cleanup := setupTestEnvironment(t)
	defer cleanup()

	initLocalIPCToken()
	publishLocalIPCEndpoint(9123, "https")
	token, port, scheme, ok := readLocalIPCEndpoint(8080)
	if !ok || token != localIPCToken || port != 9123 || scheme != "https" {
		t.Fatalf("got token=%q port=%d scheme=%q ok=%v", token, port, scheme, ok)
	}

	// Files written by older versions contain only the token.
	if err := os.WriteFile(localTokenFilePath(), []byte("legacytoken"), 0o600); err != nil {
		t.Fatal(err)
	}
	token, port, scheme, ok = readLocalIPCEndpoint(8080)
	if !ok || token != "legacytoken" || port != 8080 || scheme != "http" {
		t.Fatalf("legacy file: token=%q port=%d scheme=%q ok=%v", token, port, scheme, ok)
	}
}

func TestWriteFileAtomic_ReplacesWithoutLeavingTempFiles(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "state.json")
	for _, content := range []string{"first", "second"} {
		if err := writeFileAtomic(p, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if b, _ := os.ReadFile(p); string(b) != "second" {
		t.Fatalf("content = %q", b)
	}
	if entries, _ := os.ReadDir(dir); len(entries) != 1 {
		t.Fatalf("expected only the target file, found %d entries", len(entries))
	}
}

func TestParseOnOff(t *testing.T) {
	for in, want := range map[string]bool{"on": true, "ON": true, "true": true, "1": true, "enable": true, "off": false, "": false, "no": false, "garbage": false} {
		if got := parseOnOff(in); got != want {
			t.Errorf("parseOnOff(%q) = %v, want %v", in, got, want)
		}
	}
}

func TestZipDirectory_SkipsUnreadableAndProducesValidArchive(t *testing.T) {
	src := t.TempDir()
	_ = os.WriteFile(filepath.Join(src, "a.txt"), []byte("hello"), 0o600)
	_ = os.MkdirAll(filepath.Join(src, "empty"), 0o755)

	var sink strings.Builder
	files, dirs, _, err := zipDirectory(src, &sink)
	if err != nil {
		t.Fatal(err)
	}
	if files != 1 || dirs != 1 {
		t.Fatalf("files=%d dirs=%d", files, dirs)
	}
	// The archive must end with a central directory (explicit Close).
	if !strings.Contains(sink.String(), "PK\x05\x06") {
		t.Fatal("zip is missing its end-of-central-directory record")
	}
}

func TestRevokeDevice_RemovesEverythingTiedToIt(t *testing.T) {
	cleanup := setupTestEnvironment(t)
	defer cleanup()

	dev := registerDevice("device-revoke-1", "Gone", make([]byte, 32))
	sess := makeTestSession(dev.ID, dev.Name)
	queueOffline(Message{Type: "text", TargetDeviceID: dev.ID})
	transfersMu.Lock()
	transfers["t-revoke"] = &TransferState{ID: "t-revoke", Owner: dev.ID, IsDownload: true}
	transfersMu.Unlock()

	revokeDevice(dev.ID)

	if findDevice(dev.ID) != nil {
		t.Error("device still paired")
	}
	sessionsMu.Lock()
	_, live := sessions[sess.ID]
	sessionsMu.Unlock()
	if live {
		t.Error("session survived revocation")
	}
	transfersMu.Lock()
	_, kept := transfers["t-revoke"]
	transfersMu.Unlock()
	if kept {
		t.Error("transfer survived revocation")
	}
	if len(takeOutbox(dev.ID)) != 0 {
		t.Error("queued messages survived revocation")
	}
}

func TestRequestLimiter_OneReplyPerSourcePerGap(t *testing.T) {
	var l requestLimiter
	a := &net.UDPAddr{IP: net.IPv4(10, 0, 0, 5), Port: 4000}
	aOtherPort := &net.UDPAddr{IP: net.IPv4(10, 0, 0, 5), Port: 4001}
	b := &net.UDPAddr{IP: net.IPv4(10, 0, 0, 6), Port: 4000}
	if !l.allow(a) {
		t.Fatal("first request must be answered")
	}
	if l.allow(a) || l.allow(aOtherPort) {
		t.Fatal("a second request from the same host inside the gap must be dropped")
	}
	if !l.allow(b) {
		t.Fatal("a different host must not be affected")
	}
}

func TestNextAnnounceDelay_StaysWithinJitterWindow(t *testing.T) {
	lo, hi := announceInterval-announceJitter/2, announceInterval+announceJitter/2
	seen := map[time.Duration]bool{}
	for i := 0; i < 200; i++ {
		d := nextAnnounceDelay()
		if d < lo || d > hi {
			t.Fatalf("delay %v outside [%v, %v]", d, lo, hi)
		}
		seen[d] = true
	}
	if len(seen) < 20 {
		t.Fatal("delays are not jittered")
	}
}

func TestStopDiscovery_IsFastAndIdempotent(t *testing.T) {
	stop, err := startUDPDiscovery(8080, "PC", "id-1", "http", "")
	if err != nil {
		t.Skipf("discovery port busy: %v", err)
	}
	start := time.Now()
	stop()
	stop()
	if d := time.Since(start); d > 500*time.Millisecond {
		t.Fatalf("stop took %v; the responder should wake immediately", d)
	}
}

func TestDecodeAppleScriptData(t *testing.T) {
	// osascript prints the clipboard as text: «data PNGf<hex>»
	got, err := decodeAppleScriptData([]byte("«data PNGf89504E470D0A1A0A»\n"))
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "\x89PNG\r\n\x1a\n" {
		t.Fatalf("decoded %q", got)
	}
	for _, bad := range []string{"", "plain text", "«data »", "«data PNGfZZ»"} {
		if _, err := decodeAppleScriptData([]byte(bad)); err == nil {
			t.Errorf("%q should not decode", bad)
		}
	}
}

func TestLaunchdPlist_EscapesPathsAndRunsAtLoad(t *testing.T) {
	plist := renderLaunchdPlist("/Users/a&b/Apps <x>/p2p", "/Users/a&b/P2P/p2p.log")
	for _, want := range []string{
		"<key>RunAtLoad</key>\n\t<true/>",
		"<string>/Users/a&amp;b/Apps &lt;x&gt;/p2p</string>",
		"<string>--no-tray</string>",
		launchdLabel,
	} {
		if !strings.Contains(plist, want) {
			t.Errorf("plist is missing %q:\n%s", want, plist)
		}
	}
	if strings.Contains(plist, "a&b") {
		t.Error("unescaped ampersand would make the plist invalid XML")
	}
}

// A phone must hear about a PC at once (announce) and learn immediately when it
// leaves (bye); these are the two datagrams the live device list depends on.
func TestUDPDiscovery_AnnouncesOnStartAndSaysGoodbyeOnStop(t *testing.T) {
	phone, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Skipf("cannot open loopback socket: %v", err)
	}
	defer phone.Close()

	saved := announceTargets
	announceTargets = func() []*net.UDPAddr { return []*net.UDPAddr{phone.LocalAddr().(*net.UDPAddr)} }
	defer func() { announceTargets = saved }()

	stop, err := startUDPDiscovery(8080, "Office PC", "server-xyz", "http", "")
	if err != nil {
		t.Skipf("discovery port busy: %v", err)
	}
	defer stop()

	read := func(within time.Duration) (DiscoveryInfo, bool) {
		_ = phone.SetReadDeadline(time.Now().Add(within))
		buf := make([]byte, 2048)
		n, _, err := phone.ReadFromUDP(buf)
		if err != nil {
			return DiscoveryInfo{}, false
		}
		var info DiscoveryInfo
		if json.Unmarshal(buf[:n], &info) != nil {
			t.Fatalf("not JSON: %q", buf[:n])
		}
		return info, true
	}

	info, ok := read(time.Second)
	if !ok || info.Type != "announce" || info.DeviceID != "server-xyz" || info.Name != "Office PC" || info.Port != 8080 {
		t.Fatalf("expected an immediate announce, got %+v (ok=%v)", info, ok)
	}

	stop()
	sawBye := false
	for i := 0; i < 8 && !sawBye; i++ { // queued announces may precede the bye
		if m, ok := read(500 * time.Millisecond); ok && m.Type == "bye" && m.DeviceID == "server-xyz" {
			sawBye = true
		}
	}
	if !sawBye {
		t.Fatal("no goodbye was sent on stop")
	}
	// Nothing may follow the goodbye, or the phone would list the PC again.
	for {
		m, ok := read(300 * time.Millisecond)
		if !ok {
			break
		}
		if m.Type == "announce" {
			t.Fatal("an announce arrived after the goodbye")
		}
	}
}
