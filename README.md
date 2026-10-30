# P2P Link (Pro)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Go Version](https://img.shields.io/badge/Go-1.21%2B-00ADD8?logo=go)](https://go.dev/)
[![React](https://img.shields.io/badge/React-18-61DAFB?logo=react)](https://react.dev/)
[![Capacitor](https://img.shields.io/badge/Capacitor-Android%208.5-119EFF?logo=capacitor)](https://capacitorjs.com/)
[![Zero Dependencies](https://img.shields.io/badge/Android%20Studio-Not%20Required-success)](#android-build--installation-no-android-studio-needed)

**P2P Link** is an ultra-fast, zero-RAM, peer-to-peer file transfer, real-time messaging, and clipboard synchronization system designed as an industry-grade alternative to AirDrop and Snapdrop for PC-to-Mobile communication.

It features a high-performance **Go host engine** on desktop with embedded frontend web assets, and an **OLED dark-mode React client** that operates both as an installable Progressive Web App (PWA) and as a native Android APK (built via Capacitor and Gradle CLI without Android Studio).

---

## Key Highlights & Architectural Features

### 1. Instant Desktop Launch (< 10ms)
- **Standalone Binary (`p2p.exe`)**: Compiled with Go's `//go:embed all:dist` and stripped symbols (`-ldflags="-s -w"`), resulting in a compact ~9 MB single executable.
- **Zero Startup Recompilation**: Replaces slow `go run .` multi-second compile times with instant (<10ms) execution.
- **Dynamic Port Stepping**: Defaults to port `8080`. If port 8080 is occupied by another service, it automatically steps through `8081`..`8090` without failing.
- **Zero-Delay Hotspot & Offline Startup**: Bypasses WAN DNS blocking with non-blocking interface inspection (`net.DialTimeout(..., 200ms)` and `net.InterfaceAddrs()`), ensuring instantaneous startup even when offline or connected to isolated phone hotspots.

### 2. Android Build Without Android Studio
- **100% CLI Toolchain**: Compiles and packages production Android APKs via Node.js / batch scripts calling the Gradle wrapper (`gradlew.bat`) directly with `JAVA_HOME` and `ANDROID_HOME` configuration.
- **One-Command APK Generation**: `scripts\build-apk.bat` (or `npm run android:build`) compiles Vite assets, runs `cap sync android`, and generates `dist-apk\p2p-debug.apk` in ~1-2 minutes.
- **One-Command Phone Deployment**: `scripts\install-phone.bat` (or `npm run android:install`) automatically detects connected Android devices via ADB, installs the APK, and launches the app on screen.

### 3. Industry-Grade Security & Protocol
- **End-to-End Encryption**: AES-256-GCM symmetric session keys derived via HKDF-SHA256 from ephemeral pairing codes.
- **Cryptographic Nonce & Sequence Tracking**: Bidirectional sequence counters (`c2s` / `s2c`) prevent message replay, reordering, and tampering.
- **Hardened Path Traversal Protection**: Multi-layered defense against directory escape attacks (`../../`), Windows reserved device names (`CON`, `PRN`, `AUX`, `NUL`, `COM1-9`, `LPT1-9`), illegal filesystem characters (`<>:"/\|?*`), and filename truncation limits.
- **Zero-RAM File Streaming**: Chunks (1 MB) are verified, decrypted, and written directly to disk via random-access offsets (`WriteAt`), keeping server and client memory footprints completely flat regardless of whether you transfer a 10 MB photo or a 60 GB 4K video.

### 4. Clean Desktop Terminal UX & Instant Fast Transfers
- **Structured Scannable Feed**: High-signal, noise-free terminal interface with precise `HH:MM` timestamps, clean status/directional badges (`● Online`, `↑ Sent`, `↓ Received`, `↓ File`, `↑ File`), and zero redundant system log spam.
- **In-Place Live Progress**: File uploads and downloads update dynamically in a single row without multi-line console flooding.
- **Fast Send Shorthand (`> <filepath>`) & Direct Path Drop**: Send any file, image, or video with `> "C:\file.mp4"`, `> "file.zip"`, or simply paste / drag-and-drop the file path directly into the prompt without typing `send`.
- **Silent Clipboard Sync & Deduplication**: Syncs PC clipboard quietly to connected devices in the background without interrupting prompt typing or echoing sync updates.
- **Offline Outbox & Auto-Delivery**: Content sent while devices are temporarily disconnected queues automatically in an outbox and delivers immediately upon reconnection.

### 5. Rich Media Previews & Modern UI/UX (Apple / Google Grade)
- **Non-Chat Transfer Workspace**: Structured dark workspace cards with sender direction pills, type indicators (`APK`, `Image`, `Video`, `Clipboard`, `Text`), timestamps, and 1-tap `Copy` and `Save` buttons.
- **Native Android Downloads Integration**: Custom `FileSaverPlugin` utilizing Android `MediaStore.Downloads` and system `DownloadManager` so files and media saved on phone appear instantly in the phone's native **Files / Downloads** app.
- **Redesigned Lightbox**: Floating bottom glass zoom dock (`-`, `100%`, `+`, `Reset`), mobile touch pan gestures, and persistent header `Save` button.
- **Inline Audio Player**: Embedded waveform player for `.mp3`, `.wav`, `.aac`, `.ogg`, `.flac`, `.opus` with seek scrubber, elapsed/total timers, and mute toggle.
- **Inline Video Player**: HTML5 video playback for `.mp4`, `.webm`, `.mov`.
- **Inline PDF Viewer**: Document badge with file size indicator, quick in-app modal reader, and external viewer support.
- **Code & Text Snippet Viewer**: Syntax-labeled code preview with line numbers and 1-click clipboard copy for source files (`.go`, `.ts`, `.tsx`, `.js`, `.py`, `.rs`, `.json`, `.md`, `.txt`, `.yaml`, etc.).
- **Batch Transfer HUD**: Real-time multi-file drag-and-drop queue with cumulative progress bar, EMA speed tracker, remaining ETA calculation, and "Pause All" / "Resume All" controls.
- **Synthesized Audio Chimes & Haptics**: Pleasant crystal two-tone chime synthesized dynamically via Web Audio API oscillators on transfer completion (zero external audio file dependencies), plus native Android haptic vibration.
- **Android Hardware Back-Button Support**: Managed modal stack ensures pressing the Android back button closes lightboxes, viewers, and the QR scanner without closing the app; double-tap at root exits safely.

---

## Quick Start (User Guide)

### Running on Desktop (PC)

Ensure your PC and phone are connected to the same Wi-Fi or phone hotspot.

1. **Launch the Server**:
   Double-click **`Start P2P.bat`** in the root directory.
   - If `p2p.exe` is not already compiled, it will automatically build it once, then launch instantly.
   - An ASCII banner, active port, and pairing QR code will appear in the terminal.

2. **Useful CLI Commands**:
   Type any of these commands directly into the PC terminal:
   - `> <filepath>` or paste path: Sends a file from PC to connected devices (e.g. `> "C:\Photos\vacation.jpg"` or drag & drop directly).
   - `open` or `ui` : Opens the Web UI in your default desktop browser.
   - `status` or `info` : Displays real-time server uptime, active port, memory allocation, paired devices, and active transfers.
   - `pair` : Displays a fresh QR code for pairing a new device.
   - `devices` : Lists all paired devices and their online/offline status.
   - `unpair <device>` : Unpairs a device by name or ID.
   - `send <filepath>` : Traditional syntax for sending files.
   - `setdir <path>` : Changes the directory where received files are saved (default: `~/P2P/received`).
   - `clear` or `cls` : Clears the terminal screen.
   - `exit` : Gracefully shuts down the server.

---

### Connecting on Phone

1. **Via Mobile Browser (PWA)**:
   - Open your mobile browser and navigate to the address shown in your PC terminal (e.g. `http://192.168.1.5:8080`).
   - Tap **"Scan QR to Pair"** and scan the QR code in your PC terminal.
   - *Optional:* Tap your browser menu and choose **"Add to Home Screen"** to install it as an app.

2. **Via Native Android App (APK)**:
   - Build and install the APK using the CLI toolchain (instructions below).
   - Open the app, grant Camera permission when prompted, and scan the PC terminal QR code.
   - The phone pairs permanently; subsequent launches auto-connect in under 1 second.

---

## Android Build & Installation (No Android Studio Needed)

You do **not** need Android Studio installed. The project uses standard Android SDK command-line tools and the Gradle wrapper.

### Prerequisites (Already set up on your machine)
- Java JDK 22 (`C:\Program Files\Java\jdk-22`)
- Android SDK (`E:\Android\Sdk`)

### 1. Build the Android APK
From the root directory, simply run:
```cmd
scripts\build-apk.bat
```
*(Or from `apps/mobile`: `npm run android:build`)*

This script automatically:
1. Builds the latest React web assets (`npm run build`).
2. Syncs web assets to the native Android Capacitor project (`cap sync android`).
3. Runs the Gradle wrapper (`gradlew.bat assembleDebug`).
4. Outputs the finished APK to:
   ```
   dist-apk\p2p-debug.apk
   ```

### 2. Install & Launch on Your Phone
1. Connect your Android phone to your PC via USB with **USB Debugging** enabled in Developer Options (or connect over Wi-Fi via `adb connect <phone-ip>:<port>`).
2. Run:
```cmd
scripts\install-phone.bat
```
*(Or from `apps/mobile`: `npm run android:install`)*

The script checks for connected devices via ADB, installs `dist-apk\p2p-debug.apk`, and immediately starts the app on your phone.

---

## Desktop Standalone Binary Build

To re-compile the standalone `p2p.exe` binary after making code or UI modifications:

```cmd
build-desktop.bat
```

This compiles `apps/cli` with embedded assets into `e:\personal\p2p\p2p.exe`.

---

## Verification & Automated Test Suite

The Go backend includes a comprehensive test suite covering security, protocol compliance, concurrency, and filesystem protections:

To run tests:
```bash
cd apps/cli
go test -v ./...
```

**Tested Scenarios (20 passing tests):**
- Zero-byte file transfers (upload and download)
- Chunk encryption validation and tampering detection
- Out-of-order chunk writing and offset accuracy
- Resumable upload chunk range reporting
- Clean temp file cleanup on cancel/timeout
- Path traversal defanging (`../../`, hidden traversal, directory separation)
- Windows reserved device name defanging (`CON`, `PRN`, `AUX`, `NUL`, `COM1-9`, `LPT1-9`)
- Automatic collision resolution for duplicate filenames (`file (1).ext`)
- Concurrent collision resolution under high load
- Dynamic port allocation stepping
- Thread-safe client connection management and broadcast pumps
- Embedded web frontend and asset serving

---

## Directory Structure

```
p2p/
├── p2p.exe                     # Standalone compiled desktop host binary (~9 MB)
├── Start P2P.bat               # One-click desktop launcher (instant launch)
├── build-desktop.bat           # Standalone desktop binary compiler
├── dist-apk/
│   └── p2p-debug.apk           # Compiled native Android APK (~4.3 MB)
├── scripts/
│   ├── build-apk.bat           # Automated Android APK build script (CLI)
│   ├── build-apk.js            # Node.js APK build runner
│   └── install-phone.bat       # ADB install and launch script
├── apps/
│   ├── cli/                    # Go backend host server
│   │   ├── main.go             # Server initialization, CLI repl, web server
│   │   ├── file_transfer.go    # Streaming, chunking, sanitization, disk I/O
│   │   ├── auth.go             # AES-256-GCM / HMAC crypto session manager
│   │   ├── state.go            # Paired device state persistence
│   │   ├── dist/               # Embedded web assets (synced from mobile)
│   │   ├── protocol_test.go    # Protocol unit tests
│   │   ├── security_test.go    # Security and path traversal tests
│   │   └── server_test.go      # Dynamic port and concurrency tests
│   └── mobile/                 # React 18 + TypeScript + Vite + Capacitor
│       ├── src/
│       │   ├── App.tsx         # Main chat, batch HUD, modal and transfer UI
│       │   ├── index.css       # Dark OLED styles and shimmer animations
│       │   ├── components/     # Lightbox, Audio, Video, PDF, Code, Batch HUD
│       │   └── lib/            # Crypto, telemetry, backButton, audio, transport
│       └── android/            # Capacitor native Android Gradle wrapper
└── README.md
```

---

## License

MIT License. Designed and crafted for high-performance peer-to-peer productivity.
