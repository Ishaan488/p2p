package main

import (
	"context"
	"crypto/tls"
	"embed"
	"flag"
	"fmt"
	"log"
	"mime"
	"net/http"
	"net/http/pprof"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
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

var startTime = time.Now()

var (
	port                     = flag.Int("port", 8080, "port to listen on")
	homeFlag                 = flag.String("home", "", "directory for received files and app data (default ~/P2P)")
	noClipboard              = flag.Bool("no-clipboard", false, "disable clipboard sync")
	openBrowserFlag          = flag.Bool("open", false, "open Desktop Companion UI in default browser on startup")
	desktopFlag              = flag.Bool("desktop", false, "open Desktop Companion & QR Pairing window on startup")
	devModeFlag              = flag.Bool("dev", false, "serve web UI from disk (mobile/dist) instead of embedded")
	tlsFlag                  = flag.Bool("tls", false, "enable HTTPS/WSS with self-signed TLS and cert pinning")
	pprofFlag                = flag.Bool("pprof", false, "enable pprof profiling endpoint on 127.0.0.1:6060")
	debugFlag                = flag.Bool("debug", false, "enable verbose debug logging and profiling")
	sendFlag                 = flag.String("send", "", "send a file or folder directly via running instance or on startup")
	toFlag                   = flag.String("to", "", "target device name, alias, or ID for --send")
	trayFlag                 = flag.Bool("tray", false, "run with system tray integration (hides console if started from autostart)")
	noTrayFlag               = flag.Bool("no-tray", false, "disable Windows system tray icon")
	installContextMenuFlag   = flag.Bool("install-context-menu", false, "register Windows Explorer 'Send via P2P Link' context menu")
	uninstallContextMenuFlag = flag.Bool("uninstall-context-menu", false, "remove Windows Explorer 'Send via P2P Link' context menu")
	autostartFlag            = flag.String("autostart", "", "configure launch on OS startup ('on' or 'off')")
	bandwidthFlag            = flag.Int64("bandwidth", 0, "bandwidth limit in MB/s (0 = unlimited)")
)

func httpScheme() string {
	if tlsEnabled {
		return "https"
	}
	return "http"
}

var (
	shutdownOnce sync.Once
	shutdownCh   = make(chan struct{})
)

// requestShutdown asks main to stop the server gracefully. Safe to call from
// any goroutine, any number of times.
func requestShutdown() {
	shutdownOnce.Do(func() { close(shutdownCh) })
}

// newMux wires every HTTP route. It is a dedicated mux (not http.DefaultServeMux)
// so nothing registered by an imported package, such as pprof, is ever exposed
// on the LAN listener.
func newMux(devMode bool) *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", handleWebSocket)
	mux.HandleFunc("/pair", handlePair)
	mux.HandleFunc("/hello", handleHello)
	mux.HandleFunc("/unpair", authed(handleUnpair))
	mux.HandleFunc("/discover", handleDiscover)
	mux.HandleFunc("/api/probe", handleDiscover)
	mux.HandleFunc("/upload_check_hash", authed(handleUploadCheckHash))
	mux.HandleFunc("/upload_init", authed(handleUploadInit))
	mux.HandleFunc("/upload", authed(handleUploadChunk))
	mux.HandleFunc("/upload_complete", authed(handleUploadComplete))
	mux.HandleFunc("/upload_cancel", authed(handleUploadCancel))
	mux.HandleFunc("/download", authed(handleDownloadChunk))
	mux.HandleFunc("/download_full", authed(handleDownloadFull))
	mux.HandleFunc("/device_alias", authed(handleDeviceAlias))
	mux.HandleFunc("/settings", authed(handleSettings))
	mux.HandleFunc("/local/send", handleLocalSend)
	mux.HandleFunc("/local/status", handleDesktopStatus)
	mux.HandleFunc("/local/action", handleDesktopAction)
	mux.HandleFunc("/desktop", handleDesktopUI)
	mux.Handle("/", getFrontendHandler(devMode))
	return mux
}

// newHTTPServer builds the server with protection against slow-header clients.
// Read/write timeouts are deliberately unset: they would abort large transfers.
func newHTTPServer(handler http.Handler) *http.Server {
	return &http.Server{
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       2 * time.Minute,
		MaxHeaderBytes:    64 << 10,
	}
}

func startPprof() {
	mux := http.NewServeMux()
	mux.HandleFunc("/debug/pprof/", pprof.Index)
	mux.HandleFunc("/debug/pprof/cmdline", pprof.Cmdline)
	mux.HandleFunc("/debug/pprof/profile", pprof.Profile)
	mux.HandleFunc("/debug/pprof/symbol", pprof.Symbol)
	mux.HandleFunc("/debug/pprof/trace", pprof.Trace)
	go func() {
		fmt.Printf("%s[Profiler]%s pprof listening on http://127.0.0.1:6060/debug/pprof/\n", Cyan, Reset)
		if err := http.ListenAndServe("127.0.0.1:6060", mux); err != nil && err != http.ErrServerClosed {
			log.Printf("pprof error: %v", err)
		}
	}()
}

func printBanner() {
	fmt.Print(Cyan + `
    ____ ___  ____     __    _       __
   / __ \__ \/ __ \   / /   (_)___  / /__
  / /_/ /_/ / /_/ /  / /   / / __ \/ //_/
 / ____/ __/ ____/  / /___/ / / / / ,<
/_/   /____/_/     /_____/_/_/ /_/_/|_|
` + Reset)
}

func main() {
	flag.Parse()
	os.Exit(run())
}

// run starts the server and blocks until shutdown. It returns the process exit code.
func run() int {
	if *port < 1 || *port > 65535 {
		fmt.Fprintf(os.Stderr, "Invalid --port %d (must be 1-65535)\n", *port)
		return 2
	}
	if *homeFlag != "" {
		abs, err := filepath.Abs(*homeFlag)
		if err != nil {
			abs = *homeFlag
		}
		baseDir = abs
		receiveDir = filepath.Join(baseDir, "received")
		tempDir = filepath.Join(baseDir, "temp")
	}

	if code, done := runOneShotFlags(); done {
		return code
	}

	// Direct file/folder sending from Explorer context menu or CLI (FR 42, FR 46):
	// hand the request to an already running instance when there is one.
	directSendPath := strings.TrimSpace(*sendFlag)
	if directSendPath == "" && flag.NArg() >= 2 && strings.EqualFold(flag.Arg(0), "send") {
		directSendPath = flag.Arg(1)
	}
	if directSendPath != "" {
		if abs, err := filepath.Abs(directSendPath); err == nil {
			directSendPath = abs // the running instance has a different working directory
		}
		if trySendViaRunningInstance(directSendPath, *toFlag, *port) {
			fmt.Printf("Queued %q via active P2P Link instance.\n", filepath.Base(directSendPath))
			return 0
		}
	}

	initDirs()
	loadState()
	loadHistory()
	recovered := recoverOrSweepTempDir()
	initLocalIPCToken()
	startTransferJanitor()

	if *bandwidthFlag > 0 {
		setBandwidthLimitBps(*bandwidthFlag * 1024 * 1024)
	}

	initialPort := *port
	listener, activePort, err := setupListener(initialPort)
	if err != nil {
		fmt.Fprintf(os.Stderr, "%sFailed to bind port: %v%s\n", Red, err, Reset)
		return 1
	}
	*port = activePort

	if *tlsFlag {
		tlsConfig, fp, err := setupTLS(baseDir, localIPs())
		if err != nil {
			fmt.Fprintf(os.Stderr, "%sFailed to initialize TLS: %v%s\n", Red, err, Reset)
			_ = listener.Close()
			return 1
		}
		tlsEnabled = true
		tlsFingerprint = fp
		listener = tls.NewListener(listener, tlsConfig)
	}

	publishLocalIPCEndpoint(activePort, httpScheme())

	printBanner()
	if activePort != initialPort {
		fmt.Printf(Yellow+"  Port %d was busy. Switched to port %d\n"+Reset, initialPort, activePort)
	}
	if recovered > 0 {
		fmt.Printf(Green+"  Recovered %d pending transfer(s) from previous session\n"+Reset, recovered)
	}
	if *pprofFlag || *debugFlag {
		startPprof()
	}
	if tlsEnabled {
		fmt.Printf(Green+"  Server running on port %d (HTTPS/TLS enabled)"+Reset+" (https://localhost:%d)\n", activePort, activePort)
	} else {
		fmt.Printf(Green+"  Server running on port %d"+Reset+" (http://localhost:%d)\n", activePort, activePort)
	}
	fmt.Println(White + "  Type '" + Yellow + "help" + White + "' for commands.\n" + Reset)

	server := newHTTPServer(newMux(*devModeFlag))
	serveErr := make(chan error, 1)
	go func() { serveErr <- server.Serve(listener) }()

	if !*noClipboard {
		go watchClipboard()
	}
	if !*noTrayFlag {
		startSystemTray(activePort)
		if *trayFlag {
			// When launched via OS startup with --tray, hide the console window automatically
			toggleConsoleVisibility()
		}
	}

	// Zero-config discovery: mDNS announcement and UDP broadcast.
	go startDiscovery(activePort, getServerName(), getServerID(), httpScheme(), tlsFingerprint)
	go pingActiveHeartbeat()

	showPairing()

	// Launched with --send and no running instance: queue the transfer now.
	if directSendPath != "" {
		target, ok := resolveOptionalTarget(strings.TrimSpace(*toFlag))
		if ok {
			if err := startSendTransferTargeted(directSendPath, target); err != nil {
				printSync(Red, "! Error", fmt.Sprintf("Failed to queue %s: %v", directSendPath, err), "")
			}
		}
	}

	if *openBrowserFlag || *desktopFlag {
		go func() {
			time.Sleep(150 * time.Millisecond)
			_ = openBrowser(fmt.Sprintf("%s://localhost:%d/desktop", httpScheme(), *port))
		}()
	}

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, os.Interrupt, syscall.SIGTERM)

	// The terminal loop ends on EOF (no console attached); the server keeps
	// running until it is told to stop.
	go func() {
		runREPL()
		fmt.Println(Dim + "  (terminal input closed; press Ctrl+C or use the tray menu to stop)" + Reset)
	}()

	exitCode := 0
	select {
	case <-sigCh:
		fmt.Println(Dim + "\n  Signal received, shutting down..." + Reset)
	case <-shutdownCh:
	case err := <-serveErr:
		if err != nil && err != http.ErrServerClosed {
			fmt.Fprintf(os.Stderr, "%sServer error: %v%s\n", Red, err, Reset)
			exitCode = 1
		}
	}

	shutdownServer(server)
	return exitCode
}

// pingActiveHeartbeat sends a once-per-day anonymous ping to GoatCounter
func pingActiveHeartbeat() {
	today := time.Now().UTC().Format("2006-01-02")
	stateMu.Lock()
	last := state.LastHeartbeatDate
	if last == today {
		stateMu.Unlock()
		return
	}
	state.LastHeartbeatDate = today
	saveStateLocked()
	stateMu.Unlock()

	client := &http.Client{Timeout: 6 * time.Second}
	req, err := http.NewRequest("GET", "https://p2plink.goatcounter.com/count?p=/app-active-windows&t=P2P+Link+Active+Windows", nil)
	if err == nil {
		req.Header.Set("User-Agent", "P2P-Link/1.0 (Windows)")
		resp, err := client.Do(req)
		if err == nil && resp != nil && resp.Body != nil {
			_ = resp.Body.Close()
		}
	}
}

// shutdownServer stops accepting work, gives in-flight requests a moment to
// finish, and releases OS resources (tray icon, discovery sockets).
func shutdownServer(server *http.Server) {
	stopSystemTray()
	stopDiscovery()

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := server.Shutdown(ctx); err != nil {
		_ = server.Close() // long-running transfers: cut them; they resume on reconnect
	}
}

// runOneShotFlags handles flags that perform one action and exit (FR 42, FR 47).
func runOneShotFlags() (exitCode int, done bool) {
	switch {
	case *installContextMenuFlag:
		if err := installExplorerContextMenu(); err != nil {
			fmt.Fprintf(os.Stderr, "Failed to install Explorer context menu: %v\n", err)
			return 1, true
		}
		fmt.Println("Windows Explorer context menu ('Send via P2P Link') installed successfully.")
		return 0, true
	case *uninstallContextMenuFlag:
		_ = uninstallExplorerContextMenu()
		fmt.Println("Windows Explorer context menu uninstalled.")
		return 0, true
	case *autostartFlag != "":
		enable := parseOnOff(*autostartFlag)
		if err := setOSAutostart(enable); err != nil {
			fmt.Fprintf(os.Stderr, "Failed to update autostart: %v\n", err)
			return 1, true
		}
		fmt.Printf("OS Autostart set to: %v\n", enable)
		return 0, true
	}
	return 0, false
}
