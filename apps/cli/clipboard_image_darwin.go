//go:build darwin

package main

import (
	"bytes"
	"os/exec"
)

// macOS clipboard image reader using osascript
func readOSClipboardImage() ([]byte, error) {
	cmd := exec.Command("osascript", "-e", `
		set cb to the clipboard as «class PNGf»
		return cb
	`)
	var out bytes.Buffer
	cmd.Stdout = &out
	if err := cmd.Run(); err != nil {
		return nil, nil // Clipboard does not contain an image
	}
	return out.Bytes(), nil
}

