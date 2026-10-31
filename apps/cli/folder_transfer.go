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

// FolderMetadata carries details about a streamed folder transfer
type FolderMetadata struct {
	FolderName   string `json:"folderName"`
	TotalFiles   int    `json:"totalFiles"`
	TotalDirs    int    `json:"totalDirs"`
	OriginalSize int64  `json:"originalSize"`
}

// zipDirectory streams a directory into a zip writer, preserving relative structure,
// empty directories, and protecting against symlink escapes.
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
	defer zipWriter.Close()

	err = filepath.Walk(cleanSrc, func(path string, info os.FileInfo, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}

		relPath, err := filepath.Rel(cleanSrc, path)
		if err != nil {
			return err
		}
		if relPath == "." {
			return nil
		}

		// Convert Windows backslashes to forward slashes for cross-platform ZIP standard
		slashPath := filepath.ToSlash(relPath)

		// Check for symlinks to prevent directory traversal escapes
		if info.Mode()&os.ModeSymlink != 0 {
			resolved, err := filepath.EvalSymlinks(path)
			if err != nil {
				// Skip broken symlinks safely
				return nil
			}
			resolvedClean := filepath.Clean(resolved)
			// If symlink points outside the source directory, skip to prevent leakage
			if !strings.HasPrefix(resolvedClean, cleanSrc+string(os.PathSeparator)) && resolvedClean != cleanSrc {
				return nil
			}
		}

		if info.IsDir() {
			dirCount++
			_, err = zipWriter.Create(slashPath + "/")
			return err
		}

		fileCount++
		totalBytes += info.Size()

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

		file, err := os.Open(path)
		if err != nil {
			return err
		}
		defer file.Close()

		_, err = io.Copy(writer, file)
		return err
	})

	if err != nil {
		return fileCount, dirCount, totalBytes, err
	}

	return fileCount, dirCount, totalBytes, nil
}

// extractZipSafely unpacks a ZIP archive into destDir with strict Zip Slip path traversal defenses.
// It verifies that all entries resolve strictly inside destDir, preserving subfolders and empty folders.
func extractZipSafely(zipReader *zip.Reader, destDir string) (extractedFiles int, extractedDirs int, err error) {
	cleanDest := filepath.Clean(destDir)
	if err := os.MkdirAll(cleanDest, 0755); err != nil {
		return 0, 0, err
	}

	for _, file := range zipReader.File {
		cleanName := filepath.Clean(file.Name)

		// 1. Strict Zip Slip Defense: reject any relative path traversal or drive letters
		if strings.HasPrefix(cleanName, "..") || filepath.IsAbs(cleanName) || strings.Contains(file.Name, "../") || strings.Contains(file.Name, "..\\") {
			return extractedFiles, extractedDirs, fmt.Errorf("security alert: Zip Slip path traversal entry rejected (%q)", file.Name)
		}

		targetPath := filepath.Join(cleanDest, cleanName)
		// Ensure resolved target is strictly within cleanDest
		if !strings.HasPrefix(filepath.Clean(targetPath), cleanDest+string(os.PathSeparator)) && filepath.Clean(targetPath) != cleanDest {
			return extractedFiles, extractedDirs, fmt.Errorf("security alert: target path %q escapes destination %q", targetPath, cleanDest)
		}

		if file.FileInfo().IsDir() {
			extractedDirs++
			if err := os.MkdirAll(targetPath, 0755); err != nil {
				return extractedFiles, extractedDirs, err
			}
			continue
		}

		// Ensure parent directory exists for nested files
		parentDir := filepath.Dir(targetPath)
		if err := os.MkdirAll(parentDir, 0755); err != nil {
			return extractedFiles, extractedDirs, err
		}

		// Read and extract file with bounded decompression to prevent Zip Bombs
		rc, err := file.Open()
		if err != nil {
			return extractedFiles, extractedDirs, err
		}

		outFile, err := os.OpenFile(targetPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, file.Mode())
		if err != nil {
			rc.Close()
			return extractedFiles, extractedDirs, err
		}

		// Limit uncompressed size per file to 10 GB to mitigate zip bombs
		const maxFileUncompressed = 10 * 1024 * 1024 * 1024
		lr := io.LimitReader(rc, maxFileUncompressed)
		_, copyErr := io.Copy(outFile, lr)
		outFile.Close()
		rc.Close()

		if copyErr != nil {
			return extractedFiles, extractedDirs, copyErr
		}
		extractedFiles++
	}

	return extractedFiles, extractedDirs, nil
}

// startSendFolderTransfer packages a directory into a temporary zip package on the fly
// and enqueues a folder transfer to connected devices.
func startSendFolderTransfer(folderPath string) error {
	return startSendFolderTransferTargeted(folderPath, nil)
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

	folderName := sanitizeFilename(filepath.Base(cleanPath))
	tmpZipPath := filepath.Join(tempDir, fmt.Sprintf("folder_%s_%d.zip", folderName, time.Now().UnixNano()))

	zipFile, err := os.Create(tmpZipPath)
	if err != nil {
		return fmt.Errorf("failed to create folder zip container: %w", err)
	}

	files, dirs, origSize, err := zipDirectory(cleanPath, zipFile)
	zipFile.Close()
	if err != nil {
		_ = os.Remove(tmpZipPath)
		return fmt.Errorf("failed to package folder: %w", err)
	}

	zipStat, err := os.Stat(tmpZipPath)
	if err != nil {
		_ = os.Remove(tmpZipPath)
		return err
	}

	transferID := randomID()
	totalSize := zipStat.Size()
	chunkSize := int64(defaultChunkSize)
	totalChunks := int((totalSize + chunkSize - 1) / chunkSize)
	if totalSize == 0 {
		totalChunks = 0
	}

	ownerID := ""
	if targetDevice != nil {
		ownerID = targetDevice.ID
	}

	transfersMu.Lock()
	transfers[transferID] = &TransferState{
		ID:          transferID,
		Filename:    folderName + ".zip",
		TotalChunks: totalChunks,
		ChunkSize:   chunkSize,
		TotalSize:   totalSize,
		FilePath:    tmpZipPath,
		IsDownload:  true,
		IsFolder:    true,
		FolderName:  folderName,
		Owner:       ownerID,
		LastActive:  time.Now().Unix(),
	}
	transfersMu.Unlock()

	targetLabel := "all devices"
	if targetDevice != nil {
		targetLabel = targetDevice.Name
	}

	printSync(Cyan, "📁 Folder", fmt.Sprintf("%s (%d files, %d folders · %s → %s)", folderName, files, dirs, formatSize(totalSize), targetLabel), "packaging complete")

	// Notify connected devices of incoming folder transfer
	msg := Message{
		Version:   1,
		Type:      "file_start",
		ID:        "msg-" + transferID,
		Timestamp: time.Now().Unix(),
		Payload: map[string]interface{}{
			"transferId":   transferID,
			"filename":     folderName + ".zip",
			"folderName":   folderName,
			"isFolder":     true,
			"totalFiles":   files,
			"totalDirs":    dirs,
			"originalSize": origSize,
			"mimeType":     "application/zip",
			"totalSize":    totalSize,
			"chunkSize":    chunkSize,
			"totalChunks":  totalChunks,
		},
	}
	if targetDevice != nil {
		msg.TargetDeviceID = targetDevice.ID
	}
	delivered := broadcastMessage(msg)
	if delivered == 0 {
		printSync(Yellow, "📁 Folder", folderName, fmt.Sprintf("queued for %s", targetLabel))
	}
	return nil
}

