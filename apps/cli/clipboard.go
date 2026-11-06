package main

import (
	"fmt"
	"sync"
	"time"

	"github.com/atotto/clipboard"
)

var (
	clipboardMu       sync.RWMutex
	lastClipboardText string
)

func readClipboardWithRetry() (string, error) {
	var err error
	var text string
	for attempt := 0; attempt < 3; attempt++ {
		text, err = clipboard.ReadAll()
		if err == nil {
			return text, nil
		}
		time.Sleep(50 * time.Millisecond)
	}
	return "", err
}

// maxClipboardSyncBytes bounds the text mirrored between devices.
const maxClipboardSyncBytes = 1 << 20

func watchClipboard() {
	if clipboard.Unsupported {
		// Linux without xclip, xsel or wl-clipboard: every read would fail.
		printAsync(Yellow, "○ Clipboard", "Sync unavailable", "install xclip, xsel or wl-clipboard")
		return
	}
	// Seed initial clipboard state so pre-existing clipboard text isn't broadcast on boot
	if initial, err := readClipboardWithRetry(); err == nil && initial != "" {
		clipboardMu.Lock()
		lastClipboardText = initial
		clipboardMu.Unlock()
	}

	pollInterval := 1 * time.Second
	for {
		time.Sleep(pollInterval)
		if !isClipboardSyncEnabled() {
			continue
		}
		text, err := readClipboardWithRetry()
		if err != nil {
			// No text on the clipboard (or it is busy): it may hold an image instead.
			checkAndBroadcastClipboardImage()
			if pollInterval < 3*time.Second {
				pollInterval += 500 * time.Millisecond
			}
			continue
		}
		pollInterval = 1 * time.Second

		clipboardMu.RLock()
		prev := lastClipboardText
		clipboardMu.RUnlock()

		if text != "" && text != prev {
			clipboardMu.Lock()
			lastClipboardText = text
			clipboardMu.Unlock()

			if len(text) > maxClipboardSyncBytes {
				printAsync(Yellow, "○ Clipboard", "Skipped oversized clipboard text", formatSize(int64(len(text))))
				continue
			}

			// Check for sensitive clipboard content (FR 36)
			if isSensitiveClipboardFilterEnabled() {
				if sensitive, reason := isSensitiveClipboard(text); sensitive {
					printAsync(Yellow, "○ ClipGuard", "Blocked sensitive clipboard sync", reason)
					continue
				}
			}

			msg := Message{
				Version:   1,
				Type:      "clipboard",
				ID:        fmt.Sprintf("msg-%d", time.Now().UnixNano()),
				Timestamp: time.Now().Unix(),
				Payload:   TextPayload{Text: text},
			}
			// Silently sync PC clipboard to connected devices without interrupting terminal input
			broadcastOnlineOnly(msg)
		} else {
			// Check if an image is on the clipboard (screenshots, copied photos)
			checkAndBroadcastClipboardImage()
		}
	}
}

// copyToClipboard writes text to the local clipboard. It reports whether the
// text was actually copied (false when sync is disabled or the write failed).
func copyToClipboard(text string) bool {
	if !isClipboardSyncEnabled() {
		return false
	}
	clipboardMu.Lock()
	lastClipboardText = text
	clipboardMu.Unlock()

	for attempt := 0; attempt < 3; attempt++ {
		if err := clipboard.WriteAll(text); err == nil {
			return true
		}
		time.Sleep(50 * time.Millisecond)
	}
	return false
}
