package main

import (
	"net/http"
	"strings"
)

type aliasUpdateRequest struct {
	DeviceID    string `json:"deviceId,omitempty"`
	DeviceAlias string `json:"deviceAlias,omitempty"`
	PCAlias     string `json:"pcAlias,omitempty"`
}

func handleDeviceAlias(w http.ResponseWriter, r *http.Request, s *Session) {
	var req aliasUpdateRequest
	if err := s.readRequest(r, &req); err != nil {
		httpError(w, http.StatusBadRequest, "Invalid request")
		return
	}

	// A device may only rename itself, never another paired device.
	if req.DeviceID != "" && req.DeviceID != s.Device.ID {
		httpError(w, http.StatusForbidden, "A device can only change its own alias")
		return
	}

	var updatedDeviceName, updatedAlias string
	if dev, ok := setDeviceAlias(s.Device.ID, req.DeviceAlias); ok {
		stateMu.Lock()
		updatedDeviceName, updatedAlias = dev.DisplayName(), dev.Alias
		stateMu.Unlock()
	}

	if req.PCAlias != "" || r.URL.Query().Get("updatePc") == "1" {
		setServerAlias(req.PCAlias)
	}

	s.writeResponse(w, r, map[string]interface{}{
		"ok":          true,
		"deviceName":  updatedDeviceName,
		"deviceAlias": updatedAlias,
		"pcName":      getServerName(),
	})
}

type settingsPayload struct {
	BandwidthLimitBps      int64  `json:"bandwidthLimitBps"`
	MaxConcurrency         int    `json:"maxConcurrency"`
	ClipboardSyncEnabled   bool   `json:"clipboardSyncEnabled"`
	SensitiveFilterEnabled bool   `json:"sensitiveFilterEnabled"`
	ReceiveDir             string `json:"receiveDir"`
	PCAlias                string `json:"pcAlias"`
	DeviceAlias            string `json:"deviceAlias"`
	ContextMenuEnabled     bool   `json:"contextMenuEnabled"`
	AutostartEnabled       bool   `json:"autostartEnabled"`
}

type settingsUpdateRequest struct {
	BandwidthLimitBps      *int64  `json:"bandwidthLimitBps,omitempty"`
	MaxConcurrency         *int    `json:"maxConcurrency,omitempty"`
	ClipboardSyncEnabled   *bool   `json:"clipboardSyncEnabled,omitempty"`
	SensitiveFilterEnabled *bool   `json:"sensitiveFilterEnabled,omitempty"`
	ReceiveDir             *string `json:"receiveDir,omitempty"`
	PCAlias                *string `json:"pcAlias,omitempty"`
	DeviceAlias            *string `json:"deviceAlias,omitempty"`
	ContextMenuEnabled     *bool   `json:"contextMenuEnabled,omitempty"`
	AutostartEnabled       *bool   `json:"autostartEnabled,omitempty"`
}

func handleSettings(w http.ResponseWriter, r *http.Request, s *Session) {
	if r.Method == http.MethodPost {
		var req settingsUpdateRequest
		if err := s.readRequest(r, &req); err != nil {
			httpError(w, http.StatusBadRequest, "Invalid settings payload")
			return
		}
		if req.BandwidthLimitBps != nil {
			persistBandwidthLimit(*req.BandwidthLimitBps)
		}
		if req.MaxConcurrency != nil {
			c := *req.MaxConcurrency
			if c < 0 {
				c = 0
			}
			if c > 16 {
				c = 16
			}
			stateMu.Lock()
			state.MaxConcurrency = c
			saveStateLocked()
			stateMu.Unlock()
		}
		if req.ClipboardSyncEnabled != nil {
			setClipboardSyncEnabled(*req.ClipboardSyncEnabled)
		}
		if req.SensitiveFilterEnabled != nil {
			setSensitiveClipboardFilterEnabled(*req.SensitiveFilterEnabled)
		}
		if req.ReceiveDir != nil && strings.TrimSpace(*req.ReceiveDir) != "" {
			if err := setReceiveDir(strings.TrimSpace(*req.ReceiveDir)); err == nil {
				persistReceiveDir()
			} else {
				printAsync(Yellow, "○ Settings", "Receive folder not changed", err.Error())
			}
		}
		if req.PCAlias != nil {
			setServerAlias(*req.PCAlias)
		}
		if req.DeviceAlias != nil {
			setDeviceAlias(s.Device.ID, *req.DeviceAlias)
		}
		if req.ContextMenuEnabled != nil {
			if *req.ContextMenuEnabled {
				_ = installExplorerContextMenu()
			} else {
				_ = uninstallExplorerContextMenu()
			}
		}
		if req.AutostartEnabled != nil {
			_ = setOSAutostart(*req.AutostartEnabled)
		}
	}

	stateMu.Lock()
	maxConc := state.MaxConcurrency
	pcAlias := state.ServerAlias
	devAlias := s.Device.Alias
	stateMu.Unlock()

	currDir := getReceiveDir()

	resp := settingsPayload{
		BandwidthLimitBps:      getBandwidthLimitBps(),
		MaxConcurrency:         maxConc,
		ClipboardSyncEnabled:   isClipboardSyncEnabled(),
		SensitiveFilterEnabled: isSensitiveClipboardFilterEnabled(),
		ReceiveDir:             currDir,
		PCAlias:                pcAlias,
		DeviceAlias:            devAlias,
		ContextMenuEnabled:     isExplorerContextMenuInstalled(),
		AutostartEnabled:       isOSAutostartEnabled(),
	}
	s.writeResponse(w, r, resp)
}
