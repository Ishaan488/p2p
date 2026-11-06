package main

import (
	"bytes"
	"encoding/xml"
	"fmt"
)

// macOS starts per-user background programs through launchd. A property list in
// ~/Library/LaunchAgents with RunAtLoad makes P2P Link start at login. (The XDG
// ~/.config/autostart entry used on Linux is ignored by macOS.)
//
// This file has no build tag so the plist generation can be unit-tested anywhere;
// the installer that uses it is in autostart_darwin.go.

const launchdLabel = "com.p2plink.agent"

func xmlEscape(s string) string {
	var b bytes.Buffer
	_ = xml.EscapeText(&b, []byte(s))
	return b.String()
}

// renderLaunchdPlist builds the agent definition. The server runs without a
// terminal (stdin is /dev/null under launchd), logging to logPath.
func renderLaunchdPlist(exePath, logPath string) string {
	return fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>%s</string>
	<key>ProgramArguments</key>
	<array>
		<string>%s</string>
		<string>--no-tray</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<false/>
	<key>StandardOutPath</key>
	<string>%s</string>
	<key>StandardErrorPath</key>
	<string>%s</string>
</dict>
</plist>
`, launchdLabel, xmlEscape(exePath), xmlEscape(logPath), xmlEscape(logPath))
}
