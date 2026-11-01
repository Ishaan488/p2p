//go:build !windows

package main

import "errors"

// Process sampling is only implemented on Windows (the benchmark SUT host).
type procHandle int

func openProc(pid int) (procHandle, error) {
	return 0, errors.New("process sampling is only implemented on Windows")
}
func (h procHandle) close() {}
func (h procHandle) mem() (ws, peakWS, priv uint64, err error) {
	return 0, 0, 0, errors.New("unsupported")
}
func (h procHandle) cpuSeconds() (float64, error) { return 0, errors.New("unsupported") }

