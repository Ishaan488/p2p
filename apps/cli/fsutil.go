package main

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

var windowsReservedNames = map[string]bool{
	"CON": true, "PRN": true, "AUX": true, "NUL": true,
	"COM1": true, "COM2": true, "COM3": true, "COM4": true,
	"COM5": true, "COM6": true, "COM7": true, "COM8": true, "COM9": true,
	"LPT1": true, "LPT2": true, "LPT3": true, "LPT4": true,
	"LPT5": true, "LPT6": true, "LPT7": true, "LPT8": true, "LPT9": true,
}

const maxFilenameBytes = 200

// truncateUTF8 shortens s to at most n bytes without splitting a rune.
func truncateUTF8(s string, n int) string {
	if len(s) <= n {
		return s
	}
	for n > 0 && s[n]&0xC0 == 0x80 { // s[n] continues a multi-byte sequence
		n--
	}
	return s[:n]
}

// sanitizeFilename strips any directory components a client may have sent,
// removes Windows reserved chars, defangs device names, trims trailing dots/spaces,
// and bounds the filename length.
func sanitizeFilename(name string) string {
	name = strings.ReplaceAll(name, "\\", "/")
	if idx := strings.LastIndex(name, "/"); idx >= 0 {
		name = name[idx+1:]
	}
	name = strings.Map(func(r rune) rune {
		if r < 32 || r == 0x7f || strings.ContainsRune(`<>:"|?*`, r) {
			return '_'
		}
		return r
	}, name)
	name = strings.Trim(name, " \t\r\n.")
	if name == "" || name == "." || name == ".." {
		return "unnamed"
	}

	// Truncate overly long filenames while preserving the extension
	if len(name) > maxFilenameBytes {
		fullExt := filepath.Ext(name)
		ext := truncateUTF8(fullExt, 50)
		base := strings.TrimSuffix(name, fullExt)
		maxBase := maxFilenameBytes - len(ext)
		if maxBase < 1 {
			maxBase = 1
		}
		name = truncateUTF8(base, maxBase) + ext
	}

	// Defang Windows reserved device names (CON, PRN, AUX, NUL, COM1-9, LPT1-9)
	root := strings.ToUpper(strings.Split(name, ".")[0])
	if windowsReservedNames[strings.TrimRight(root, " ")] {
		name = "_" + name
	}

	return name
}

// moveMu serialises moves into the receive directory so two transfers with the
// same file name never pick the same destination.
var moveMu sync.Mutex

// destCandidate returns the counter-th collision-free spelling of filename
// ("name.ext", "name (1).ext", ...) inside cleanDir, verifying it cannot escape cleanDir.
func destCandidate(cleanDir, filename string, counter int) (string, error) {
	candidate := filename
	if counter > 0 {
		ext := filepath.Ext(filename)
		candidate = fmt.Sprintf("%s (%d)%s", strings.TrimSuffix(filename, ext), counter, ext)
	}
	p := filepath.Join(cleanDir, candidate)
	rel, err := filepath.Rel(cleanDir, p)
	if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) {
		return "", fmt.Errorf("invalid destination path: %s", p)
	}
	return p, nil
}

// absDir resolves dir to an absolute path and creates it.
func absDir(dir string) (string, error) {
	cleanDir, err := filepath.Abs(dir)
	if err != nil {
		cleanDir = filepath.Clean(dir)
	}
	if err := os.MkdirAll(cleanDir, 0o755); err != nil {
		return "", err
	}
	return cleanDir, nil
}

func exists(path string) bool {
	_, err := os.Lstat(path)
	return err == nil
}

// moveFile renames src to dst, falling back to an exclusive copy across
// volumes. It never overwrites an existing dst.
func moveFile(src, dst string) error {
	if exists(dst) {
		return fmt.Errorf("destination exists: %s", dst)
	}
	if err := os.Rename(src, dst); err == nil {
		return nil
	}
	if err := copyExclusive(src, dst); err != nil {
		return err
	}
	_ = os.Remove(src)
	return nil
}

// moveToFinalPath moves src to finalPath (used when completing an interrupted commit).
func moveToFinalPath(src, finalPath string) error {
	moveMu.Lock()
	defer moveMu.Unlock()

	if err := os.MkdirAll(filepath.Dir(finalPath), 0o755); err != nil {
		return err
	}
	if err := moveFile(src, finalPath); err != nil {
		return fmt.Errorf("failed to move %s to %s: %w", src, finalPath, err)
	}
	return nil
}

// moveIntoDir moves src into dir under a collision-free name and returns the final path.
func moveIntoDir(src, dir, filename string) (string, error) {
	moveMu.Lock()
	defer moveMu.Unlock()

	cleanDir, err := absDir(dir)
	if err != nil {
		return "", err
	}
	cleanFilename := sanitizeFilename(filepath.Base(filepath.Clean(filename)))

	for counter := 0; counter < 10000; counter++ {
		finalPath, err := destCandidate(cleanDir, cleanFilename, counter)
		if err != nil {
			return "", err
		}
		if exists(finalPath) {
			continue
		}
		if err := moveFile(src, finalPath); err == nil {
			return finalPath, nil
		}
	}
	return "", fmt.Errorf("could not find unique filename after multiple attempts")
}

// copyExclusive copies src to dest, failing if dest already exists. A partial
// copy is removed.
func copyExclusive(src, dest string) (err error) {
	srcFile, err := os.Open(src)
	if err != nil {
		return err
	}
	defer srcFile.Close()

	destFile, err := os.OpenFile(dest, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	defer func() {
		if cerr := destFile.Close(); err == nil {
			err = cerr
		}
		if err != nil {
			_ = os.Remove(dest)
		}
	}()

	if _, err = io.Copy(destFile, srcFile); err != nil {
		return err
	}
	return destFile.Sync()
}
