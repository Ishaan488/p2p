package main

import (
	"bufio"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

// Interactive terminal ("p2p>") command loop.

const replMaxLine = 1 << 20 // pasted paths / messages can exceed bufio's default 64 KiB

const helpText = `
  Commands
  send <path> [--to <device|#n>]   Send file or folder to all or specific device
  > <path> [--to <device|#n>]      Quick send file or folder
  msg <text> [--to <device>]       Send text message to all or specific device
  devices                          List paired & active devices (with #index & alias)
  alias <device> <new_name>        Assign a custom alias to a paired device
  pcalias <new_name>               Assign a custom display name to this PC
  trust <device>                   Trust device (auto-accept transfers)
  untrust <device>                 Require approval for each transfer
  unpair <device>                  Remove a paired device
  bandwidth <MB/s|unlimited>       Set transfer speed limit (e.g. 'bandwidth 10')
  clipboard <on|off>               Toggle automatic clipboard synchronization
  clipfilter <on|off>              Toggle sensitive clipboard content filter
  context-menu <on|off>            Toggle Windows Explorer right-click 'Send via P2P'
  autostart <on|off>               Toggle launch automatically on system startup
  tray                             Hide/restore console window to system tray
  history [clear]                  Show or clear recent transfer history
  status                           Show server, bandwidth & network info
  pair                             Show a fresh pairing QR code
  open                             Open web interface in browser
  setdir <path>                    Change folder for received files
  clear                            Clear terminal screen
  exit                             Stop server
`

func printHelp() {
	fmt.Println(Cyan + helpText + Reset)
}

// parseOnOff interprets the usual spellings of an on/off argument.
func parseOnOff(arg string) bool {
	switch strings.ToLower(strings.TrimSpace(arg)) {
	case "on", "true", "1", "enable", "enabled", "yes", "install":
		return true
	}
	return false
}

// runREPL reads commands from stdin until EOF. It returns when stdin is closed
// (for example when the process was started without a console); the server keeps
// running in that case.
func runREPL() {
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 0, 64<<10), replMaxLine)
	for {
		fmt.Print("p2p> ")
		if !scanner.Scan() {
			return
		}
		text := strings.TrimSpace(scanner.Text())
		if text == "" {
			continue
		}
		if answerApproval(text) {
			continue
		}
		handleCommand(text)
	}
}

// splitCommand returns the lower-cased verb and the remaining argument text.
func splitCommand(text string) (verb, arg string) {
	if i := strings.IndexAny(text, " \t"); i >= 0 {
		return strings.ToLower(text[:i]), strings.TrimSpace(text[i+1:])
	}
	return strings.ToLower(text), ""
}

// bareCommands take no argument: "clear the cache" is a chat message, not a command.
var bareCommands = map[string]bool{
	"help": true, "?": true, "exit": true, "quit": true, "clear": true, "cls": true,
	"open": true, "ui": true, "status": true, "info": true, "pair": true,
	"devices": true, "tray": true,
}

func handleCommand(text string) {
	verb, arg := splitCommand(text)
	if verb == "clear" && strings.EqualFold(arg, "history") {
		verb, arg = "history", "clear"
	}
	if bareCommands[verb] && arg != "" {
		cmdMessage(text)
		return
	}

	switch verb {
	case "help", "?":
		printHelp()
	case "exit", "quit":
		fmt.Println(Dim + "  Shutting down..." + Reset)
		requestShutdown()
	case "clear", "cls":
		fmt.Print("\033[H\033[2J")
	case "open", "ui":
		url := fmt.Sprintf("%s://localhost:%d/desktop", httpScheme(), *port)
		printSync(Green, "● Browser", url, "opened")
		if err := openBrowser(url); err != nil {
			printSync(Red, "! Error", fmt.Sprintf("Failed to open browser: %v", err), "")
		}
	case "status", "info":
		printStatus()
	case "pair":
		showPairing()
	case "devices":
		printDevices()
	case "tray":
		toggleConsoleVisibility()
	case "history", "log":
		if strings.EqualFold(arg, "clear") {
			clearHistory()
			printSync(Green, "● History", "Transfer history cleared", "")
		} else {
			printTransferHistory()
		}
	case "alias", "rename":
		cmdAlias(arg)
	case "pcalias":
		saved := setServerAlias(strings.Trim(arg, "\"'"))
		printSync(Green, "● PC Alias", getServerName(), fmt.Sprintf("alias=%q", saved))
	case "bandwidth":
		cmdBandwidth(arg)
	case "clipboard":
		enable := parseOnOff(arg)
		setClipboardSyncEnabled(enable)
		printSync(Green, "● Clipboard", "Auto-sync "+enabledWord(enable), "")
	case "clipfilter":
		enable := parseOnOff(arg)
		setSensitiveClipboardFilterEnabled(enable)
		printSync(Green, "● ClipGuard", "Sensitive filter "+enabledWord(enable), "")
	case "context-menu":
		cmdContextMenu(parseOnOff(arg))
	case "autostart":
		enable := parseOnOff(arg)
		if err := setOSAutostart(enable); err != nil {
			printSync(Red, "! Error", fmt.Sprintf("Failed: %v", err), "")
		} else {
			printSync(Green, "● Autostart", fmt.Sprintf("Launch on startup: %v", enable), "")
		}
	case "trust", "untrust":
		cmdTrust(arg, verb == "trust")
	case "unpair":
		unpairDevice(strings.Trim(arg, "\"'"))
	case "setdir":
		cmdSetDir(arg)
	default:
		switch {
		case isSendCommand(text):
			cmdSend(text)
		default:
			cmdMessage(text)
		}
	}
}

func enabledWord(on bool) string {
	if on {
		return "enabled"
	}
	return "disabled"
}

func cmdAlias(arg string) {
	parts := strings.SplitN(arg, " ", 2)
	if len(parts) < 2 || strings.TrimSpace(parts[0]) == "" {
		printSync(Red, "! Usage", "alias <device> <new_alias>", "")
		return
	}
	target, newAlias := strings.Trim(parts[0], "\"'"), strings.Trim(strings.TrimSpace(parts[1]), "\"'")
	dev := resolveDeviceTarget(target)
	if dev == nil {
		printSync(Red, "! Error", fmt.Sprintf("No paired device matches %q", target), "")
		return
	}
	updated, ok := setDeviceAlias(dev.ID, newAlias)
	if !ok {
		printSync(Red, "! Error", fmt.Sprintf("No paired device matches %q", target), "")
		return
	}
	_ = syncQuickSendShortcuts()
	printSync(Green, "● Alias", fmt.Sprintf("%s → %s", updated.Name, updated.DisplayName()), "saved")
}

func cmdBandwidth(arg string) {
	arg = strings.ToLower(strings.TrimSpace(arg))
	var bps int64
	switch {
	case arg == "unlimited" || arg == "0" || arg == "off":
		bps = 0
	default:
		mbps, err := strconv.ParseFloat(arg, 64)
		if err != nil || mbps <= 0 || mbps > 1<<20 {
			printSync(Red, "! Usage", "bandwidth <MB/s|unlimited>", "")
			return
		}
		bps = int64(mbps * 1024 * 1024)
	}
	persistBandwidthLimit(bps)
	if bps == 0 {
		printSync(Green, "● Bandwidth", "Unlimited", "rate limiting disabled")
	} else {
		printSync(Green, "● Bandwidth", fmt.Sprintf("%s/s cap", formatSize(bps)), "active")
	}
}

func cmdContextMenu(enable bool) {
	if enable {
		if err := installExplorerContextMenu(); err != nil {
			printSync(Red, "! Error", fmt.Sprintf("Failed: %v", err), "")
			return
		}
		printSync(Green, "● Explorer", "Added 'Send via P2P Link' to Windows right-click menu", "")
		return
	}
	_ = uninstallExplorerContextMenu()
	printSync(Yellow, "○ Explorer", "Removed Windows right-click menu", "")
}

func cmdTrust(target string, trusted bool) {
	target = strings.Trim(target, "\"'")
	dev := resolveDeviceTarget(target)
	if dev == nil || !setDeviceTrust(dev.ID, trusted) {
		printSync(Red, "! Error", fmt.Sprintf("No paired device matches %q", target), "")
		return
	}
	if trusted {
		printSync(Green, "● Trusted", dev.DisplayName(), "transfers auto-accepted")
	} else {
		printSync(Yellow, "○ Untrusted", dev.DisplayName(), "per-transfer approval required")
	}
}

func cmdSetDir(arg string) {
	newDir := strings.Trim(strings.TrimSpace(arg), "\"'")
	if newDir == "" {
		printSync(Red, "! Usage", "setdir <path>", "")
		return
	}
	if err := setReceiveDir(newDir); err != nil {
		printSync(Red, "! Error", fmt.Sprintf("Failed to set directory: %v", err), "")
		return
	}
	persistReceiveDir()
	printSync(Green, "● Storage", newDir, "receive folder updated")
}

// resolveOptionalTarget resolves a "--to" query. ok is false (and an error has
// been printed) when a query was given but matched no paired device.
func resolveOptionalTarget(query string) (dev *Device, ok bool) {
	if query == "" {
		return nil, true
	}
	dev = resolveDeviceTarget(query)
	if dev == nil {
		printSync(Red, "! Error", fmt.Sprintf("No paired device matches %q (type 'devices')", query), "")
		return nil, false
	}
	return dev, true
}

func cmdSend(text string) {
	filePath, targetQuery := extractFilePathAndTarget(text)
	fmt.Print("\033[1A\r\033[2K")
	target, ok := resolveOptionalTarget(targetQuery)
	if !ok {
		return
	}
	if err := startSendTransferTargeted(filePath, target); err != nil {
		printSync(Red, "! Error", fmt.Sprintf("Could not send file: %v", err), "")
	}
}

// cmdMessage sends any unrecognised line as a text message.
func cmdMessage(text string) {
	fmt.Print("\033[1A\r\033[2K")
	cleanText, targetQuery := parseTargetFlag(text)
	if len(cleanText) >= 4 && strings.EqualFold(cleanText[:4], "msg ") {
		cleanText = strings.TrimSpace(cleanText[4:])
	}
	if cleanText == "" {
		return
	}
	target, ok := resolveOptionalTarget(targetQuery)
	if !ok {
		return
	}
	msg := Message{
		Version:   1,
		Type:      "text",
		ID:        fmt.Sprintf("msg-%d", time.Now().UnixNano()),
		Timestamp: time.Now().Unix(),
		Payload:   TextPayload{Text: cleanText},
	}
	targetLabel := ""
	if target != nil {
		msg.TargetDeviceID = target.ID
		targetLabel = " → " + target.DisplayName()
	}
	if broadcastMessage(msg) > 0 {
		printSync(Cyan, "↑ Sent", cleanText+targetLabel, "")
	} else {
		printSync(Yellow, "↑ Sent", cleanText+targetLabel, "queued")
	}
}
