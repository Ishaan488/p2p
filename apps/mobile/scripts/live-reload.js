import { spawn, execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const mobileDir = path.resolve(__dirname, '..');

// Find ADB path
function getAdbPath() {
  const localAppData = process.env.LOCALAPPDATA || '';
  const defaultSdkAdb = path.join(localAppData, 'Android', 'Sdk', 'platform-tools', 'adb.exe');
  if (fs.existsSync(defaultSdkAdb)) {
    return defaultSdkAdb;
  }
  return 'adb';
}

const adb = getAdbPath();

console.log('[LiveReload] Checking connected Android devices via ADB...');
try {
  const devices = execSync(`"${adb}" devices`, { encoding: 'utf-8' });
  console.log(devices.trim());
  if (!devices.includes('\tdevice')) {
    console.warn('[LiveReload] Warning: No active Android device detected. Make sure USB Debugging is ON.');
  } else {
    console.log('[LiveReload] Forwarding port 5173 to phone...');
    execSync(`"${adb}" forward tcp:5173 tcp:5173`);
    console.log('[LiveReload] Port 5173 successfully forwarded (localhost:5173 -> desktop:5173).');
  }
} catch (err) {
  console.error('[LiveReload] ADB error:', err.message);
}

// Sync capacitor with live reload enabled
console.log('[LiveReload] Syncing Capacitor Android config with Live Reload URL...');
try {
  execSync('npx cap copy android', {
    cwd: mobileDir,
    stdio: 'inherit',
    env: { ...process.env, CAPACITOR_LIVE_RELOAD: 'true' }
  });
  console.log('[LiveReload] Capacitor Android config synced.');
} catch (err) {
  console.error('[LiveReload] Sync error:', err.message);
}

// Start Vite dev server
console.log('[LiveReload] Starting Vite dev server...');
const vite = spawn('npx', ['vite', '--host', '0.0.0.0', '--port', '5173'], {
  cwd: mobileDir,
  stdio: 'inherit',
  shell: true
});

vite.on('close', (code) => {
  console.log(`[LiveReload] Vite server exited with code ${code}`);
});

process.on('SIGINT', () => {
  vite.kill('SIGINT');
  process.exit();
});

