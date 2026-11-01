//go:build windows

package main

import (
	"fmt"
	"syscall"
	"unsafe"
)

var (
	modPsapi                 = syscall.NewLazyDLL("psapi.dll")
	procGetProcessMemoryInfo = modPsapi.NewProc("GetProcessMemoryInfo")
	modKernel32              = syscall.NewLazyDLL("kernel32.dll")
	procGetProcessTimes      = modKernel32.NewProc("GetProcessTimes")
)

// pmcEx mirrors PROCESS_MEMORY_COUNTERS_EX (amd64 layout).
type pmcEx struct {
	cb                uint32
	pageFaults        uint32
	peakWorkingSet    uintptr
	workingSet        uintptr
	quotaPeakPaged    uintptr
	quotaPaged        uintptr
	quotaPeakNonPaged uintptr
	quotaNonPaged     uintptr
	pagefile          uintptr
	peakPagefile      uintptr
	privateUsage      uintptr
}

type procHandle syscall.Handle

func openProc(pid int) (procHandle, error) {
	// PROCESS_QUERY_INFORMATION | PROCESS_VM_READ
	h, err := syscall.OpenProcess(0x0400|0x0010, false, uint32(pid))
	if err != nil {
		return 0, fmt.Errorf("OpenProcess(%d): %w", pid, err)
	}
	return procHandle(h), nil
}

func (h procHandle) close() { syscall.CloseHandle(syscall.Handle(h)) }

// mem returns Working Set, lifetime Peak Working Set and Private Bytes (commit charge).
func (h procHandle) mem() (ws, peakWS, priv uint64, err error) {
	var c pmcEx
	c.cb = uint32(unsafe.Sizeof(c))
	r, _, e := procGetProcessMemoryInfo.Call(uintptr(h), uintptr(unsafe.Pointer(&c)), uintptr(c.cb))
	if r == 0 {
		return 0, 0, 0, e
	}
	return uint64(c.workingSet), uint64(c.peakWorkingSet), uint64(c.privateUsage), nil
}

// cpuSeconds returns cumulative kernel+user CPU time of the process.
func (h procHandle) cpuSeconds() (float64, error) {
	var cr, ex, k, u syscall.Filetime
	r, _, e := procGetProcessTimes.Call(uintptr(h),
		uintptr(unsafe.Pointer(&cr)), uintptr(unsafe.Pointer(&ex)),
		uintptr(unsafe.Pointer(&k)), uintptr(unsafe.Pointer(&u)))
	if r == 0 {
		return 0, e
	}
	ft := func(f syscall.Filetime) float64 {
		return float64(uint64(f.HighDateTime)<<32|uint64(f.LowDateTime)) / 1e7
	}
	return ft(k) + ft(u), nil
}

