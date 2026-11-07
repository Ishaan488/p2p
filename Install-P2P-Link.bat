@echo off
setlocal
title P2P Link Setup
cd /d "%~dp0"

echo.
echo   P2P Link — Windows Setup
echo   ----------------------------------------
echo.

:: 1. Ensure p2p.exe exists
if not exist "%~dp0p2p.exe" (
    echo   [1/4] Building p2p.exe...
    cd /d "%~dp0apps\cli"
    go build -o "%~dp0p2p.exe" .
    if errorlevel 1 (
        echo   [Error] Could not build p2p.exe.
        pause
        exit /b 1
    )
    cd /d "%~dp0"
) else (
    echo   [1/4] Found p2p.exe
)

:: 2. Configure Windows Firewall rules (TCP 8080-8090, UDP 8089 & 5353)
echo   [2/4] Allowing local Wi-Fi transfers through Windows Firewall...
net session >nul 2>&1
if %errorlevel% == 0 (
    netsh advfirewall firewall delete rule name="P2P Link Server" >nul 2>&1
    netsh advfirewall firewall delete rule name="P2P Link Discovery" >nul 2>&1
    netsh advfirewall firewall add rule name="P2P Link Server" dir=in action=allow protocol=TCP localport=8080-8090 profile=any >nul
    netsh advfirewall firewall add rule name="P2P Link Discovery" dir=in action=allow protocol=UDP localport=8089,5353 profile=any >nul
) else (
    powershell -NoProfile -Command "Start-Process cmd -ArgumentList '/c netsh advfirewall firewall delete rule name=\"P2P Link Server\" >nul 2>&1 & netsh advfirewall firewall delete rule name=\"P2P Link Discovery\" >nul 2>&1 & netsh advfirewall firewall add rule name=\"P2P Link Server\" dir=in action=allow protocol=TCP localport=8080-8090 profile=any & netsh advfirewall firewall add rule name=\"P2P Link Discovery\" dir=in action=allow protocol=UDP localport=8089,5353 profile=any' -Verb RunAs -WindowStyle Hidden -Wait"
)

:: 3. Register Windows Explorer Right-Click Menu ("Send via P2P Link")
echo   [3/4] Adding "Send via P2P Link" to Windows Explorer right-click menu...
"%~dp0p2p.exe" --install-context-menu

:: 4. Create Desktop Shortcut ("P2P Link")
echo   [4/4] Creating Desktop shortcut...
powershell -NoProfile -Command "$ws = New-Object -ComObject WScript.Shell; $s = $ws.CreateShortcut([Environment]::GetFolderPath('Desktop') + '\P2P Link.lnk'); $s.TargetPath = '%~dp0p2p.exe'; $s.WorkingDirectory = '%~dp0'; $s.Description = 'P2P Link - Direct Phone and PC File Transfer'; $s.Save()"

echo.
echo   Setup complete. Launching P2P Link...
start "" "%~dp0p2p.exe"
timeout /t 2 >nul
