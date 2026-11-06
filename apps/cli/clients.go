package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// WebSocket clients: connection lifecycle, message dispatch and broadcast.

const (
	wsReadTimeout     = 12 * time.Second
	wsWriteTimeout    = 5 * time.Second
	wsPingInterval    = 3500 * time.Millisecond
	wsMaxFrameBytes   = 8 << 20 // largest accepted (encrypted) frame
	clientSendBuffer  = 256
	maxOutboxPerQueue = 200 // < clientSendBuffer so a flush can never overflow the send channel
	offlineDebounce   = 4500 * time.Millisecond
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool {
		return true // Allow all origins for local network
	},
}

type Client struct {
	conn    *websocket.Conn
	send    chan Message
	device  *Device
	session *Session
	mu      sync.Mutex
	closed  bool
}

func (c *Client) Close() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.closeLocked()
}

func (c *Client) closeLocked() {
	if c.closed {
		return
	}
	c.closed = true
	close(c.send)
	if c.conn != nil {
		c.conn.Close()
	}
}

// Enqueue queues msg for delivery. A client whose buffer is full is too slow to
// keep up and is disconnected; it reports false in that case.
func (c *Client) Enqueue(msg Message) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return false
	}
	select {
	case c.send <- msg:
		return true
	default:
		c.closeLocked()
		return false
	}
}

var (
	clients   = make(map[*Client]bool)
	clientsMu sync.Mutex

	// Messages for devices that are offline. Key: device ID, or "" for broadcasts.
	outboxMu     sync.Mutex
	deviceOutbox = make(map[string][]Message)

	lastDisconnectMu  sync.Mutex
	lastDisconnectMap = make(map[string]time.Time)
	deviceOnlineState = make(map[string]bool)
)

func hasOnlineClients() bool {
	clientsMu.Lock()
	defer clientsMu.Unlock()
	return len(clients) > 0
}

func deviceOnline(id string) bool {
	clientsMu.Lock()
	defer clientsMu.Unlock()
	for client := range clients {
		if client.device != nil && client.device.ID == id {
			return true
		}
	}
	return false
}

func getDeviceRemoteAddr(id string) string {
	clientsMu.Lock()
	defer clientsMu.Unlock()
	for client := range clients {
		if client.device != nil && client.device.ID == id && client.conn != nil {
			return client.conn.RemoteAddr().String()
		}
	}
	return ""
}

// takeOutbox removes and returns the messages waiting for deviceID: broadcasts
// first, then those addressed to the device.
func takeOutbox(deviceID string) []Message {
	outboxMu.Lock()
	defer outboxMu.Unlock()
	var pending []Message
	if global := deviceOutbox[""]; len(global) > 0 {
		pending = append(pending, global...)
		delete(deviceOutbox, "")
	}
	if targeted := deviceOutbox[deviceID]; len(targeted) > 0 {
		pending = append(pending, targeted...)
		delete(deviceOutbox, deviceID)
	}
	if len(pending) > maxOutboxPerQueue {
		pending = pending[len(pending)-maxOutboxPerQueue:]
	}
	return pending
}

func queueOffline(msg Message) {
	outboxMu.Lock()
	defer outboxMu.Unlock()
	bucket := msg.TargetDeviceID
	q := append(deviceOutbox[bucket], msg)
	if len(q) > maxOutboxPerQueue {
		q = q[len(q)-maxOutboxPerQueue:] // drop the oldest
	}
	deviceOutbox[bucket] = q
}

func handleWebSocket(w http.ResponseWriter, r *http.Request) {
	session := authenticate(r)
	if session != nil {
		sessionsMu.Lock()
		if session.wsClaimed {
			session = nil
		} else {
			session.wsClaimed = true
		}
		sessionsMu.Unlock()
	}
	if session == nil {
		http.Error(w, "Session expired", http.StatusUnauthorized)
		return
	}
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		// Let the client retry the upgrade with the same session.
		sessionsMu.Lock()
		session.wsClaimed = false
		sessionsMu.Unlock()
		log.Println("Upgrade error:", err)
		return
	}
	conn.SetReadLimit(wsMaxFrameBytes)

	client := &Client{
		conn:    conn,
		send:    make(chan Message, clientSendBuffer),
		device:  session.Device,
		session: session,
	}
	touchDevice(session.Device)

	clientsMu.Lock()
	clients[client] = true
	clientsMu.Unlock()

	// Flush messages queued while the device was offline.
	pending := takeOutbox(session.Device.ID)
	for _, m := range pending {
		client.Enqueue(m)
	}

	lastDisconnectMu.Lock()
	wasOnline := deviceOnlineState[session.Device.ID]
	lastDisconnect := lastDisconnectMap[session.Device.ID]
	deviceOnlineState[session.Device.ID] = true
	lastDisconnectMu.Unlock()

	if len(pending) > 0 {
		printAsync(Green, "● Online", client.device.DisplayName(), fmt.Sprintf("delivered %d queued", len(pending)))
	} else if !wasOnline && time.Since(lastDisconnect) > 4*time.Second {
		printAsync(Green, "● Online", client.device.DisplayName(), "")
	}

	go client.writePump()
	client.readPump()
}

// markDisconnected runs when a client goes away. The "offline" notice is
// debounced so a quick tab switch or reconnect does not spam the terminal.
func (c *Client) markDisconnected() {
	clientsMu.Lock()
	delete(clients, c)
	clientsMu.Unlock()
	c.Close()

	devID, devName := c.device.ID, c.device.DisplayName()
	lastDisconnectMu.Lock()
	lastDisconnectMap[devID] = time.Now()
	lastDisconnectMu.Unlock()

	go func() {
		time.Sleep(offlineDebounce)
		if deviceOnline(devID) {
			return
		}
		lastDisconnectMu.Lock()
		wasOnline := deviceOnlineState[devID]
		deviceOnlineState[devID] = false
		lastDisconnectMu.Unlock()
		if wasOnline {
			printAsync(Yellow, "○ Offline", devName, "")
		}
	}()
}

func (c *Client) readPump() {
	defer c.markDisconnected()

	// Read timeout and keepalive pong handling
	_ = c.conn.SetReadDeadline(time.Now().Add(wsReadTimeout))
	c.conn.SetPongHandler(func(string) error {
		return c.conn.SetReadDeadline(time.Now().Add(wsReadTimeout))
	})

	// Frames are encrypted and numbered per direction: anything replayed,
	// reordered, dropped or forged fails to decrypt and ends the connection.
	for counter := 0; ; counter++ {
		_, frame, err := c.conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				log.Printf("websocket read error: %v", err)
			}
			return
		}
		_ = c.conn.SetReadDeadline(time.Now().Add(wsReadTimeout))
		plaintext, err := c.session.open(frame, fmt.Sprintf("c2s\n%d", counter))
		if err != nil {
			printAsync(Red, "! Security", c.device.DisplayName(), "dropped undecryptable frame")
			return
		}
		var msg Message
		if json.Unmarshal(plaintext, &msg) != nil {
			continue
		}
		c.dispatch(msg)
	}
}

// payloadString extracts a string field from a decoded JSON payload.
func payloadString(payload interface{}, key string) (string, bool) {
	m, ok := payload.(map[string]interface{})
	if !ok {
		return "", false
	}
	v, ok := m[key].(string)
	return v, ok
}

func (c *Client) dispatch(msg Message) {
	switch msg.Type {
	case "ping":
		c.Enqueue(Message{Version: 1, Type: "pong"})
	case "text":
		if text, ok := payloadString(msg.Payload, "text"); ok {
			meta := "clipboard sync off"
			if copyToClipboard(text) {
				meta = "copied"
			}
			printAsync(Blue, "↓ Received", printableText(text, 0), meta)
		}
	case "clipboard":
		c.handleClipboardMessage(msg)
	case "file_reject", "transfer_reject":
		if tid, ok := payloadString(msg.Payload, "transferId"); ok && tid != "" {
			c.handleRemoteReject(tid)
		}
	}
}

func (c *Client) handleClipboardMessage(msg Message) {
	if !isClipboardSyncEnabled() {
		return
	}
	text, ok := payloadString(msg.Payload, "text")
	if !ok || text == "" || len(text) > maxClipboardSyncBytes {
		return
	}
	if isSensitiveClipboardFilterEnabled() {
		if sensitive, reason := isSensitiveClipboard(text); sensitive {
			printAsync(Yellow, "○ ClipGuard", "Blocked incoming sensitive clipboard", reason)
			return
		}
	}
	clipboardMu.RLock()
	prev := lastClipboardText
	clipboardMu.RUnlock()
	if text != prev && copyToClipboard(text) {
		printAsync(Cyan, "↓ Clipboard", fmt.Sprintf("%q", printableText(text, 42)), "")
	}
}

// handleRemoteReject cleans up after the remote device declined a transfer.
// It only acts on transfers that belong to this device (or to everyone).
func (c *Client) handleRemoteReject(transferID string) {
	transfersMu.Lock()
	t, exists := transfers[transferID]
	if exists && t.Owner != "" && t.Owner != c.device.ID {
		exists = false
	}
	if exists {
		delete(transfers, transferID)
	}
	transfersMu.Unlock()
	if !exists || t == nil {
		return
	}

	direction := "Received"
	if t.IsDownload {
		direction = "Sent"
		t.cleanupDownload()
	} else {
		t.discard()
	}
	printAsync(Yellow, "○ Rejected", t.Filename, "rejected by remote device")
	recordTransfer(TransferRecord{
		ID:        t.ID,
		Filename:  t.Filename,
		Size:      t.TotalSize,
		Direction: direction,
		Device:    c.device.DisplayName(),
		Status:    "Rejected",
	})
}

func (c *Client) writePump() {
	ticker := time.NewTicker(wsPingInterval)
	defer func() {
		ticker.Stop()
		c.Close()
	}()
	for counter := 0; ; {
		select {
		case msg, ok := <-c.send:
			if !ok {
				_ = c.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}
			data, err := json.Marshal(msg)
			if err != nil {
				log.Printf("dropping unserialisable %q message: %v", msg.Type, err)
				continue
			}
			frame := c.session.seal(data, fmt.Sprintf("s2c\n%d", counter))
			counter++
			_ = c.conn.SetWriteDeadline(time.Now().Add(wsWriteTimeout))
			if err := c.conn.WriteMessage(websocket.BinaryMessage, frame); err != nil {
				return
			}
		case <-ticker.C:
			_ = c.conn.SetWriteDeadline(time.Now().Add(wsWriteTimeout))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

func broadcastOnlineOnly(msg Message) int {
	clientsMu.Lock()
	defer clientsMu.Unlock()
	delivered := 0
	for client := range clients {
		if msg.TargetDeviceID != "" && client.device != nil && client.device.ID != msg.TargetDeviceID {
			continue
		}
		if client.Enqueue(msg) {
			delivered++
		} else {
			delete(clients, client)
		}
	}
	return delivered
}

// broadcastMessage delivers msg to the matching online devices, or queues it
// until one connects. It returns how many devices received it right away.
func broadcastMessage(msg Message) int {
	delivered := broadcastOnlineOnly(msg)
	if delivered == 0 {
		queueOffline(msg)
	}
	return delivered
}
