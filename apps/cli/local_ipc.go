package main

import (
	"bytes"
	"crypto/subtle"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// Loopback IPC: lets a second invocation (Explorer context menu, "Send to",
// `p2p --send file`) hand its file to the already running instance instead of
// starting another server (FR 42, 46, 48).
//
// The running instance publishes an endpoint file containing a random token,
// its port and scheme. Only that token (readable by the same OS user) lets a
// loopback client use /local/send.

var localIPCToken string

func localTokenFilePath() string {
	return filepath.Join(baseDir, ".local_ipc_token")
}

// initLocalIPCToken creates a fresh token. The port is published once known.
func initLocalIPCToken() {
	localIPCToken = randomID()
	publishLocalIPCEndpoint(0, "http")
}

// publishLocalIPCEndpoint writes "token\nport\nscheme" for other invocations.
func publishLocalIPCEndpoint(port int, scheme string) {
	content := fmt.Sprintf("%s\n%d\n%s\n", localIPCToken, port, scheme)
	if err := writeFileAtomic(localTokenFilePath(), []byte(content), 0o600); err != nil {
		fmt.Printf("%sCould not write local IPC endpoint (context-menu sends will start a new instance): %v%s\n", Yellow, err, Reset)
	}
}

type localSendRequest struct {
	Path   string `json:"path"`
	Target string `json:"target,omitempty"`
}

func handleLocalSend(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		httpError(w, http.StatusMethodNotAllowed, "POST required")
		return
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	ip := net.ParseIP(host)
	if ip == nil || !ip.IsLoopback() {
		httpError(w, http.StatusForbidden, "Loopback access only")
		return
	}

	token := r.Header.Get("X-Local-Token")
	if localIPCToken == "" || subtle.ConstantTimeCompare([]byte(token), []byte(localIPCToken)) != 1 {
		httpError(w, http.StatusUnauthorized, "Invalid local IPC token")
		return
	}

	var req localSendRequest
	if err := readJSONBody(r, &req); err != nil || strings.TrimSpace(req.Path) == "" {
		httpError(w, http.StatusBadRequest, "Invalid path")
		return
	}

	var targetDev *Device
	if strings.TrimSpace(req.Target) != "" {
		targetDev = resolveDeviceTarget(strings.TrimSpace(req.Target))
		if targetDev == nil {
			httpError(w, http.StatusNotFound, fmt.Sprintf("Device %q not found", req.Target))
			return
		}
	}

	if err := startSendTransferTargeted(req.Path, targetDev); err != nil {
		httpError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"ok":   true,
		"path": req.Path,
	})
}

// readLocalIPCEndpoint parses the endpoint file. Old files held only the token.
func readLocalIPCEndpoint(defaultPort int) (token string, port int, scheme string, ok bool) {
	data, err := os.ReadFile(localTokenFilePath())
	if err != nil {
		return "", 0, "", false
	}
	lines := strings.Fields(string(data))
	if len(lines) == 0 {
		return "", 0, "", false
	}
	token, port, scheme = lines[0], defaultPort, "http"
	if len(lines) >= 2 {
		if p, err := strconv.Atoi(lines[1]); err == nil && p > 0 && p <= 65535 {
			port = p
		}
	}
	if len(lines) >= 3 && (lines[2] == "http" || lines[2] == "https") {
		scheme = lines[2]
	}
	return token, port, scheme, true
}

// trySendViaRunningInstance attempts to hand off a file/folder send request to an already
// running local P2P Link instance (FR 42, FR 46). Returns true if delivered.
func trySendViaRunningInstance(filePath, target string, defaultPort int) bool {
	token, port, scheme, ok := readLocalIPCEndpoint(defaultPort)
	if !ok {
		return false
	}
	payload, err := json.Marshal(localSendRequest{Path: filePath, Target: target})
	if err != nil {
		return false
	}

	// The instance may be busy packing a large folder before it answers, so
	// only connecting is time-limited, not the whole exchange.
	client := &http.Client{
		Timeout: 10 * time.Minute,
		Transport: &http.Transport{
			DialContext: (&net.Dialer{Timeout: 2 * time.Second}).DialContext,
			// Loopback only, and the request is authenticated by the local token.
			TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
		},
	}
	url := fmt.Sprintf("%s://127.0.0.1:%d/local/send", scheme, port)
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(payload))
	if err != nil {
		return false
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Local-Token", token)

	resp, err := client.Do(req)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	return resp.StatusCode == http.StatusOK
}
