import { registerPlugin, Capacitor } from '@capacitor/core';
import { ServerApi } from './api';
import { SpeedTracker, calculateEta } from './telemetry';
import { playTransferSuccessChime } from './audio';
import { startTransferForeground, stopTransferForeground, updateTransferForeground } from './foregroundService';

const PARALLEL_CHUNKS = 4;
const DOWNLOAD_SUBDIR_KEY = 'p2p_download_subdir';

export function getDownloadSubDir(): string {
  try {
    return localStorage.getItem(DOWNLOAD_SUBDIR_KEY) ?? 'P2P Link';
  } catch {
    return 'P2P Link';
  }
}

export function setDownloadSubDir(subDir: string): void {
  try {
    const clean = subDir.replace(/[\\<>:"|?*]/g, '').replace(/\.\./g, '').trim();
    localStorage.setItem(DOWNLOAD_SUBDIR_KEY, clean);
  } catch {
    // ignore storage errors
  }
}

export interface DownloadInfo {
  transferId: string;
  totalChunks: number;
  totalSize: number;
}

interface FileSaverPlugin {
  saveToDownloads(options: {
    filename: string;
    base64Data: string;
    mimeType?: string;
    subDir?: string;
  }): Promise<{ success: boolean; path: string }>;
  startSaveFile(options: {
    fileId: string;
    filename: string;
    mimeType?: string;
    subDir?: string;
  }): Promise<{ success: boolean; fileId: string }>;
  writeChunk(options: {
    fileId: string;
    base64Chunk: string;
    offset?: number;
  }): Promise<{ success: boolean; bytesWritten?: number }>;
  finishSaveFile(options: {
    fileId: string;
    expectedSize?: number;
  }): Promise<{ success: boolean; path: string }>;
  cleanupAbandonedPendingDownloads(): Promise<{ cleaned: number }>;
  abortSaveFile(options: {
    fileId: string;
  }): Promise<{ aborted?: boolean }>;
  downloadWithSystemManager(options: {
    url: string;
    filename: string;
    mimeType?: string;
    subDir?: string;
  }): Promise<{ enqueued: boolean }>;
}

export const FileSaver = registerPlugin<FileSaverPlugin>('FileSaver');

export function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  const len = bytes.byteLength;
  const CHUNK_SIZE = 0x8000;
  for (let i = 0; i < len; i += CHUNK_SIZE) {
    const slice = bytes.subarray(i, Math.min(i + CHUNK_SIZE, len));
    binary += String.fromCharCode.apply(null, slice as any);
  }
  return btoa(binary);
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const res = reader.result as string;
      resolve(res);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// Session chunk cache to preserve downloaded chunks across network drops, terminal restarts, and retries
const downloadChunksCache = new Map<string, (Blob | null)[]>();

// In-memory cache of direct-to-disk chunk bitmaps
const directDownloadBitmaps = new Map<string, Uint8Array>();

export function loadChunkBitmap(transferId: string, totalChunks: number): Uint8Array {
  const cached = directDownloadBitmaps.get(transferId);
  if (cached && cached.length === totalChunks) {
    return cached;
  }
  try {
    const raw = localStorage.getItem(`p2p_chunk_bitmap_${transferId}`);
    if (raw && raw.length === totalChunks) {
      const arr = new Uint8Array(totalChunks);
      for (let i = 0; i < totalChunks; i++) {
        if (raw.charCodeAt(i) === 49) arr[i] = 1;
      }
      directDownloadBitmaps.set(transferId, arr);
      return arr;
    }
  } catch {}
  const fresh = new Uint8Array(totalChunks);
  directDownloadBitmaps.set(transferId, fresh);
  return fresh;
}

let bitmapSaveTimeout: ReturnType<typeof setTimeout> | null = null;
const pendingBitmaps = new Map<string, Uint8Array>();

export function saveChunkBitmap(transferId: string, bitmap: Uint8Array): void {
  directDownloadBitmaps.set(transferId, bitmap);
  pendingBitmaps.set(transferId, bitmap);
  if (!bitmapSaveTimeout) {
    bitmapSaveTimeout = setTimeout(() => {
      bitmapSaveTimeout = null;
      for (const [tid, bm] of pendingBitmaps.entries()) {
        try {
          let str = '';
          for (let i = 0; i < bm.length; i++) {
            str += bm[i] ? '1' : '0';
          }
          localStorage.setItem(`p2p_chunk_bitmap_${tid}`, str);
        } catch {}
      }
      pendingBitmaps.clear();
    }, 150);
  }
}

export function flushChunkBitmap(transferId: string): void {
  const bm = directDownloadBitmaps.get(transferId);
  if (bm) {
    try {
      let str = '';
      for (let i = 0; i < bm.length; i++) {
        str += bm[i] ? '1' : '0';
      }
      localStorage.setItem(`p2p_chunk_bitmap_${transferId}`, str);
    } catch {}
  }
}

export function removeChunkBitmap(transferId: string): void {
  directDownloadBitmaps.delete(transferId);
  pendingBitmaps.delete(transferId);
  try {
    localStorage.removeItem(`p2p_chunk_bitmap_${transferId}`);
  } catch {}
}

export function clearDownloadCache(transferId: string): void {
  downloadChunksCache.delete(transferId);
  removeChunkBitmap(transferId);
  if (Capacitor.isNativePlatform()) {
    FileSaver.abortSaveFile({ fileId: `dl_${transferId}` }).catch(() => {});
  }
}

export function getCachedDownloadBytes(transferId: string, totalSize?: number, totalChunks?: number): number {
  const parts = downloadChunksCache.get(transferId);
  if (parts) {
    let sum = 0;
    for (const p of parts) {
      if (p) sum += p.size;
    }
    return sum;
  }
  if (totalSize && totalChunks) {
    const bitmap = loadChunkBitmap(transferId, totalChunks);
    const chunkSize = Math.ceil(totalSize / totalChunks);
    let sum = 0;
    for (let i = 0; i < totalChunks; i++) {
      if (bitmap[i]) {
        const isLast = i === totalChunks - 1;
        sum += isLast ? (totalSize - i * chunkSize) : chunkSize;
      }
    }
    return sum;
  }
  return 0;
}

// Fetches a file from the PC chunk by chunk, decrypting each one. The result
// is assembled as a Blob, which browsers keep on disk once it grows large.
export async function downloadEncrypted(
  api: ServerApi,
  info: DownloadInfo,
  onProgress: (receivedBytes: number, speed?: number, eta?: string) => void,
  signal?: AbortSignal
): Promise<Blob> {
  if (info.totalChunks === 0 || info.totalSize === 0) {
    onProgress(0, 0, 'Done');
    playTransferSuccessChime();
    return new Blob([]);
  }

  // Reuse already downloaded chunks if resuming an interrupted session
  let parts: (Blob | null)[];
  const cached = downloadChunksCache.get(info.transferId);
  if (cached && cached.length === info.totalChunks) {
    parts = cached;
  } else {
    parts = new Array(info.totalChunks).fill(null);
    downloadChunksCache.set(info.transferId, parts);
  }

  let received = 0;
  for (const p of parts) {
    if (p) received += p.size;
  }

  const tracker = new SpeedTracker();
  if (received > 0) {
    const resumePct = Math.round((received / info.totalSize) * 100);
    onProgress(received, 0, `Resumed at ${resumePct}%`);
  }

  await startTransferForeground('P2P Link Download', `Downloading file (${formatBytes(info.totalSize)})...`);

  let next = 0;
  const getNextChunkIndex = (): number => {
    while (next < info.totalChunks) {
      const idx = next++;
      if (parts[idx] === null) {
        return idx;
      }
    }
    return -1;
  };

  const worker = async () => {
    while (true) {
      const index = getNextChunkIndex();
      if (index === -1) break;

      let chunk: Uint8Array | null = null;
      for (let attempt = 1; ; attempt++) {
        try {
          chunk = await api.downloadChunk(info.transferId, index, signal);
          break;
        } catch (err) {
          if (signal?.aborted || attempt >= 15) throw err;
          await new Promise(r => setTimeout(r, Math.min(3000, 400 * (1.3 ** attempt))));
        }
      }
      if (!chunk) throw new Error('Chunk download failed');
      parts[index] = new Blob([chunk as BlobPart]);
      received += chunk.length;

      const speed = tracker.update(received);
      const remainingBytes = Math.max(0, info.totalSize - received);
      const eta = calculateEta(remainingBytes, speed);

      const percent = Math.round((received / info.totalSize) * 100);
      updateTransferForeground(`Downloading file (${percent}%)`, percent);
      onProgress(received, speed, eta);
    }
  };

  const workers = Array.from({ length: Math.min(PARALLEL_CHUNKS, info.totalChunks) }, worker);
  try {
    await Promise.all(workers);
  } catch (err) {
    next = info.totalChunks;
    await Promise.allSettled(workers);
    throw err;
  } finally {
    await stopTransferForeground();
  }

  for (let i = 0; i < parts.length; i++) {
    if (!parts[i]) {
      throw new Error(`Incomplete download: chunk ${i} missing`);
    }
  }

  if (received !== info.totalSize) throw new Error('Downloaded size does not match');
  downloadChunksCache.delete(info.transferId);
  playTransferSuccessChime();
  return new Blob(parts as Blob[]);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let u = -1;
  do {
    bytes /= 1024;
    u++;
  } while (bytes >= 1024 && u < units.length - 1);
  return `${bytes.toFixed(1)} ${units[u]}`;
}

// Hands a finished download to the browser's "save file" flow (HTML5 fallback).
export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// Saves a file to the device's public Downloads directory (or configured subfolder — FR 24).
// Streams in 2MB slices to prevent Out Of Memory errors on large files.
export async function saveToDeviceDownloads(
  blob: Blob,
  filename: string,
  mimeType?: string,
  customSubDir?: string,
  onProgress?: (writtenBytes: number, totalBytes: number) => void
): Promise<{ success: boolean; path?: string }> {
  const subDir = customSubDir !== undefined ? customSubDir : getDownloadSubDir();
  if (Capacitor.isNativePlatform()) {
    const fileId = Math.random().toString(36).slice(2) + Date.now().toString(36);
    try {
      await FileSaver.startSaveFile({
        fileId,
        filename,
        mimeType: mimeType || blob.type || 'application/octet-stream',
        subDir
      });

      // Stream in 2MB slices — zero memory pressure even for 1GB+ files!
      const SLICE_SIZE = 2 * 1024 * 1024;
      const totalSize = blob.size;
      for (let offset = 0; offset < totalSize; offset += SLICE_SIZE) {
        const slice = blob.slice(offset, Math.min(totalSize, offset + SLICE_SIZE));
        const base64Chunk = await blobToBase64(slice);
        await FileSaver.writeChunk({ fileId, base64Chunk, offset });
        const currentWritten = Math.min(totalSize, offset + slice.size);
        if (onProgress) {
          onProgress(currentWritten, totalSize);
        }
      }

      const res = await FileSaver.finishSaveFile({ fileId, expectedSize: totalSize });
      return { success: true, path: res.path };
    } catch (err) {
      console.warn('Native streaming FileSaver failed:', err);
      try {
        await FileSaver.abortSaveFile({ fileId });
      } catch {}
    }
  }

  saveBlob(blob, filename);
  if (onProgress) {
    onProgress(blob.size, blob.size);
  }
  return { success: true, path: filename };
}

export interface DirectDownloadOptions {
  filename: string;
  mimeType?: string;
  subDir?: string;
}

/**
 * Streams chunks directly from the server to native storage via FileSaverPlugin.
 * Completely eliminates full-file JavaScript memory accumulation (O(1) memory footprint).
 */
export async function downloadDirectToDisk(
  api: ServerApi,
  info: DownloadInfo,
  options: DirectDownloadOptions,
  onProgress: (receivedBytes: number, speed?: number, eta?: string) => void,
  signal?: AbortSignal
): Promise<{ success: boolean; path: string }> {
  if (info.totalChunks === 0 || info.totalSize === 0) {
    onProgress(0, 0, 'Done');
    playTransferSuccessChime();
    return { success: true, path: options.filename };
  }

  const fileId = `dl_${info.transferId}`;
  const subDir = options.subDir !== undefined ? options.subDir : getDownloadSubDir();

  await FileSaver.startSaveFile({
    fileId,
    filename: options.filename,
    mimeType: options.mimeType || 'application/octet-stream',
    subDir
  });

  const chunkSize = Math.ceil(info.totalSize / info.totalChunks);
  const completed = loadChunkBitmap(info.transferId, info.totalChunks);

  let receivedBytes = 0;
  for (let i = 0; i < info.totalChunks; i++) {
    if (completed[i]) {
      const isLast = i === info.totalChunks - 1;
      const expectedChunkLen = isLast ? (info.totalSize - i * chunkSize) : chunkSize;
      receivedBytes += expectedChunkLen;
    }
  }

  const tracker = new SpeedTracker();
  if (receivedBytes > 0) {
    const resumePct = Math.round((receivedBytes / info.totalSize) * 100);
    onProgress(receivedBytes, 0, `Resumed at ${resumePct}%`);
  }

  await startTransferForeground('P2P Link Download', `Downloading ${options.filename}...`);

  let next = 0;
  const getNextChunkIndex = (): number => {
    while (next < info.totalChunks) {
      const idx = next++;
      if (!completed[idx]) {
        return idx;
      }
    }
    return -1;
  };

  const worker = async () => {
    while (true) {
      const index = getNextChunkIndex();
      if (index === -1) break;

      let chunk: Uint8Array | null = null;
      for (let attempt = 1; ; attempt++) {
        try {
          chunk = await api.downloadChunk(info.transferId, index, signal);
          break;
        } catch (err) {
          if (signal?.aborted || attempt >= 15) throw err;
          await new Promise(r => setTimeout(r, Math.min(3000, 400 * (1.3 ** attempt))));
        }
      }
      if (!chunk) throw new Error('Chunk download failed');

      const offset = index * chunkSize;
      const base64Chunk = uint8ArrayToBase64(chunk);
      await FileSaver.writeChunk({ fileId, offset, base64Chunk });

      completed[index] = 1;
      saveChunkBitmap(info.transferId, completed);
      receivedBytes += chunk.length;

      const speed = tracker.update(receivedBytes);
      const remainingBytes = Math.max(0, info.totalSize - receivedBytes);
      const eta = calculateEta(remainingBytes, speed);

      const percent = Math.round((receivedBytes / info.totalSize) * 100);
      updateTransferForeground(`Downloading ${options.filename} (${percent}%)`, percent);
      onProgress(receivedBytes, speed, eta);
    }
  };

  const workers = Array.from({ length: Math.min(PARALLEL_CHUNKS, info.totalChunks) }, worker);
  try {
    await Promise.all(workers);

    // Verify complete bitmap coverage before publication
    for (let i = 0; i < info.totalChunks; i++) {
      if (!completed[i]) {
        throw new Error(`Incomplete download: chunk ${i} was not received`);
      }
    }
    if (receivedBytes !== info.totalSize) {
      throw new Error(`Downloaded byte count mismatch: got ${receivedBytes}, expected ${info.totalSize}`);
    }

    const res = await FileSaver.finishSaveFile({ fileId, expectedSize: info.totalSize });
    removeChunkBitmap(info.transferId);
    playTransferSuccessChime();
    return res;
  } catch (err) {
    next = info.totalChunks;
    await Promise.allSettled(workers);
    flushChunkBitmap(info.transferId);
    // Keep file handle and chunk bitmap intact for seamless reconnect resume.
    // Explicit cancellation or item deletion clears it via clearDownloadCache().
    throw err;
  } finally {
    await stopTransferForeground();
  }
}

// Enqueues a direct download with Android's system DownloadManager.
export async function downloadWithSystemManager(
  url: string,
  filename: string,
  mimeType?: string,
  customSubDir?: string
): Promise<boolean> {
  const subDir = customSubDir !== undefined ? customSubDir : getDownloadSubDir();
  if (Capacitor.isNativePlatform()) {
    try {
      await FileSaver.downloadWithSystemManager({
        url,
        filename,
        mimeType: mimeType || '*/*',
        subDir
      });
      return true;
    } catch (err) {
      console.warn('downloadWithSystemManager failed, attempting window.open:', err);
    }
  }
  window.open(url, '_blank');
  return true;
}
