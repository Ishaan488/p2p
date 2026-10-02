package main

import (
	"bufio"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/mdp/qrterminal/v3"
)

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
	conn *websocket.Conn
	send chan Message
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

func main() {
	initDirs()
	fmt.Print(Cyan + `
    ____ ___  ____   __    _       __  
   / __ \__ \/ __ \ / /   (_)___  / /__
  / /_/ /_/ / /_/ // /   / / __ \/ //_/
 / ____/ __/ ____// /___/ / / / / ,<   
/_/   /____/_/   /_____/_/_/ /_/_/|_|  
` + Reset)
	fmt.Println(Green + "\n  Server running on port 8080" + Reset)
	fmt.Println(White + "  Type '" + Yellow + "help" + White + "' for commands.\n" + Reset)

	http.HandleFunc("/ws", handleWebSocket)
	http.HandleFunc("/upload", handleUploadChunk)
	http.HandleFunc("/download", handleDownloadChunk)

	// Serve the production React PWA
	fs := http.FileServer(http.Dir("../mobile/dist"))
	http.Handle("/", fs)

	go func() {
		log.Println("Listening on 0.0.0.0:8080")
		if err := http.ListenAndServe("0.0.0.0:8080", nil); err != nil {
			log.Fatal("ListenAndServe:", err)
		}
	}()

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
				fmt.Println(Yellow + "pair" + Reset + "       : Show QR code to connect phone")
				fmt.Println(Yellow + "send <file>" + Reset + ": Send a file (e.g. send \"C:\\photo.jpg\")")
				fmt.Println(Yellow + "exit" + Reset + "       : Close the server\n")
			} else if text == "exit" {
				fmt.Println(Yellow + "Shutting down..." + Reset)
				os.Exit(0)
			} else if text == "pair" {
				ip := getLocalIP()
				if ip != "" {
					addr := fmt.Sprintf("%s:8080", ip)
					fmt.Printf("\n%s[Pairing]%s Scan this QR code from your phone:\n\n", Cyan, Reset)
					qrterminal.GenerateHalfBlock(addr, qrterminal.L, os.Stdout)
					fmt.Print("\n> ")
				} else {
					fmt.Printf("%sCould not determine local IP address%s\n> ", Red, Reset)
				}
			} else if strings.HasPrefix(text, "send ") {
				filePath := strings.TrimPrefix(text, "send ")
				filePath = strings.TrimSpace(filePath)
				filePath = strings.Trim(filePath, "\"'")
				err := startSendTransfer(filePath)
				if err != nil {
					fmt.Printf("Failed to send file: %v\n> ", err)
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

func handleWebSocket(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Println("Upgrade error:", err)
		return
	}

	client := &Client{
		conn: conn,
		send: make(chan Message, 256),
	}

	clientsMu.Lock()
	clients[client] = true
	clientsMu.Unlock()

	fmt.Printf("%s%s[Device Connected]%s %s\n> ", ClearLine, Green, Reset, r.RemoteAddr)

	go client.writePump()
	client.readPump()
}

func (c *Client) readPump() {
	defer func() {
		clientsMu.Lock()
		delete(clients, c)
		clientsMu.Unlock()
		c.conn.Close()
		fmt.Printf("%s%s[Device Disconnected]%s\n> ", ClearLine, Yellow, Reset)
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
					fmt.Printf("%s%s[Phone]:%s %s\n> ", ClearLine, Blue, Reset, text)
				}
			}
		} else if msg.Type == "file_start" {
			payload, ok := msg.Payload.(map[string]interface{})
			if ok {
				transferId, _ := payload["transferId"].(string)
				filename, _ := payload["filename"].(string)
				totalChunksFloat, _ := payload["totalChunks"].(float64)
				startReceiveTransfer(transferId, filename, int(totalChunksFloat))
			}
		} else if msg.Type == "file_complete" {
			payload, ok := msg.Payload.(map[string]interface{})
			if ok {
				transferId, _ := payload["transferId"].(string)
				checksum, _ := payload["checksum"].(string)
				completeTransfer(transferId, checksum)
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
