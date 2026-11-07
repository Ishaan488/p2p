@echo off
title P2P Link
cd /d "%~dp0"

:: Request Administrator privileges to configure Firewall (only needed first time)
net session >nul 2>&1
if %errorlevel% == 0 (
    netsh advfirewall firewall show rule name="P2P Link Server" >nul 2>&1
    if errorlevel 1 (
        echo Configuring Windows Firewall for P2P Link...
        netsh advfirewall firewall add rule name="P2P Link Server" dir=in action=allow protocol=TCP localport=8080-8090 profile=any >nul
        netsh advfirewall firewall add rule name="P2P Link Discovery" dir=in action=allow protocol=UDP localport=8089,5353 profile=any >nul
    )
) else (
    netsh advfirewall firewall show rule name="P2P Link Server" >nul 2>&1
    if errorlevel 1 (
        echo Requesting Administrator permission to allow P2P Link through Windows Firewall...
        powershell -Command "Start-Process cmd -ArgumentList '/c netsh advfirewall firewall add rule name=\"P2P Link Server\" dir=in action=allow protocol=TCP localport=8080-8090 profile=any & netsh advfirewall firewall add rule name=\"P2P Link Discovery\" dir=in action=allow protocol=UDP localport=8089,5353 profile=any' -Verb RunAs -WindowStyle Hidden"
    )
)

:: Check if p2p.exe exists; if not, build it
if not exist "%~dp0p2p.exe" (
    echo Building P2P Link...
    cd apps\cli
    go build -o "%~dp0p2p.exe" .
    cd /d "%~dp0"
)

:: Launch P2P Link (shows QR in terminal and system tray icon)
start "" "%~dp0p2p.exe"
