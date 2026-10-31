import { registerPlugin, Capacitor, PluginListenerHandle } from '@capacitor/core';

export interface SharedFileItem {
  name: string;
  size: number;
  mimeType: string;
  path: string;
}

export interface SharedDataPayload {
  hasShare?: boolean;
  text?: string;
  files?: SharedFileItem[];
}

interface ShareTargetPlugin {
  getPendingShare(): Promise<SharedDataPayload>;
  addListener(eventName: 'sharedData', listenerFunc: (data: SharedDataPayload) => void): Promise<PluginListenerHandle>;
}

const ShareTarget = registerPlugin<ShareTargetPlugin>('ShareTarget');

export async function checkPendingShare(): Promise<SharedDataPayload | null> {
  if (!Capacitor.isNativePlatform()) return null;
  try {
    const res = await ShareTarget.getPendingShare();
    if (res && res.hasShare) {
      return res;
    }
  } catch (e) {
    console.debug('Failed to get pending share:', e);
  }
  return null;
}

export async function onSharedData(callback: (data: SharedDataPayload) => void): Promise<() => void> {
  if (!Capacitor.isNativePlatform()) return () => {};
  try {
    const handle = await ShareTarget.addListener('sharedData', callback);
    return () => handle.remove();
  } catch {
    return () => {};
  }
}

