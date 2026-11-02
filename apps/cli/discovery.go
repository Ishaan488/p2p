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
// and periodically announces presence on local broadcast and multicast channels,
// providing a resilient discovery mechanism for routers that filter mDNS multicast packets.
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

	buildInfo := func() []byte {
		displayName := pcName
		if alias := getServerAlias(); alias != "" {
			displayName = alias
		} else if displayName == "" {
			displayName = getServerName()
		}
		info := DiscoveryInfo{
			Name:        displayName,
			DeviceID:    deviceID,
			Port:        port,
			Scheme:      scheme,
			CertFP:      certFP,
			IPs:         localIPs(),
			Version:     "1.0",
			RequirePair: true,
		}
		respBytes, _ := json.Marshal(info)
		return respBytes
	}

	// 1. Passive listener: immediately answers any DiscoverReqMsg directed at port 8089
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
				respBytes := buildInfo()
				if len(respBytes) > 0 {
					_, _ = conn.WriteTo(respBytes, remoteAddr)
				}
			}
		}
	}()

	// 2. Active periodic announcement: broadcast presence every 3 seconds to all subnet broadcast
	// addresses and multicast group 224.0.0.167 so listening mobile devices discover this PC automatically.
	go func() {
		ticker := time.NewTicker(3 * time.Second)
		defer ticker.Stop()

		for {
			select {
			case <-stopCh:
				return
			case <-ticker.C:
				respBytes := buildInfo()
				if len(respBytes) == 0 {
					continue
				}
				for _, dst := range localBroadcastAddrs() {
					_, _ = conn.WriteTo(respBytes, dst)
				}
			}
		}
	}()

	return func() {
		close(stopCh)
		conn.Close()
	}, nil
}

// localBroadcastAddrs returns all subnet broadcast addresses for active IPv4 interfaces,
// plus universal broadcast (255.255.255.255) and multicast group 224.0.0.167.
func localBroadcastAddrs() []*net.UDPAddr {
	var addrs []*net.UDPAddr
	ifaces, err := net.Interfaces()
	if err == nil {
		for _, iface := range ifaces {
			if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
				continue
			}
			ifAddrs, err := iface.Addrs()
			if err != nil {
				continue
			}
			for _, addr := range ifAddrs {
				ipNet, ok := addr.(*net.IPNet)
				if !ok || ipNet.IP.To4() == nil {
					continue
				}
				ip := ipNet.IP.To4()
				mask := ipNet.Mask
				if len(mask) == 4 {
					bcast := net.IPv4(
						ip[0]|^mask[0],
						ip[1]|^mask[1],
						ip[2]|^mask[2],
						ip[3]|^mask[3],
					)
					addrs = append(addrs, &net.UDPAddr{IP: bcast, Port: UDPDiscoverPort})
				}
			}
		}
	}
	addrs = append(addrs, &net.UDPAddr{IP: net.IPv4bcast, Port: UDPDiscoverPort})
	mcastIP := net.ParseIP("224.0.0.167")
	if mcastIP != nil {
		addrs = append(addrs, &net.UDPAddr{IP: mcastIP, Port: UDPDiscoverPort})
	}
	return addrs
}

// handleDiscover provides an HTTP probe endpoint (`GET /discover` or `GET /api/probe`).
// Returns public node identity and scheme to allow fast subnet scanning when mDNS/multicast is blocked.
func handleDiscover(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "*")
	w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")

	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusOK)
		return
	}

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
	if alias := getServerAlias(); alias != "" {
		return alias
	}
	hostname, _ := os.Hostname()
	if hostname == "" {
		return "Desktop"
	}
	return hostname
}
