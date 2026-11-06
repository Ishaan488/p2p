//go:build darwin

package main

import (
	"os"
	"path/filepath"
)

func launchdPlistPath(home string) string {
	return filepath.Join(home, "Library", "LaunchAgents", launchdLabel+".plist")
}

func setLaunchdAutostart(enabled bool) error {
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	plist := launchdPlistPath(home)
	if !enabled {
		if err := os.Remove(plist); err != nil && !os.IsNotExist(err) {
			return err
		}
		return nil
	}
	exePath, err := os.Executable()
	if err != nil {
		return err
	}
	if resolved, err := filepath.EvalSymlinks(exePath); err == nil {
		exePath = resolved
	}
	exePath, _ = filepath.Abs(exePath)
	if err := os.MkdirAll(filepath.Dir(plist), 0o755); err != nil {
		return err
	}
	return os.WriteFile(plist, []byte(renderLaunchdPlist(exePath, filepath.Join(baseDir, "p2p.log"))), 0o644)
}

func isLaunchdAutostartEnabled() bool {
	home, err := os.UserHomeDir()
	if err != nil {
		return false
	}
	_, err = os.Stat(launchdPlistPath(home))
	return err == nil
}
