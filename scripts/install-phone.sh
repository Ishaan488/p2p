#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APK_PATH="$SCRIPT_DIR/dist-apk/p2p-debug.apk"

if [ ! -f "$APK_PATH" ]; then
    echo "[!] $APK_PATH not found. Building first..."
    bash "$SCRIPT_DIR/scripts/build-apk.sh"
fi

echo "[*] Installing to connected Android device..."
adb install -r "$APK_PATH"
echo "[OK] Installed successfully."

