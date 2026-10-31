import { registerPlugin, Capacitor } from '@capacitor/core';

interface ForegroundServicePlugin {
  start(options: { title?: string; text?: string; progress?: number }): Promise<void>;
  update(options: { title?: string; text?: string; progress?: number }): Promise<void>;
  stop(): Promise<void>;
}

const ForegroundService = registerPlugin<ForegroundServicePlugin>('ForegroundService');

let isServiceRunning = false;
let activeCount = 0;

export async function startTransferForeground(title?: string, text?: string): Promise<void> {
  activeCount++;
  if (!Capacitor.isNativePlatform()) return;
  try {
    if (!isServiceRunning) {
      isServiceRunning = true;
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
    await ForegroundService.stop();
  } catch (e) {
    console.debug('Foreground service stop notice:', e);
  }
}

