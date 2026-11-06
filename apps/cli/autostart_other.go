//go:build !darwin && !windows

package main

// launchd exists only on macOS; Linux uses the XDG autostart entry in os_integration_other.go.

func setLaunchdAutostart(bool) error { return nil }

func isLaunchdAutostartEnabled() bool { return false }
