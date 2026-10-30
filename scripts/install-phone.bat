@echo off
setlocal enabledelayedexpansion

echo ===================================================
echo   P2P Mobile - Install and Launch on Phone
echo ===================================================
echo.

:: 1. Define paths
set "SCRIPT_DIR=%~dp0"
for %%I in ("%SCRIPT_DIR%..") do set "ROOT_DIR=%%~fI"
set "DIST_DIR=%ROOT_DIR%\dist-apk"
set "APK_PATH=%DIST_DIR%\p2p-debug.apk"
set "APP_PACKAGE=com.example.app"
set "APP_ACTIVITY=com.example.app/.MainActivity"

if not defined ANDROID_HOME (
    set "ANDROID_HOME=E:\Android\Sdk"
)
set "ADB=%ANDROID_HOME%\platform-tools\adb.exe"

:: 2. Check adb executable
if not exist "%ADB%" (
    echo [ERROR] ADB executable not found at:
    echo   "%ADB%"
    echo Please ensure Android SDK platform-tools is installed.
    exit /b 1
)

:: 3. Check if APK exists; if not, build it
if not exist "%APK_PATH%" (
    echo [WARNING] Built APK not found at "%APK_PATH%".
    echo Starting build now...
    echo.
    call "%SCRIPT_DIR%build-apk.bat"
    if errorlevel 1 (
        echo [ERROR] Build failed. Please fix build issues and retry.
        exit /b 1
    )
)

:: 4. Check connected ADB devices
echo [*] Checking connected Android devices via ADB...
"%ADB%" start-server >nul 2>&1

set "DEVICE_COUNT=0"
set "CONNECTED_SERIAL="

for /f "usebackq skip=1 tokens=1,2" %%A in (`"%ADB%" devices`) do (
    if "%%B"=="device" (
        set /a DEVICE_COUNT+=1
        set "CONNECTED_SERIAL=%%A"
        echo  - Found online device: %%A
    )
    if "%%B"=="unauthorized" (
        echo  - [WARNING] Device %%A is unauthorized. Check phone screen and allow debugging.
    )
    if "%%B"=="offline" (
        echo  - [WARNING] Device %%A is offline.
    )
)

if %DEVICE_COUNT% equ 0 (
    echo.
    echo [ERROR] No online Android device detected!
    echo.
    echo Steps to connect your phone:
    echo  1. Connect your phone via USB cable to this PC.
    echo  2. Enable Developer Options on your phone:
    echo     Settings - About Phone - Tap "Build Number" 7 times.
    echo  3. Enable "USB Debugging" under Settings - Developer Options.
    echo  4. Unlock phone and tap "Allow" on the USB Debugging prompt.
    echo  5. [Optional] For Wireless ADB:
    echo     In Developer Options, turn on "Wireless Debugging" and run:
    echo     "%ADB%" connect ^<Phone-IP^>:^<Port^>
    echo.
    exit /b 1
)

echo.
echo [*] Target device : %CONNECTED_SERIAL% (Total connected: %DEVICE_COUNT%)
echo [*] Installing APK: %APK_PATH%
"%ADB%" install -r -d "%APK_PATH%"
if errorlevel 1 (
    echo.
    echo [ERROR] APK installation failed!
    echo If caused by certificate signature mismatch, uninstall the existing app first:
    echo   "%ADB%" uninstall %APP_PACKAGE%
    exit /b 1
)

echo.
echo [OK] APK successfully installed!
echo [*] Launching %APP_PACKAGE% ...
"%ADB%" shell am start -n "%APP_ACTIVITY%" >nul 2>&1
if errorlevel 1 (
    "%ADB%" shell monkey -p %APP_PACKAGE% -c android.intent.category.LAUNCHER 1 >nul 2>&1
)

echo.
echo ===================================================
echo   APP LAUNCHED SUCCESSFULLY ON PHONE!
echo ===================================================
echo   Package  : %APP_PACKAGE%
echo   Activity : %APP_ACTIVITY%
echo ===================================================

exit /b 0
