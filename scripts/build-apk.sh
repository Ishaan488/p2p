#!/usr/bin/env bash
set -euo pipefail

# P2P Mobile - Android CLI Build for Linux & macOS (No Android Studio)
echo "==================================================="
echo "  P2P Mobile - Android CLI Build (POSIX)"
echo "==================================================="
echo ""

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$SCRIPT_DIR"

if [ -z "${ANDROID_HOME:-}" ]; then
    if [ -d "$HOME/Library/Android/sdk" ]; then
        export ANDROID_HOME="$HOME/Library/Android/sdk"
    elif [ -d "$HOME/Android/Sdk" ]; then
        export ANDROID_HOME="$HOME/Android/Sdk"
    fi
fi

echo "[*] ANDROID_HOME : ${ANDROID_HOME:-not set}"
echo "[*] Project Root : $SCRIPT_DIR"
echo ""

# 1. Build Web Assets
echo "[1/3] Building Web Assets (Vite + React)..."
npm --prefix apps/mobile run build

# 2. Capacitor Sync
echo "[2/3] Syncing Web Assets with Capacitor..."
npx --prefix apps/mobile cap sync android

# 3. Assemble APK
echo "[3/3] Compiling Android APK with Gradle..."
cd apps/mobile/android
chmod +x ./gradlew
./gradlew assembleDebug

mkdir -p "$SCRIPT_DIR/dist-apk"
cp app/build/outputs/apk/debug/app-debug.apk "$SCRIPT_DIR/dist-apk/p2p-debug.apk"

echo ""
echo "==================================================="
echo "  BUILD SUCCESSFUL"
echo "  APK Output: $SCRIPT_DIR/dist-apk/p2p-debug.apk"
echo "==================================================="

