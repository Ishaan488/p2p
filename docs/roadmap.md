# Product & Engineering Roadmap

This document outlines the architectural roadmap, completed milestones, and upcoming capabilities for P2P Link.

---

## 1. Completed Core Milestones (v1.0 – v2.2)

- [x] **Zero-Trust Encrypted Transfer**: AES-256-GCM / ChaCha20-Poly1305 AEAD authenticated chunk encryption with context-bound AAD.
- [x] **Crash-Consistent Chunk Recovery**: Generation-based manifest recovery, cryptographic per-chunk digest validation, and atomic finalization.
- [x] **Cross-Platform Clipboard Synchronization**: Instant bidirectional text and image clipboard sync over encrypted WebSockets.
- [x] **Local Auto-Discovery**: Zero-configuration discovery using mDNS (`_p2p-link._tcp`) and UDP broadcast failover.
- [x] **Interactive Permission & Trust System**: Desktop and mobile permission prompts for unknown devices with persistent device trust.
- [x] **Folder Streaming & Tar Pipeline**: In-memory streaming directory packaging and extraction with ZipSlip traversal defense.
- [x] **Modern Utility Mobile UI**: Obsidian + Soft Lavender theme, status indicators, and clean device sheet navigation.

---

## 2. Upcoming Features & Milestones

### 2.1 Remote File Explorer (Read-Only / Sandboxed)
- Expose a user-designated directory on the PC (e.g., `Shared/`) to the mobile app over the authenticated session.
- Allow remote browsing, selective file download, and direct mobile upload without manual desktop staging.
- Enforce strict read-only / write-only sandboxing to prevent desktop filesystem modification.

### 2.2 Wi-Fi Direct / Local Hotspot Mode
- Support direct device-to-device file transfers when no local Wi-Fi router or access point is available.
- Enable Android Wi-Fi Aware (NAN) and SoftAP hotspot creation directly from the app.

### 2.3 WebCrypto Performance Pipeline
- Optimize Capacitor Android chunk processing using streaming `ReadableStream` pipelines and WebWorker offloading for crypto decryption.
- Reduce Chromium WebView memory pressure during multi-gigabyte background transfers.

### 2.4 End-to-End Relay (Optional Global Tunneling)
- Integrate optional self-hosted relay or lightweight tunnel (e.g., Tailscale / Cloudflare tunnel integration) for out-of-LAN transfers.
- Retain end-to-end client encryption: relay server acts strictly as an untrusted ciphertext forwarder.
