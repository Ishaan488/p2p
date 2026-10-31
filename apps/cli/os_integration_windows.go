//go:build windows

package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"unsafe"
)

const (
	regFileShellKey = `HKCU\Software\Classes\*\shell\P2PLink`
	regDirShellKey  = `HKCU\Software\Classes\Directory\shell\P2PLink`
	regRunKey       = `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`
	regRunValueName = `P2PLink`
)

// installExplorerContextMenu registers "Send via P2P Link" in the Windows Explorer
// right-click context menu for both files and folders under HKCU (no admin required — FR 42, NFR 30),
// and populates Windows SendTo quick-send shortcuts for paired devices (FR 48).
func installExplorerContextMenu() error {
	exePath, err := os.Executable()
	if err != nil {
		return err
	}
	exePath, _ = filepath.Abs(exePath)
	cmdStr := fmt.Sprintf(`"%s" --send "%%1"`, exePath)

	commands := [][]string{
		{"add", regFileShellKey, "/ve", "/d", "Send via P2P Link", "/f"},
		{"add", regFileShellKey, "/v", "Icon", "/d", fmt.Sprintf(`"%s",0`, exePath), "/f"},
		{"add", regFileShellKey + `\command`, "/ve", "/d", cmdStr, "/f"},
		{"add", regDirShellKey, "/ve", "/d", "Send Folder via P2P Link", "/f"},
		{"add", regDirShellKey, "/v", "Icon", "/d", fmt.Sprintf(`"%s",0`, exePath), "/f"},
		{"add", regDirShellKey + `\command`, "/ve", "/d", cmdStr, "/f"},
	}

	for _, args := range commands {
		if out, err := exec.Command("reg", args...).CombinedOutput(); err != nil {
			return fmt.Errorf("reg %v failed: %v (%s)", args, err, strings.TrimSpace(string(out)))
		}
	}

	_ = syncQuickSendShortcuts()
	return nil
}

// uninstallExplorerContextMenu removes the Windows Explorer context menu entries (FR 42).
func uninstallExplorerContextMenu() error {
	_ = exec.Command("reg", "delete", regFileShellKey, "/f").Run()
	_ = exec.Command("reg", "delete", regDirShellKey, "/f").Run()
	_ = removeQuickSendShortcuts()
	return nil
}

// isExplorerContextMenuInstalled checks if the Explorer right-click menu is currently registered.
func isExplorerContextMenuInstalled() bool {
	err := exec.Command("reg", "query", regFileShellKey+`\command`).Run()
	return err == nil
}

// syncQuickSendShortcuts creates SendTo menu items for quick-sending to paired devices (FR 48).
func syncQuickSendShortcuts() error {
	appData := os.Getenv("APPDATA")
	if appData == "" {
		return nil
	}
	sendToDir := filepath.Join(appData, "Microsoft", "Windows", "SendTo")
	if _, err := os.Stat(sendToDir); err != nil {
		return nil
	}
	exePath, err := os.Executable()
	if err != nil {
		return err
	}
	exePath, _ = filepath.Abs(exePath)

	// Main SendTo entry
	mainCmd := filepath.Join(sendToDir, "P2P Link (All Devices).cmd")
	content := fmt.Sprintf("@echo off\r\n\"%s\" --send \"%%~1\"\r\n", exePath)
	_ = os.WriteFile(mainCmd, []byte(content), 0644)

	// Per-device Quick-Send entries for frequently used paired devices
	devices := listDevices()
	for _, d := range devices {
		label := sanitizeFilename(d.DisplayName())
		if label == "" {
			continue
		}
		devCmd := filepath.Join(sendToDir, fmt.Sprintf("P2P Link (%s).cmd", label))
		devScript := fmt.Sprintf("@echo off\r\n\"%s\" --send \"%%~1\" --to \"%s\"\r\n", exePath, d.ID)
		_ = os.WriteFile(devCmd, []byte(devScript), 0644)
	}
	return nil
}

func removeQuickSendShortcuts() error {
	appData := os.Getenv("APPDATA")
	if appData == "" {
		return nil
	}
	sendToDir := filepath.Join(appData, "Microsoft", "Windows", "SendTo")
	matches, _ := filepath.Glob(filepath.Join(sendToDir, "P2P Link*.cmd"))
	for _, m := range matches {
		_ = os.Remove(m)
	}
	return nil
}

// setOSAutostart configures whether P2P Link starts automatically on Windows login (FR 47).
func setOSAutostart(enabled bool) error {
	if !enabled {
		_ = exec.Command("reg", "delete", regRunKey, "/v", regRunValueName, "/f").Run()
		return nil
	}
	exePath, err := os.Executable()
	if err != nil {
		return err
	}
	exePath, _ = filepath.Abs(exePath)
	cmdStr := fmt.Sprintf(`"%s" --tray`, exePath)
	if out, err := exec.Command("reg", "add", regRunKey, "/v", regRunValueName, "/t", "REG_SZ", "/d", cmdStr, "/f").CombinedOutput(); err != nil {
		return fmt.Errorf("failed to enable autostart: %v (%s)", err, strings.TrimSpace(string(out)))
	}
	return nil
}

// isOSAutostartEnabled returns true if P2P Link is configured to launch on Windows startup.
func isOSAutostartEnabled() bool {
	err := exec.Command("reg", "query", regRunKey, "/v", regRunValueName).Run()
	return err == nil
}

// ============================================================================
// Pure-Go Win32 System Tray Implementation (FR 45)
// ============================================================================

const (
	wmAppTrayCallback = 0x8000 + 42
	wmCommand         = 0x0111
	wmDestroy         = 0x0002
	wmLButtonUp       = 0x0202
	wmLButtonDblClk   = 0x0203
	wmRButtonUp       = 0x0205

	nimAdd    = 0x00000000
	nimModify = 0x00000001
	nimDelete = 0x00000002

	nifMessage = 0x00000001
	nifIcon    = 0x00000002
	nifTip     = 0x00000004

	idiApplication = 32512

	mfString    = 0x00000000
	mfSeparator = 0x00000800
	tpmBottomAlign = 0x0020
	tpmLeftAlign   = 0x0000
	tpmRightButton = 0x0002

	swHide    = 0
	swRestore = 9

	menuCmdOpenUI       = 1001
	menuCmdToggleWindow = 1002
	menuCmdShowQR       = 1003
	menuCmdContextMenu  = 1004
	menuCmdExit         = 1005
)

type guid struct {
	Data1 uint32
	Data2 uint16
	Data3 uint16
	Data4 [8]byte
}

type notifyIconDataW struct {
	CbSize           uint32
	HWnd              uintptr
	UID              uint32
	UFlags           uint32
	UCallbackMessage uint32
	HIcon            uintptr
	SzTip            [128]uint16
	DwState          uint32
	DwStateMask      uint32
	SzInfo           [256]uint16
	UVersion         uint32
	SzInfoTitle      [64]uint16
	DwInfoFlags      uint32
	GuidItem         guid
	HBalloonIcon     uintptr
}

type wndClassExW struct {
	CbSize        uint32
	Style         uint32
	LpfnWndProc   uintptr
	CbClsExtra    int32
	CbWndExtra    int32
	HInstance     uintptr
	HIcon         uintptr
	HCursor       uintptr
	HbrBackground uintptr
	LpszMenuName  *uint16
	LpszClassName *uint16
	HIconSm       uintptr
}

type point struct {
	X int32
	Y int32
}

type winMsg struct {
	HWnd    uintptr
	Message uint32
	WParam  uintptr
	LParam  uintptr
	Time    uint32
	Pt      point
}

var (
	user32               = syscall.NewLazyDLL("user32.dll")
	shell32              = syscall.NewLazyDLL("shell32.dll")
	kernel32             = syscall.NewLazyDLL("kernel32.dll")
	procRegisterClassExW = user32.NewProc("RegisterClassExW")
	procCreateWindowExW  = user32.NewProc("CreateWindowExW")
	procDefWindowProcW   = user32.NewProc("DefWindowProcW")
	procGetMessageW      = user32.NewProc("GetMessageW")
	procTranslateMessage = user32.NewProc("TranslateMessage")
	procDispatchMessageW = user32.NewProc("DispatchMessageW")
	procPostQuitMessage  = user32.NewProc("PostQuitMessage")
	procLoadIconW        = user32.NewProc("LoadIconW")
	procCreatePopupMenu  = user32.NewProc("CreatePopupMenu")
	procAppendMenuW      = user32.NewProc("AppendMenuW")
	procDestroyMenu      = user32.NewProc("DestroyMenu")
	procTrackPopupMenu   = user32.NewProc("TrackPopupMenu")
	procGetCursorPos     = user32.NewProc("GetCursorPos")
	procSetForegroundWnd = user32.NewProc("SetForegroundWindow")
	procShowWindow       = user32.NewProc("ShowWindow")
	procShellNotifyIconW = shell32.NewProc("Shell_NotifyIconW")
	procGetModuleHandleW = kernel32.NewProc("GetModuleHandleW")
	procGetConsoleWindow = kernel32.NewProc("GetConsoleWindow")

	trayMu          sync.Mutex
	trayActive      bool
	trayHWnd        uintptr
	trayNID         notifyIconDataW
	consoleVisible  = true
	trayServerPort  int
)

func toggleConsoleVisibility() {
	hwnd, _, _ := procGetConsoleWindow.Call()
	if hwnd == 0 {
		return
	}
	trayMu.Lock()
	defer trayMu.Unlock()
	if consoleVisible {
		procShowWindow.Call(hwnd, swHide)
		consoleVisible = false
	} else {
		procShowWindow.Call(hwnd, swRestore)
		procSetForegroundWnd.Call(hwnd)
		consoleVisible = true
	}
}

func showTrayContextMenu(hwnd uintptr) {
	hMenu, _, _ := procCreatePopupMenu.Call()
	if hMenu == 0 {
		return
	}
	defer procDestroyMenu.Call(hMenu)

	appendItem := func(flags uintptr, id uintptr, label string) {
		ptr, _ := syscall.UTF16PtrFromString(label)
		procAppendMenuW.Call(hMenu, flags, id, uintptr(unsafe.Pointer(ptr)))
	}

	appendItem(mfString, menuCmdOpenUI, fmt.Sprintf("Open P2P Link Web UI (Port %d)", trayServerPort))
	if consoleVisible {
		appendItem(mfString, menuCmdToggleWindow, "Hide Terminal Window")
	} else {
		appendItem(mfString, menuCmdToggleWindow, "Show Terminal Window")
	}
	appendItem(mfString, menuCmdShowQR, "Display Pairing QR in Terminal")
	if isExplorerContextMenuInstalled() {
		appendItem(mfString, menuCmdContextMenu, "Disable Explorer Context Menu")
	} else {
		appendItem(mfString, menuCmdContextMenu, "Enable Explorer Context Menu")
	}
	appendItem(mfSeparator, 0, "")
	appendItem(mfString, menuCmdExit, "Exit P2P Link")

	var pt point
	procGetCursorPos.Call(uintptr(unsafe.Pointer(&pt)))
	procSetForegroundWnd.Call(hwnd)
	procTrackPopupMenu.Call(
		hMenu,
		tpmBottomAlign|tpmLeftAlign|tpmRightButton,
		uintptr(pt.X),
		uintptr(pt.Y),
		0,
		hwnd,
		0,
	)
}

func trayWndProc(hwnd uintptr, msg uint32, wParam, lParam uintptr) uintptr {
	switch msg {
	case wmAppTrayCallback:
		switch uint32(lParam) {
		case wmLButtonDblClk:
			_ = openBrowser(fmt.Sprintf("%s://localhost:%d", httpScheme(), trayServerPort))
		case wmRButtonUp, wmLButtonUp:
			showTrayContextMenu(hwnd)
		}
		return 0
	case wmCommand:
		switch int(wParam & 0xffff) {
		case menuCmdOpenUI:
			_ = openBrowser(fmt.Sprintf("%s://localhost:%d", httpScheme(), trayServerPort))
		case menuCmdToggleWindow:
			toggleConsoleVisibility()
		case menuCmdShowQR:
			if !consoleVisible {
				toggleConsoleVisibility()
			}
			showPairing()
		case menuCmdContextMenu:
			if isExplorerContextMenuInstalled() {
				_ = uninstallExplorerContextMenu()
				printAsync(Yellow, "○ ContextMenu", "Removed from Windows Explorer", "")
			} else {
				if err := installExplorerContextMenu(); err == nil {
					printAsync(Green, "● ContextMenu", "Added 'Send via P2P Link' to Windows Explorer", "")
				}
			}
		case menuCmdExit:
			stopSystemTray()
			os.Exit(0)
		}
		return 0
	case wmDestroy:
		stopSystemTray()
		procPostQuitMessage.Call(0)
		return 0
	}
	ret, _, _ := procDefWindowProcW.Call(hwnd, uintptr(msg), wParam, lParam)
	return ret
}

// startSystemTray launches the Windows notification area (system tray) icon on a locked OS thread (FR 45).
func startSystemTray(port int) {
	trayMu.Lock()
	if trayActive {
		trayMu.Unlock()
		return
	}
	trayActive = true
	trayServerPort = port
	trayMu.Unlock()

	go func() {
		runtime.LockOSThread()
		defer runtime.UnlockOSThread()

		hInstance, _, _ := procGetModuleHandleW.Call(0)
		className, _ := syscall.UTF16PtrFromString("P2PLinkTrayWindowClass")

		wc := wndClassExW{
			CbSize:        uint32(unsafe.Sizeof(wndClassExW{})),
			LpfnWndProc:   syscall.NewCallback(trayWndProc),
			HInstance:     hInstance,
			LpszClassName: className,
		}
		procRegisterClassExW.Call(uintptr(unsafe.Pointer(&wc)))

		title, _ := syscall.UTF16PtrFromString("P2P Link Tray Host")
		hwnd, _, _ := procCreateWindowExW.Call(
			0,
			uintptr(unsafe.Pointer(className)),
			uintptr(unsafe.Pointer(title)),
			0,
			0, 0, 0, 0,
			0, 0, hInstance, 0,
		)
		if hwnd == 0 {
			return
		}
		trayHWnd = hwnd

		hIcon, _, _ := procLoadIconW.Call(0, idiApplication)
		trayNID = notifyIconDataW{
			CbSize:           uint32(unsafe.Sizeof(notifyIconDataW{})),
			HWnd:             hwnd,
			UID:              1,
			UFlags:           nifMessage | nifIcon | nifTip,
			UCallbackMessage: wmAppTrayCallback,
			HIcon:            hIcon,
		}
		tip := fmt.Sprintf("P2P Link — Active on Port %d", port)
		tipUTF16, _ := syscall.UTF16FromString(tip)
		copy(trayNID.SzTip[:], tipUTF16)

		procShellNotifyIconW.Call(nimAdd, uintptr(unsafe.Pointer(&trayNID)))

		var m winMsg
		for {
			ret, _, _ := procGetMessageW.Call(uintptr(unsafe.Pointer(&m)), 0, 0, 0)
			if int32(ret) <= 0 {
				break
			}
			procTranslateMessage.Call(uintptr(unsafe.Pointer(&m)))
			procDispatchMessageW.Call(uintptr(unsafe.Pointer(&m)))
		}
	}()
}

// stopSystemTray removes the tray icon cleanly before exit.
func stopSystemTray() {
	trayMu.Lock()
	defer trayMu.Unlock()
	if !trayActive || trayHWnd == 0 {
		return
	}
	procShellNotifyIconW.Call(nimDelete, uintptr(unsafe.Pointer(&trayNID)))
	trayActive = false
}

