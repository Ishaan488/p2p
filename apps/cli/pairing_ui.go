package main

import (
	"fmt"
	"os"

	"github.com/mdp/qrterminal/v3"
)

// showPairing prints a QR code that opens the app and pairs the scanning device.
func showPairing() {
	ips := localIPs()
	if len(ips) == 0 {
		fmt.Printf("\n%sCould not determine local IP address%s\n", Red, Reset)
		return
	}
	code := newPairCode()
	addr := fmt.Sprintf("%s:%d", ips[0], *port)
	qrLink := fmt.Sprintf("%s://%s/#pair=%s", httpScheme(), addr, code)
	if tlsEnabled && tlsFingerprint != "" {
		qrLink = fmt.Sprintf("%s://%s/#pair=%s&cert=%s", httpScheme(), addr, code, tlsFingerprint)
	}
	fmt.Printf("\n  %sScan QR in P2P Link mobile app:%s\n\n", Cyan, Reset)
	qrterminal.GenerateHalfBlock(qrLink, qrterminal.L, os.Stdout)
	fmt.Printf("\n  Manual IP : %s%s%s\n", Yellow, addr, Reset)
	for _, ip := range ips[1:] {
		fmt.Printf("  Alt IP    : %s%s:%d%s\n", Dim, ip, *port, Reset)
	}
	fmt.Printf("  %s──────────────────────────────────────────────────────%s\n\n", Dim, Reset)
}

// shortID abbreviates a device id for display.
func shortID(id string) string {
	if len(id) > 8 {
		return id[:8]
	}
	return id
}
