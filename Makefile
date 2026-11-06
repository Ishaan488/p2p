.PHONY: all build cross web test vet fmt fmt-check check apk clean

# Default: build for the current host OS
all: build

# Build the web UI (embedded into the desktop binary)
web:
	npm --prefix apps/mobile run build

# Copy the built web UI next to the Go sources so `go:embed` can pick it up
define SYNC_WEB
	@node -e "const fs = require('fs'); fs.mkdirSync('apps/cli/dist', { recursive: true }); if (fs.existsSync('apps/mobile/dist')) fs.cpSync('apps/mobile/dist', 'apps/cli/dist', { recursive: true });"
endef

# Build desktop binary for current host platform
build:
	@echo "==> Building desktop binary..."
	$(SYNC_WEB)
	cd apps/cli && go build -trimpath -ldflags="-s -w" -o ../../p2p .
	@echo "==> Done: p2p"

# Cross-compile standalone binaries for Windows, Linux, and macOS (Intel & Apple Silicon)
cross:
	@echo "==> Cross-compiling standalone binaries..."
	$(SYNC_WEB)
	@node -e "require('fs').mkdirSync('dist-bin', { recursive: true });"
	cd apps/cli && GOOS=windows GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o ../../dist-bin/p2p-windows-amd64.exe .
	cd apps/cli && GOOS=windows GOARCH=arm64 go build -trimpath -ldflags="-s -w" -o ../../dist-bin/p2p-windows-arm64.exe .
	cd apps/cli && GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o ../../dist-bin/p2p-linux-amd64 .
	cd apps/cli && GOOS=linux GOARCH=arm64 go build -trimpath -ldflags="-s -w" -o ../../dist-bin/p2p-linux-arm64 .
	cd apps/cli && GOOS=darwin GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o ../../dist-bin/p2p-darwin-amd64 .
	cd apps/cli && GOOS=darwin GOARCH=arm64 go build -trimpath -ldflags="-s -w" -o ../../dist-bin/p2p-darwin-arm64 .
	@echo "==> Cross compilation complete! Binaries created in dist-bin/"

# Run all Go test suites: unit, fuzz, integration, and security
test:
	@echo "==> Running Go test suites..."
	cd apps/cli && go test ./...

vet:
	cd apps/cli && go vet ./...

fmt:
	cd apps/cli && gofmt -w .

# Fails if any Go file is not gofmt-clean
fmt-check:
	@cd apps/cli && out="$$(gofmt -l .)"; if [ -n "$$out" ]; then echo "gofmt needed:"; echo "$$out"; exit 1; fi

# Everything that should pass before a release
check: fmt-check vet test
	npm --prefix apps/mobile exec -- tsc --noEmit
	npm --prefix apps/mobile test

# Assemble Android APK without Android Studio
apk:
	@echo "==> Building Android APK..."
	npm --prefix apps/mobile run build
	npx --prefix apps/mobile cap sync android
	cd apps/mobile/android && ./gradlew assembleDebug

clean:
	rm -rf dist-bin dist-apk p2p p2p.exe apps/cli/dist apps/mobile/dist
