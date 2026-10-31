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

// Device is a phone/tablet/browser that has been paired with this PC.
type Device struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Key      []byte `json:"key"` // long-term secret derived from the pairing code
	PairedAt int64  `json:"pairedAt"`
	LastSeen int64  `json:"lastSeen"`
	Trusted  bool   `json:"trusted"` // if true, transfers are accepted automatically without prompting
}

type appState struct {
	ServerID string    `json:"serverId"`
	Devices  []*Device `json:"devices"`
}

var (
	state   appState
	stateMu sync.Mutex
)

func statePath() string {
	return filepath.Join(baseDir, "state.json")
}

func loadState() {
	stateMu.Lock()
	defer stateMu.Unlock()
	p := statePath()
	if data, err := os.ReadFile(p); err == nil {
		if err := json.Unmarshal(data, &state); err != nil {
			// Corrupted state file recovery: back up corrupted file and start clean
			backup := fmt.Sprintf("%s.corrupt.%d", p, time.Now().Unix())
			_ = os.Rename(p, backup)
			fmt.Printf("%s[State Recovery] Corrupted %s detected. Backed up to %s and initialized clean state.%s\n",
				Yellow, filepath.Base(p), filepath.Base(backup), Reset)
			state = appState{}
		}
	}
	if state.ServerID == "" {
		state.ServerID = randomID()
		saveStateLocked()
	}
}

// saveStateLocked persists the state; it holds device keys, so keep it private to the user.
func saveStateLocked() {
	data, err := json.MarshalIndent(&state, "", "  ")
	if err != nil {
		return
	}
	os.MkdirAll(baseDir, 0755)
	tmp := statePath() + ".tmp"
	if err := os.WriteFile(tmp, data, 0600); err != nil {
		fmt.Printf("%sCould not save %s: %v%s\n", Red, statePath(), err, Reset)
		return
	}
	os.Rename(tmp, statePath())
}

func findDevice(id string) *Device {
	stateMu.Lock()
	defer stateMu.Unlock()
	for _, d := range state.Devices {
		if d.ID == id {
			return d
		}
	}
	return nil
}

// findDeviceByQuery matches a device by exact name or by id prefix.
func findDeviceByQuery(query string) *Device {
	stateMu.Lock()
	defer stateMu.Unlock()
	for _, d := range state.Devices {
		if strings.EqualFold(d.Name, query) {
			return d
		}
	}
	for _, d := range state.Devices {
		if strings.HasPrefix(d.ID, query) {
			return d
		}
	}
	return nil
}

// registerDevice stores a newly paired device, replacing an earlier pairing of the same id.
func registerDevice(id, name string, key []byte) *Device {
	stateMu.Lock()
	defer stateMu.Unlock()

	taken := func(candidate string) bool {
		for _, d := range state.Devices {
			if d.ID != id && strings.EqualFold(d.Name, candidate) {
				return true
			}
		}
		return false
	}
	unique := name
	for n := 2; taken(unique); n++ {
		unique = fmt.Sprintf("%s %d", name, n)
	}

	now := time.Now().Unix()
	for _, d := range state.Devices {
		if d.ID == id {
			d.Name, d.Key, d.PairedAt, d.LastSeen = unique, key, now, now
			saveStateLocked()
			return d
		}
	}
	device := &Device{ID: id, Name: unique, Key: key, PairedAt: now, LastSeen: now}
	state.Devices = append(state.Devices, device)
	saveStateLocked()
	return device
}

func removeDevice(id string) {
	stateMu.Lock()
	defer stateMu.Unlock()
	kept := state.Devices[:0]
	for _, d := range state.Devices {
		if d.ID != id {
			kept = append(kept, d)
		}
	}
	state.Devices = kept
	saveStateLocked()
}

func touchDevice(d *Device) {
	stateMu.Lock()
	d.LastSeen = time.Now().Unix()
	saveStateLocked()
	stateMu.Unlock()
}

func setDeviceTrust(id string, trusted bool) bool {
	stateMu.Lock()
	defer stateMu.Unlock()
	for _, d := range state.Devices {
		if d.ID == id || strings.EqualFold(d.Name, id) {
			d.Trusted = trusted
			saveStateLocked()
			return true
		}
	}
	return false
}

func listDevices() []Device {
	stateMu.Lock()
	defer stateMu.Unlock()
	out := make([]Device, 0, len(state.Devices))
	for _, d := range state.Devices {
		out = append(out, *d)
	}
	return out
}
