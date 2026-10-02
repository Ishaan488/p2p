# P2P System Architecture

## Overview
A local-first P2P communication system connecting an Android phone and a Windows laptop without requiring an internet connection.

## Components

1. **Android Client (Mobile)**
   - **Framework:** React PWA (TypeScript)
   - **Persistence:** IndexedDB
   - **Role:** Connects to the Windows discovery/communication server, provides the user interface for text and file exchange.

2. **Windows Client (Desktop/CLI)**
   - **Language:** Go
   - **Role:** Lightweight CLI server and client. Runs a local HTTP/WebSocket server to handle connections from the Android client on the local network.

3. **Application Protocol**
   - **Format:** JSON messages over WebSocket for text/control, Binary streaming for files/images.
   - **Transport Abstraction:** Separates the application logic from the underlying network transport (Wi-Fi, Bluetooth).

## Phase 1 Architecture (Wi-Fi Local Network)
```text
                         P2P SYSTEM
                             │
                ┌────────────┴────────────┐
                │                         │
             ANDROID                   WINDOWS
                │                         │
           React PWA                  CLI client
                │                         │
                └────────────┬────────────┘
                             │
                     Application Protocol
                             │
                     Transport Abstraction
                             │
                      Local Network
                             │
                ┌────────────┴────────────┐
                │                         │
             WebSocket              HTTP/Binary
                │                         │
           text/control             files/images
```
