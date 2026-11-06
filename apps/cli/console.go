package main

import (
	"fmt"
	"strings"
	"time"
)

const (
	Reset     = "\033[0m"
	Bold      = "\033[1m"
	Dim       = "\033[90m"
	Red       = "\033[31m"
	Green     = "\033[32m"
	Yellow    = "\033[33m"
	Blue      = "\033[94m"
	Cyan      = "\033[36m"
	White     = "\033[37m"
	ClearLine = "\r\033[2K"
)

func nowStamp() string {
	return time.Now().Format("15:04")
}

func formatSize(bytes int64) string {
	const unit = 1024
	if bytes < unit {
		return fmt.Sprintf("%d B", bytes)
	}
	div, exp := int64(unit), 0
	for n := bytes / unit; n >= unit; n /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %cB", float64(bytes)/float64(div), "KMGTPE"[exp])
}

// printAsync prints a structured event line from a background goroutine and restores the prompt.
func printAsync(badgeColor, badge, mainText, meta string) {
	metaStr := ""
	if meta != "" {
		metaStr = fmt.Sprintf(" %s(%s)%s", Dim, meta, Reset)
	}
	fmt.Printf("\r\033[2K  %s%s%s  %s%-11s%s %s%s\np2p> ",
		Dim, nowStamp(), Reset,
		badgeColor, badge, Reset,
		mainText, metaStr)
}

// printSync prints a structured event line synchronously inside the REPL loop (prompt is printed by loop).
func printSync(badgeColor, badge, mainText, meta string) {
	metaStr := ""
	if meta != "" {
		metaStr = fmt.Sprintf(" %s(%s)%s", Dim, meta, Reset)
	}
	fmt.Printf("  %s%s%s  %s%-11s%s %s%s\n",
		Dim, nowStamp(), Reset,
		badgeColor, badge, Reset,
		mainText, metaStr)
}

// printableText strips control characters (including ANSI escape sequences)
// from text that originates on another device before it reaches the terminal,
// and optionally shortens it to max runes (0 = no limit).
func printableText(s string, max int) string {
	s = strings.Map(func(r rune) rune {
		switch {
		case r == '\n' || r == '\r' || r == '\t':
			return ' '
		case r < 32 || r == 127 || (r >= 0x80 && r < 0xA0):
			return -1
		}
		return r
	}, s)
	if r := []rune(s); max > 0 && len(r) > max {
		return string(r[:max-3]) + "..."
	}
	return s
}
