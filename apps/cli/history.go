package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

type TransferRecord struct {
	ID        string `json:"id"`
	Filename  string `json:"filename"`
	Size      int64  `json:"size"`
	Direction string `json:"direction"` // "Sent" or "Received"
	Device    string `json:"device"`
	Timestamp int64  `json:"timestamp"`
	Status    string `json:"status"` // "Completed", "Cancelled", "Rejected", "Failed"
}

var (
	historyMu sync.Mutex
	history   []TransferRecord
)

func historyPath() string {
	return filepath.Join(baseDir, "history.json")
}

func loadHistory() {
	historyMu.Lock()
	defer historyMu.Unlock()
	p := historyPath()
	if data, err := os.ReadFile(p); err == nil {
		if err := json.Unmarshal(data, &history); err != nil {
			// Back up corrupted history if unreadable
			_ = os.Rename(p, fmt.Sprintf("%s.corrupt.%d", p, time.Now().Unix()))
			history = nil
		}
	}
}

func recordTransfer(rec TransferRecord) {
	historyMu.Lock()
	defer historyMu.Unlock()
	if rec.Timestamp == 0 {
		rec.Timestamp = time.Now().Unix()
	}
	history = append([]TransferRecord{rec}, history...)
	if len(history) > 200 {
		history = history[:200]
	}

	data, err := json.MarshalIndent(history, "", "  ")
	if err == nil {
		_ = os.MkdirAll(baseDir, 0755)
		tmp := historyPath() + ".tmp"
		if err := os.WriteFile(tmp, data, 0600); err == nil {
			_ = os.Rename(tmp, historyPath())
		}
	}
}

func printTransferHistory() {
	historyMu.Lock()
	records := make([]TransferRecord, len(history))
	copy(records, history)
	historyMu.Unlock()

	if len(records) == 0 {
		fmt.Printf("\n  %sNo transfer history found.%s\n\n", Dim, Reset)
		return
	}

	fmt.Printf("\n  %sRecent Transfer History (%d records)%s\n", Cyan, len(records), Reset)
	fmt.Printf("  %-6s  %-9s  %-24s  %-10s  %-16s  %s\n",
		"TIME", "DIR", "FILE", "SIZE", "DEVICE", "STATUS")
	fmt.Println("  ----------------------------------------------------------------------------")

	limit := 25
	if len(records) < limit {
		limit = len(records)
	}
	for _, r := range records[:limit] {
		tStr := time.Unix(r.Timestamp, 0).Format("15:04")
		dirColor := Green
		if r.Direction == "Sent" {
			dirColor = Cyan
		}
		statusColor := White
		switch r.Status {
		case "Completed":
			statusColor = Green
		case "Cancelled":
			statusColor = Yellow
		case "Rejected", "Failed":
			statusColor = Red
		}

		name := r.Filename
		if len(name) > 24 {
			ext := filepath.Ext(name)
			base := name[:min(len(name)-len(ext), 20)]
			name = base + "..." + ext
		}
		dev := r.Device
		if len(dev) > 16 {
			dev = dev[:13] + "..."
		}

		fmt.Printf("  %s%-6s%s  %s%-9s%s  %-24s  %-10s  %-16s  %s%s%s\n",
			Dim, tStr, Reset,
			dirColor, r.Direction, Reset,
			name, formatSize(r.Size), dev,
			statusColor, r.Status, Reset)
	}
	fmt.Println()
}

