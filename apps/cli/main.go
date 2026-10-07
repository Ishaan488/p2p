package main

import (
	"bufio"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/atotto/clipboard"
	"github.com/gorilla/websocket"
	"github.com/mdp/qrterminal/v3"
)

var lastClipboardText string

func watchClipboard() {
	for {
		time.Sleep(1 * time.Second)
		text, err := clipboard.ReadAll()
		if err == nil && text != "" && text != lastClipboardText {
			lastClipboardText = text
			msg := Message{
				Type:      "clipboard",
				ID:        fmt.Sprintf("msg-%d", time.Now().UnixNano()),
				Timestamp: time.Now().Unix(),
				Payload:   TextPayload{Text: text},
			}
			fmt.Printf("%s%s[Clipboard Synced PC -> Phone]%s\n> ", ClearLine, Cyan, Reset)
			broadcastMessage(msg)
		}
	}
}

const (
	Reset     = "\033[0m"
	Red       = "\033[31m"
	Green     = "\033[32m"
	Yellow    = "\033[33m"
	Blue      = "\033[34m"
	Cyan      = "\033[36m"
	White     = "\033[37m"
	ClearLine = "\033[2K\r"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool {
		return true // Allow all origins for local network
	},
}

type Client struct {
	conn   *websocket.Conn
	send   chan Message
	device *Device
}

var (
	clients   = make(map[*Client]bool)
	clientsMu sync.Mutex
)

func getLocalIP() string {
	// Best method: Let OS pick the outbound IP (ignores WSL/Docker virtual adapters)
	conn, err := net.Dial("udp", "8.8.8.8:80")
	if err == nil {
		defer conn.Close()
		localAddr := conn.LocalAddr().(*net.UDPAddr)
		return localAddr.IP.String()
	}

	// Fallback if offline
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return ""
	}
	for _, address := range addrs {
		if ipnet, ok := address.(*net.IPNet); ok && !ipnet.IP.IsLoopback() {
			if ipnet.IP.To4() != nil {
				ip := ipnet.IP.String()
				// Ignore link-local (169.254.x.x) and common Docker (172.x.x.x) if possible in fallback
				if !strings.HasPrefix(ip, "169.254.") && !strings.HasPrefix(ip, "172.") {
					return ip
				}
			}
		}
	}
	return ""
}

var (
	port        = flag.Int("port", 8080, "port to listen on")
	homeFlag    = flag.String("home", "", "directory for received files and app data (default ~/P2P)")
	noClipboard = flag.Bool("no-clipboard", false, "disable clipboard sync")
)

func main() {
	flag.Parse()
	if *homeFlag != "" {
		baseDir = *homeFlag
		receiveDir = filepath.Join(baseDir, "received")
		tempDir = filepath.Join(baseDir, "temp")
	}
	initDirs()
	loadState()
	cleanTempDir()
	startTransferJanitor()
	fmt.Print(Cyan + `
    ____ ___  ____     __    _       __  
   / __ \__ \/ __ \   / /   (_)___  / /__
  / /_/ /_/ / /_/ /  / /   / / __ \/ //_/
 / ____/ __/ ____/  / /___/ / / / /  ,<   
/_/   /____/_/     /_____/_/_/ /_/_/|_|  
` + Reset)
	fmt.Println(Green + "\n  Server running on port 8080" + Reset)
	fmt.Println(White + "  Type '" + Yellow + "help" + White + "' for commands.\n" + Reset)

	http.HandleFunc("/ws", handleWebSocket)
	http.HandleFunc("/pair", handlePair)
	http.HandleFunc("/hello", handleHello)
	http.HandleFunc("/upload_init", authed(handleUploadInit))
	http.HandleFunc("/upload", authed(handleUploadChunk))
	http.HandleFunc("/upload_complete", authed(handleUploadComplete))
	http.HandleFunc("/upload_cancel", authed(handleUploadCancel))
	http.HandleFunc("/download_full", authed(handleDownloadFull))

	// Serve the production React PWA
	fs := http.FileServer(http.Dir("../mobile/dist"))
	http.Handle("/", fs)

	if !*noClipboard {
		go watchClipboard()
	}

	go func() {
		listenAddr := fmt.Sprintf("0.0.0.0:%d", *port)
		log.Println("Listening on " + listenAddr)
		if err := http.ListenAndServe(listenAddr, nil); err != nil {
			log.Fatal("ListenAndServe:", err)
		}
	}()

	// Auto-display QR Code on startup
	showPairing()

	// CLI input for sending messages
	scanner := bufio.NewScanner(os.Stdin)
	for {
		fmt.Print("> ")
		if !scanner.Scan() {
			break
		}
		text := strings.TrimSpace(scanner.Text())
		if text != "" {
			if text == "help" {
				fmt.Println(Cyan + "\n--- Commands ---" + Reset)
				fmt.Println(Yellow + "pair" + Reset + "            : Show a fresh QR code to pair a device")
				fmt.Println(Yellow + "devices" + Reset + "         : List paired devices")
				fmt.Println(Yellow + "unpair <device>" + Reset + " : Remove a paired device (by name or id)")
				fmt.Println(Yellow + "send <file>" + Reset + "     : Send a file (e.g. send \"C:\\photo.jpg\")")
				fmt.Println(Yellow + "setdir <path>" + Reset + "   : Set directory for received files")
				fmt.Println(Yellow + "exit" + Reset + "            : Close the server")
				fmt.Println()
			} else if text == "exit" {
				fmt.Println(Yellow + "Shutting down..." + Reset)
				os.Exit(0)
			} else if text == "pair" {
				showPairing()
			} else if text == "devices" {
				printDevices()
			} else if strings.HasPrefix(text, "unpair ") {
				unpairDevice(strings.TrimSpace(strings.TrimPrefix(text, "unpair ")))
			} else if strings.HasPrefix(text, "send ") {
				filePath := strings.TrimPrefix(text, "send ")
				filePath = strings.TrimSpace(filePath)
				filePath = strings.Trim(filePath, "\"'")
				err := startSendTransfer(filePath)
				if err != nil {
					fmt.Printf("Failed to send file: %v\n> ", err)
				}
			} else if strings.HasPrefix(text, "setdir ") {
				newDir := strings.TrimPrefix(text, "setdir ")
				newDir = strings.TrimSpace(newDir)
				newDir = strings.Trim(newDir, "\"'")
				err := setReceiveDir(newDir)
				if err != nil {
					fmt.Printf("%sFailed to set receive directory: %v%s\n> ", Red, err, Reset)
				} else {
					fmt.Printf("%sReceive directory set to: %s%s\n> ", Green, newDir, Reset)
				}
			} else {
				msg := Message{
					Version:   1,
					Type:      "text",
					ID:        fmt.Sprintf("msg-%d", time.Now().UnixNano()),
					Timestamp: time.Now().Unix(),
					Payload:   TextPayload{Text: text},
				}
				broadcastMessage(msg)
			}
		}
	}
}

// showPairing prints a QR code that opens the app and pairs the scanning device.
func showPairing() {
	code := newPairCode()
	ip := getLocalIP()
	if ip == "" {
		fmt.Printf("\n%sCould not determine local IP address%s\n", Red, Reset)
		fmt.Printf("  Pairing code: %s%s%s\n\n", Yellow, formatPairCode(code), Reset)
		return
	}
	addr := fmt.Sprintf("%s:%d", ip, *port)
	fmt.Printf("\n%s[Pairing]%s Scan this QR code from your phone:\n\n", Cyan, Reset)
	qrterminal.GenerateHalfBlock(fmt.Sprintf("http://%s/#pair=%s", addr, code), qrterminal.L, os.Stdout)
	fmt.Printf("\n  Or open %shttp://%s%s and enter the code %s%s%s\n", White, addr, Reset, Yellow, formatPairCode(code), Reset)
	fmt.Printf("  The code is valid for %d minutes.\n\n", int(pairCodeTTL.Minutes()))
}

func deviceOnline(id string) bool {
	clientsMu.Lock()
	defer clientsMu.Unlock()
	for client := range clients {
		if client.device.ID == id {
			return true
		}
	}
	return false
}

func printDevices() {
	devices := listDevices()
	if len(devices) == 0 {
		fmt.Println("No paired devices. Type 'pair' to add one.")
		return
	}
	fmt.Println(Cyan + "\n--- Paired devices ---" + Reset)
	for _, d := range devices {
		status := "last seen " + time.Unix(d.LastSeen, 0).Format("2006-01-02 15:04")
		if deviceOnline(d.ID) {
			status = Green + "online" + Reset
		}
		fmt.Printf("%s%-24s%s %s  %s\n", Yellow, d.Name, Reset, d.ID[:8], status)
	}
	fmt.Println()
}

func unpairDevice(query string) {
	device := findDeviceByQuery(strings.Trim(query, "\"'"))
	if device == nil {
		fmt.Printf("%sNo paired device matches %q%s\n", Red, query, Reset)
		return
	}
	removeDevice(device.ID)
	dropSessions(device.ID)

	clientsMu.Lock()
	for client := range clients {
		if client.device.ID == device.ID {
			client.conn.Close()
		}
	}
	clientsMu.Unlock()
	fmt.Printf("%sUnpaired %s%s\n", Green, device.Name, Reset)
}

func handleWebSocket(w http.ResponseWriter, r *http.Request) {
	session := authenticate(r)
	if session == nil {
		http.Error(w, "Session expired", http.StatusUnauthorized)
		return
	}
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Println("Upgrade error:", err)
		return
	}

	client := &Client{
		conn:   conn,
		send:   make(chan Message, 256),
		device: session.Device,
	}
	touchDevice(session.Device)

	clientsMu.Lock()
	clients[client] = true
	clientsMu.Unlock()

	fmt.Printf("%s%s[Device Connected]%s %s (%s)\n> ", ClearLine, Green, Reset, client.device.Name, r.RemoteAddr)

	go client.writePump()
	client.readPump()
}

func (c *Client) readPump() {
	defer func() {
		clientsMu.Lock()
		delete(clients, c)
		clientsMu.Unlock()
		c.conn.Close()
		fmt.Printf("%s%s[Device Disconnected]%s %s\n> ", ClearLine, Yellow, Reset, c.device.Name)
	}()

	for {
		var msg Message
		err := c.conn.ReadJSON(&msg)
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				log.Printf("error: %v", err)
			}
			break
		}

		if msg.Type == "text" {
			payload, ok := msg.Payload.(map[string]interface{})
			if ok {
				if text, exists := payload["text"].(string); exists {
					lastClipboardText = text
					clipboard.WriteAll(text)
					fmt.Printf("%s%s[%s]:%s %s %s(Copied to Clipboard)%s\n> ", ClearLine, Blue, c.device.Name, Reset, text, Cyan, Reset)
				}
			}
		} else if msg.Type == "clipboard" {
			payload, ok := msg.Payload.(map[string]interface{})
			if ok {
				if text, exists := payload["text"].(string); exists {
					lastClipboardText = text
					clipboard.WriteAll(text)
					fmt.Printf("%s%s[Clipboard Synced %s -> PC]%s\n> ", ClearLine, Cyan, c.device.Name, Reset)
				}
			}
		}
	}
}

func (c *Client) writePump() {
	defer func() {
		c.conn.Close()
	}()
	for {
		msg, ok := <-c.send
		if !ok {
			c.conn.WriteMessage(websocket.CloseMessage, []byte{})
			return
		}
		err := c.conn.WriteJSON(msg)
		if err != nil {
			return
		}
	}
}

func broadcastMessage(msg Message) {
	clientsMu.Lock()
	defer clientsMu.Unlock()
	for client := range clients {
		select {
		case client.send <- msg:
		default:
			close(client.send)
			delete(clients, client)
		}
	}
}
