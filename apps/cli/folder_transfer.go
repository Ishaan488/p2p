package main

import (
	"archive/zip"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Folder transfers: a directory is packed into a temporary zip which is then
// sent like any other file.

// maxUncompressedFileBytes caps what a single zip entry may expand to (zip bombs).
const maxUncompressedFileBytes = 10 << 30

// zipDirectory streams a directory into a zip writer, preserving the relative
// structure and empty directories. Symlinks and other special files are skipped
// (they could point outside the folder), as are files that cannot be read.
func zipDirectory(srcDir string, targetWriter io.Writer) (fileCount int, dirCount int, totalBytes int64, err error) {
	cleanSrc := filepath.Clean(srcDir)
	srcInfo, err := os.Stat(cleanSrc)
	if err != nil {
		return 0, 0, 0, err
	}
	if !srcInfo.IsDir() {
		return 0, 0, 0, fmt.Errorf("%s is not a directory", cleanSrc)
	}

	zipWriter := zip.NewWriter(targetWriter)

	walkErr := filepath.Walk(cleanSrc, func(path string, info os.FileInfo, walkErr error) error {
		if walkErr != nil {
			if path == cleanSrc {
				return walkErr
			}
			return nil // vanished or unreadable entry: skip it, keep going
		}

		relPath, err := filepath.Rel(cleanSrc, path)
		if err != nil {
			return err
		}
		if relPath == "." {
			return nil
		}
		// Convert Windows backslashes to forward slashes for the ZIP standard
		slashPath := filepath.ToSlash(relPath)

		if info.IsDir() {
			dirCount++
			_, err = zipWriter.Create(slashPath + "/")
			return err
		}
		if !info.Mode().IsRegular() {
			return nil
		}

		file, err := os.Open(path)
		if err != nil {
			return nil // locked or permission denied: skip this file
		}
		defer file.Close()

		header, err := zip.FileInfoHeader(info)
		if err != nil {
			return err
		}
		header.Name = slashPath
		header.Method = zip.Deflate
		writer, err := zipWriter.CreateHeader(header)
		if err != nil {
			return err
		}
		n, err := io.Copy(writer, file)
		if err != nil {
			return err
		}
		fileCount++
		totalBytes += n
		return nil
	})

	// Closing writes the central directory; without it the archive is unreadable.
	if closeErr := zipWriter.Close(); walkErr == nil {
		walkErr = closeErr
	}
	return fileCount, dirCount, totalBytes, walkErr
}

// extractZipSafely unpacks a ZIP archive into destDir with strict Zip Slip path traversal defenses.
// It verifies that all entries resolve strictly inside destDir, preserving subfolders and empty folders.
func extractZipSafely(zipReader *zip.Reader, destDir string) (extractedFiles int, extractedDirs int, err error) {
	cleanDest := filepath.Clean(destDir)
	if err := os.MkdirAll(cleanDest, 0o755); err != nil {
		return 0, 0, err
	}

	for _, file := range zipReader.File {
		cleanName := filepath.Clean(file.Name)

		// Reject relative path traversal and absolute paths / drive letters
		if cleanName == ".." || strings.HasPrefix(cleanName, ".."+string(os.PathSeparator)) ||
			filepath.IsAbs(cleanName) || filepath.VolumeName(cleanName) != "" ||
			strings.Contains(file.Name, "../") || strings.Contains(file.Name, "..\\") {
			return extractedFiles, extractedDirs, fmt.Errorf("security alert: Zip Slip path traversal entry rejected (%q)", file.Name)
		}

		targetPath := filepath.Join(cleanDest, cleanName)
		if targetPath != cleanDest && !strings.HasPrefix(targetPath, cleanDest+string(os.PathSeparator)) {
			return extractedFiles, extractedDirs, fmt.Errorf("security alert: target path %q escapes destination %q", targetPath, cleanDest)
		}

		if file.FileInfo().IsDir() {
			extractedDirs++
			if err := os.MkdirAll(targetPath, 0o755); err != nil {
				return extractedFiles, extractedDirs, err
			}
			continue
		}

		if err := extractZipEntry(file, targetPath); err != nil {
			return extractedFiles, extractedDirs, err
		}
		extractedFiles++
	}

	return extractedFiles, extractedDirs, nil
}

func extractZipEntry(file *zip.File, targetPath string) error {
	if err := os.MkdirAll(filepath.Dir(targetPath), 0o755); err != nil {
		return err
	}
	rc, err := file.Open()
	if err != nil {
		return err
	}
	defer rc.Close()

	outFile, err := os.OpenFile(targetPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, file.Mode().Perm()|0o600)
	if err != nil {
		return err
	}
	// Read one byte past the limit so an oversized entry is detected, not silently truncated.
	n, copyErr := io.Copy(outFile, io.LimitReader(rc, maxUncompressedFileBytes+1))
	if closeErr := outFile.Close(); copyErr == nil {
		copyErr = closeErr
	}
	if copyErr == nil && n > maxUncompressedFileBytes {
		copyErr = fmt.Errorf("zip entry %q exceeds the %d byte limit", file.Name, int64(maxUncompressedFileBytes))
	}
	if copyErr != nil {
		_ = os.Remove(targetPath)
	}
	return copyErr
}

func startSendFolderTransferTargeted(folderPath string, targetDevice *Device) error {
	cleanPath := filepath.Clean(folderPath)
	stat, err := os.Stat(cleanPath)
	if err != nil {
		return err
	}
	if !stat.IsDir() {
		return fmt.Errorf("%s is not a directory", cleanPath)
	}

	initDirs()
	folderName := sanitizeFilename(filepath.Base(cleanPath))
	tmpZipPath := filepath.Join(getTempDir(), fmt.Sprintf("folder_%s_%d.zip", folderName, time.Now().UnixNano()))

	zipFile, err := os.OpenFile(tmpZipPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return fmt.Errorf("failed to create folder zip container: %w", err)
	}
	files, dirs, origSize, err := zipDirectory(cleanPath, zipFile)
	if cerr := zipFile.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		_ = os.Remove(tmpZipPath)
		return fmt.Errorf("failed to package folder: %w", err)
	}

	zipStat, err := os.Stat(tmpZipPath)
	if err != nil {
		_ = os.Remove(tmpZipPath)
		return err
	}

	ownerID := ""
	if targetDevice != nil {
		ownerID = targetDevice.ID
	}
	chunkSize := int64(defaultChunkSize)
	state := &TransferState{
		ID:          randomID(),
		Filename:    folderName + ".zip",
		TotalChunks: chunkCount(zipStat.Size(), chunkSize),
		ChunkSize:   chunkSize,
		TotalSize:   zipStat.Size(),
		FilePath:    tmpZipPath,
		IsDownload:  true,
		IsFolder:    true,
		FolderName:  folderName,
		Owner:       ownerID,
		LastActive:  time.Now().Unix(),
	}

	transfersMu.Lock()
	transfers[state.ID] = state
	transfersMu.Unlock()

	if err := state.saveMeta(); err != nil {
		printSync(Yellow, "! Warning", "failed to persist folder download state", err.Error())
	}

	printSync(Cyan, "📁 Folder", fmt.Sprintf("%s (%d files, %d folders)", folderName, files, dirs), "packaging complete")

	announceDownload(state, targetDevice, map[string]interface{}{
		"folderName":   folderName,
		"isFolder":     true,
		"totalFiles":   files,
		"totalDirs":    dirs,
		"originalSize": origSize,
		"mimeType":     "application/zip",
	})
	return nil
}
