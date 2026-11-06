package main

import (
	"regexp"
	"strings"
)

var (
	rePrivateKey    = regexp.MustCompile(`(?i)-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----`)
	reJWT           = regexp.MustCompile(`\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b`)
	reAPIToken      = regexp.MustCompile(`\b(ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|xox[baprs]-[A-Za-z0-9-]{10,})\b`)
	reSecretKV      = regexp.MustCompile(`(?i)\b(password|passwd|pwd|secret|api_key|apikey|access_token|auth_token|private_key)\s*[:=]\s*\S{4,}`)
	reCardCandidate = regexp.MustCompile(`\b(?:\d[ -]*?){13,19}\b`)
)

func isClipboardSyncEnabled() bool {
	if *noClipboard {
		return false
	}
	stateMu.Lock()
	defer stateMu.Unlock()
	return !state.ClipboardSyncDisabled
}

func setClipboardSyncEnabled(enabled bool) {
	stateMu.Lock()
	state.ClipboardSyncDisabled = !enabled
	saveStateLocked()
	stateMu.Unlock()
}

func isSensitiveClipboardFilterEnabled() bool {
	stateMu.Lock()
	defer stateMu.Unlock()
	return !state.SensitiveFilterDisabled
}

func setSensitiveClipboardFilterEnabled(enabled bool) {
	stateMu.Lock()
	state.SensitiveFilterDisabled = !enabled
	saveStateLocked()
	stateMu.Unlock()
}

// passesLuhn verifies whether a string of digits satisfies the Luhn checksum (ISO/IEC 7812).
func passesLuhn(digits string) bool {
	if len(digits) < 13 || len(digits) > 19 {
		return false
	}
	allSame := true
	for i := 1; i < len(digits); i++ {
		if digits[i] != digits[0] {
			allSame = false
			break
		}
	}
	if allSame {
		return false
	}
	sum := 0
	alt := false
	for i := len(digits) - 1; i >= 0; i-- {
		d := int(digits[i] - '0')
		if d < 0 || d > 9 {
			return false
		}
		if alt {
			d *= 2
			if d > 9 {
				d -= 9
			}
		}
		sum += d
		alt = !alt
	}
	return sum%10 == 0
}

// isSensitiveClipboard checks if clipboard text contains sensitive credentials, keys,
// tokens, or payment card numbers that should not be automatically broadcast (FR 36).
func isSensitiveClipboard(text string) (bool, string) {
	trimmed := strings.TrimSpace(text)
	if trimmed == "" {
		return false, ""
	}
	if rePrivateKey.MatchString(trimmed) {
		return true, "cryptographic private key"
	}
	if reJWT.MatchString(trimmed) {
		return true, "JWT authentication token"
	}
	if reAPIToken.MatchString(trimmed) {
		return true, "API secret key/token"
	}
	if reSecretKV.MatchString(trimmed) {
		return true, "credential assignment"
	}
	for _, match := range reCardCandidate.FindAllString(trimmed, -1) {
		var digits strings.Builder
		for _, ch := range match {
			if ch >= '0' && ch <= '9' {
				digits.WriteRune(ch)
			}
		}
		if passesLuhn(digits.String()) {
			return true, "payment card number"
		}
	}
	return false, ""
}
