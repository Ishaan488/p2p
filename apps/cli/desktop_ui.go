package main

import (
	"bytes"
	"fmt"
	"net"
	"net/http"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"rsc.io/qr"
)

func isLoopbackRemote(remoteAddr string) bool {
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		host = remoteAddr
	}
	ip := net.ParseIP(strings.Trim(host, "[]"))
	return ip != nil && ip.IsLoopback()
}

type desktopDeviceDTO struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	DisplayName string `json:"displayName"`
	Online      bool   `json:"online"`
	Trusted     bool   `json:"trusted"`
	LastSeen    int64  `json:"lastSeen"`
}

type desktopStatusResponse struct {
	ServerName           string             `json:"serverName"`
	IPs                  []string           `json:"ips"`
	Port                 int                `json:"port"`
	Scheme               string             `json:"scheme"`
	ManualAddr           string             `json:"manualAddr"`
	QRLink               string             `json:"qrLink"`
	QRSVG                string             `json:"qrSvg"`
	ReceiveDir           string             `json:"receiveDir"`
	ContextMenuInstalled bool               `json:"contextMenuInstalled"`
	AutostartEnabled     bool               `json:"autostartEnabled"`
	Devices              []desktopDeviceDTO `json:"devices"`
	History              []TransferRecord   `json:"history"`
}

func buildQRSVG(text string) string {
	code, err := qr.Encode(text, qr.L)
	if err != nil || code == nil || code.Size <= 0 {
		return ""
	}
	margin := 2
	total := code.Size + margin*2
	var buf bytes.Buffer
	fmt.Fprintf(&buf, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 %d %d" shape-rendering="crispEdges" width="184" height="184">`, total, total)
	fmt.Fprintf(&buf, `<rect width="%d" height="%d" fill="#F1F1F1" rx="2"/>`, total, total)
	buf.WriteString(`<path fill="#101010" d="`)
	for y := 0; y < code.Size; y++ {
		for x := 0; x < code.Size; x++ {
			if code.Black(x, y) {
				fmt.Fprintf(&buf, "M%d,%dh1v1h-1z", x+margin, y+margin)
			}
		}
	}
	buf.WriteString(`"/></svg>`)
	return buf.String()
}

func currentOrNewPairLink(forceRefresh bool) (qrLink string, manualAddr string, ips []string) {
	ips = localIPs()
	code, valid := currentPairCode()
	if !valid || forceRefresh {
		code = newPairCode()
	}
	primaryIP := "127.0.0.1"
	if len(ips) > 0 {
		primaryIP = ips[0]
	}
	manualAddr = fmt.Sprintf("%s:%d", primaryIP, *port)
	qrLink = fmt.Sprintf("%s://%s/#pair=%s", httpScheme(), manualAddr, code)
	if tlsEnabled && tlsFingerprint != "" {
		qrLink = fmt.Sprintf("%s://%s/#pair=%s&cert=%s", httpScheme(), manualAddr, code, tlsFingerprint)
	}
	return qrLink, manualAddr, ips
}

func handleDesktopStatus(w http.ResponseWriter, r *http.Request) {
	if !isLoopbackRemote(r.RemoteAddr) {
		httpError(w, http.StatusForbidden, "Local only")
		return
	}
	forceRefresh := r.URL.Query().Get("refresh") == "1"
	qrLink, manualAddr, ips := currentOrNewPairLink(forceRefresh)

	rawDevices := listDevices()
	devices := make([]desktopDeviceDTO, 0, len(rawDevices))
	for _, d := range rawDevices {
		devices = append(devices, desktopDeviceDTO{
			ID:          d.ID,
			Name:        d.Name,
			DisplayName: d.DisplayName(),
			Online:      deviceOnline(d.ID),
			Trusted:     d.Trusted,
			LastSeen:    d.LastSeen,
		})
	}

	historyMu.Lock()
	limit := len(history)
	if limit > 15 {
		limit = 15
	}
	recentHistory := make([]TransferRecord, limit)
	copy(recentHistory, history[:limit])
	historyMu.Unlock()

	resp := desktopStatusResponse{
		ServerName:           getServerName(),
		IPs:                  ips,
		Port:                 *port,
		Scheme:               httpScheme(),
		ManualAddr:           manualAddr,
		QRLink:               qrLink,
		QRSVG:                buildQRSVG(qrLink),
		ReceiveDir:           getReceiveDir(),
		ContextMenuInstalled: isExplorerContextMenuInstalled(),
		AutostartEnabled:     isOSAutostartEnabled(),
		Devices:              devices,
		History:              recentHistory,
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, resp)
}

type desktopActionRequest struct {
	Action   string `json:"action"`
	Path     string `json:"path,omitempty"`
	Text     string `json:"text,omitempty"`
	TargetID string `json:"targetId,omitempty"`
	Enable   bool   `json:"enable,omitempty"`
}

func handleDesktopAction(w http.ResponseWriter, r *http.Request) {
	if !isLoopbackRemote(r.RemoteAddr) {
		httpError(w, http.StatusForbidden, "Local only")
		return
	}
	if r.Method != http.MethodPost {
		httpError(w, http.StatusMethodNotAllowed, "POST required")
		return
	}
	if r.Header.Get("X-P2P-Desktop") != "1" {
		httpError(w, http.StatusForbidden, "Missing desktop header")
		return
	}

	var req desktopActionRequest
	if err := readJSONBody(r, &req); err != nil {
		httpError(w, http.StatusBadRequest, "Invalid JSON body")
		return
	}

	switch req.Action {
	case "open_received_dir":
		dir := getReceiveDir()
		if err := openFolderInOS(dir); err != nil {
			httpError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{"ok": true, "dir": dir})

	case "refresh_qr":
		newPairCode()
		writeJSON(w, http.StatusOK, map[string]interface{}{"ok": true})

	case "send_text":
		text := strings.TrimSpace(req.Text)
		if text == "" {
			httpError(w, http.StatusBadRequest, "Text cannot be empty")
			return
		}
		var target *Device
		if req.TargetID != "" {
			target = findDevice(req.TargetID)
		}
		msg := Message{
			Version:   1,
			Type:      "text",
			ID:        fmt.Sprintf("msg-%d", time.Now().UnixNano()),
			Timestamp: time.Now().Unix(),
			Payload:   TextPayload{Text: text},
		}
		if target != nil {
			msg.TargetDeviceID = target.ID
		}
		delivered := broadcastMessage(msg)
		writeJSON(w, http.StatusOK, map[string]interface{}{"ok": true, "delivered": delivered})

	case "send_path":
		cleanPath := strings.Trim(strings.TrimSpace(req.Path), "\"'")
		if cleanPath == "" {
			httpError(w, http.StatusBadRequest, "Path is required")
			return
		}
		var target *Device
		if req.TargetID != "" {
			target = findDevice(req.TargetID)
		}
		if err := startSendTransferTargeted(cleanPath, target); err != nil {
			httpError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{"ok": true, "filename": filepath.Base(cleanPath)})

	case "pick_and_send_file":
		paths, err := pickFilesNative()
		if err != nil {
			httpError(w, http.StatusInternalServerError, err.Error())
			return
		}
		if len(paths) == 0 {
			writeJSON(w, http.StatusOK, map[string]interface{}{"ok": true, "cancelled": true})
			return
		}
		var target *Device
		if req.TargetID != "" {
			target = findDevice(req.TargetID)
		}
		sent := make([]string, 0, len(paths))
		for _, p := range paths {
			if err := startSendTransferTargeted(p, target); err != nil {
				httpError(w, http.StatusBadRequest, err.Error())
				return
			}
			sent = append(sent, filepath.Base(p))
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{"ok": true, "sent": sent})

	case "pick_and_send_folder":
		folderPath, err := pickFolderNative()
		if err != nil {
			httpError(w, http.StatusInternalServerError, err.Error())
			return
		}
		if folderPath == "" {
			writeJSON(w, http.StatusOK, map[string]interface{}{"ok": true, "cancelled": true})
			return
		}
		var target *Device
		if req.TargetID != "" {
			target = findDevice(req.TargetID)
		}
		if err := startSendTransferTargeted(folderPath, target); err != nil {
			httpError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{"ok": true, "sent": []string{filepath.Base(folderPath)}})

	case "toggle_trust":
		if req.TargetID == "" {
			httpError(w, http.StatusBadRequest, "Target device ID required")
			return
		}
		setDeviceTrust(req.TargetID, req.Enable)
		writeJSON(w, http.StatusOK, map[string]interface{}{"ok": true})

	case "toggle_context_menu":
		var err error
		if req.Enable {
			err = installExplorerContextMenu()
		} else {
			err = uninstallExplorerContextMenu()
		}
		if err != nil {
			httpError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{"ok": true, "enabled": isExplorerContextMenuInstalled()})

	case "toggle_autostart":
		if err := setOSAutostart(req.Enable); err != nil {
			httpError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{"ok": true, "enabled": isOSAutostartEnabled()})

	default:
		httpError(w, http.StatusBadRequest, "Unknown action")
	}
}

func openFolderInOS(dir string) error {
	switch runtime.GOOS {
	case "windows":
		return exec.Command("explorer.exe", dir).Start()
	case "darwin":
		return exec.Command("open", dir).Start()
	default:
		return exec.Command("xdg-open", dir).Start()
	}
}

func pickFilesNative() ([]string, error) {
	if runtime.GOOS != "windows" {
		return nil, fmt.Errorf("native file picker is supported on Windows")
	}
	script := `Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.OpenFileDialog; $f.Title = 'Select files to send'; $f.Multiselect = $true; if ($f.ShowDialog() -eq 'OK') { $f.FileNames -join "` + "\n" + `" }`
	out, err := exec.Command("powershell", "-NoProfile", "-STA", "-Command", script).Output()
	if err != nil {
		return nil, err
	}
	raw := strings.TrimSpace(string(out))
	if raw == "" {
		return nil, nil
	}
	lines := strings.Split(raw, "\n")
	res := make([]string, 0, len(lines))
	for _, l := range lines {
		l = strings.TrimSpace(l)
		if l != "" {
			res = append(res, l)
		}
	}
	return res, nil
}

func pickFolderNative() (string, error) {
	if runtime.GOOS != "windows" {
		return "", fmt.Errorf("native folder picker is supported on Windows")
	}
	script := `Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.FolderBrowserDialog; $f.Description = 'Select folder to send'; if ($f.ShowDialog() -eq 'OK') { $f.SelectedPath }`
	out, err := exec.Command("powershell", "-NoProfile", "-STA", "-Command", script).Output()
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}

func handleDesktopUI(w http.ResponseWriter, r *http.Request) {
	if !isLoopbackRemote(r.RemoteAddr) {
		httpError(w, http.StatusForbidden, "Local only")
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write([]byte(desktopCompanionHTML))
}

const desktopCompanionHTML = `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>P2P Link</title>
<style>
  :root {
    color-scheme: dark;
    --bg: #101010;
    --surface-1: #181818;
    --surface-2: #202020;
    --surface-3: #292929;
    --surface-4: #303030;
    --divider: #343434;
    --divider-strong: #454545;
    --text-1: #F1F1F1;
    --text-2: #A5A5A5;
    --text-3: #777777;
    --action-bg: #E5E5E5;
    --action-text: #151515;
    --action-bg-pressed: #CFCFCF;
    --success: #79C9A2;
    --warning: #DDBB75;
    --error: #E97878;
    --r-btn: 12px;
    --r-group: 16px;
    --font: 'Inter Variable', 'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  }
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: var(--bg);
    color: var(--text-1);
    font-family: var(--font);
    font-size: 15px;
    line-height: 1.45;
    -webkit-font-smoothing: antialiased;
    min-height: 100vh;
    display: flex;
    flex-direction: column;
  }
  button, input, select { font: inherit; color: inherit; background: none; border: 0; }
  button { cursor: pointer; }
  .shell {
    width: 100%;
    max-width: 540px;
    margin: 0 auto;
    padding: 20px 16px 110px;
    flex: 1;
  }
  .top-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    min-height: 56px;
    padding: 0 4px 12px;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .brand-mark {
    width: 38px;
    height: 38px;
    border-radius: 11px;
    background: var(--surface-1);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--text-1);
  }
  .brand-title {
    font-size: 17px;
    font-weight: 600;
    letter-spacing: -0.02em;
  }
  .brand-sub {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--text-2);
  }
  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--text-3);
  }
  .dot.ok { background: var(--success); }
  .section-label {
    padding: 20px 16px 8px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-3);
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .group {
    background: var(--surface-1);
    border-radius: var(--r-group);
    overflow: hidden;
  }
  .group > .row + .row {
    border-top: 1px solid var(--divider);
  }
  .row {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    min-height: 56px;
    padding: 10px 16px;
    text-align: left;
    color: var(--text-1);
    transition: background 120ms ease;
  }
  button.row:hover { background: var(--surface-2); }
  button.row:active { background: var(--surface-3); }
  .row-main {
    display: flex;
    flex-direction: column;
    gap: 2px;
    flex: 1;
    min-width: 0;
  }
  .row-title {
    font-size: 15px;
    font-weight: 500;
    line-height: 1.3;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .row-sub {
    font-size: 12px;
    color: var(--text-2);
    line-height: 1.35;
  }
  .row-value {
    font-size: 13px;
    color: var(--text-2);
    flex-shrink: 0;
  }
  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    min-height: 44px;
    padding: 0 16px;
    border-radius: var(--r-btn);
    background: var(--surface-2);
    color: var(--text-1);
    font-size: 14px;
    font-weight: 600;
    transition: background 120ms ease;
  }
  .btn:hover { background: var(--surface-3); }
  .btn:active { background: var(--surface-4); }
  .btn-primary {
    background: var(--action-bg);
    color: var(--action-text);
  }
  .btn-primary:hover { background: #FFFFFF; }
  .btn-primary:active { background: var(--action-bg-pressed); }
  .btn-sm {
    min-height: 32px;
    padding: 0 12px;
    font-size: 12.5px;
    border-radius: 9px;
  }
  .switch {
    position: relative;
    width: 48px;
    height: 28px;
    flex-shrink: 0;
    border-radius: 999px;
    background: var(--surface-4);
    border: 1px solid var(--divider-strong);
    transition: background 120ms ease, border-color 120ms ease;
  }
  .switch-knob {
    position: absolute;
    top: 3px;
    left: 3px;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: var(--text-2);
    transition: transform 200ms cubic-bezier(0.2, 0, 0, 1), background 120ms ease;
  }
  .switch.on {
    background: var(--action-bg);
    border-color: var(--action-bg);
  }
  .switch.on .switch-knob {
    transform: translateX(20px);
    background: var(--action-text);
  }
  .qr-panel {
    display: flex;
    align-items: center;
    gap: 20px;
    padding: 20px;
  }
  @media (max-width: 480px) {
    .qr-panel { flex-direction: column; text-align: center; }
  }
  .qr-frame {
    width: 184px;
    height: 184px;
    border-radius: 12px;
    overflow: hidden;
    flex-shrink: 0;
    background: #F1F1F1;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .qr-info {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .qr-addr {
    font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
    font-size: 13px;
    color: var(--text-1);
    background: var(--surface-2);
    padding: 6px 10px;
    border-radius: 8px;
    align-self: flex-start;
    user-select: all;
  }
  .composer {
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    background: var(--bg);
    border-top: 1px solid var(--divider);
    padding: 12px 16px 16px;
  }
  .composer-inner {
    max-width: 540px;
    margin: 0 auto;
    display: flex;
    gap: 8px;
  }
  .toast {
    position: fixed;
    bottom: 84px;
    left: 50%;
    transform: translateX(-50%);
    background: var(--surface-3);
    color: var(--text-1);
    padding: 10px 16px;
    border-radius: 999px;
    font-size: 13px;
    font-weight: 500;
    box-shadow: 0 8px 28px rgba(0,0,0,0.55);
    display: none;
    z-index: 200;
  }
</style>
</head>
<body>
<div class="shell">
  <div class="top-bar">
    <div class="brand">
      <span class="brand-mark">
        <svg width="22" height="22" viewBox="0 0 32 32" fill="none">
          <rect x="4.5" y="4.5" width="13.5" height="13.5" rx="3.8" stroke="currentColor" stroke-width="2.2"/>
          <rect x="14" y="14" width="13.5" height="13.5" rx="3.8" stroke="currentColor" stroke-width="2.2"/>
          <circle cx="11.25" cy="11.25" r="1.75" fill="currentColor"/>
          <circle cx="20.75" cy="20.75" r="1.75" fill="currentColor"/>
          <path d="M11.25 11.25L20.75 20.75" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
        </svg>
      </span>
      <div>
        <div class="brand-title" id="pcName">P2P Link</div>
        <div class="brand-sub"><span class="dot ok"></span><span id="statusText">Listening on local network</span></div>
      </div>
    </div>
    <button class="btn btn-sm" onclick="doAction({action:'open_received_dir'})">Received folder</button>
  </div>

  <div class="section-label">
    <span>Pair a phone</span>
    <button onclick="doAction({action:'refresh_qr'})" style="color:var(--text-2);font-size:11px;text-transform:none;letter-spacing:0;">Refresh code</button>
  </div>
  <div class="group">
    <div class="qr-panel">
      <div class="qr-frame" id="qrContainer"></div>
      <div class="qr-info">
        <div class="row-title">Scan from P2P Link on your phone</div>
        <div class="row-sub">Or enter this address manually in the app:</div>
        <div class="qr-addr" id="manualAddr">...</div>
      </div>
    </div>
  </div>

  <div class="section-label">Saved devices</div>
  <div class="group" id="deviceList">
    <div class="row"><span class="row-sub">No paired phones yet</span></div>
  </div>

  <div class="section-label">Recent activity</div>
  <div class="group" id="historyList">
    <div class="row"><span class="row-sub">No transfers in this session</span></div>
  </div>

  <div class="section-label">Windows integration</div>
  <div class="group">
    <div class="row">
      <span class="row-main">
        <span class="row-title">Explorer right-click menu</span>
        <span class="row-sub">Send any file or folder directly from Windows Explorer</span>
      </span>
      <button type="button" class="switch" id="ctxSwitch" onclick="toggleContextMenu()" aria-label="Explorer menu">
        <span class="switch-knob"></span>
      </button>
    </div>
    <div class="row">
      <span class="row-main">
        <span class="row-title">Start with Windows</span>
        <span class="row-sub">Run quietly in the background on sign-in</span>
      </span>
      <button type="button" class="switch" id="autoSwitch" onclick="toggleAutostart()" aria-label="Start with Windows">
        <span class="switch-knob"></span>
      </button>
    </div>
  </div>
</div>

<div class="composer">
  <div class="composer-inner">
    <button class="btn btn-primary" style="flex:1;min-height:48px;" onclick="pickFile()">+ Send files</button>
    <button class="btn" style="min-height:48px;" onclick="pickFolder()">Folder</button>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
let currentState = null;

function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.style.display = 'block';
  clearTimeout(window._toastTimer);
  window._toastTimer = setTimeout(function() { el.style.display = 'none'; }, 3000);
}

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, function(c) {
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
  });
}

async function fetchStatus() {
  try {
    const res = await fetch('/local/status');
    if (!res.ok) return;
    const data = await res.json();
    currentState = data;
    renderStatus(data);
  } catch (e) {
    document.getElementById('statusText').textContent = 'Offline';
  }
}

function renderStatus(data) {
  document.getElementById('pcName').textContent = data.serverName;
  document.getElementById('manualAddr').textContent = data.manualAddr;
  if (data.qrSvg) {
    document.getElementById('qrContainer').innerHTML = data.qrSvg;
  }

  const ctxSw = document.getElementById('ctxSwitch');
  ctxSw.className = 'switch' + (data.contextMenuInstalled ? ' on' : '');
  const autoSw = document.getElementById('autoSwitch');
  autoSw.className = 'switch' + (data.autostartEnabled ? ' on' : '');

  const devList = document.getElementById('deviceList');
  if (!data.devices || data.devices.length === 0) {
    devList.innerHTML = '<div class="row"><span class="row-sub">No paired phones yet</span></div>';
  } else {
    devList.innerHTML = data.devices.map(function(d) {
      return '<div class="row">' +
        '<span class="dot ' + (d.online ? 'ok' : '') + '"></span>' +
        '<span class="row-main">' +
          '<span class="row-title">' + escapeHtml(d.displayName) + '</span>' +
          '<span class="row-sub">' + (d.online ? 'Connected' : 'Offline') + ' · ' + (d.trusted ? 'Accepts files automatically' : 'Asks before receiving') + '</span>' +
        '</span>' +
        '<button class="btn btn-sm" onclick="doAction({action:\'toggle_trust\', targetId:\'' + escapeHtml(d.id) + '\', enable:' + (!d.trusted) + '})">' +
          (d.trusted ? 'Trusted' : 'Trust') +
        '</button>' +
      '</div>';
    }).join('');
  }

  const histList = document.getElementById('historyList');
  if (!data.history || data.history.length === 0) {
    histList.innerHTML = '<div class="row"><span class="row-sub">No transfers in this session</span></div>';
  } else {
    histList.innerHTML = data.history.slice(0, 6).map(function(h) {
      return '<div class="row">' +
        '<span class="row-main">' +
          '<span class="row-title">' + escapeHtml(h.filename) + '</span>' +
          '<span class="row-sub">' + escapeHtml(h.direction) + ' · ' + formatBytes(h.size) + ' · ' + escapeHtml(h.device || 'Phone') + '</span>' +
        '</span>' +
        '<span class="row-value">' + escapeHtml(h.status) + '</span>' +
      '</div>';
    }).join('');
  }
}

async function doAction(payload) {
  try {
    const res = await fetch('/local/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-P2P-Desktop': '1' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok) {
      showToast(data.error || 'Action failed');
      return null;
    }
    await fetchStatus();
    return data;
  } catch (e) {
    showToast('Server unreachable');
    return null;
  }
}

async function pickFile() {
  const res = await doAction({ action: 'pick_and_send_file' });
  if (res && res.sent && res.sent.length > 0) {
    showToast('Sending ' + res.sent.join(', '));
  }
}

async function pickFolder() {
  const res = await doAction({ action: 'pick_and_send_folder' });
  if (res && res.sent && res.sent.length > 0) {
    showToast('Sending ' + res.sent.join(', '));
  }
}

async function toggleContextMenu() {
  if (!currentState) return;
  await doAction({ action: 'toggle_context_menu', enable: !currentState.contextMenuInstalled });
}

async function toggleAutostart() {
  if (!currentState) return;
  await doAction({ action: 'toggle_autostart', enable: !currentState.autostartEnabled });
}

fetchStatus();
setInterval(fetchStatus, 2500);
</script>
</body>
</html>
`
