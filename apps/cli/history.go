package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
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

func saveHistoryLocked() {
	data, err := json.MarshalIndent(history, "", "  ")
	if err != nil {
		return
	}
	if err := writeFileAtomic(historyPath(), data, 0o600); err != nil {
		fmt.Printf("%sCould not save transfer history: %v%s\n", Yellow, err, Reset)
	}
}

// clearHistory forgets all recorded transfers.
func clearHistory() {
	historyMu.Lock()
	defer historyMu.Unlock()
	history = nil
	_ = os.Remove(historyPath())
}

func recordTransfer(rec TransferRecord) {
	historyMu.Lock()
	defer historyMu.Unlock()
	if rec.Timestamp == 0 {
		rec.Timestamp = time.Now().Unix()
	}
	for i := range history {
		if history[i].ID == rec.ID {
			if rec.Device != "" && history[i].Device == "" {
				history[i].Device = rec.Device
			}
			history[i].Status = rec.Status
			history[i].Filename = rec.Filename
			saveHistoryLocked()
			return
		}
	}
	history = append([]TransferRecord{rec}, history...)
	if len(history) > 200 {
		history = history[:200]
	}
	saveHistoryLocked()
}

func isRecordFileValid(r *TransferRecord) bool {
	if r == nil || r.Status != "Completed" {
		return false
	}
	p := filepath.Join(getReceiveDir(), r.Filename)
	fi, err := os.Stat(p)
	return err == nil && fi.Size() == r.Size
}

func lookupCompletedTransfer(id string) *TransferRecord {
	historyMu.Lock()
	defer historyMu.Unlock()
	for i := range history {
		if history[i].ID == id && history[i].Status == "Completed" {
			r := history[i]
			if isRecordFileValid(&r) {
				return &r
			}
			return nil
		}
	}
	p := historyPath()
	if data, err := os.ReadFile(p); err == nil {
		var diskHistory []TransferRecord
		if json.Unmarshal(data, &diskHistory) == nil {
			for i := range diskHistory {
				if diskHistory[i].ID == id && diskHistory[i].Status == "Completed" {
					history = diskHistory
					r := diskHistory[i]
					if isRecordFileValid(&r) {
						return &r
					}
					return nil
				}
			}
		}
	}
	return nil
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

		name := printableText(r.Filename, 0)
		if len([]rune(name)) > 24 {
			ext := filepath.Ext(name)
			base := []rune(strings.TrimSuffix(name, ext))
			if len(base) > 20 {
				base = base[:20]
			}
			name = string(base) + "..." + ext
		}
		dev := printableText(r.Device, 16)

		fmt.Printf("  %s%-6s%s  %s%-9s%s  %-24s  %-10s  %-16s  %s%s%s\n",
			Dim, tStr, Reset,
			dirColor, r.Direction, Reset,
			name, formatSize(r.Size), dev,
			statusColor, r.Status, Reset)
	}
	fmt.Println()
}
