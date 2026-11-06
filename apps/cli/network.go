package main

import (
	"fmt"
	"io/fs"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"time"
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
