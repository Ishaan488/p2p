import { registerPlugin, Capacitor, PluginListenerHandle } from '@capacitor/core';

export interface SharedFileItem {
  name: string;
  size: number;
  mimeType: string;
  path?: string;
  uri?: string;
  isNativeUri?: boolean;
}

export interface SharedDataPayload {
  hasShare?: boolean;
  text?: string;
  files?: SharedFileItem[];
}

interface ShareTargetPlugin {
  getPendingShare(): Promise<SharedDataPayload>;
  readChunk(options: { uri: string; offset: number; length: number }): Promise<{ base64Data: string; bytesRead: number }>;
  releaseSharedUri(options: { uri: string }): Promise<{ released: boolean }>;
  addListener(eventName: 'sharedData', listenerFunc: (data: SharedDataPayload) => void): Promise<PluginListenerHandle>;
}

const ShareTarget = registerPlugin<ShareTargetPlugin>('ShareTarget');

export async function releaseSharedUri(uri: string): Promise<void> {
  if (!Capacitor.isNativePlatform() || !uri) return;
  try {
    await ShareTarget.releaseSharedUri({ uri });
  } catch (e) {
    console.debug('Failed to release shared uri:', e);
  }
}

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

/**
 * Reads a bounded chunk from native Android without buffering the entire file into WebView RAM.
 */
export async function readSharedChunk(uri: string, offset: number, length: number): Promise<Uint8Array> {
  const res = await ShareTarget.readChunk({ uri, offset, length });
  const binary = atob(res.base64Data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Stream-compatible file abstraction for native Android content:// URIs.
 * Slices chunks on-demand with O(1) memory instead of loading the full file into a Blob.
 */
export class NativeSharedFile {
  readonly name: string;
  readonly size: number;
  readonly lastModified: number;
  readonly type: string;
  readonly uri: string;

  constructor(item: SharedFileItem) {
    this.name = item.name;
    this.size = item.size;
    this.type = item.mimeType || 'application/octet-stream';
    this.uri = item.uri || item.path || '';
    this.lastModified = Date.now();
  }

  async slice(start: number, end: number): Promise<Uint8Array> {
    const length = Math.max(0, end - start);
    return readSharedChunk(this.uri, start, length);
  }
}
