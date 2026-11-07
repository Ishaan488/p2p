@echo off
setlocal
set "ROOT_DIR=%~dp0.."
cd /d "%ROOT_DIR%"

if not defined JAVA_HOME (
    if exist "C:\Program Files\Java\jdk-22\bin\java.exe" (
        set "JAVA_HOME=C:\Program Files\Java\jdk-22"
    )
)
if not defined ANDROID_HOME (
    if exist "E:\Android\Sdk" (
        set "ANDROID_HOME=E:\Android\Sdk"
    )
)

echo [1/4] Building web assets...
cd /d "%ROOT_DIR%\apps\mobile"
call npm run build
if errorlevel 1 (
    echo [ERROR] Web build failed.
    exit /b 1
)

echo [2/4] Syncing Capacitor to Android...
cd /d "%ROOT_DIR%\apps\mobile"
call npx cap sync android
if errorlevel 1 (
    echo [ERROR] Capacitor sync failed.
    exit /b 1
)

echo [3/4] Assembling signed release APK...
cd /d "%ROOT_DIR%\apps\mobile\android"
if not exist "app\p2p-release-key.jks" (
    echo Generating release keystore...
    "%JAVA_HOME%\bin\keytool.exe" -genkeypair -v -keystore "app\p2p-release-key.jks" -alias p2plink -keyalg RSA -keysize 2048 -validity 10000 -storepass p2plink123 -keypass p2plink123 -dname "CN=P2P Link, OU=Mobile, O=P2PLink, L=City, S=State, C=IN"
)
call "%ROOT_DIR%\apps\mobile\android\gradlew.bat" assembleRelease
if errorlevel 1 (
    echo [ERROR] Gradle assembleRelease failed.
    exit /b 1
)

echo [4/4] Copying signed release APK to dist-apk\...
cd /d "%ROOT_DIR%"
if not exist "dist-apk" mkdir dist-apk
copy /Y "apps\mobile\android\app\build\outputs\apk\release\app-release.apk" "dist-apk\p2p-release.apk" >nul

echo.
echo [DONE] Signed Release APK ready at: %cd%\dist-apk\p2p-release.apk
