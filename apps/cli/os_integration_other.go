//go:build !windows

package main

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
)

func installExplorerContextMenu() error {
	if runtime.GOOS == "linux" {
		home, err := os.UserHomeDir()
		if err != nil {
			return err
		}
		exePath, err := os.Executable()
		if err != nil {
			return err
		}
		exePath, _ = filepath.Abs(exePath)
		desktopDir := filepath.Join(home, ".local", "share", "applications")
		_ = os.MkdirAll(desktopDir, 0755)
		entryPath := filepath.Join(desktopDir, "p2plink-send.desktop")
		entry := fmt.Sprintf("[Desktop Entry]\nType=Application\nName=Send via P2P Link\nExec=\"%s\" --send %%F\nTerminal=false\nMimeType=application/octet-stream;inode/directory;\n", exePath)
		return os.WriteFile(entryPath, []byte(entry), 0644)
	}
	return nil
}

func uninstallExplorerContextMenu() error {
	if runtime.GOOS == "linux" {
		home, _ := os.UserHomeDir()
		_ = os.Remove(filepath.Join(home, ".local", "share", "applications", "p2plink-send.desktop"))
	}
	return nil
}

func isExplorerContextMenuInstalled() bool {
	if runtime.GOOS == "linux" {
		home, _ := os.UserHomeDir()
		_, err := os.Stat(filepath.Join(home, ".local", "share", "applications", "p2plink-send.desktop"))
		return err == nil
	}
	return false
}

func syncQuickSendShortcuts() error {
	return nil
}

func setOSAutostart(enabled bool) error {
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	autostartDir := filepath.Join(home, ".config", "autostart")
	entryPath := filepath.Join(autostartDir, "p2plink.desktop")
	if !enabled {
		_ = os.Remove(entryPath)
		return nil
	}
	exePath, err := os.Executable()
	if err != nil {
		return err
	}
	exePath, _ = filepath.Abs(exePath)
	_ = os.MkdirAll(autostartDir, 0755)
	entry := fmt.Sprintf("[Desktop Entry]\nType=Application\nName=P2P Link\nExec=\"%s\"\nTerminal=false\n", exePath)
	return os.WriteFile(entryPath, []byte(entry), 0644)
}

func isOSAutostartEnabled() bool {
	home, err := os.UserHomeDir()
	if err != nil {
		return false
	}
	_, err = os.Stat(filepath.Join(home, ".config", "autostart", "p2plink.desktop"))
	return err == nil
}

func startSystemTray(port int) {}

func stopSystemTray() {}

func toggleConsoleVisibility() {}

