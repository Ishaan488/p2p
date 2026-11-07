import { registerPlugin, Capacitor, PluginListenerHandle } from '@capacitor/core';
import { sharedUriRefs } from './sharedUriRefs';

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
  stageSharedFile(options: { uri: string }): Promise<{ path: string; size: number }>;
  addListener(eventName: 'sharedData', listenerFunc: (data: SharedDataPayload) => void): Promise<PluginListenerHandle>;
}

const ShareTarget = registerPlugin<ShareTargetPlugin>('ShareTarget');

/** Declares that `count` uploads will each release this URI once (one shared file sent to several PCs). */
export function retainSharedUri(uri: string, count: number): void {
  sharedUriRefs.retain(uri, count);
}

export async function releaseSharedUri(uri: string): Promise<void> {
  if (!Capacitor.isNativePlatform() || !uri) return;
  if (!sharedUriRefs.release(uri)) return; // another upload is still reading it
  try {
    await ShareTarget.releaseSharedUri({ uri });
  } catch (e) {
    console.debug('Failed to release shared uri:', e);
  }
}

/**
 * Copies a shared file into app storage and returns the local copy with its exact size. Sending from that
 * copy avoids every quirk of reading straight from another app's provider. Returns null if staging fails
 * (the caller may then fall back to reading the original URI).
 */
export async function stageSharedFile(item: SharedFileItem): Promise<SharedFileItem | null> {
  if (!Capacitor.isNativePlatform() || !item.uri || !item.uri.startsWith('content://')) return item;
  try {
    const res = await ShareTarget.stageSharedFile({ uri: item.uri });
    if (!res.path || !(res.size > 0)) return null;
    return { ...item, uri: res.path, path: res.path, size: res.size };
  } catch (e) {
    console.debug('stageSharedFile failed:', e);
    return null;
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
    const length = Math.max(0, Math.min(end, this.size) - start);
    // The native side can return fewer bytes than asked (provider hiccup); retry before giving up so a
    // short read never turns into a silently truncated file.
    let last: Uint8Array = new Uint8Array(0);
    for (let attempt = 0; attempt < 3; attempt++) {
      last = await readSharedChunk(this.uri, start, length);
      if (last.length === length) return last;
    }
    throw new Error(`Short read from shared file at offset ${start}: expected ${length}, got ${last.length}`);
  }
}
