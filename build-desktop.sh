#!/usr/bin/env bash
set -euo pipefail

# P2P Link Desktop Standalone Builder (Linux, macOS, WSL)
echo "==================================================="
echo "  P2P Link Desktop Standalone Builder"
echo "==================================================="
echo ""

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# 1. Check for Go
if ! command -v go >/dev/null 2>&1; then
    echo "[ERROR] Go compiler not found in PATH. Please install Go from https://go.dev/dl/"
    exit 1
fi

# 2. Sync frontend web UI assets from apps/mobile/dist to apps/cli/dist
if [ -f "$SCRIPT_DIR/apps/mobile/dist/index.html" ]; then
    echo "[1/3] Syncing frontend web UI assets from apps/mobile/dist..."
    mkdir -p "$SCRIPT_DIR/apps/cli/dist"
    cp -r "$SCRIPT_DIR/apps/mobile/dist/"* "$SCRIPT_DIR/apps/cli/dist/"
    echo "      Frontend assets synced successfully."
else
    echo "[WARN] apps/mobile/dist not found. Building web assets with npm..."
    if command -v npm >/dev/null 2>&1; then
        npm --prefix "$SCRIPT_DIR/apps/mobile" run build
        mkdir -p "$SCRIPT_DIR/apps/cli/dist"
        cp -r "$SCRIPT_DIR/apps/mobile/dist/"* "$SCRIPT_DIR/apps/cli/dist/"
    else
        echo "[ERROR] npm not found. Please build frontend first."
        exit 1
    fi
fi

# 3. Detect Host OS & Architecture
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"

OUT_BIN="p2p"
if [ "$OS" = "windows" ] || [ "${OS#*mingw}" != "$OS" ] || [ "${OS#*cygwin}" != "$OS" ]; then
    OUT_BIN="p2p.exe"
fi

echo "[2/3] Compiling optimized standalone binary ($OUT_BIN) for $OS/$ARCH..."
cd "$SCRIPT_DIR/apps/cli"
go build -trimpath -ldflags="-s -w" -o "$SCRIPT_DIR/$OUT_BIN" .

# 4. Verify binary creation
if [ -f "$SCRIPT_DIR/$OUT_BIN" ]; then
    SIZE=$(wc -c < "$SCRIPT_DIR/$OUT_BIN" | tr -d ' ')
    echo "[3/3] Build complete: $SCRIPT_DIR/$OUT_BIN ($SIZE bytes)"
    echo ""
    echo "==================================================="
    echo "  SUCCESS: Standalone $OUT_BIN is ready"
    echo "==================================================="
else
    echo "[ERROR] Output file $SCRIPT_DIR/$OUT_BIN not found!"
    exit 1
fi

