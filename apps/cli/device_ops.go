package main

import "fmt"

// revokeDevice removes a paired device and everything tied to it: its stored
// key, live sessions, in-flight transfers and open WebSocket connections.
func revokeDevice(deviceID string) {
	removeDevice(deviceID)
	dropSessions(deviceID)

	transfersMu.Lock()
	var abandoned []*TransferState
	for id, t := range transfers {
		if t.Owner == deviceID {
			abandoned = append(abandoned, t)
			delete(transfers, id)
		}
	}
	transfersMu.Unlock()
	for _, t := range abandoned {
		t.discard()
	}

	clientsMu.Lock()
	var dropped []*Client
	for c := range clients {
		if c.device != nil && c.device.ID == deviceID {
			dropped = append(dropped, c)
			delete(clients, c)
		}
	}
	clientsMu.Unlock()
	for _, c := range dropped {
		c.Close()
	}

	outboxMu.Lock()
	delete(deviceOutbox, deviceID)
	outboxMu.Unlock()
}

// unpairDevice is the terminal "unpair" command.
func unpairDevice(query string) {
	device := resolveDeviceTarget(query)
	if device == nil {
		printSync(Red, "! Error", fmt.Sprintf("No paired device matches %q", query), "")
		return
	}
	name := device.DisplayName()
	revokeDevice(device.ID)
	printSync(Green, "● Unpaired", name, "")
}
