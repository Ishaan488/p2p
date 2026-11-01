@echo off
title P2P Link Server
cd /d "%~dp0"

rem Windows Firewall blocks incoming connections on "Public" networks (campus, cafe,
rem hotel Wi-Fi). Check if the firewall rule for port range 8080-8090 or 8080 exists.
netsh advfirewall firewall show rule name="P2P Link (TCP 8080-8090)" >nul 2>&1
if not errorlevel 1 goto start
netsh advfirewall firewall show rule name="P2P Link (TCP 8080)" >nul 2>&1
if not errorlevel 1 goto start

echo Allowing P2P Link through Windows Firewall (one time).
echo Click "Yes" on the administrator prompt.
powershell -NoProfile -Command "Start-Process netsh -Verb RunAs -Wait -ArgumentList 'advfirewall firewall add rule name=\"P2P Link (TCP 8080-8090)\" dir=in action=allow protocol=TCP localport=8080-8090 profile=any'"
netsh advfirewall firewall show rule name="P2P Link (TCP 8080-8090)" >nul 2>&1
if errorlevel 1 (
    echo.
    echo Could not add the firewall rule - other devices may not be able to connect.
    echo.
) else (
    echo Firewall rule added.
)

:start
rem If p2p.exe does not exist or Go files are newer, rebuild it
set NEED_BUILD=0
if not exist "%~dp0p2p.exe" set NEED_BUILD=1
if %NEED_BUILD%==0 (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "$exe = Get-Item '%~dp0p2p.exe'; $newest = Get-ChildItem '%~dp0apps\cli\*.go' | Sort-Object LastWriteTime -Descending | Select-Object -First 1; if ($newest -and $newest.LastWriteTime -gt $exe.LastWriteTime) { exit 1 } else { exit 0 }" >nul 2>&1
    if errorlevel 1 (
        echo [INFO] Go source files updated. Rebuilding p2p.exe...
        set NEED_BUILD=1
    )
)
if %NEED_BUILD%==1 (
    echo [INFO] Building desktop binary p2p.exe...
    call "%~dp0build-desktop.bat"
    if errorlevel 1 (
        echo.
        echo [ERROR] Build failed. Please ensure Go is installed.
        pause
        exit /b 1
    )
)

rem Launch the pre-compiled binary instantly (<10ms)
"%~dp0p2p.exe" %*
if errorlevel 1 (
    echo.
    echo The server stopped with an error.
    pause
)
