# P2P Link

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Go Version](https://img.shields.io/badge/Go-1.21%2B-00ADD8?logo=go)](https://go.dev/)
[![React](https://img.shields.io/badge/React-18-61DAFB?logo=react)](https://react.dev/)
[![Capacitor](https://img.shields.io/badge/Capacitor-Android%208.5-119EFF?logo=capacitor)](https://capacitorjs.com/)
[![Platforms](https://img.shields.io/badge/Platforms-Windows%20%7C%20macOS%20%7C%20Linux%20%7C%20Android-green)](#cross-platform-support)
[![Zero Dependencies](https://img.shields.io/badge/Android%20Studio-Not%20Required-success)](#android-build--installation-no-android-studio-needed)

**P2P Link** is an ultra-fast, encrypted, local peer-to-peer file transfer, real-time messaging, and clipboard synchronization platform designed as an enterprise-grade alternative to Apple AirDrop, Snapdrop, and Quick Share for PC-to-Mobile communication.

It couples a high-throughput **Go host engine** on desktop with embedded frontend web assets and an **OLED dark-mode React client** that functions both as an installable Progressive Web App (PWA) and as a native Android app (compiled via Capacitor and Gradle CLI without Android Studio).

---

## 🚀 Key Feature Matrix

| Phase | Milestone | Capabilities Delivered |
| :--- | :--- | :--- |
| **Phase 1** | **Core Reliability** | Auto-resume on Wi-Fi drop/reconnect • Android Foreground Service (transfers continue screen-off) • Android Share Target ("Share → P2P Link") • Transfer approval/rejection • Device trust whitelist • Persistent transfer history |
| **Phase 2** | **Security Hardening** | Ephemeral pairing codes with rate-limiting & lockout • Anti-replay nonces & sequence counter validation • Pinned TLS (HTTPS/WSS) • Two-way remote unpair (`/unpair`) • Continuous Go fuzz testing on protocol parsers |
| **Phase 3** | **Usability & Frictionless UX** | mDNS ZeroConf auto-discovery (`_p2plink._tcp`) • UDP LAN broadcast fallback (`:8089`) • Safe ZIP folder streaming with Zip Slip protection • Cross-platform clipboard sync (Windows/macOS/Linux) • Full `Makefile` and POSIX shell tooling |
| **Phase 4** | **Scale & Performance** | Multi-device concurrent routing (`--to <device>`) • Per-device isolated outboxes • Pre-flight SHA-256 deduplication (0 bytes sent for duplicates) • Parallel worker chunk streaming • Flat $\mathcal{O}(1)$ memory footprint for 60GB+ files • Built-in `pprof` profiling diagnostics |

---

## ⚡ Architecture & Highlights

### 1. Instant Desktop Launch (< 10ms) & Cross-Platform Engine
* **Single Standalone Executable**: Compiled with Go's `//go:embed all:dist` and stripped debug symbols (`-ldflags="-s -w"`), packaging the entire server and UI into a single self-contained ~15 MB executable (`p2p.exe` on Windows or `p2p` on macOS/Linux).
* **Cross-Platform Toolchain**: Fully buildable on Windows, Linux, and macOS via `Makefile` or shell scripts without depending on Windows `.bat` files.
* **Dynamic Port Allocation**: Defaults to `8080` and automatically claims adjacent ports (`8081`–`8090`) if busy.
* **Non-Blocking Network Initialization**: Rapid 200ms interface inspection eliminates WAN DNS delays when offline or running on phone hotspots.

### 2. Multi-Device Targeting & Isolated Outboxes
* **Concurrent Multi-Peer Support**: One PC can connect to multiple phones and tablets concurrently.
* **Per-Device Routing**: Target transfers directly to specific devices with `--to <name|id>` (e.g. `send movie.mp4 --to Pixel`).
* **Device-Isolated Outboxes**: An offline phone never stalls or delays transfers intended for other devices; targeted messages remain queued in the offline peer's bucket and flush automatically upon reconnection.

### 3. Pre-Flight Content Deduplication (0-Byte Transmit)
* Before streaming chunk payloads, the client computes an incremental SHA-256 hash using `@noble/hashes` without loading the full file into memory.
* The desktop checks the local hash index (`/upload_check_hash`). If the file already exists on the destination, chunk transmission is bypassed entirely, completing instantly (100%) and recording in transfer history as `Deduplicated (Skipped)`.

### 4. Line-Rate Parallel Streams with Flat $\mathcal{O}(1)$ Memory
* Uploads and downloads stream across parallel workers (4–8 concurrent chunks).
* Direct random-access disk writes (`os.File.WriteAt`) with read-write mutexes ensure that out-of-order chunks assemble seamlessly.
* Server and client memory overhead remains strictly flat ($< 15\text{ MB}$) regardless of whether the file is 5 MB or 60 GB+.

### 5. Zero-Configuration Auto-Discovery
* **Dual-Channel Discovery**: Uses standard mDNS (`_p2plink._tcp.local`) for instant local peer discovery, backed by a UDP broadcast probe (`:8089`) for networks where multicast is restricted.
* **Intelligent Network Fallback**: Clearly identifies campus / enterprise Wi-Fi AP Client Isolation and guides users to 1-tap QR pairing or manual IP entry.

### 6. Android Build Without Android Studio
* **100% CLI Toolchain**: Compiles and packages production Android APKs via standard Node.js and Gradle wrapper commands (`gradlew assembleDebug`).
* **One-Command Build & Install**: Run `scripts\build-apk.bat` (or `make apk`) followed by `scripts\install-phone.bat` (or `make install`) to compile and push directly to connected phones via ADB.

### 7. Industry-Grade Security
* **AES-256-GCM Encryption**: Every chunk, JSON payload, and WebSocket frame is sealed with authenticated encryption derived via HKDF-SHA256.
* **Anti-Replay Nonce Tracking**: One-off cryptographic nonces and frame sequence counters prevent reordering, replay attacks, and man-in-the-middle tampering.
* **Brute-Force Lockout**: Pairing endpoints strictly enforce rate limits and lockout policies after 5 failed attempts.
* **Filesystem Defenses**: Sanitization strips directory traversal sequences (`../../`), defangs Windows reserved device names (`CON`, `PRN`, `AUX`, `NUL`, `COM1-9`, `LPT1-9`), and enforces path containment.

---

## 🖥️ Desktop CLI User Guide

### Starting the Server

```bash
# Windows (One-Click)
Start P2P.bat

# Windows / Linux / macOS (Executable)
./p2p.exe        # Windows
./p2p            # Linux / macOS

# With optional pprof profiler enabled (127.0.0.1:6060)
./p2p.exe -pprof
```

### CLI Commands Reference

Type commands directly into the interactive `p2p>` prompt:

| Command | Action | Example |
| :--- | :--- | :--- |
| `send <path>` | Send file or directory to all connected devices | `send "C:\Movies\clip.mp4"` |
| `send <path> --to <peer>` | Send file or directory to a specific device | `send "report.pdf" --to Pixel` |
| `> <path> [--to <peer>]` | Shorthand for fast file sending | `> "photo.jpg" --to "iPhone 15"` |
| `msg <text> [--to <peer>]` | Send text message to all or specific device | `msg "Meeting Link" --to Pixel` |
| `<drag-and-drop path>` | Paste or drop any file path into terminal | `"D:\Backups\archive.zip"` |
| `devices` | List paired devices, online state, and IP | `devices` |
| `trust <device>` | Auto-accept file transfers without terminal prompt | `trust "Pixel 7"` |
| `untrust <device>` | Require interactive terminal approval per transfer | `untrust "Pixel 7"` |
| `unpair <device>` | Revoke and unpair a device | `unpair "Pixel 7"` |
| `history` | Display recent transfer history | `history` |
| `status` or `info` | Display uptime, RAM usage, goroutines, active transfers | `status` |
| `setdir <path>` | Change folder where received files are saved | `setdir "D:\Downloads"` |
| `pair` | Display QR code and manual IP for mobile pairing | `pair` |
| `open` or `ui` | Open the desktop web workspace in default browser | `open` |
| `clear` or `cls` | Clear terminal screen | `clear` |
| `exit` | Gracefully shut down the server | `exit` |

---

## 📱 Mobile App Guide (Android & PWA)

### Option 1: Native Android App (Recommended)
1. Build the APK without Android Studio:
   ```cmd
   scripts\build-apk.bat
   ```
   *(Or on Linux/macOS: `./scripts/build-apk.sh` or `make apk`)*
2. Install to connected phone via ADB:
   ```cmd
   scripts\install-phone.bat
   ```
   *(Or on Linux/macOS: `./scripts/install-phone.sh` or `make install`)*
3. Open **P2P Link** on your phone, tap **"Scan QR Code"**, and point the camera at your desktop terminal.
4. **Android Share Target**: Select photos, documents, or text in any Android app, tap **Share**, and choose **P2P Link** to transmit directly to your PC.
5. **Background Transfers**: Transfers continue seamlessly with the screen off via the Android Foreground Service.

### Option 2: Browser Progressive Web App (PWA)
1. Open Chrome, Safari, or Firefox on your phone and navigate to the PC IP shown in the terminal (e.g. `http://192.168.1.15:8080`).
2. Scan the terminal pairing QR code or enter the pairing code.
3. Tap **"Add to Home Screen"** to install as a standalone OLED web app.

---

## 🌐 Network Topology & Troubleshooting

### Campus, College & Enterprise Wi-Fi (AP Client Isolation)
Most university and public Wi-Fi networks enable **AP (Client) Isolation**, which intentionally drops broadcast/multicast packets (blocking mDNS and auto-discovery) and prevents devices on the same Wi-Fi from communicating directly.

* **Fix 1 (Direct Pairing)**: Tap **"Scan QR Code"** in the mobile app to connect via the exact IP and token, bypassing discovery.
* **Fix 2 (Manual IP)**: Enter the PC LAN IP displayed in the terminal (e.g. `10.x.x.x:8080`) instead of `localhost:8080`.
* **Fix 3 (Phone Hotspot)**: Turn on your phone's Wi-Fi hotspot and connect your PC to it. Mobile hotspots do not enforce AP isolation, enabling full wire-speed transfers (up to 80–120 MB/s).

### Firewall Configuration (Windows)
If Windows Firewall blocks inbound local traffic:
* Run `Start P2P.bat` as Administrator once, or execute:
  ```powershell
  New-NetFirewallRule -DisplayName "P2P Link" -Direction Inbound -LocalPort 8080-8090 -Protocol TCP -Action Allow
  ```

---

## 🛠️ Developer & Build Toolchain

### Cross-Platform Make Targets
```bash
make desktop       # Builds standalone desktop binary (p2p)
make apk           # Builds production Android APK (dist-apk/p2p-debug.apk)
make install       # Installs APK to connected Android phone via ADB
make test          # Runs complete automated unit, scale, and security test suite
make clean         # Cleans build artifacts and temp files
```

### Windows Batch Scripts
* `Start P2P.bat` — One-click launcher (auto-compiles if needed and boots in <10ms).
* `build-desktop.bat` — Compiles standalone `p2p.exe` with embedded assets.
* `scripts\build-apk.bat` — Compiles the Android APK via Gradle wrapper.
* `scripts\install-phone.bat` — Pushes APK to phone via ADB.

---

## 🧪 Comprehensive Verification & Test Suite

The test suite covers protocol compliance, multi-device routing, cryptographic security, file sanitization, and scale limits:

```bash
cd apps/cli
go test -v ./...
```

### Tested Scenarios
* **Multi-Device Targeted Routing** (`TestPhase4_MultiDeviceTargeting`): Verifies messages and transfers route exclusively to the targeted device without leaking to peers.
* **Device-Isolated Outboxes** (`TestPhase4_DeviceIsolatedOutbox`): Verifies offline devices do not block others and properly dequeue messages on reconnect.
* **Pre-Flight Deduplication** (`TestPhase4_ContentDeduplication`): Verifies pre-flight hash verification skips chunk transmission for identical files.
* **Out-of-Order Parallel Chunk Assembly** (`TestPhase4_ParallelOutOfOrderChunks`): Verifies concurrent random-offset chunk writes assemble into bit-exact files.
* **Flat $\mathcal{O}(1)$ Memory Footprint** (`TestPhase4_FlatMemoryScaling`): Verifies streaming multi-chunk files keeps heap memory flat without buffering.
* **100+ Concurrent Transfer Stress Test** (`TestPhase4_100SimultaneousTransfers`): Verifies 100 simultaneous transfers complete with zero deadlocks or race conditions.
* **Pprof Diagnostic Endpoint** (`TestPhase4_PprofEndpoint`): Verifies runtime heap and goroutine profilers are available.
* **Fuzz Testing**: Continuous fuzzing on filename sanitization (`FuzzSanitizeFilename`), pairing code normalization (`FuzzNormalizePairCode`), chunk AAD binding (`FuzzChunkAAD`), and request HMAC signatures (`FuzzRequestSignature`).
* **Security & Path Traversal**: Verified defenses against directory escape (`../../`), Zip Slip, Windows reserved names, and unauthenticated endpoint hits.

---

## 📂 Project Structure

```
p2p/
├── p2p.exe                          # Standalone desktop host binary (~15 MB)
├── Start P2P.bat                    # Instant desktop launcher
├── build-desktop.bat / .sh          # Desktop standalone binary compiler
├── Makefile                         # Cross-platform build automation
├── dist-apk/
│   └── p2p-debug.apk                # Production native Android APK (~4.3 MB)
├── scripts/
│   ├── build-apk.bat / .sh          # Android APK build script (CLI, No Studio)
│   ├── build-apk.js                 # Node.js APK build runner
│   └── install-phone.bat / .sh      # ADB deployment script
├── apps/
│   ├── cli/                         # High-performance Go host backend
│   │   ├── main.go                  # Server bootstrap, interactive REPL, routing
│   │   ├── auth.go                  # AES-256-GCM / HMAC session manager
│   │   ├── dedup.go                 # Pre-flight SHA-256 content deduplication
│   │   ├── file_transfer.go         # Zero-RAM chunk streaming & WriteAt I/O
│   │   ├── folder_transfer.go       # ZIP folder packaging with Zip Slip defenses
│   │   ├── discovery.go             # mDNS ZeroConf & UDP LAN broadcast
│   │   ├── clipboard_image_*.go     # Multi-OS image clipboard sync (Win/Mac/Linux)
│   │   ├── protocol.go              # Shared wire protocol & message structs
│   │   ├── state.go                 # Device pairing persistence
│   │   ├── dist/                    # Embedded web assets (synced from mobile)
│   │   ├── phase3_test.go           # Usability & folder transfer tests
│   │   ├── phase4_test.go           # Multi-device, dedup, and scale tests
│   │   └── security_phase2_test.go  # Security, rate-limit, and fuzz tests
│   └── mobile/                      # React 18 + TypeScript + Vite + Capacitor
│       ├── src/
│       │   ├── App.tsx              # OLED workspace, transfer HUD, modal manager
│       │   ├── components/          # Lightbox, Audio, Video, PDF, Code, Batch HUD
│       │   └── lib/                 # Crypto, uploads, downloads, telemetry, discovery
│       └── android/                 # Native Android Gradle wrapper project
└── README.md
```

---

## 📄 License

Distributed under the [MIT License](LICENSE).
