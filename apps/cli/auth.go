package main

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

// Pairing and authentication.
//
// The PC shows a QR code holding a short-lived secret. The secret never
// travels over the network: both sides derive a per-device key from it and the
// device proves it knows the key. A device that only knows the PC's address
// instead sends its own key, which the PC owner approves at the terminal. Every later connection starts with /hello,
// which mixes fresh nonces from both sides into a session key; all other
// requests carry a session id and an HMAC made with that key.
//
// Everything after /hello is also encrypted end to end with AES-256-GCM under
// a key derived from the session key: request and response bodies, file
// chunks and WebSocket frames. Each is bound to its context (path, transfer
// and chunk, or frame counter) so it cannot be replayed somewhere else.

const (
	pairCodeLength   = 16
	pairCodeAlphabet = "ABCDEFGHJKMNPQRSTVWXYZ23456789" // no look-alikes (0/O, 1/I/L) and no U
	pairCodeTTL      = 10 * time.Minute
	sessionTTL       = 12 * time.Hour
	maxSessions      = 16 // per device; /hello needs no proof, so keep it from piling up
)

var deviceIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{8,64}$`)

func hmacSHA256(key []byte, parts ...[]byte) []byte {
	mac := hmac.New(sha256.New, key)
	for _, p := range parts {
		mac.Write(p)
	}
	return mac.Sum(nil)
}

// hkdf32 is HKDF-SHA256 (RFC 5869) for a single 32-byte output block.
func hkdf32(secret, salt []byte, info string) []byte {
	prk := hmacSHA256(salt, secret)
	return hmacSHA256(prk, []byte(info), []byte{1})
}

func deviceKeyFromCode(code, deviceID string) []byte {
	return hkdf32([]byte(code), []byte(deviceID), "p2p-link device key v1")
}

func normalizePairCode(code string) string {
	return strings.ToUpper(strings.NewReplacer("-", "", " ", "").Replace(code))
}

var (
	pairMu      sync.Mutex
	pairCode    string
	pairExpires time.Time
)

// newPairCode replaces the current pairing code with a fresh one.
func newPairCode() string {
	buf := make([]byte, pairCodeLength)
	rand.Read(buf)
	code := make([]byte, pairCodeLength)
	for i, b := range buf {
		code[i] = pairCodeAlphabet[int(b)%len(pairCodeAlphabet)]
	}
	pairMu.Lock()
	pairCode = string(code)
	pairExpires = time.Now().Add(pairCodeTTL)
	pairMu.Unlock()
	return string(code)
}

func currentPairCode() (string, bool) {
	pairMu.Lock()
	defer pairMu.Unlock()
	return pairCode, pairCode != "" && time.Now().Before(pairExpires)
}

func formatPairCode(code string) string {
	groups := []string{}
	for i := 0; i < len(code); i += 4 {
		groups = append(groups, code[i:min(i+4, len(code))])
	}
	return strings.Join(groups, "-")
}

func sanitizeDeviceName(name string) string {
	name = strings.Map(func(r rune) rune {
		if r < 32 || r == 127 {
			return -1
		}
		return r
	}, name)
	name = strings.TrimSpace(name)
	if r := []rune(name); len(r) > 40 {
		name = string(r[:40])
	}
	if name == "" {
		return "Unnamed device"
	}
	return name
}

type pairRequest struct {
	DeviceID string `json:"deviceId"`
	Name     string `json:"name"`
	MAC      string `json:"mac"` // QR pairing: proves the device holds the secret in the QR code
	Key      string `json:"key"` // manual pairing: a device key the PC owner must approve
}

// Manual pairing and per-transfer approval at the PC terminal.
const approvalTimeout = 60 * time.Second

type ApprovalAnswer struct {
	Allow  bool
	Always bool
}

var (
	approvalMu              sync.Mutex
	pendingApproval         chan bool           // non-nil while a pairing request waits for y/n
	pendingTransferApproval chan ApprovalAnswer // non-nil while a transfer waits for y/n/a
)

// answerApproval is called by the terminal when the user types y, n, or always/a.
// It reports whether there was a request waiting.
func answerApproval(input string) bool {
	lower := strings.ToLower(strings.TrimSpace(input))

	// Check transfer approval first
	approvalMu.Lock()
	tch := pendingTransferApproval
	approvalMu.Unlock()
	if tch != nil {
		switch lower {
		case "y", "yes":
			select {
			case tch <- ApprovalAnswer{Allow: true, Always: false}:
			default:
			}
			return true
		case "n", "no":
			select {
			case tch <- ApprovalAnswer{Allow: false, Always: false}:
			default:
			}
			return true
		case "a", "always":
			select {
			case tch <- ApprovalAnswer{Allow: true, Always: true}:
			default:
			}
			return true
		}
	}

	// Check pairing approval
	approvalMu.Lock()
	pch := pendingApproval
	approvalMu.Unlock()
	if pch != nil {
		switch lower {
		case "y", "yes":
			select {
			case pch <- true:
			default:
			}
			return true
		case "n", "no":
			select {
			case pch <- false:
			default:
			}
			return true
		}
	}

	return false
}

func askTransferApproval(d *Device, filename string, size int64) (allow bool, always bool) {
	approvalMu.Lock()
	if pendingTransferApproval != nil {
		approvalMu.Unlock()
		return false, false
	}
	ch := make(chan ApprovalAnswer, 1)
	pendingTransferApproval = ch
	approvalMu.Unlock()
	defer func() {
		approvalMu.Lock()
		pendingTransferApproval = nil
		approvalMu.Unlock()
	}()

	fmt.Printf("\r\033[2K  %s%s%s  %s? Transfer%s   \"%s\" (%s) from %s. Accept? (y/n/a=always): \np2p> ",
		Dim, nowStamp(), Reset, Yellow, Reset, filename, formatSize(size), d.Name)

	select {
	case ans := <-ch:
		return ans.Allow, ans.Always
	case <-time.After(approvalTimeout):
		printAsync(Yellow, "○ Timeout", filename, "transfer request expired")
		return false, false
	}
}

func askApproval(name, addr string) bool {
	approvalMu.Lock()
	if pendingApproval != nil {
		approvalMu.Unlock()
		return false
	}
	ch := make(chan bool, 1)
	pendingApproval = ch
	approvalMu.Unlock()
	defer func() {
		approvalMu.Lock()
		pendingApproval = nil
		approvalMu.Unlock()
	}()

	fmt.Printf("%s%s[Pairing request]%s \"%s\" from %s wants to connect. Type %sy%s to allow or %sn%s to deny: ",
		ClearLine, Yellow, Reset, name, addr, Green, Reset, Red, Reset)
	select {
	case allow := <-ch:
		return allow
	case <-time.After(approvalTimeout):
		printAsync(Yellow, "○ Timeout", name, "pairing request expired")
		return false
	}
}

// Pairing rate limiting and lockout state
type pairAttempt struct {
	count       int
	lockedUntil time.Time
	lastTime    time.Time
}

var (
	pairLimitsMu sync.Mutex
	pairLimits   = make(map[string]*pairAttempt)
)

const (
	maxPairAttempts = 5
	pairLockoutTime = 5 * time.Minute
)

func clientIP(remoteAddr string) string {
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		return remoteAddr
	}
	return host
}

func checkPairRateLimit(ip string) (bool, time.Duration) {
	pairLimitsMu.Lock()
	defer pairLimitsMu.Unlock()
	att, exists := pairLimits[ip]
	if !exists {
		return false, 0
	}
	now := time.Now()
	if now.Before(att.lockedUntil) {
		return true, att.lockedUntil.Sub(now)
	}
	if now.Sub(att.lastTime) > 10*time.Minute {
		delete(pairLimits, ip)
		return false, 0
	}
	return false, 0
}

func recordPairFailure(ip string) (bool, time.Duration) {
	pairLimitsMu.Lock()
	defer pairLimitsMu.Unlock()
	now := time.Now()
	att, exists := pairLimits[ip]
	if !exists {
		att = &pairAttempt{count: 0, lastTime: now}
		pairLimits[ip] = att
	}
	att.count++
	att.lastTime = now
	if att.count >= maxPairAttempts {
		att.lockedUntil = now.Add(pairLockoutTime)
		return true, pairLockoutTime
	}
	return false, 0
}

func resetPairLimit(ip string) {
	pairLimitsMu.Lock()
	defer pairLimitsMu.Unlock()
	delete(pairLimits, ip)
}

func handlePair(w http.ResponseWriter, r *http.Request) {
	if enableCORS(w, r) {
		return
	}
	ip := clientIP(r.RemoteAddr)
	if locked, retryAfter := checkPairRateLimit(ip); locked {
		w.Header().Set("Retry-After", fmt.Sprintf("%d", int(retryAfter.Seconds())+1))
		writeJSON(w, http.StatusTooManyRequests, map[string]interface{}{
			"error":      "Too many failed pairing attempts. Temporarily locked out.",
			"code":       "locked_out",
			"retryAfter": int(retryAfter.Seconds()) + 1,
		})
		return
	}

	var req pairRequest
	if err := readJSONBody(r, &req); err != nil || !deviceIDPattern.MatchString(req.DeviceID) {
		recordPairFailure(ip)
		httpError(w, http.StatusBadRequest, "Invalid request")
		return
	}

	var key []byte
	if req.Key != "" {
		var err error
		if key, err = hex.DecodeString(req.Key); err != nil || len(key) != 32 {
			recordPairFailure(ip)
			httpError(w, http.StatusBadRequest, "Invalid request")
			return
		}
		if !askApproval(sanitizeDeviceName(req.Name), r.RemoteAddr) {
			recordPairFailure(ip)
			httpError(w, http.StatusForbidden, "The PC did not approve this device")
			return
		}
	} else {
		code, valid := currentPairCode()
		if !valid {
			recordPairFailure(ip)
			httpError(w, http.StatusForbidden, "This QR code has expired. Type 'pair' on the PC for a new one.")
			return
		}
		key = deviceKeyFromCode(code, req.DeviceID)
		want := hmacSHA256(key, []byte("pair\n"+req.DeviceID+"\n"+req.Name))
		got, _ := hex.DecodeString(req.MAC)
		if !hmac.Equal(want, got) {
			recordPairFailure(ip)
			printAsync(Red, "! Rejected", sanitizeDeviceName(req.Name), "invalid QR code")
			httpError(w, http.StatusForbidden, "Invalid QR code. Scan the one currently shown on the PC.")
			return
		}
	}

	resetPairLimit(ip)

	device := registerDevice(req.DeviceID, sanitizeDeviceName(req.Name), key)
	dropSessions(device.ID)
	lastDisconnectMu.Lock()
	deviceOnlineState[device.ID] = true
	lastDisconnectMu.Unlock()
	printAsync(Green, "● Paired", device.Name, "connected")

	hostname, _ := os.Hostname()
	writeJSON(w, http.StatusOK, map[string]string{
		"serverId":   state.ServerID,
		"serverName": hostname,
		"deviceName": device.Name,
		"proof":      hex.EncodeToString(hmacSHA256(key, []byte("paired\n"+state.ServerID))),
	})
}

type Session struct {
	ID       string
	Key      []byte // authenticates requests (HMAC)
	Device   *Device
	LastUsed time.Time

	aead      cipher.AEAD // encrypts everything the session carries
	wsClaimed bool        // a session carries at most one WebSocket, so frame counters never repeat

	noncesMu   sync.Mutex
	seenNonces map[string]time.Time
}

func (s *Session) recordNonce(nonce string) bool {
	if nonce == "" {
		return true
	}
	s.noncesMu.Lock()
	defer s.noncesMu.Unlock()
	if s.seenNonces == nil {
		s.seenNonces = make(map[string]time.Time)
	}
	now := time.Now()
	for n, t := range s.seenNonces {
		if now.Sub(t) > 15*time.Minute {
			delete(s.seenNonces, n)
		}
	}
	if _, seen := s.seenNonces[nonce]; seen {
		return false
	}
	s.seenNonces[nonce] = now
	return true
}

const sealOverhead = 12 + 16 // nonce + GCM tag

var errSealed = errors.New("could not decrypt")

func newSession(device *Device, key []byte) *Session {
	block, _ := aes.NewCipher(hkdf32(key, nil, "p2p-link encryption v1"))
	aead, _ := cipher.NewGCM(block)
	return &Session{ID: randomID(), Key: key, Device: device, LastUsed: time.Now(), aead: aead}
}

// seal encrypts plaintext bound to aad; the random nonce is prepended.
func (s *Session) seal(plaintext []byte, aad string) []byte {
	nonce := make([]byte, 12, len(plaintext)+sealOverhead)
	rand.Read(nonce)
	return s.aead.Seal(nonce, nonce, plaintext, []byte(aad))
}

func (s *Session) open(sealed []byte, aad string) ([]byte, error) {
	if len(sealed) < sealOverhead {
		return nil, errSealed
	}
	plaintext, err := s.aead.Open(nil, sealed[:12], sealed[12:], []byte(aad))
	if err != nil {
		return nil, errSealed
	}
	return plaintext, nil
}

// readRequest decrypts and decodes a JSON request body.
func (s *Session) readRequest(r *http.Request, v interface{}) error {
	body, err := io.ReadAll(io.LimitReader(r.Body, 64<<10))
	if err != nil {
		return err
	}
	plaintext, err := s.open(body, "req\n"+r.URL.Path+"\n"+r.URL.Query().Get("n"))
	if err != nil {
		return err
	}
	return json.Unmarshal(plaintext, v)
}

// writeResponse encrypts a JSON reply, bound to the request it answers.
func (s *Session) writeResponse(w http.ResponseWriter, r *http.Request, v interface{}) {
	data, _ := json.Marshal(v)
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Write(s.seal(data, "res\n"+r.URL.Path+"\n"+r.URL.Query().Get("n")))
}

func chunkAAD(transferID string, chunkIndex int) string {
	return fmt.Sprintf("chunk\n%s\n%d", transferID, chunkIndex)
}

var (
	sessions   = make(map[string]*Session)
	sessionsMu sync.Mutex
)

type helloRequest struct {
	DeviceID    string `json:"deviceId"`
	ClientNonce string `json:"clientNonce"`
}

// handleHello opens a session for a paired device. The reply proves the server
// knows the device key too, so a device cannot be lured to an impostor.
func handleHello(w http.ResponseWriter, r *http.Request) {
	if enableCORS(w, r) {
		return
	}
	var req helloRequest
	if err := readJSONBody(r, &req); err != nil {
		httpError(w, http.StatusBadRequest, "Invalid request")
		return
	}
	clientNonce, err := hex.DecodeString(req.ClientNonce)
	if err != nil || len(clientNonce) < 16 {
		httpError(w, http.StatusBadRequest, "Invalid nonce")
		return
	}
	device := findDevice(req.DeviceID)
	if device == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "This device is not paired", "code": "not_paired"})
		return
	}

	serverNonce := make([]byte, 16)
	rand.Read(serverNonce)
	session := newSession(device, hkdf32(device.Key, append(clientNonce, serverNonce...), "p2p-link session v1"))

	sessionsMu.Lock()
	var oldest *Session
	count := 0
	for id, s := range sessions {
		if time.Since(s.LastUsed) > sessionTTL {
			delete(sessions, id)
		} else if s.Device.ID == device.ID {
			count++
			if oldest == nil || s.LastUsed.Before(oldest.LastUsed) {
				oldest = s
			}
		}
	}
	if count >= maxSessions {
		delete(sessions, oldest.ID)
	}
	sessions[session.ID] = session
	sessionsMu.Unlock()

	writeJSON(w, http.StatusOK, map[string]string{
		"sessionId":   session.ID,
		"serverNonce": hex.EncodeToString(serverNonce),
		"proof":       hex.EncodeToString(hmacSHA256(session.Key, []byte("server"))),
	})
}

func dropSessions(deviceID string) {
	sessionsMu.Lock()
	defer sessionsMu.Unlock()
	for id, s := range sessions {
		if s.Device.ID == deviceID {
			delete(sessions, id)
		}
	}
}

// requestSignature is the HMAC a client must attach as the "mac" query
// parameter: it covers the method, the path and every other query parameter.
func requestSignature(key []byte, r *http.Request) []byte {
	query := r.URL.Query()
	names := make([]string, 0, len(query))
	for name := range query {
		if name != "mac" {
			names = append(names, name)
		}
	}
	sort.Strings(names)
	pairs := make([]string, len(names))
	for i, name := range names {
		pairs[i] = name + "=" + query.Get(name)
	}
	return hmacSHA256(key, []byte(r.Method+"\n"+r.URL.Path+"\n"+strings.Join(pairs, "&")))
}

// authenticate returns the session a request belongs to, or nil if it is not
// from a paired device with a live session.
func authenticate(r *http.Request) *Session {
	sessionsMu.Lock()
	session := sessions[r.URL.Query().Get("sid")]
	if session != nil && time.Since(session.LastUsed) > sessionTTL {
		delete(sessions, session.ID)
		session = nil
	}
	if session != nil {
		session.LastUsed = time.Now()
	}
	sessionsMu.Unlock()
	if session == nil {
		return nil
	}

	got, _ := hex.DecodeString(r.URL.Query().Get("mac"))
	if !hmac.Equal(requestSignature(session.Key, r), got) {
		return nil
	}

	nonce := r.URL.Query().Get("n")
	if nonce != "" {
		if !session.recordNonce(nonce) {
			return nil // Anti-replay: duplicate nonce rejected
		}
	}
	return session
}

// authed wraps a handler so it only runs for paired devices.
func authed(handler func(w http.ResponseWriter, r *http.Request, s *Session)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if enableCORS(w, r) {
			return
		}
		session := authenticate(r)
		if session == nil {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "Session expired", "code": "no_session"})
			return
		}
		handler(w, r, session)
	}
}

// handleUnpair revokes a paired device from the mobile client side
func handleUnpair(w http.ResponseWriter, r *http.Request, s *Session) {
	deviceID := s.Device.ID
	deviceName := s.Device.Name

	removeDevice(deviceID)
	dropSessions(deviceID)

	transfersMu.Lock()
	var abandoned []*TransferState
	for id, state := range transfers {
		if state.Owner == deviceID {
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
		if client.device.ID == deviceID {
			client.Close()
			delete(clients, client)
		}
	}
	clientsMu.Unlock()

	printAsync(Yellow, "○ Revoked", deviceName, "unpaired by remote device")
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}
