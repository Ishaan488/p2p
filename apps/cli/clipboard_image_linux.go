//go:build linux

package main

import (
	"os/exec"
)

// Linux clipboard image reader (supports both X11 via xclip and Wayland via wl-paste)
func readOSClipboardImage() ([]byte, error) {
	if _, err := exec.LookPath("wl-paste"); err == nil {
		out, err := exec.Command("wl-paste", "--type", "image/png").Output()
		if err == nil && len(out) > 0 {
			return out, nil
		}
	}
	if _, err := exec.LookPath("xclip"); err == nil {
		out, err := exec.Command("xclip", "-selection", "clipboard", "-t", "image/png", "-o").Output()
		if err == nil && len(out) > 0 {
			return out, nil
		}
	}
	return nil, nil
}

