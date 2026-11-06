//go:build !windows

package main

import (
	"syscall"

	"golang.org/x/sys/unix"
)

// reuseAddrControl marks the discovery socket SO_REUSEADDR (and, best effort,
// SO_REUSEPORT) before it binds, so a second local P2P Link process (for
// example when testing several instances on one machine) can bind the same
// discovery port instead of losing discovery entirely. The kernel then
// delivers broadcast/multicast datagrams to every socket bound this way,
// which is exactly what the announce/request protocol needs.
func reuseAddrControl(_, _ string, c syscall.RawConn) error {
	var sockErr error
	if err := c.Control(func(fd uintptr) {
		sockErr = unix.SetsockoptInt(int(fd), unix.SOL_SOCKET, unix.SO_REUSEADDR, 1)
		if sockErr == nil {
			// SO_REUSEPORT gives proper multi-listener fan-out on Linux/BSD/macOS;
			// harmless to ignore if the kernel does not support it.
			_ = unix.SetsockoptInt(int(fd), unix.SOL_SOCKET, unix.SO_REUSEPORT, 1)
		}
	}); err != nil {
		return err
	}
	return sockErr
}
