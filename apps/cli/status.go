package main

import (
	"fmt"
	"runtime"
	"time"
)

func printStatus() {
	var mem runtime.MemStats
	runtime.ReadMemStats(&mem)

	uptime := time.Since(startTime).Round(time.Second)
	ips := localIPs()

	devices := listDevices()
	onlineCount := 0
	for _, d := range devices {
		if deviceOnline(d.ID) {
			onlineCount++
		}
	}

	type transferInfo struct {
		name     string
		progress string
		mode     string
	}
	var transferList []transferInfo
	transfersMu.Lock()
	for _, t := range transfers {
		mode := "receiving"
		pct := 0.0
		if t.IsDownload {
			mode = "sending"
		} else {
			t.mu.Lock()
			rec := t.receivedCount
			t.mu.Unlock()
			if t.TotalChunks > 0 {
				pct = float64(rec) / float64(t.TotalChunks) * 100
			}
		}
		transferList = append(transferList, transferInfo{
			name:     t.Filename,
			progress: fmt.Sprintf("%.1f%%", pct),
			mode:     mode,
		})
	}
	transfersMu.Unlock()
	activeCount := len(transferList)

	bwLimit := getBandwidthLimitBps()
	bwStr := "Unlimited"
	if bwLimit > 0 {
		bwStr = formatSize(bwLimit) + "/s"
	}

	fmt.Println(Cyan + "\n--- Server Status ---" + Reset)
	fmt.Printf("  Node Name:    %s%s%s\n", White, getServerName(), Reset)
	fmt.Printf("  Uptime:       %s%s%s\n", Green, uptime.String(), Reset)
	fmt.Printf("  Active Port:  %s%d%s\n", Yellow, *port, Reset)
	fmt.Printf("  Web UI:       %s%s://localhost:%d%s\n", Cyan, httpScheme(), *port, Reset)
	if len(ips) > 0 {
		fmt.Printf("  LAN URLs:     %s%s://%s:%d%s\n", White, httpScheme(), ips[0], *port, Reset)
		for _, ip := range ips[1:] {
			fmt.Printf("                %s%s://%s:%d%s\n", White, httpScheme(), ip, *port, Reset)
		}
	}
	fmt.Printf("  Memory:       Alloc: %.2f MB | Sys: %.2f MB | Goroutines: %d | GC Cycles: %d\n",
		float64(mem.Alloc)/1024/1024,
		float64(mem.Sys)/1024/1024,
		runtime.NumGoroutine(),
		mem.NumGC,
	)
	fmt.Printf("  Paired:       %d device(s) (%s%d online%s)\n",
		len(devices),
		Green, onlineCount, Reset,
	)
	fmt.Printf("  Bandwidth:    %s\n", bwStr)
	fmt.Printf("  Clipboard:    Sync=%v | SensitiveFilter=%v\n", isClipboardSyncEnabled(), isSensitiveClipboardFilterEnabled())
	fmt.Printf("  OS Menu:      ExplorerMenu=%v | Autostart=%v\n", isExplorerContextMenuInstalled(), isOSAutostartEnabled())
	if activeCount == 0 {
		fmt.Printf("  Transfers:    0 active\n")
	} else {
		fmt.Printf("  Transfers:    %d active\n", activeCount)
		for _, t := range transferList {
			fmt.Printf("    - %s (%s, %s)\n", t.name, t.progress, t.mode)
		}
	}
	fmt.Printf("  Storage Dir:  %s\n\n", getReceiveDir())
}

func printDevices() {
	devices := listDevices()
	if len(devices) == 0 {
		fmt.Println("  No paired devices. Type 'pair' to add one.")
		return
	}
	fmt.Println(Cyan + "\n  Paired Devices" + Reset)
	for i, d := range devices {
		status := Dim + "last seen " + time.Unix(d.LastSeen, 0).Format("15:04") + Reset
		addr := ""
		if deviceOnline(d.ID) {
			status = Green + "● online" + Reset
			if rAddr := getDeviceRemoteAddr(d.ID); rAddr != "" {
				addr = Dim + "(" + rAddr + ")" + Reset
			}
		}
		trust := Dim + "[approval req]" + Reset
		if d.Trusted {
			trust = Green + "[trusted]" + Reset
		}
		display := d.DisplayName()
		if d.Alias != "" && d.Alias != d.Name {
			display = fmt.Sprintf("%s (%s)", d.Alias, d.Name)
		}
		fmt.Printf("  %s#%d%s %s%-22s%s %s%-10s%s %-16s %-14s %s\n",
			Yellow, i+1, Reset, White, display, Reset, Dim, shortID(d.ID), Reset, trust, status, addr)
	}
	fmt.Printf("  %sTip: Quick-send using 'send <path> --to #1' or assign alias via 'alias #1 MyPhone'%s\n\n", Dim, Reset)
}
