import { registerPlugin, Capacitor } from '@capacitor/core';
import { ServerApi } from './api';
import { SpeedTracker, calculateEta } from './telemetry';
import { playTransferSuccessChime } from './audio';

const PARALLEL_CHUNKS = 4;

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
  }): Promise<{ success: boolean; path: string }>;
  downloadWithSystemManager(options: {
    url: string;
    filename: string;
    mimeType?: string;
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

  const worker = async () => {
    while (next < info.totalChunks) {
      const index = next++;
      const chunk = await api.downloadChunk(info.transferId, index, signal);
      parts[index] = new Blob([chunk as BlobPart]);
      received += chunk.length;

      const speed = tracker.update(received);
      const remainingBytes = Math.max(0, info.totalSize - received);
      const eta = calculateEta(remainingBytes, speed);

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
  }

  if (received !== info.totalSize) throw new Error('Downloaded size does not match');
  playTransferSuccessChime();
  return new Blob(parts);
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

// Saves a file to the device's public Downloads directory.
// On Android native app: writes directly to /storage/emulated/0/Download via MediaStore.
// On Desktop/Browser: triggers standard browser save flow.
export async function saveToDeviceDownloads(
  blob: Blob,
  filename: string,
  mimeType?: string
): Promise<{ success: boolean; path?: string }> {
  if (Capacitor.isNativePlatform()) {
    try {
      const base64Data = await blobToBase64(blob);
      const res = await FileSaver.saveToDownloads({
        filename,
        base64Data,
        mimeType: mimeType || blob.type || 'application/octet-stream'
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
  mimeType?: string
): Promise<boolean> {
  if (Capacitor.isNativePlatform()) {
    try {
      await FileSaver.downloadWithSystemManager({
        url,
        filename,
        mimeType: mimeType || '*/*'
      });
      return true;
    } catch (err) {
      console.warn('downloadWithSystemManager failed, attempting window.open:', err);
    }
  }
  window.open(url, '_blank');
  return true;
}
