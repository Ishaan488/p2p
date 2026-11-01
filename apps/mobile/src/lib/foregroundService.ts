import { registerPlugin, Capacitor } from '@capacitor/core';

interface ForegroundServicePlugin {
  start(options: { title?: string; text?: string; progress?: number }): Promise<void>;
  update(options: { title?: string; text?: string; progress?: number }): Promise<void>;
  stop(): Promise<void>;
}

const ForegroundService = registerPlugin<ForegroundServicePlugin>('ForegroundService');

let isServiceRunning = false;
let activeCount = 0;
let lastClientUpdate = 0;
const CLIENT_THROTTLE_MS = 500;

export async function startTransferForeground(title?: string, text?: string): Promise<void> {
  activeCount++;
  if (!Capacitor.isNativePlatform()) return;
  try {
    if (!isServiceRunning) {
      isServiceRunning = true;
      lastClientUpdate = Date.now();
      await ForegroundService.start({
        title: title || 'P2P Link Transfer',
        text: text || 'Transfer in progress (screen off safe)'
      });
    }
  } catch (e) {
    console.debug('Foreground service start notice:', e);
  }
}

export async function updateTransferForeground(text: string, progress?: number): Promise<void> {
  if (!Capacitor.isNativePlatform() || !isServiceRunning) return;
  const now = Date.now();
  const isCrucial = progress === 0 || progress === 100 || progress === undefined;
  if (!isCrucial && (now - lastClientUpdate < CLIENT_THROTTLE_MS)) {
    return;
  }
  lastClientUpdate = now;
  try {
    await ForegroundService.update({
      title: 'P2P Link Transfer',
      text,
      progress
    });
  } catch {
    // Ignore update errors
  }
}

export async function stopTransferForeground(): Promise<void> {
  activeCount = Math.max(0, activeCount - 1);
  if (activeCount > 0) return;
  if (!Capacitor.isNativePlatform() || !isServiceRunning) return;
  try {
    isServiceRunning = false;
    lastClientUpdate = 0;
    await ForegroundService.stop();
  } catch (e) {
    console.debug('Foreground service stop notice:', e);
  }
}
