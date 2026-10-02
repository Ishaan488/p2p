# P2P Link

A lightning-fast, zero-RAM, peer-to-peer file transfer and messaging utility. Built with a Go CLI backend and a React (PWA) mobile frontend, P2P Link is designed to act as a robust, professional-grade alternative to AirDrop or Snapdrop for seamless PC-to-Phone communication.

## Features

- **Zero-RAM File Transfers:** Large files (e.g., 50GB videos or executables) bypass temporary browser memory entirely. They are streamed block-by-block directly to the OS download manager, meaning the app uses zero extra RAM no matter the file size.
- **Memory-Safe Image Previews:** Images under 20MB are elegantly rendered inline with a sleek frosted-glass preview. Oversized images (like 2GB RAW files) are dynamically downgraded to direct-disk downloads to prevent Out-Of-Memory (OOM) browser crashes.
- **Ultra-Premium UI:** Features a completely bespoke "Monochrome Transfer Log" design. Stripped of flashy, generic chat app aesthetics, it relies on highly sophisticated translucent whites, OLED-blacks, and subtle blue steel highlights for a native, developer-tool feel.
- **QR Code Pairing:** Connect your mobile device instantly by scanning a terminal-generated QR code. No IP addresses to type.
- **Haptic-style Micro-interactions:** Hardware-accelerated CSS animations (`transform` and `opacity`) ensure buttery-smooth 60FPS UI transitions, avoiding choppy layout reflows during deletions and list interactions.

## Architecture

The project is split into two main components:
1. **`apps/cli` (Go):** The host server running on your PC. It manages WebSocket connections, serves the web app to the phone, generates QR codes, and streams files directly from the hard drive.
2. **`apps/mobile` (React + TypeScript + Vite):** The client-side Progressive Web App (PWA) accessed by your mobile browser.

## Usage Guide

To use P2P Link, your PC and Phone must be connected to the **same Wi-Fi network**.

### Step 1: Start the Server (PC)
1. Open the project folder on your PC.
2. Double-click the `Start P2P.bat` file.
3. A terminal window will open indicating the server has started.

### Step 2: Connect your Phone
1. In the terminal window, type `pair` and press Enter.
2. A QR code will appear on your screen.
3. Open your phone's camera and scan the QR code to copy the IP address (e.g., `192.168.1.5:8080`).
4. Open your mobile web browser, type `http://` followed by the pasted IP address (e.g., `http://192.168.1.5:8080`), and hit go.
5. **Optional:** Once the web app opens, you can tap your browser's menu and select **"Add to Home Screen"** to install it as a standalone app!

### Step 3: Transferring Files
- **From Phone to PC:** Tap the paperclip icon in the app, select any file, and it will instantly upload to the `receive` folder on your PC.
  - *Tip:* You can change where files are saved at any time by typing `setdir "D:\My Downloads"` in the PC terminal!
- **From PC to Phone:** In your PC's terminal window, type `send "C:\path\to\your\file.jpg"` and press Enter. It will appear on your phone instantly.

---

## Developer Build Instructions

If you are cloning this repository from scratch or modifying the frontend code, you must build the web app before running the server.

### Prerequisites
- [Go](https://golang.org/dl/) (1.20+)
- [Node.js](https://nodejs.org/en/download/) (v18+)

### 1. Build the Mobile App
```bash
cd apps/mobile
npm install
npm run build
```

### 2. Start the Server
```bash
cd apps/cli
go run .
```

---

## Development

If you wish to modify the mobile frontend and see real-time updates:
```bash
cd apps/mobile
npm run dev
```
Note: To test the app fully, the Go backend must be running, and you will need to point the Vite dev server to the Go WebSocket endpoint.

## License
MIT License
