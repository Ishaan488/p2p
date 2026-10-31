package main

import (
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/grandcat/zeroconf"
)

// Service discovery constants for P2P Link
const (
	MDNSServiceType = "_p2plink._tcp"
	MDNSDomain      = "local."
	UDPDiscoverPort = 8089
	DiscoverReqMsg  = "P2P_DISCOVER_REQ"
)

type DiscoveryInfo struct {
	Name        string   `json:"name"`
	DeviceID    string   `json:"id"`
	Port        int      `json:"port"`
	Scheme      string   `json:"scheme"`
	CertFP      string   `json:"cert,omitempty"`
	IPs         []string `json:"ips"`
	Version     string   `json:"version"`
	RequirePair bool     `json:"requirePair"`
}

var (
	mdnsServer *zeroconf.Server
	mdnsMu     sync.Mutex
)

// startMDNS announces this P2P Link node on the local network via mDNS (RFC 6762 / Zeroconf).
// Other devices on the same Wi-Fi/LAN can discover it instantly without typing IP addresses.
func startMDNS(port int, pcName string, deviceID string, scheme string, certFP string) (*zeroconf.Server, error) {
	mdnsMu.Lock()
	defer mdnsMu.Unlock()

	if mdnsServer != nil {
		mdnsServer.Shutdown()
		mdnsServer = nil
	}

	hostname, _ := os.Hostname()
	if hostname == "" {
		hostname = pcName
	}
	instanceName := fmt.Sprintf("p2p-%s", strings.ReplaceAll(hostname, " ", "-"))

	txtRecords := []string{
		fmt.Sprintf("name=%s", pcName),
		fmt.Sprintf("id=%s", deviceID),
		fmt.Sprintf("scheme=%s", scheme),
		fmt.Sprintf("port=%d", port),
		"v=1.0",
	}
	if certFP != "" {
		txtRecords = append(txtRecords, fmt.Sprintf("cert=%s", certFP))
	}

	server, err := zeroconf.Register(
		instanceName,
		MDNSServiceType,
		MDNSDomain,
		port,
		txtRecords,
		nil, // bind to all active interfaces
	)
	if err != nil {
		return nil, fmt.Errorf("mDNS register error: %w", err)
	}

	mdnsServer = server
	return server, nil
}

// stopMDNS cleanly unregisters the mDNS service
func stopMDNS() {
	mdnsMu.Lock()
	defer mdnsMu.Unlock()
	if mdnsServer != nil {
		mdnsServer.Shutdown()
		mdnsServer = nil
	}
}

// startUDPDiscovery listens on a local UDP port for broadcast pings from mobile apps or web clients,
// providing a secondary discovery mechanism for routers that filter mDNS multicast packets.
func startUDPDiscovery(port int, pcName string, deviceID string, scheme string, certFP string) (func(), error) {
	addr := &net.UDPAddr{
		Port: UDPDiscoverPort,
		IP:   net.IPv4zero,
	}
	conn, err := net.ListenUDP("udp4", addr)
	if err != nil {
		// Port might be in use by another instance; non-fatal
		return func() {}, err
	}

	stopCh := make(chan struct{})
	go func() {
		defer conn.Close()
		buf := make([]byte, 1024)
		for {
			select {
			case <-stopCh:
				return
			default:
			}

			_ = conn.SetReadDeadline(time.Now().Add(1 * time.Second))
			n, remoteAddr, err := conn.ReadFrom(buf)
			if err != nil {
				continue
			}

			req := strings.TrimSpace(string(buf[:n]))
			if strings.HasPrefix(req, DiscoverReqMsg) {
				info := DiscoveryInfo{
					Name:        pcName,
					DeviceID:    deviceID,
					Port:        port,
					Scheme:      scheme,
					CertFP:      certFP,
					IPs:         localIPs(),
					Version:     "1.0",
					RequirePair: true,
				}
				respBytes, err := json.Marshal(info)
				if err == nil {
					_, _ = conn.WriteTo(respBytes, remoteAddr)
				}
			}
		}
	}()

	return func() {
		close(stopCh)
		conn.Close()
	}, nil
}

// handleDiscover provides an HTTP probe endpoint (`GET /discover` or `GET /api/probe`).
// Returns public node identity and scheme to allow fast subnet scanning when mDNS/multicast is blocked.
func handleDiscover(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Content-Type", "application/json")

	info := DiscoveryInfo{
		Name:        getServerName(),
		DeviceID:    getServerID(),
		Port:        *port,
		Scheme:      httpScheme(),
		CertFP:      tlsFingerprint,
		IPs:         localIPs(),
		Version:     "1.0",
		RequirePair: true,
	}

	_ = json.NewEncoder(w).Encode(info)
}


func getServerName() string {
	hostname, _ := os.Hostname()
	if hostname == "" {
		return "Desktop"
	}
	return hostname
}
