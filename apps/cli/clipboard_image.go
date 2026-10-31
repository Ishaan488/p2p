package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

var (
	lastImageHash   string
	lastImageHashMu sync.Mutex
)

// readClipboardImage calls the OS-specific implementation to read raw image bytes (as PNG)
func readClipboardImage() ([]byte, error) {
	return readOSClipboardImage()
}

// checkAndBroadcastClipboardImage periodically detects image copy events on the OS clipboard
// and broadcasts them to connected devices without duplicating previous items.
func checkAndBroadcastClipboardImage() {
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

	// Write PNG to temp cache and initiate send transfer
	filename := fmt.Sprintf("Clipboard_%s.png", time.Now().Format("20060102_150405"))
	tmpPath := filepath.Join(tempDir, filename)
	if err := os.WriteFile(tmpPath, imgBytes, 0644); err != nil {
		return
	}

	printAsync(Cyan, "↓ ClipImg", fmt.Sprintf("%s (%s)", filename, formatSize(int64(len(imgBytes)))), "clipboard image detected")

	_ = startSendTransfer(tmpPath)
}
