package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

const (
	maxClipboardImageBytes = 32 << 20
	clipboardImagePrefix   = "Clipboard_"
)

var (
	lastImageHash   string
	lastImageHashMu sync.Mutex
	lastImagePoll   time.Time
)

// subprocessImagePollGap spaces out clipboard image checks on platforms where each
// check spawns a helper process (osascript, wl-paste, xclip).
const subprocessImagePollGap = 2 * time.Second

// decodeAppleScriptData extracts the bytes from AppleScript's textual form of
// binary data, for example "«data PNGf89504E47...»" (osascript prints the clipboard
// that way rather than as raw bytes).
func decodeAppleScriptData(out []byte) ([]byte, error) {
	text := strings.TrimSpace(string(out))
	start := strings.Index(text, "«data ")
	end := strings.LastIndex(text, "»")
	if start < 0 || end < start {
		return nil, fmt.Errorf("not AppleScript data")
	}
	body := text[start+len("«data ") : end]
	if len(body) < 4 {
		return nil, fmt.Errorf("empty AppleScript data")
	}
	return hex.DecodeString(body[4:]) // skip the 4-character type code ("PNGf")
}

// readClipboardImage calls the OS-specific implementation to read raw image bytes (as PNG)
func readClipboardImage() ([]byte, error) {
	return readOSClipboardImage()
}

// checkAndBroadcastClipboardImage detects image copy events on the OS clipboard
// and sends them to connected devices once per distinct image.
func checkAndBroadcastClipboardImage() {
	if runtime.GOOS != "windows" {
		lastImageHashMu.Lock()
		tooSoon := time.Since(lastImagePoll) < subprocessImagePollGap
		if !tooSoon {
			lastImagePoll = time.Now()
		}
		lastImageHashMu.Unlock()
		if tooSoon {
			return
		}
	}
	imgBytes, err := readClipboardImage()
	if err != nil || len(imgBytes) == 0 {
		return
	}

	hash := sha256.Sum256(imgBytes)
	hashHex := hex.EncodeToString(hash[:])

	lastImageHashMu.Lock()
	if hashHex == lastImageHash {
		lastImageHashMu.Unlock()
		return
	}
	lastImageHash = hashHex
	lastImageHashMu.Unlock()

	// Like clipboard text, images are mirrored to devices that are online right
	// now; they are never queued for later (that would pile up files on disk).
	if !hasOnlineClients() {
		return
	}
	if len(imgBytes) > maxClipboardImageBytes {
		printAsync(Yellow, "○ Clipboard", "Skipped oversized clipboard image", formatSize(int64(len(imgBytes))))
		return
	}

	dir := getTempDir()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return
	}
	filename := fmt.Sprintf("%s%s.png", clipboardImagePrefix, time.Now().Format("20060102_150405"))
	tmpPath := filepath.Join(dir, filename)
	if err := os.WriteFile(tmpPath, imgBytes, 0o600); err != nil {
		return
	}

	printAsync(Cyan, "↓ ClipImg", fmt.Sprintf("%s (%s)", filename, formatSize(int64(len(imgBytes)))), "clipboard image detected")

	if err := startSendTransferTargeted(tmpPath, nil); err != nil {
		_ = os.Remove(tmpPath)
	}
}

// isGeneratedTempFile reports whether path is a file this program created in
// its own temp directory (clipboard image or folder archive) and may delete
// once the transfer that used it is over.
func isGeneratedTempFile(path string) bool {
	if path == "" {
		return false
	}
	if filepath.Dir(filepath.Clean(path)) != filepath.Clean(getTempDir()) {
		return false
	}
	base := filepath.Base(path)
	return strings.HasPrefix(base, clipboardImagePrefix) || (strings.HasPrefix(base, "folder_") && strings.HasSuffix(base, ".zip"))
}
