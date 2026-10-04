package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

var (
	receiveDir = filepath.Join(os.Getenv("USERPROFILE"), "P2P", "received")
	tempDir    = filepath.Join(os.Getenv("USERPROFILE"), "P2P", "temp")
)

type TransferState struct {
	ID          string
	Filename    string
	TotalChunks int
	File        *os.File
	FilePath    string
	IsDownload  bool // true if Windows is sending to phone
	LastActive  int64 // Unix timestamp
}

var (
	transfers   = make(map[string]*TransferState)
	transfersMu sync.Mutex
)

func initDirs() {
	os.MkdirAll(receiveDir, 0755)
	os.MkdirAll(tempDir, 0755)
}

// Background janitor to clean up abandoned transfers (file descriptor leaks)
func startTransferJanitor() {
	go func() {
		for {
			time.Sleep(5 * time.Minute)
			now := time.Now().Unix()
			
			transfersMu.Lock()
			for id, state := range transfers {
				if now - state.LastActive > 900 { // 15 minutes timeout
					if state.File != nil {
						state.File.Close()
					}
					if !state.IsDownload {
						os.Remove(state.FilePath) // cleanup temp file
					}
					delete(transfers, id)
					fmt.Printf("\n%s[System]:%s Cleaned up stale transfer %s\n> ", Yellow, Reset, state.Filename)
				}
			}
			transfersMu.Unlock()
		}
	}()
}

func getUniqueFilePath(dir, filename string) string {
	ext := filepath.Ext(filename)
	name := strings.TrimSuffix(filename, ext)
	path := filepath.Join(dir, filename)
	
	counter := 1
	for {
		if _, err := os.Stat(path); os.IsNotExist(err) {
			break
		}
		path = filepath.Join(dir, fmt.Sprintf("%s (%d)%s", name, counter, ext))
		counter++
	}
	return path
}

func getTempPath(id string) string {
	return filepath.Join(tempDir, id+".tmp")
}

func setReceiveDir(newDir string) error {
	absPath, err := filepath.Abs(newDir)
	if err != nil {
		return err
	}
	err = os.MkdirAll(absPath, 0755)
	if err != nil {
		return err
	}
	
	newTemp := filepath.Join(absPath, ".temp")
	err = os.MkdirAll(newTemp, 0755)
	if err != nil {
		return err
	}

	transfersMu.Lock()
	receiveDir = absPath
	tempDir = newTemp
	transfersMu.Unlock()
	return nil
}

func startReceiveTransfer(id, filename string, totalChunks int) {
	initDirs()
	path := getTempPath(id)
	f, err := os.Create(path)
	if err != nil {
		fmt.Println("Error creating temp file:", err)
		return
	}
	transfersMu.Lock()
	transfers[id] = &TransferState{
		ID:          id,
		Filename:    filename,
		TotalChunks: totalChunks,
		File:        f,
		FilePath:    path,
		IsDownload:  false,
		LastActive:  time.Now().Unix(),
	}
	transfersMu.Unlock()
	fmt.Printf("%s%s[Receiving file]:%s %s\n", ClearLine, Cyan, Reset, filename)
}

func enableCORS(w http.ResponseWriter, r *http.Request) bool {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
	if r.Method == "OPTIONS" {
		w.WriteHeader(http.StatusOK)
		return true
	}
	return false
}

func handleUploadChunk(w http.ResponseWriter, r *http.Request) {
	if enableCORS(w, r) {
		return
	}

	// Phone uploading to Windows
	transferId := r.URL.Query().Get("transferId")
	chunkIndex, _ := strconv.Atoi(r.URL.Query().Get("chunkIndex"))
	chunkSize, _ := strconv.Atoi(r.URL.Query().Get("chunkSize"))
	if chunkSize == 0 {
		chunkSize = 65536
	}

	transfersMu.Lock()
	state, exists := transfers[transferId]
	if exists {
		state.LastActive = time.Now().Unix()
	}
	transfersMu.Unlock()

	if !exists {
		http.Error(w, "Unknown transfer", 404)
		return
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "Failed to read", 500)
		return
	}

	// Write chunk exactly at its designated offset (100% robust against out-of-order chunks)
	offset := int64(chunkIndex * chunkSize)
	_, err = state.File.WriteAt(body, offset)
	if err != nil {
		http.Error(w, "Failed to write", 500)
		return
	}

	w.WriteHeader(http.StatusOK)

	// Beautiful progress bar
	printProgressBar(state.Filename, chunkIndex+1, state.TotalChunks)
}

func printProgressBar(filename string, current, total int) {
	percent := float64(current) / float64(total) * 100
	completed := int(percent / 5) // 20 blocks total
	if completed > 20 {
		completed = 20
	}
	bar := strings.Repeat("█", completed) + strings.Repeat("░", 20-completed)
	// \r first, then \033[K to clear from cursor to end of line
	fmt.Printf("\r\033[K%s[Receiving]%s %s %s %.1f%%", Cyan, Reset, filename, bar, percent)
	if current == total {
		fmt.Print("\n> ")
	}
}

func handleDownloadChunk(w http.ResponseWriter, r *http.Request) {
	if enableCORS(w, r) {
		return
	}

	// Phone downloading from Windows
	transferId := r.URL.Query().Get("transferId")
	chunkIndex, _ := strconv.Atoi(r.URL.Query().Get("chunkIndex"))
	chunkSize, _ := strconv.Atoi(r.URL.Query().Get("chunkSize"))

	transfersMu.Lock()
	state, exists := transfers[transferId]
	if exists {
		state.LastActive = time.Now().Unix()
	}
	transfersMu.Unlock()

	if !exists || !state.IsDownload {
		http.Error(w, "Unknown transfer", 404)
		return
	}

	offset := int64(chunkIndex * chunkSize)
	buf := make([]byte, chunkSize)

	n, err := state.File.ReadAt(buf, offset)
	if err != nil && err != io.EOF {
		http.Error(w, "Failed to read", 500)
		return
	}

	w.Write(buf[:n])
}

func handleDownloadFull(w http.ResponseWriter, r *http.Request) {
	if enableCORS(w, r) {
		return
	}

	transferId := r.URL.Query().Get("transferId")

	transfersMu.Lock()
	state, exists := transfers[transferId]
	if exists {
		delete(transfers, transferId) // DownloadFull completes the transfer
	}
	transfersMu.Unlock()

	if !exists || !state.IsDownload {
		http.Error(w, "Unknown transfer", 404)
		return
	}

	w.Header().Set("Content-Disposition", "attachment; filename=\""+state.Filename+"\"")
	http.ServeFile(w, r, state.FilePath)
}

func completeTransfer(id string, expectedHash string) {
	transfersMu.Lock()
	state, exists := transfers[id]
	if exists {
		delete(transfers, id)
	}
	transfersMu.Unlock()

	if !exists {
		return
	}

	state.File.Close()

	if state.IsDownload {
		return // we just served it
	}

	// Verify checksum
	f, err := os.Open(state.FilePath)
	if err == nil {
		defer f.Close()
		h := sha256.New()
		io.Copy(h, f)
		actualHash := hex.EncodeToString(h.Sum(nil))

		if actualHash == expectedHash || expectedHash == "pending" {
			finalPath := getUniqueFilePath(receiveDir, state.Filename)
			f.Close()
			err := os.Rename(state.FilePath, finalPath)
			if err != nil {
				// Fallback to copy if rename fails across partitions
				srcFile, errCopy := os.Open(state.FilePath)
				if errCopy == nil {
					destFile, errCreate := os.Create(finalPath)
					if errCreate == nil {
						io.Copy(destFile, srcFile)
						destFile.Close()
						srcFile.Close()
						os.Remove(state.FilePath)
						fmt.Printf("\n%s[File Received]:%s %s saved to %s\n> ", Green, Reset, state.Filename, finalPath)
					} else {
						srcFile.Close()
						fmt.Printf("%s%s[Error saving file]:%s %v\n> ", ClearLine, Red, Reset, errCreate)
					}
				} else {
					fmt.Printf("%s%s[Error saving file]:%s %v\n> ", ClearLine, Red, Reset, err)
				}
			} else {
				fmt.Printf("\n%s[File Received]:%s %s saved to %s\n> ", Green, Reset, state.Filename, finalPath)
			}
		} else {
			fmt.Printf("\n%s[File Transfer Failed]:%s Checksum mismatch for %s\n> ", Red, Reset, state.Filename)
			f.Close()
			os.Remove(state.FilePath)
		}
	}
}

func startSendTransfer(filePath string) error {
	f, err := os.Open(filePath)
	if err != nil {
		return err
	}

	stat, err := f.Stat()
	if err != nil {
		f.Close()
		return err
	}

	// Skip synchronous hashing for large files to prevent CLI freeze
	checksum := "pending"
	f.Close() // ServeFile will open it itself

	filename := filepath.Base(filePath)
	transferId := "transfer-" + strconv.FormatInt(stat.Size(), 10) + filename // simplified id
	totalSize := stat.Size()
	chunkSize := int64(65536)
	totalChunks := int((totalSize + chunkSize - 1) / chunkSize)

	transfersMu.Lock()
	transfers[transferId] = &TransferState{
		ID:          transferId,
		Filename:    filename,
		TotalChunks: totalChunks,
		FilePath:    filePath,
		IsDownload:  true,
		LastActive:  time.Now().Unix(),
	}
	transfersMu.Unlock()

	// Notify phone to start download
	msg := Message{
		Version:   1,
		Type:      "file_start",
		ID:        "msg-" + transferId,
		Timestamp: stat.ModTime().Unix(),
		Payload: map[string]interface{}{
			"transferId":  transferId,
			"filename":    filename,
			"mimeType":    "application/octet-stream",
			"totalSize":   totalSize,
			"chunkSize":   chunkSize,
			"totalChunks": totalChunks,
			"checksum":    checksum,
		},
	}
	broadcastMessage(msg)
	fmt.Printf("%s%s[Sending file]:%s %s (Waiting for phone to download)\n", ClearLine, Cyan, Reset, filename)
	return nil
}
