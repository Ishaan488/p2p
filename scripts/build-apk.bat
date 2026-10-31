@echo off
setlocal enabledelayedexpansion

echo ===================================================
echo   P2P Mobile - Android CLI Build (No Android Studio)
echo ===================================================
echo.

:: 1. Define paths
set "SCRIPT_DIR=%~dp0"
for %%I in ("%SCRIPT_DIR%..") do set "ROOT_DIR=%%~fI"
set "MOBILE_DIR=%ROOT_DIR%\apps\mobile"
set "ANDROID_DIR=%MOBILE_DIR%\android"
set "DIST_DIR=%ROOT_DIR%\dist-apk"
set "OUTPUT_APK=%DIST_DIR%\p2p-debug.apk"
set "SOURCE_APK=%ANDROID_DIR%\app\build\outputs\apk\debug\app-debug.apk"

:: 2. Configure SDK & JDK environments
if not defined JAVA_HOME (
    set "JAVA_HOME=C:\Program Files\Java\jdk-22"
)
if not exist "%JAVA_HOME%\bin\java.exe" (
    set "JAVA_HOME=C:\Program Files\Java\jdk-22"
)

if not defined ANDROID_HOME (
    set "ANDROID_HOME=E:\Android\Sdk"
)
if not exist "%ANDROID_HOME%" (
    set "ANDROID_HOME=E:\Android\Sdk"
)
set "ANDROID_SDK_ROOT=%ANDROID_HOME%"

:: Ensure tools are in PATH for current session
set "PATH=%JAVA_HOME%\bin;%ANDROID_HOME%\platform-tools;%ANDROID_HOME%\cmdline-tools\latest\bin;%PATH%"

echo [*] JAVA_HOME    : %JAVA_HOME%
echo [*] ANDROID_HOME : %ANDROID_HOME%
echo [*] Root Dir     : %ROOT_DIR%
echo.

:: Check JDK
if not exist "%JAVA_HOME%\bin\java.exe" (
    echo [ERROR] Java JDK not found at "%JAVA_HOME%".
    echo Please verify Java 22 is installed at C:\Program Files\Java\jdk-22.
    exit /b 1
)

:: Check Android SDK
if not exist "%ANDROID_HOME%" (
    echo [ERROR] Android SDK not found at "%ANDROID_HOME%".
    exit /b 1
)

:: 3. Step 1 - Build Web Assets
echo ---------------------------------------------------
echo [1/3] Building Web Assets (Vite + React) ...
echo ---------------------------------------------------
cd /d "%MOBILE_DIR%"
call npm run build
if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Web build failed with exit code %errorlevel%!
    exit /b %errorlevel%
)
echo [OK] Web assets built successfully.
echo.

:: 4. Step 2 - Capacitor Sync to Android
echo ---------------------------------------------------
echo [2/3] Syncing Web Assets with Capacitor ...
echo ---------------------------------------------------
cd /d "%MOBILE_DIR%"
call npx cap sync android
if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Capacitor sync failed with exit code %errorlevel%!
    exit /b %errorlevel%
)
echo [OK] Capacitor sync complete.
echo.

:: 5. Step 3 - Gradle APK Assembly
echo ---------------------------------------------------
echo [3/3] Compiling Android APK with Gradle ...
echo ---------------------------------------------------
cd /d "%ANDROID_DIR%"
call "%ANDROID_DIR%\gradlew.bat" assembleDebug
if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Gradle build failed with exit code %errorlevel%!
    exit /b %errorlevel%
)
echo [OK] Gradle assembly succeeded.
echo.

:: 6. Copy output APK
if not exist "%DIST_DIR%" (
    mkdir "%DIST_DIR%"
)

if not exist "%SOURCE_APK%" (
    echo [ERROR] Built APK was not found at:
    echo   "%SOURCE_APK%"
    exit /b 1
)

copy /y "%SOURCE_APK%" "%OUTPUT_APK%" >nul
if %errorlevel% neq 0 (
    echo [ERROR] Failed to copy APK to "%OUTPUT_APK%".
    exit /b %errorlevel%
)

:: 7. Display APK Stats
echo ===================================================
echo   BUILD SUCCESSFUL!
echo ===================================================
for %%F in ("%OUTPUT_APK%") do (
    set "APK_SIZE_BYTES=%%~zF"
    set "APK_PATH=%%~fF"
)

:: Calculate size in MB using powershell
for /f %%A in ('powershell -NoProfile -Command "[math]::Round(%APK_SIZE_BYTES% / 1MB, 2)"') do set "APK_SIZE_MB=%%A"

echo APK Output : %APK_PATH%
echo File Size  : %APK_SIZE_BYTES% bytes (~%APK_SIZE_MB% MB)
echo.
echo To install to a connected phone, run:
echo   npm run android:install
echo   OR scripts\install-phone.bat
echo ===================================================

cd /d "%ROOT_DIR%"
exit /b 0
