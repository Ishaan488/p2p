package main

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
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
// The PC shows a short-lived pairing code (inside the QR). The code never
// travels over the network: both sides derive a per-device key from it and the
// device proves it knows the key. Every later connection starts with /hello,
// which mixes fresh nonces from both sides into a session key; all other
// requests carry a session id and an HMAC made with that key.

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
	MAC      string `json:"mac"`
}

func handlePair(w http.ResponseWriter, r *http.Request) {
	if enableCORS(w, r) {
		return
	}
	var req pairRequest
	if err := readJSONBody(r, &req); err != nil || !deviceIDPattern.MatchString(req.DeviceID) {
		httpError(w, http.StatusBadRequest, "Invalid request")
		return
	}
	code, valid := currentPairCode()
	if !valid {
		httpError(w, http.StatusForbidden, "Pairing code expired. Type 'pair' on the PC for a new one.")
		return
	}

	key := deviceKeyFromCode(code, req.DeviceID)
	want := hmacSHA256(key, []byte("pair\n"+req.DeviceID+"\n"+req.Name))
	got, _ := hex.DecodeString(req.MAC)
	if !hmac.Equal(want, got) {
		fmt.Printf("%s%s[Pairing]%s Rejected attempt from %s (wrong code)\n> ", ClearLine, Red, Reset, r.RemoteAddr)
		httpError(w, http.StatusForbidden, "Wrong pairing code")
		return
	}

	device := registerDevice(req.DeviceID, sanitizeDeviceName(req.Name), key)
	dropSessions(device.ID)
	fmt.Printf("%s%s[Paired]%s %s\n> ", ClearLine, Green, Reset, device.Name)

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
	Key      []byte
	Device   *Device
	LastUsed time.Time
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
	session := &Session{
		ID:       randomID(),
		Key:      hkdf32(device.Key, append(clientNonce, serverNonce...), "p2p-link session v1"),
		Device:   device,
		LastUsed: time.Now(),
	}

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
