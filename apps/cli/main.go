package main

import (
	"bufio"
	"crypto/tls"
	"embed"
	"encoding/json"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"mime"
	"net"
	"net/http"
	_ "net/http/pprof"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/atotto/clipboard"
	"github.com/gorilla/websocket"
	"github.com/mdp/qrterminal/v3"
)

func init() {
	mime.AddExtensionType(".js", "application/javascript")
	mime.AddExtensionType(".mjs", "application/javascript")
	mime.AddExtensionType(".css", "text/css")
	mime.AddExtensionType(".svg", "image/svg+xml")
	mime.AddExtensionType(".webmanifest", "application/manifest+json")
	mime.AddExtensionType(".json", "application/json")
	mime.AddExtensionType(".wasm", "application/wasm")
}

//go:embed all:dist
var embeddedFS embed.FS

var (
	clipboardMu       sync.RWMutex
	lastClipboardText string
	startTime         = time.Now()

	outboxMu          sync.Mutex
	cliOutbox         []Message
	deviceOutbox      = make(map[string][]Message) // key: device.ID or "" for broadcast
	lastDisconnectMap = make(map[string]time.Time)
	deviceOnlineState = make(map[string]bool)
	lastDisconnectMu  sync.Mutex
)

const (
	Reset     = "\033[0m"
	Bold      = "\033[1m"
	Dim       = "\033[90m"
	Red       = "\033[31m"
	Green     = "\033[32m"
	Yellow    = "\033[33m"
	Blue      = "\033[94m"
	Cyan      = "\033[36m"
	White     = "\033[37m"
	ClearLine = "\r\033[2K"
)

func nowStamp() string {
	return time.Now().Format("15:04")
}

func formatSize(bytes int64) string {
	const unit = 1024
	if bytes < unit {
		return fmt.Sprintf("%d B", bytes)
	}
	div, exp := int64(unit), 0
	for n := bytes / unit; n >= unit; n /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %cB", float64(bytes)/float64(div), "KMGTPE"[exp])
}

// printAsync prints a structured event line from a background goroutine and restores the prompt.
func printAsync(badgeColor, badge, mainText, meta string) {
	metaStr := ""
	if meta != "" {
		metaStr = fmt.Sprintf(" %s(%s)%s", Dim, meta, Reset)
	}
	fmt.Printf("\r\033[2K  %s%s%s  %s%-11s%s %s%s\np2p> ",
		Dim, nowStamp(), Reset,
		badgeColor, badge, Reset,
		mainText, metaStr)
}

// printSync prints a structured event line synchronously inside the REPL loop (prompt is printed by loop).
func printSync(badgeColor, badge, mainText, meta string) {
	metaStr := ""
	if meta != "" {
		metaStr = fmt.Sprintf(" %s(%s)%s", Dim, meta, Reset)
	}
	fmt.Printf("  %s%s%s  %s%-11s%s %s%s\n",
		Dim, nowStamp(), Reset,
		badgeColor, badge, Reset,
		mainText, metaStr)
}

func readClipboardWithRetry() (string, error) {
	var err error
	var text string
	for attempt := 0; attempt < 3; attempt++ {
		text, err = clipboard.ReadAll()
		if err == nil {
			return text, nil
		}
		time.Sleep(50 * time.Millisecond)
	}
	return "", err
}

func watchClipboard() {
	// Seed initial clipboard state so pre-existing clipboard text isn't broadcast on boot
	if initial, err := readClipboardWithRetry(); err == nil && initial != "" {
		clipboardMu.Lock()
		lastClipboardText = initial
		clipboardMu.Unlock()
	}

	pollInterval := 1 * time.Second
	for {
		time.Sleep(pollInterval)
		text, err := readClipboardWithRetry()
		if err != nil {
			if pollInterval < 3*time.Second {
				pollInterval += 500 * time.Millisecond
			}
			continue
		}
		pollInterval = 1 * time.Second

		clipboardMu.RLock()
		prev := lastClipboardText
		clipboardMu.RUnlock()

		if text != "" && text != prev {
			clipboardMu.Lock()
			lastClipboardText = text
			clipboardMu.Unlock()

			msg := Message{
				Type:      "clipboard",
				ID:        fmt.Sprintf("msg-%d", time.Now().UnixNano()),
				Timestamp: time.Now().Unix(),
				Payload:   TextPayload{Text: text},
			}
			// Silently sync PC clipboard to connected devices without interrupting terminal input
			broadcastOnlineOnly(msg)
		} else {
			// Check if an image is on the clipboard (screenshots, copied photos)
			checkAndBroadcastClipboardImage()
		}
	}
}

func copyToClipboard(text string) {
	if *noClipboard {
		return
	}
	clipboardMu.Lock()
	lastClipboardText = text
	clipboardMu.Unlock()

	for attempt := 0; attempt < 3; attempt++ {
		if err := clipboard.WriteAll(text); err == nil {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
}

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool {
		return true // Allow all origins for local network
	},
}

type Client struct {
	conn    *websocket.Conn
	send    chan Message
	device  *Device
	session *Session
	mu      sync.Mutex
	closed  bool
}

func (c *Client) Close() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return
	}
	c.closed = true
	close(c.send)
	if c.conn != nil {
		c.conn.Close()
	}
}

func (c *Client) Enqueue(msg Message) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return false
	}
	select {
	case c.send <- msg:
		return true
	default:
		c.closed = true
		close(c.send)
		if c.conn != nil {
			c.conn.Close()
		}
		return false
	}
}

var (
	clients   = make(map[*Client]bool)
	clientsMu sync.Mutex
)

// localIPs lists the PC's LAN addresses, the one used for outbound traffic first
// (that ignores WSL/Docker virtual adapters), then any other private IPv4 address.
// If offline, returns 127.0.0.1 without hanging or blocking.
func localIPs() []string {
	var ips []string
	add := func(ip net.IP) {
		v4 := ip.To4()
		if v4 == nil || ip.IsLoopback() || (v4[0] == 169 && v4[1] == 254) {
			return
		}
		for _, have := range ips {
			if have == v4.String() {
				return
			}
		}
		ips = append(ips, v4.String())
	}

	// Fast UDP dial with strict 200ms timeout to detect outbound interface without sending packets
	if conn, err := net.DialTimeout("udp", "8.8.8.8:80", 200*time.Millisecond); err == nil {
		if udpAddr, ok := conn.LocalAddr().(*net.UDPAddr); ok {
			add(udpAddr.IP)
		}
		conn.Close()
	}

	// Enumerate network interfaces for private LAN addresses
	if addrs, err := net.InterfaceAddrs(); err == nil {
		for _, address := range addrs {
			if ipnet, ok := address.(*net.IPNet); ok && ipnet.IP.IsPrivate() {
				add(ipnet.IP)
			}
		}
	}

	if len(ips) == 0 {
		ips = append(ips, "127.0.0.1")
	}

	return ips
}

func setupListener(desiredPort int) (net.Listener, int, error) {
	maxPort := desiredPort + 10
	if maxPort > 65535 {
		maxPort = 65535
	}
	var lastErr error
	for p := desiredPort; p <= maxPort; p++ {
		addr := fmt.Sprintf("0.0.0.0:%d", p)
		l, err := net.Listen("tcp", addr)
		if err == nil {
			return l, p, nil
		}
		lastErr = err
	}
	return nil, desiredPort, fmt.Errorf("could not bind to ports %d-%d: %w", desiredPort, maxPort, lastErr)
}

func getFrontendHandler(devMode bool) http.Handler {
	diskCandidates := []string{"../mobile/dist", "apps/mobile/dist", "mobile/dist", "./dist"}
	var diskPath string
	for _, candidate := range diskCandidates {
		if info, err := os.Stat(filepath.Join(candidate, "index.html")); err == nil && !info.IsDir() {
			diskPath = candidate
			break
		}
	}

	if devMode && diskPath != "" {
		fmt.Printf("%s[Web UI]%s Serving frontend from disk (%s) [dev mode]\n", Cyan, Reset, diskPath)
		return http.FileServer(http.Dir(diskPath))
	}

	sub, err := fs.Sub(embeddedFS, "dist")
	if err == nil {
		if f, err := sub.Open("index.html"); err == nil {
			f.Close()
			return http.FileServer(http.FS(sub))
		}
	}

	if diskPath != "" {
		fmt.Printf("%s[Web UI]%s Serving frontend from disk fallback (%s)\n", Cyan, Reset, diskPath)
		return http.FileServer(http.Dir(diskPath))
	}

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "Web UI assets not found. Please build mobile frontend or embed assets.", http.StatusNotFound)
	})
}

func openBrowser(targetURL string) error {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", targetURL)
	case "darwin":
		cmd = exec.Command("open", targetURL)
	default:
		cmd = exec.Command("xdg-open", targetURL)
	}
	err := cmd.Start()
	if err != nil && runtime.GOOS == "windows" {
		return exec.Command("explorer", targetURL).Start()
	}
	return err
}

func printStatus() {
	var mem runtime.MemStats
	runtime.ReadMemStats(&mem)

	uptime := time.Since(startTime).Round(time.Second)
	ips := localIPs()

	devices := listDevices()
	onlineCount := 0
	for _, d := range devices {
		if deviceOnline(d.ID) {
			onlineCount++
		}
	}

	transfersMu.Lock()
	activeCount := len(transfers)
	type transferInfo struct {
		name     string
		progress string
		mode     string
	}
	var transferList []transferInfo
	for _, t := range transfers {
		mode := "receiving"
		if t.IsDownload {
			mode = "sending"
		}
		t.mu.Lock()
		rec := t.receivedCount
		t.mu.Unlock()
		pct := 0.0
		if t.TotalChunks > 0 {
			pct = float64(rec) / float64(t.TotalChunks) * 100
		}
		transferList = append(transferList, transferInfo{
			name:     t.Filename,
			progress: fmt.Sprintf("%.1f%%", pct),
			mode:     mode,
		})
	}
	transfersMu.Unlock()

	fmt.Println(Cyan + "\n--- Server Status ---" + Reset)
	fmt.Printf("  Uptime:       %s%s%s\n", Green, uptime.String(), Reset)
	fmt.Printf("  Active Port:  %s%d%s\n", Yellow, *port, Reset)
	fmt.Printf("  Web UI:       %s%s://localhost:%d%s\n", Cyan, httpScheme(), *port, Reset)
	if len(ips) > 0 {
		fmt.Printf("  LAN URLs:     %s%s://%s:%d%s\n", White, httpScheme(), ips[0], *port, Reset)
		for _, ip := range ips[1:] {
			fmt.Printf("                %s%s://%s:%d%s\n", White, httpScheme(), ip, *port, Reset)
		}
	}
	fmt.Printf("  Memory:       Alloc: %.2f MB | Sys: %.2f MB | Goroutines: %d | GC Cycles: %d\n",
		float64(mem.Alloc)/1024/1024,
		float64(mem.Sys)/1024/1024,
		runtime.NumGoroutine(),
		mem.NumGC,
	)
	fmt.Printf("  Paired:       %d device(s) (%s%d online%s)\n",
		len(devices),
		Green, onlineCount, Reset,
	)
	if activeCount == 0 {
		fmt.Printf("  Transfers:    0 active\n")
	} else {
		fmt.Printf("  Transfers:    %d active\n", activeCount)
		for _, t := range transferList {
			fmt.Printf("    - %s (%s, %s)\n", t.name, t.progress, t.mode)
		}
	}
	fmt.Printf("  Storage Dir:  %s\n\n", receiveDir)
}

var (
	port            = flag.Int("port", 8080, "port to listen on")
	homeFlag        = flag.String("home", "", "directory for received files and app data (default ~/P2P)")
	noClipboard     = flag.Bool("no-clipboard", false, "disable clipboard sync")
	openBrowserFlag = flag.Bool("open", false, "open web UI in default browser on startup")
	devModeFlag     = flag.Bool("dev", false, "serve web UI from disk (mobile/dist) instead of embedded")
	tlsFlag         = flag.Bool("tls", false, "enable HTTPS/WSS with self-signed TLS and cert pinning")
	pprofFlag       = flag.Bool("pprof", false, "enable pprof profiling endpoint on 127.0.0.1:6060")
	debugFlag       = flag.Bool("debug", false, "enable verbose debug logging and profiling")
)

func httpScheme() string {
	if tlsEnabled {
		return "https"
	}
	return "http"
}

func main() {
	flag.Parse()
	if *homeFlag != "" {
		baseDir = *homeFlag
		receiveDir = filepath.Join(baseDir, "received")
		tempDir = filepath.Join(baseDir, "temp")
	}
	initDirs()
	loadState()
	loadHistory()
	cleanTempDir()
	startTransferJanitor()

	initialPort := *port
	listener, activePort, err := setupListener(initialPort)
	if err != nil {
		log.Fatalf("%sFailed to bind port: %v%s\n", Red, err, Reset)
	}
	*port = activePort

	if *tlsFlag {
		tlsConfig, fp, err := setupTLS(baseDir, localIPs())
		if err != nil {
			log.Fatalf("%sFailed to initialize TLS: %v%s\n", Red, err, Reset)
		}
		tlsEnabled = true
		tlsFingerprint = fp
		listener = tls.NewListener(listener, tlsConfig)
	}

	fmt.Print(Cyan + `
    ____ ___  ____     __    _       __  
   / __ \__ \/ __ \   / /   (_)___  / /__
  / /_/ /_/ / /_/ /  / /   / / __ \/ //_/
 / ____/ __/ ____/  / /___/ / / / /  ,<   
/_/   /____/_/     /_____/_/_/ /_/_/|_|  
` + Reset)

	if activePort != initialPort {
		fmt.Printf(Yellow+"  Port %d was busy. Switched to port %d\n"+Reset, initialPort, activePort)
	}
	if *pprofFlag || *debugFlag {
		go func() {
			fmt.Printf("%s[Profiler]%s pprof listening on http://127.0.0.1:6060/debug/pprof/\n", Cyan, Reset)
			if err := http.ListenAndServe("127.0.0.1:6060", nil); err != nil && err != http.ErrServerClosed {
				log.Printf("pprof error: %v", err)
			}
		}()
	}
	if tlsEnabled {
		fmt.Printf(Green+"  Server running on port %d (HTTPS/TLS enabled)"+Reset+" (https://localhost:%d)\n", activePort, activePort)
	} else {
		fmt.Printf(Green+"  Server running on port %d"+Reset+" (http://localhost:%d)\n", activePort, activePort)
	}
	fmt.Println(White + "  Type '" + Yellow + "help" + White + "' for commands.\n" + Reset)

	http.HandleFunc("/ws", handleWebSocket)
	http.HandleFunc("/pair", handlePair)
	http.HandleFunc("/hello", handleHello)
	http.HandleFunc("/unpair", authed(handleUnpair))
	http.HandleFunc("/discover", handleDiscover)
	http.HandleFunc("/api/probe", handleDiscover)
	http.HandleFunc("/upload_check_hash", authed(handleUploadCheckHash))
	http.HandleFunc("/upload_init", authed(handleUploadInit))
	http.HandleFunc("/upload", authed(handleUploadChunk))
	http.HandleFunc("/upload_complete", authed(handleUploadComplete))
	http.HandleFunc("/upload_cancel", authed(handleUploadCancel))
	http.HandleFunc("/download", authed(handleDownloadChunk))
	http.HandleFunc("/download_full", authed(handleDownloadFull))

	// Serve the React PWA (embedded with disk fallback)
	http.Handle("/", getFrontendHandler(*devModeFlag))

	if !*noClipboard {
		go watchClipboard()
	}

	server := &http.Server{}
	go func() {
		if err := server.Serve(listener); err != nil && err != http.ErrServerClosed {
			log.Fatalf("Server error: %v", err)
		}
	}()

	// Start zero-config mDNS service announcement & UDP broadcast discovery
	go func() {
		_, _ = startMDNS(activePort, getServerName(), getServerID(), httpScheme(), tlsFingerprint)
		stopUDP, err := startUDPDiscovery(activePort, getServerName(), getServerID(), httpScheme(), tlsFingerprint)
		if err == nil && stopUDP != nil {
			defer stopUDP()
		}
	}()

	// Auto-display QR Code on startup
	showPairing()

	if *openBrowserFlag {
		go func() {
			time.Sleep(150 * time.Millisecond)
			openBrowser(fmt.Sprintf("%s://localhost:%d", httpScheme(), *port))
		}()
	}

	// CLI input for sending messages
	scanner := bufio.NewScanner(os.Stdin)
	for {
		fmt.Print("p2p> ")
		if !scanner.Scan() {
			break
		}
		text := strings.TrimSpace(scanner.Text())
		if text != "" {
			if answerApproval(text) {
				continue
			}
			if text == "help" {
				fmt.Println(Cyan + "\n  Commands" + Reset)
				fmt.Println("  " + Yellow + "send <path> [--to <device>]" + Reset + "  Send file or folder to all or specific device")
				fmt.Println("  " + Yellow + "> <path> [--to <device>]" + Reset + "     Quick send file or folder")
				fmt.Println("  " + Yellow + "msg <text> [--to <device>]" + Reset + "   Send text message to all or specific device")
				fmt.Println("  " + Yellow + "devices" + Reset + "                  List paired & active devices")
				fmt.Println("  " + Yellow + "trust <device>" + Reset + "          Trust device (auto-accept transfers)")
				fmt.Println("  " + Yellow + "untrust <device>" + Reset + "        Require approval for each transfer")
				fmt.Println("  " + Yellow + "unpair <device>" + Reset + "         Remove a paired device")
				fmt.Println("  " + Yellow + "history" + Reset + "                  Show recent transfer history")
				fmt.Println("  " + Yellow + "status" + Reset + "                   Show server & network info")
				fmt.Println("  " + Yellow + "open" + Reset + "                     Open web interface in browser")
				fmt.Println("  " + Yellow + "setdir <path>" + Reset + "            Change folder for received files")
				fmt.Println("  " + Yellow + "clear" + Reset + "                    Clear terminal screen")
				fmt.Println("  " + Yellow + "exit" + Reset + "                     Stop server")
				fmt.Println()
			} else if text == "exit" {
				fmt.Println(Dim + "  Shutting down..." + Reset)
				os.Exit(0)
			} else if text == "clear" || text == "cls" {
				fmt.Print("\033[H\033[2J")
			} else if text == "open" || text == "ui" {
				url := fmt.Sprintf("%s://localhost:%d", httpScheme(), *port)
				printSync(Green, "● Browser", url, "opened")
				if err := openBrowser(url); err != nil {
					printSync(Red, "! Error", fmt.Sprintf("Failed to open browser: %v", err), "")
				}
			} else if text == "status" || text == "info" {
				printStatus()
			} else if text == "pair" {
				showPairing()
			} else if text == "devices" {
				printDevices()
			} else if text == "history" || text == "log" {
				printTransferHistory()
			} else if strings.HasPrefix(strings.ToLower(text), "trust ") {
				target := strings.TrimSpace(text[6:])
				if setDeviceTrust(target, true) {
					printSync(Green, "● Trusted", target, "transfers auto-accepted")
				} else {
					printSync(Red, "! Error", fmt.Sprintf("No paired device matches %q", target), "")
				}
			} else if strings.HasPrefix(strings.ToLower(text), "untrust ") {
				target := strings.TrimSpace(text[8:])
				if setDeviceTrust(target, false) {
					printSync(Yellow, "○ Untrusted", target, "per-transfer approval required")
				} else {
					printSync(Red, "! Error", fmt.Sprintf("No paired device matches %q", target), "")
				}
			} else if strings.HasPrefix(strings.ToLower(text), "unpair ") {
				unpairDevice(strings.TrimSpace(text[7:]))
			} else if isSendCommand(text) {
				filePath, targetQuery := extractFilePathAndTarget(text)
				fmt.Print("\033[1A\r\033[2K")
				var targetDevice *Device
				if targetQuery != "" {
					targetDevice = findDeviceByQuery(targetQuery)
					if targetDevice == nil {
						printSync(Red, "! Error", fmt.Sprintf("No paired device matches %q (type 'devices')", targetQuery), "")
						continue
					}
				}
				if err := startSendTransferTargeted(filePath, targetDevice); err != nil {
					printSync(Red, "! Error", fmt.Sprintf("Could not send file: %v", err), "")
				}
			} else if strings.HasPrefix(strings.ToLower(text), "setdir ") {
				newDir := strings.TrimSpace(text[7:])
				newDir = strings.Trim(newDir, "\"'")
				if err := setReceiveDir(newDir); err != nil {
					printSync(Red, "! Error", fmt.Sprintf("Failed to set directory: %v", err), "")
				} else {
					printSync(Green, "● Storage", newDir, "receive folder updated")
				}
			} else {
				fmt.Print("\033[1A\r\033[2K")
				cleanText, targetQuery := parseTargetFlag(text)
				if strings.HasPrefix(strings.ToLower(cleanText), "msg ") {
					cleanText = strings.TrimSpace(cleanText[4:])
				}
				var targetDevice *Device
				if targetQuery != "" {
					targetDevice = findDeviceByQuery(targetQuery)
					if targetDevice == nil {
						printSync(Red, "! Error", fmt.Sprintf("No paired device matches %q (type 'devices')", targetQuery), "")
						continue
					}
				}
				msg := Message{
					Version:   1,
					Type:      "text",
					ID:        fmt.Sprintf("msg-%d", time.Now().UnixNano()),
					Timestamp: time.Now().Unix(),
					Payload:   TextPayload{Text: cleanText},
				}
				if targetDevice != nil {
					msg.TargetDeviceID = targetDevice.ID
				}
				delivered := broadcastMessage(msg)
				targetLabel := ""
				if targetDevice != nil {
					targetLabel = fmt.Sprintf(" → %s", targetDevice.Name)
				}
				if delivered > 0 {
					printSync(Cyan, "↑ Sent", cleanText+targetLabel, "")
				} else {
					printSync(Yellow, "↑ Sent", cleanText+targetLabel, "queued")
				}
			}
		}
	}
}

func parseTargetFlag(input string) (string, string) {
	trimmed := strings.TrimSpace(input)
	for strings.HasPrefix(strings.ToLower(trimmed), "p2p>") {
		trimmed = strings.TrimSpace(trimmed[4:])
	}
	lower := strings.ToLower(trimmed)
	idx := strings.Index(lower, " --to ")
	if idx != -1 {
		mainPart := strings.TrimSpace(trimmed[:idx])
		targetPart := strings.TrimSpace(trimmed[idx+6:])
		targetPart = strings.Trim(targetPart, "\"'")
		return mainPart, targetPart
	}
	return trimmed, ""
}

func extractFilePathAndTarget(input string) (string, string) {
	mainPart, target := parseTargetFlag(input)
	filePath := extractFilePath(mainPart)
	return filePath, target
}

func isSendCommand(input string) bool {
	mainPart, _ := parseTargetFlag(input)
	trimmed := strings.TrimSpace(mainPart)
	for strings.HasPrefix(strings.ToLower(trimmed), "p2p>") {
		trimmed = strings.TrimSpace(trimmed[4:])
	}
	lower := strings.ToLower(trimmed)
	if strings.HasPrefix(lower, "send ") || strings.HasPrefix(trimmed, ">") {
		return true
	}
	// Also detect if user dragged & dropped or pasted a valid file path directly into the prompt
	cleaned := strings.Trim(trimmed, "\"'")
	if len(cleaned) >= 2 {
		if _, err := os.Stat(cleaned); err == nil {
			return true
		}
	}
	return false
}

func extractFilePath(input string) string {
	s := strings.TrimSpace(input)
	for strings.HasPrefix(strings.ToLower(s), "p2p>") {
		s = strings.TrimSpace(s[4:])
	}
	for {
		lower := strings.ToLower(s)
		if strings.HasPrefix(lower, "send ") {
			s = strings.TrimSpace(s[5:])
		} else if strings.HasPrefix(s, ">") {
			s = strings.TrimSpace(s[1:])
		} else {
			break
		}
	}
	return strings.Trim(s, "\"'")
}

// showPairing prints a QR code that opens the app and pairs the scanning device.
func showPairing() {
	code := newPairCode()
	ips := localIPs()
	if len(ips) == 0 {
		fmt.Printf("\n%sCould not determine local IP address%s\n", Red, Reset)
		return
	}
	addr := fmt.Sprintf("%s:%d", ips[0], *port)
	qrLink := fmt.Sprintf("%s://%s/#pair=%s", httpScheme(), addr, code)
	if tlsEnabled && tlsFingerprint != "" {
		qrLink = fmt.Sprintf("%s://%s/#pair=%s&cert=%s", httpScheme(), addr, code, tlsFingerprint)
	}
	fmt.Printf("\n  %sScan QR in P2P Link mobile app:%s\n\n", Cyan, Reset)
	qrterminal.GenerateHalfBlock(qrLink, qrterminal.L, os.Stdout)
	fmt.Printf("\n  Manual IP : %s%s%s\n", Yellow, addr, Reset)
	for _, ip := range ips[1:] {
		fmt.Printf("  Alt IP    : %s%s:%d%s\n", Dim, ip, *port, Reset)
	}
	fmt.Printf("  %s──────────────────────────────────────────────────────%s\n\n", Dim, Reset)
}

func deviceOnline(id string) bool {
	clientsMu.Lock()
	defer clientsMu.Unlock()
	for client := range clients {
		if client.device.ID == id {
			return true
		}
	}
	return false
}

func getDeviceRemoteAddr(id string) string {
	clientsMu.Lock()
	defer clientsMu.Unlock()
	for client := range clients {
		if client.device != nil && client.device.ID == id && client.conn != nil {
			return client.conn.RemoteAddr().String()
		}
	}
	return ""
}

func printDevices() {
	devices := listDevices()
	if len(devices) == 0 {
		fmt.Println("  No paired devices. Type 'pair' to add one.")
		return
	}
	fmt.Println(Cyan + "\n  Paired Devices" + Reset)
	for _, d := range devices {
		status := Dim + "last seen " + time.Unix(d.LastSeen, 0).Format("15:04") + Reset
		addr := ""
		if deviceOnline(d.ID) {
			status = Green + "● online" + Reset
			if rAddr := getDeviceRemoteAddr(d.ID); rAddr != "" {
				addr = Dim + "(" + rAddr + ")" + Reset
			}
		}
		trust := Dim + "[approval req]" + Reset
		if d.Trusted {
			trust = Green + "[trusted]" + Reset
		}
		fmt.Printf("  %s%-18s%s %s%-10s%s %-16s %-14s %s\n", White, d.Name, Reset, Dim, d.ID[:8], Reset, trust, status, addr)
	}
	fmt.Printf("  %sTip: Send to specific device using 'send <path> --to <name>'%s\n\n", Dim, Reset)
}

func unpairDevice(query string) {
	device := findDeviceByQuery(strings.Trim(query, "\"'"))
	if device == nil {
		printSync(Red, "! Error", fmt.Sprintf("No paired device matches %q", query), "")
		return
	}
	removeDevice(device.ID)
	dropSessions(device.ID)

	// Clean up any transfers owned by this device to avoid resource leaks
	transfersMu.Lock()
	var abandoned []*TransferState
	for id, state := range transfers {
		if state.Owner == device.ID {
			abandoned = append(abandoned, state)
			delete(transfers, id)
		}
	}
	transfersMu.Unlock()
	for _, state := range abandoned {
		state.discard()
	}

	clientsMu.Lock()
	for client := range clients {
		if client.device.ID == device.ID {
			client.Close()
			delete(clients, client)
		}
	}
	clientsMu.Unlock()
	printSync(Green, "● Unpaired", device.Name, "")
}

func handleWebSocket(w http.ResponseWriter, r *http.Request) {
	session := authenticate(r)
	if session != nil {
		sessionsMu.Lock()
		if session.wsClaimed {
			session = nil
		} else {
			session.wsClaimed = true
		}
		sessionsMu.Unlock()
	}
	if session == nil {
		http.Error(w, "Session expired", http.StatusUnauthorized)
		return
	}
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Println("Upgrade error:", err)
		return
	}

	client := &Client{
		conn:    conn,
		send:    make(chan Message, 256),
		device:  session.Device,
		session: session,
	}
	touchDevice(session.Device)

	clientsMu.Lock()
	clients[client] = true
	clientsMu.Unlock()

	// Flush any pending messages queued while phone was offline
	outboxMu.Lock()
	var pending []Message
	if global, ok := deviceOutbox[""]; ok && len(global) > 0 {
		pending = append(pending, global...)
		deviceOutbox[""] = nil
	}
	if targeted, ok := deviceOutbox[session.Device.ID]; ok && len(targeted) > 0 {
		pending = append(pending, targeted...)
		delete(deviceOutbox, session.Device.ID)
	}
	cliOutbox = nil
	outboxMu.Unlock()

	for _, m := range pending {
		client.Enqueue(m)
	}

	lastDisconnectMu.Lock()
	wasOnline := deviceOnlineState[session.Device.ID]
	lastDisconnect := lastDisconnectMap[session.Device.ID]
	deviceOnlineState[session.Device.ID] = true
	lastDisconnectMu.Unlock()

	if len(pending) > 0 {
		printAsync(Green, "● Online", client.device.Name, fmt.Sprintf("delivered %d queued", len(pending)))
	} else if !wasOnline && time.Since(lastDisconnect) > 4*time.Second {
		printAsync(Green, "● Online", client.device.Name, "")
	}

	go client.writePump()
	client.readPump()
}

func (c *Client) readPump() {
	defer func() {
		clientsMu.Lock()
		delete(clients, c)
		clientsMu.Unlock()
		c.Close()

		lastDisconnectMu.Lock()
		lastDisconnectMap[c.device.ID] = time.Now()
		lastDisconnectMu.Unlock()

		// Debounce disconnect log: only show if device stays offline > 4.5s (not a quick tab switch)
		go func(devId string, devName string) {
			time.Sleep(4500 * time.Millisecond)
			clientsMu.Lock()
			online := false
			for cl := range clients {
				if cl.device.ID == devId {
					online = true
					break
				}
			}
			clientsMu.Unlock()
			if !online {
				lastDisconnectMu.Lock()
				wasOnline := deviceOnlineState[devId]
				deviceOnlineState[devId] = false
				lastDisconnectMu.Unlock()
				if wasOnline {
					printAsync(Yellow, "○ Offline", devName, "")
				}
			}
		}(c.device.ID, c.device.Name)
	}()

	// Frames are encrypted and numbered per direction: anything replayed,
	// reordered, dropped or forged fails to decrypt and ends the connection.
	for counter := 0; ; counter++ {
		_, frame, err := c.conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				log.Printf("error: %v", err)
			}
			break
		}
		plaintext, err := c.session.open(frame, fmt.Sprintf("c2s\n%d", counter))
		if err != nil {
			printAsync(Red, "! Security", c.device.Name, "dropped undecryptable frame")
			break
		}
		var msg Message
		if json.Unmarshal(plaintext, &msg) != nil {
			continue
		}

		if msg.Type == "text" {
			payload, ok := msg.Payload.(map[string]interface{})
			if ok {
				if text, exists := payload["text"].(string); exists {
					copyToClipboard(text)
					printAsync(Blue, "↓ Received", text, "copied")
				}
			}
		} else if msg.Type == "clipboard" {
			payload, ok := msg.Payload.(map[string]interface{})
			if ok {
				if text, exists := payload["text"].(string); exists {
					clipboardMu.RLock()
					prev := lastClipboardText
					clipboardMu.RUnlock()
					if text != "" && text != prev {
						copyToClipboard(text)
						display := strings.ReplaceAll(strings.ReplaceAll(text, "\r\n", " "), "\n", " ")
						if len(display) > 42 {
							display = display[:39] + "..."
						}
						printAsync(Cyan, "↓ Clipboard", fmt.Sprintf("%q", display), "")
					}
				}
			}
		}
	}
}

func (c *Client) writePump() {
	defer func() {
		c.Close()
	}()
	for counter := 0; ; counter++ {
		msg, ok := <-c.send
		if !ok {
			c.conn.WriteMessage(websocket.CloseMessage, []byte{})
			return
		}
		data, err := json.Marshal(msg)
		if err != nil {
			return
		}
		frame := c.session.seal(data, fmt.Sprintf("s2c\n%d", counter))
		if err := c.conn.WriteMessage(websocket.BinaryMessage, frame); err != nil {
			return
		}
	}
}

func broadcastOnlineOnly(msg Message) int {
	clientsMu.Lock()
	delivered := 0
	for client := range clients {
		if msg.TargetDeviceID != "" && client.device != nil && client.device.ID != msg.TargetDeviceID {
			continue
		}
		if client.Enqueue(msg) {
			delivered++
		} else {
			delete(clients, client)
		}
	}
	clientsMu.Unlock()
	return delivered
}

func broadcastMessage(msg Message) int {
	delivered := broadcastOnlineOnly(msg)
	if delivered == 0 {
		outboxMu.Lock()
		bucket := msg.TargetDeviceID
		deviceOutbox[bucket] = append(deviceOutbox[bucket], msg)
		cliOutbox = append(cliOutbox, msg)
		outboxMu.Unlock()
	}
	return delivered
}
