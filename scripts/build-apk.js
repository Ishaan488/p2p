#!/usr/bin/env node
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

console.log('===================================================');
console.log('  P2P Mobile - Android CLI Build (No Android Studio)');
console.log('===================================================\n');

// 1. Resolve directories
const rootDir = path.resolve(__dirname, '..');
const mobileDir = path.join(rootDir, 'apps', 'mobile');
const androidDir = path.join(mobileDir, 'android');
const distDir = path.join(rootDir, 'dist-apk');
const outputApk = path.join(distDir, 'p2p-debug.apk');
const sourceApk = path.join(androidDir, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');

// 2. Environment Setup
const javaHome = process.env.JAVA_HOME || 'C:\\Program Files\\Java\\jdk-22';
const androidHome = process.env.ANDROID_HOME || 'E:\\Android\\Sdk';

process.env.JAVA_HOME = javaHome;
process.env.ANDROID_HOME = androidHome;
process.env.ANDROID_SDK_ROOT = androidHome;

// Update PATH
const envPath = process.env.PATH || '';
process.env.PATH = `${path.join(javaHome, 'bin')}${path.delimiter}${path.join(androidHome, 'platform-tools')}${path.delimiter}${envPath}`;

console.log(`[*] JAVA_HOME    : ${javaHome}`);
console.log(`[*] ANDROID_HOME : ${androidHome}`);
console.log(`[*] Root Dir     : ${rootDir}\n`);

// Helper to run commands
function runStep(title, command, args, cwd) {
  console.log('---------------------------------------------------');
  console.log(title);
  console.log('---------------------------------------------------');
  const res = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    shell: true,
    env: process.env,
  });

  if (res.status !== 0) {
    console.error(`\n[ERROR] Command failed: ${command} ${args.join(' ')} (exit code ${res.status})`);
    process.exit(res.status || 1);
  }
}

// Step 1: Web assets
runStep('[1/3] Building Web Assets (Vite + React) ...', 'npm', ['run', 'build'], mobileDir);

// Step 2: Capacitor sync
runStep('[2/3] Syncing Web Assets with Capacitor ...', 'npx', ['cap', 'sync', 'android'], mobileDir);

// Step 3: Gradle assembly
const gradlewCmd = process.platform === 'win32' ? path.join(androidDir, 'gradlew.bat') : path.join(androidDir, 'gradlew');
runStep('[3/3] Compiling Android APK with Gradle ...', `"${gradlewCmd}"`, ['assembleDebug'], androidDir);

// Copy APK
if (!fs.existsSync(distDir)) {
  fs.mkdirSync(distDir, { recursive: true });
}

if (!fs.existsSync(sourceApk)) {
  console.error(`\n[ERROR] Built APK was not found at: ${sourceApk}`);
  process.exit(1);
}

fs.copyFileSync(sourceApk, outputApk);

// Display stats
const stats = fs.statSync(outputApk);
const sizeMb = (stats.size / (1024 * 1024)).toFixed(2);

console.log('\n===================================================');
console.log('  BUILD SUCCESSFUL!');
console.log('===================================================');
console.log(`APK Output : ${outputApk}`);
console.log(`File Size  : ${stats.size} bytes (~${sizeMb} MB)\n`);
console.log('To install to a connected phone, run:');
console.log('  npm run android:install');
console.log('  OR scripts\\install-phone.bat');
console.log('===================================================\n');
