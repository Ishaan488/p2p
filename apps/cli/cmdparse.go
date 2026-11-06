package main

import (
	"os"
	"strconv"
	"strings"
)

// Parsing helpers for the interactive terminal.

// resolveDeviceTarget supports quick-send by 1-based index (#1, 1) as well as alias, name, or ID prefix (FR 48).
func resolveDeviceTarget(query string) *Device {
	query = strings.TrimSpace(query)
	if query == "" {
		return nil
	}
	q := strings.TrimPrefix(query, "#")
	if idx, err := strconv.Atoi(q); err == nil && idx >= 1 {
		devices := listDevices()
		if idx <= len(devices) {
			return findDevice(devices[idx-1].ID)
		}
	}
	return findDeviceByQuery(query)
}

// stripPrompt removes any pasted "p2p>" prompt prefixes from a line.
func stripPrompt(s string) string {
	s = strings.TrimSpace(s)
	for len(s) >= 4 && strings.EqualFold(s[:4], "p2p>") {
		s = strings.TrimSpace(s[4:])
	}
	return s
}

// parseTargetFlag splits "<text> --to <target>" into its two halves.
func parseTargetFlag(input string) (string, string) {
	trimmed := stripPrompt(input)
	if idx := strings.Index(strings.ToLower(trimmed), " --to "); idx != -1 {
		mainPart := strings.TrimSpace(trimmed[:idx])
		targetPart := strings.Trim(strings.TrimSpace(trimmed[idx+6:]), "\"'")
		return mainPart, targetPart
	}
	return trimmed, ""
}

func extractFilePathAndTarget(input string) (string, string) {
	mainPart, target := parseTargetFlag(input)
	return extractFilePath(mainPart), target
}

func isSendCommand(input string) bool {
	mainPart, _ := parseTargetFlag(input)
	trimmed := stripPrompt(mainPart)
	if len(trimmed) >= 5 && strings.EqualFold(trimmed[:5], "send ") || strings.HasPrefix(trimmed, ">") {
		return true
	}
	// Also detect a file path that was dragged & dropped or pasted into the prompt.
	cleaned := strings.Trim(trimmed, "\"'")
	if len(cleaned) >= 2 {
		if _, err := os.Stat(cleaned); err == nil {
			return true
		}
	}
	return false
}

func extractFilePath(input string) string {
	s := stripPrompt(input)
	for {
		if len(s) >= 5 && strings.EqualFold(s[:5], "send ") {
			s = strings.TrimSpace(s[5:])
		} else if strings.HasPrefix(s, ">") {
			s = strings.TrimSpace(s[1:])
		} else {
			break
		}
	}
	return strings.Trim(s, "\"'")
}
