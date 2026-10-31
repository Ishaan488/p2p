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
  downloadWithSystemManager(options: {
    url: string;
    filename: string;
    mimeType?: string;
    subDir?: string;
  }): Promise<{ enqueued: boolean }>;
}

export const FileSaver = registerPlugin<FileSaverPlugin>('FileSaver');

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
  const parts: Blob[] = new Array(info.totalChunks);
  let received = 0;
  let next = 0;
  const tracker = new SpeedTracker();

  await startTransferForeground('P2P Link Download', `Downloading file (${formatBytes(info.totalSize)})...`);

  const worker = async () => {
    while (next < info.totalChunks) {
      const index = next++;
      let chunk: Uint8Array | null = null;
      for (let attempt = 1; ; attempt++) {
        try {
          chunk = await api.downloadChunk(info.transferId, index, signal);
          break;
        } catch (err) {
          if (signal?.aborted || attempt >= 8) throw err;
          await new Promise(r => setTimeout(r, Math.min(3000, 300 * (2 ** attempt))));
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

  if (received !== info.totalSize) throw new Error('Downloaded size does not match');
  playTransferSuccessChime();
  return new Blob(parts);
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
export async function saveToDeviceDownloads(
  blob: Blob,
  filename: string,
  mimeType?: string,
  customSubDir?: string
): Promise<{ success: boolean; path?: string }> {
  const subDir = customSubDir !== undefined ? customSubDir : getDownloadSubDir();
  if (Capacitor.isNativePlatform()) {
    try {
      const base64Data = await blobToBase64(blob);
      const res = await FileSaver.saveToDownloads({
        filename,
        base64Data,
        mimeType: mimeType || blob.type || 'application/octet-stream',
        subDir
      });
      return { success: true, path: res.path };
    } catch (err) {
      console.warn('Native FileSaver failed, attempting HTML5 fallback:', err);
    }
  }

  saveBlob(blob, filename);
  return { success: true, path: filename };
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
