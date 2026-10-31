//go:build !windows && !darwin && !linux

package main

func readOSClipboardImage() ([]byte, error) {
	return nil, nil
}

