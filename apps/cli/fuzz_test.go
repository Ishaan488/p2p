package main

import (
	"fmt"
	"net/http"
	"strings"
	"testing"
)

// FuzzSanitizeFilename fuzzes the filename sanitizer to ensure it never allows
// directory traversal, illegal chars, or unbound lengths under arbitrary byte inputs.
func FuzzSanitizeFilename(f *testing.F) {
	seeds := []string{
		"test.txt",
		"../../../../etc/passwd",
		"..\\..\\windows\\system32\\calc.exe",
		"CON.txt",
		"COM1",
		"NUL",
		"AUX.tar.gz",
		"LPT1.pdf",
		"🎉_file_файл_中文_🚀.png",
		strings.Repeat("a", 500) + ".dat",
		"<foo>:\"bar\"/baz\\qux|test?*name.mp4",
		"..",
		".",
		"",
		"   .hidden   ",
	}

	for _, s := range seeds {
		f.Add(s)
	}

	f.Fuzz(func(t *testing.T, input string) {
		sanitized := sanitizeFilename(input)

		// Must never contain directory traversal
		if strings.Contains(sanitized, "..") {
			t.Errorf("sanitized result %q contains ..", sanitized)
		}
		if strings.Contains(sanitized, "/") || strings.Contains(sanitized, "\\") {
			t.Errorf("sanitized result %q contains path separator", sanitized)
		}

		// Must never contain Windows reserved characters
		if strings.ContainsAny(sanitized, `<>:"|?*`) {
			t.Errorf("sanitized result %q contains forbidden characters", sanitized)
		}

		// Must not exceed max length
		if len(sanitized) > 220 {
			t.Errorf("sanitized result length %d exceeds max bound", len(sanitized))
		}

		// Must not be empty
		if strings.TrimSpace(sanitized) == "" {
			t.Errorf("sanitized result is empty for input %q", input)
		}
	})
}

// FuzzNormalizePairCode verifies pairing code normalization strips spaces and dashes
// and uppercases all characters without crashing or hanging.
func FuzzNormalizePairCode(f *testing.F) {
	f.Add("ABCD-EFGH-JKMN-PQRS")
	f.Add("abcd efgh jkmn pqrs")
	f.Add("---   ---")
	f.Add("")
	f.Add(strings.Repeat("X", 200))

	f.Fuzz(func(t *testing.T, input string) {
		res := normalizePairCode(input)
		if strings.Contains(res, "-") || strings.Contains(res, " ") {
			t.Errorf("normalized code %q contains delimiter", res)
		}
		if res != strings.ToUpper(res) {
			t.Errorf("normalized code %q is not uppercase", res)
		}
	})
}

// FuzzChunkAAD verifies chunk AAD formatting consistency and panic-freedom across inputs.
func FuzzChunkAAD(f *testing.F) {
	f.Add("transfer-1", 0)
	f.Add("up-abc-xyz", 1000)
	f.Add("", -1)

	f.Fuzz(func(t *testing.T, transferID string, chunkIndex int) {
		aad := chunkAAD(transferID, chunkIndex)
		expected := fmt.Sprintf("chunk\n%s\n%d", transferID, chunkIndex)
		if aad != expected {
			t.Errorf("mismatch: got %q, want %q", aad, expected)
		}
	})
}

// FuzzRequestSignature verifies request signature calculation never panics under random query strings.
func FuzzRequestSignature(f *testing.F) {
	f.Add("transferId", "12345", "chunkIndex", "0")
	f.Add("", "", "", "")

	f.Fuzz(func(t *testing.T, k1, v1, k2, v2 string) {
		key := []byte("01234567890123456789012345678901")
		req, err := http.NewRequest("GET", fmt.Sprintf("/download?%s=%s&%s=%s", k1, v1, k2, v2), nil)
		if err != nil {
			return
		}
		sig := requestSignature(key, req)
		if len(sig) != 32 {
			t.Errorf("expected 32-byte HMAC-SHA256 signature, got %d", len(sig))
		}
	})
}

