//go:build windows

package main

import (
	"syscall"

	"golang.org/x/sys/windows"
)

// reuseAddrControl marks the discovery socket SO_REUSEADDR before it binds, so
// a second local P2P Link process (for example when testing several instances
// on one machine) can bind the same discovery port instead of losing discovery
// entirely. Windows delivers broadcast datagrams to every socket bound this
// way, which is exactly what the announce/request protocol needs.
func reuseAddrControl(_, _ string, c syscall.RawConn) error {
	var sockErr error
	if err := c.Control(func(fd uintptr) {
		sockErr = windows.SetsockoptInt(windows.Handle(fd), windows.SOL_SOCKET, windows.SO_REUSEADDR, 1)
	}); err != nil {
		return err
	}
	return sockErr
}
