package main

import (
	"encoding/json"
	"fmt"
	"log"
	"math/rand"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/grandcat/zeroconf"
)

// Service discovery: how phones find this PC without typing an address.
//
// Three channels run side by side because each one is blocked on some networks:
//
//	mDNS (_p2plink._tcp)   standard zero-config; the OS/router may filter it
//	UDP announcements      this PC broadcasts "I'm here" to 255.255.255.255,
//	                       every subnet broadcast address and 224.0.0.167
//	HTTP /discover         unicast probe used by the phone's subnet scan
//
// Presence protocol on UDP port 8089 (JSON, one datagram each):
//
//	{"type":"announce", ...DiscoveryInfo}   on start, then every ~4s with jitter
//	{"type":"bye", "id": "<server id>"}     on a clean shutdown
//	reply to "P2P_DISCOVER_REQ"             unicast DiscoveryInfo
//
// Announcements scale linearly with the number of PCs on a network (N packets
// per interval, received by everyone) whereas request/response polling would
// scale quadratically, so announcements are the steady-state mechanism and
// requests are only used by a phone for a short burst right after it starts.

const (
	MDNSServiceType = "_p2plink._tcp"
	MDNSDomain      = "local."
	UDPDiscoverPort = 8089
	DiscoverReqMsg  = "P2P_DISCOVER_REQ"

	announceInterval = 4 * time.Second
	announceJitter   = time.Second // each interval is announceInterval ± announceJitter/2
	requestMinGap    = time.Second // per-source limit on request replies
	byeRepeats       = 2           // datagrams are unreliable: say goodbye twice

	maxTrackedRequesters = 1024
)

type DiscoveryInfo struct {
	Type        string   `json:"type,omitempty"` // "announce" or "bye"; empty in replies and /discover
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

// stopMDNS cleanly unregisters the mDNS service (sends the mDNS "goodbye").
func stopMDNS() {
	mdnsMu.Lock()
	defer mdnsMu.Unlock()
	if mdnsServer != nil {
		mdnsServer.Shutdown()
		mdnsServer = nil
	}
}

// announceTargets lists where announcements are sent; tests point it at loopback.
var announceTargets = localBroadcastAddrs

var (
	discoveryMu  sync.Mutex
	stopUDP      func()
	discoveryOff bool
)

// startDiscovery announces this node over mDNS and UDP broadcast. Failures are
// non-fatal: devices can still pair by scanning the QR code or typing the address.
func startDiscovery(port int, pcName, deviceID, scheme, certFP string) {
	if _, err := startMDNS(port, pcName, deviceID, scheme, certFP); err != nil {
		log.Printf("mDNS announcement unavailable: %v", err)
	}
	stop, err := startUDPDiscovery(port, pcName, deviceID, scheme, certFP)
	if err != nil {
		log.Printf("UDP discovery unavailable: %v", err)
		return
	}
	discoveryMu.Lock()
	defer discoveryMu.Unlock()
	if discoveryOff { // shutdown raced with startup
		stop()
		return
	}
	stopUDP = stop
}

// stopDiscovery says goodbye on every channel and releases the sockets, so
// phones drop this PC from their list immediately instead of waiting for a timeout.
func stopDiscovery() {
	discoveryMu.Lock()
	discoveryOff = true
	stop := stopUDP
	stopUDP = nil
	discoveryMu.Unlock()

	if stop != nil {
		stop() // sends the UDP "bye"
	}
	stopMDNS() // sends the mDNS goodbye
}

// requestLimiter allows one reply per source address per requestMinGap, so a
// burst of phones (or a malicious sender) cannot make this PC flood the network.
type requestLimiter struct {
	mu   sync.Mutex
	last map[string]time.Time
}

func (l *requestLimiter) allow(addr net.Addr) bool {
	host := addr.String()
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	now := time.Now()
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.last == nil {
		l.last = make(map[string]time.Time)
	}
	if t, ok := l.last[host]; ok && now.Sub(t) < requestMinGap {
		return false
	}
	if len(l.last) >= maxTrackedRequesters {
		for k, t := range l.last {
			if now.Sub(t) > requestMinGap {
				delete(l.last, k)
			}
		}
		if len(l.last) >= maxTrackedRequesters {
			return false
		}
	}
	l.last[host] = now
	return true
}

// nextAnnounceDelay is announceInterval with random jitter so PCs that
// started together do not keep transmitting in lock-step.
func nextAnnounceDelay() time.Duration {
	return announceInterval - announceJitter/2 + time.Duration(rand.Int63n(int64(announceJitter)))
}

// startUDPDiscovery listens on the discovery port for phone requests and
// announces presence on the local broadcast and multicast channels. The
// returned stop function broadcasts a goodbye before closing the socket.
func startUDPDiscovery(port int, pcName string, deviceID string, scheme string, certFP string) (func(), error) {
	conn, err := net.ListenUDP("udp4", &net.UDPAddr{Port: UDPDiscoverPort, IP: net.IPv4zero})
	if err != nil {
		// Port might be in use by another instance; non-fatal
		return func() {}, err
	}

	stopCh := make(chan struct{})
	var responderWG, announcerWG sync.WaitGroup

	displayName := func() string {
		if alias := getServerAlias(); alias != "" {
			return alias
		}
		if pcName != "" {
			return pcName
		}
		return getServerName()
	}
	build := func(kind string) []byte {
		info := DiscoveryInfo{
			Type:        kind,
			Name:        displayName(),
			DeviceID:    deviceID,
			Port:        port,
			Scheme:      scheme,
			CertFP:      certFP,
			IPs:         localIPs(),
			Version:     "1.0",
			RequirePair: true,
		}
		b, _ := json.Marshal(info)
		return b
	}
	broadcast := func(payload []byte) {
		for _, dst := range announceTargets() {
			_, _ = conn.WriteTo(payload, dst)
		}
	}

	// 1. Responder: answers DiscoverReqMsg with a unicast DiscoveryInfo.
	responderWG.Add(1)
	go func() {
		defer responderWG.Done()
		var limiter requestLimiter
		buf := make([]byte, 1024)
		for {
			_ = conn.SetReadDeadline(time.Now().Add(time.Second))
			n, remote, err := conn.ReadFrom(buf)
			if err != nil {
				if ne, ok := err.(net.Error); ok && ne.Timeout() {
					select {
					case <-stopCh:
						return
					default:
						continue
					}
				}
				select {
				case <-stopCh:
					return
				default:
				}
				time.Sleep(100 * time.Millisecond) // transient error: avoid a hot loop
				continue
			}
			if strings.HasPrefix(strings.TrimSpace(string(buf[:n])), DiscoverReqMsg) && limiter.allow(remote) {
				_, _ = conn.WriteTo(build(""), remote)
			}
		}
	}()

	// 2. Announcer: immediately (a phone that is already listening learns about
	// us at once), twice more shortly after in case a datagram was lost, then a
	// jittered heartbeat. Also re-registers mDNS if the network or name changed.
	announcerWG.Add(1)
	go func() {
		defer announcerWG.Done()
		sleep := func(d time.Duration) bool {
			t := time.NewTimer(d)
			defer t.Stop()
			select {
			case <-stopCh:
				return false
			case <-t.C:
				return true
			}
		}
		signature := func() string { return displayName() + "|" + strings.Join(localIPs(), ",") }
		lastSig := signature()

		for _, d := range []time.Duration{0, 400 * time.Millisecond, 800 * time.Millisecond} {
			if !sleep(d) {
				return
			}
			broadcast(build("announce"))
		}
		for sleep(nextAnnounceDelay()) {
			if sig := signature(); sig != lastSig {
				lastSig = sig
				go func() { // network changed: refresh the mDNS record too
					if _, err := startMDNS(port, displayName(), deviceID, scheme, certFP); err != nil {
						log.Printf("mDNS re-registration failed: %v", err)
					}
				}()
			}
			broadcast(build("announce"))
		}
	}()

	var stopOnce sync.Once
	return func() {
		stopOnce.Do(func() {
			close(stopCh)
			announcerWG.Wait() // no "announce" may follow the "bye"
			bye, _ := json.Marshal(DiscoveryInfo{Type: "bye", DeviceID: deviceID, Port: port, Name: displayName()})
			for i := 0; i < byeRepeats; i++ {
				broadcast(bye)
				time.Sleep(20 * time.Millisecond)
			}
			conn.Close() // also wakes the responder
			responderWG.Wait()
		})
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
	if mcastIP := net.ParseIP("224.0.0.167"); mcastIP != nil {
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
