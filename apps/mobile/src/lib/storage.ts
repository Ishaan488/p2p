// Persistent binary and thumbnail storage using browser IndexedDB and lightweight data URLs.
// Guarantees media previews, cached files, and pending uploads survive app restarts, reloads, and offline mode.

const DB_NAME = 'p2p_media_cache';
const DB_VERSION = 1;
const STORE_NAME = 'blobs';
const PENDING_UPLOADS_META_KEY = 'p2p_pending_uploads_v1';

export interface PendingUploadMeta {
  transferId: string;
  messageId: string;
  filename: string;
  mimeType: string;
  size: number;
  lastModified: number;
  priority: 'high' | 'normal' | 'low';
  createdAt: number;
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof window === 'undefined' || !window.indexedDB) {
      reject(new Error('IndexedDB not supported'));
      return;
    }
    const request = window.indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
  });
}

/**
 * Saves a Blob in IndexedDB by key (e.g. transferId or message id).
 */
export async function saveBlobToCache(key: string, blob: Blob): Promise<void> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      const store = tx.objectStore(STORE_NAME);
      store.put(blob, key);
    });
  } catch (err) {
    console.debug('Failed to cache blob in IndexedDB:', err);
  }
}

/**
 * Retrieves a cached Blob from IndexedDB by key.
 */
export async function getBlobFromCache(key: string): Promise<Blob | null> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      tx.onerror = () => reject(tx.error);
      const store = tx.objectStore(STORE_NAME);
      const request = store.get(key);
      request.onsuccess = () => {
        resolve(request.result instanceof Blob ? request.result : null);
      };
      request.onerror = () => reject(request.error);
    });
  } catch (err) {
    console.debug('Failed to get blob from cache:', err);
    return null;
  }
}

/**
 * Deletes a cached Blob from IndexedDB by key.
 */
export async function deleteBlobFromCache(key: string): Promise<void> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.objectStore(STORE_NAME).delete(key);
    });
  } catch (err) {
    console.debug('Failed to delete blob from cache:', err);
  }
}

/**
 * Persists a pending upload's metadata and file blob so interrupted transfers can be
 * automatically recovered after an app restart or reload (FR 19, NFR 16).
 */
export async function savePendingUpload(
  transferId: string,
  messageId: string,
  file: File,
  priority: 'high' | 'normal' | 'low' = 'normal'
): Promise<void> {
  try {
    // Only cache files up to 250 MB in IndexedDB to avoid exhausting mobile webview quota
    if (file.size <= 250 * 1024 * 1024) {
      await saveBlobToCache(`pending-${transferId}`, file);
    }
    const raw = localStorage.getItem(PENDING_UPLOADS_META_KEY);
    const list: PendingUploadMeta[] = raw ? JSON.parse(raw) : [];
    const filtered = list.filter((item) => item.transferId !== transferId);
    filtered.push({
      transferId,
      messageId,
      filename: file.name,
      mimeType: file.type || 'application/octet-stream',
      size: file.size,
      lastModified: file.lastModified || Date.now(),
      priority,
      createdAt: Date.now()
    });
    localStorage.setItem(PENDING_UPLOADS_META_KEY, JSON.stringify(filtered));
  } catch (err) {
    console.debug('Could not persist pending upload:', err);
  }
}

/**
 * Removes a pending upload from restart recovery persistence once it completes or is cancelled.
 */
export async function removePendingUpload(transferId: string): Promise<void> {
  try {
    await deleteBlobFromCache(`pending-${transferId}`);
    const raw = localStorage.getItem(PENDING_UPLOADS_META_KEY);
    if (!raw) return;
    const list: PendingUploadMeta[] = JSON.parse(raw);
    const next = list.filter((item) => item.transferId !== transferId);
    localStorage.setItem(PENDING_UPLOADS_META_KEY, JSON.stringify(next));
  } catch (err) {
    console.debug('Could not remove pending upload:', err);
  }
}

/**
 * Restores all non-expired pending uploads persisted before an application restart (FR 19, NFR 16).
 */
export async function loadPendingUploads(): Promise<Array<{ meta: PendingUploadMeta; file: File }>> {
  try {
    const raw = localStorage.getItem(PENDING_UPLOADS_META_KEY);
    if (!raw) return [];
    const list: PendingUploadMeta[] = JSON.parse(raw);
    const now = Date.now();
    const maxAgeMs = 24 * 60 * 60 * 1000; // 24 hours TTL
    const validMeta: PendingUploadMeta[] = [];
    const restored: Array<{ meta: PendingUploadMeta; file: File }> = [];

    for (const meta of list) {
      if (now - meta.createdAt > maxAgeMs) {
        await deleteBlobFromCache(`pending-${meta.transferId}`);
        continue;
      }
      const blob = await getBlobFromCache(`pending-${meta.transferId}`);
      if (blob && blob.size === meta.size) {
        const file = new File([blob], meta.filename, {
          type: meta.mimeType,
          lastModified: meta.lastModified
        });
        validMeta.push(meta);
        restored.push({ meta, file });
      }
    }
    localStorage.setItem(PENDING_UPLOADS_META_KEY, JSON.stringify(validMeta));
    return restored;
  } catch (err) {
    console.debug('Failed to load pending uploads:', err);
    return [];
  }
}

/**
 * Generates an ultra-compact (~8-16 KB) base64 thumbnail data URL from an image Blob/File.
 * This can be stored in the message JSON in localStorage so previews render instantaneously
 * upon opening the app even before any network or disk operations!
 */
export async function generateThumbnailDataUrl(blob: Blob, maxDim = 320): Promise<string> {
  return new Promise((resolve) => {
    // Only process image blobs
    if (!blob.type.startsWith('image/')) {
      resolve('');
      return;
    }

    const img = new Image();
    const url = URL.createObjectURL(blob);
    img.onload = () => {
      URL.revokeObjectURL(url);
      try {
        let width = img.naturalWidth || img.width;
        let height = img.naturalHeight || img.height;

        if (width <= 0 || height <= 0) {
          resolve('');
          return;
        }

        if (width > maxDim || height > maxDim) {
          if (width > height) {
            height = Math.round((height * maxDim) / width);
            width = maxDim;
          } else {
            width = Math.round((width * maxDim) / height);
            height = maxDim;
          }
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve('');
          return;
        }

        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'medium';
        ctx.drawImage(img, 0, 0, width, height);

        // Export as WebP or JPEG thumbnail (quality 0.72)
        const dataUrl = canvas.toDataURL('image/jpeg', 0.72);
        resolve(dataUrl);
      } catch {
        resolve('');
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve('');
    };
    img.src = url;
  });
}

/**
 * Extracts a representative frame from a video Blob/File and generates a compact data URL.
 * Enables instant video thumbnail rendering in the transfer history without loading the full video.
 */
export async function generateVideoThumbnailDataUrl(blob: Blob, maxDim = 320): Promise<string> {
  return new Promise((resolve) => {
    if (!blob.type.startsWith('video/') && !blob.type.includes('octet-stream')) {
      resolve('');
      return;
    }

    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;
    video.playsInline = true;

    let url = '';
    try {
      url = URL.createObjectURL(blob);
    } catch {
      resolve('');
      return;
    }

    const timeout = setTimeout(() => {
      cleanup();
      resolve('');
    }, 3500);

    const cleanup = () => {
      clearTimeout(timeout);
      video.removeAttribute('src');
      video.load();
      if (url) URL.revokeObjectURL(url);
    };

    video.onloadedmetadata = () => {
      const seekTarget = video.duration && video.duration > 0
        ? Math.min(1.0, video.duration * 0.2)
        : 0;
      video.currentTime = seekTarget;
    };

    video.onseeked = () => {
      try {
        let width = video.videoWidth;
        let height = video.videoHeight;

        if (width <= 0 || height <= 0) {
          cleanup();
          resolve('');
          return;
        }

        if (width > maxDim || height > maxDim) {
          if (width > height) {
            height = Math.round((height * maxDim) / width);
            width = maxDim;
          } else {
            width = Math.round((width * maxDim) / height);
            height = maxDim;
          }
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          cleanup();
          resolve('');
          return;
        }

        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'medium';
        ctx.drawImage(video, 0, 0, width, height);

        const dataUrl = canvas.toDataURL('image/jpeg', 0.75);
        cleanup();
        resolve(dataUrl);
      } catch {
        cleanup();
        resolve('');
      }
    };

    video.onerror = () => {
      cleanup();
      resolve('');
    };

    video.src = url;
  });
}

// ============================================================================
// Client-Side Sensitive Clipboard Content Detection (FR 35 & FR 36)
// ============================================================================

const RE_PRIVATE_KEY = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/i;
const RE_JWT = /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/;
const RE_API_TOKEN = /\b(ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|xox[baprs]-[A-Za-z0-9-]{10,})\b/;
const RE_SECRET_KV = /\b(password|passwd|pwd|secret|api_key|apikey|access_token|auth_token|private_key)\s*[:=]\s*\S{4,}/i;
const RE_CARD_CANDIDATE = /\b(?:\d[ -]*?){13,19}\b/g;

function passesLuhnCheck(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19) return false;
  if (/^(\d)\1+$/.test(digits)) return false;
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

export function isSensitiveClipboardText(text: string): { sensitive: boolean; reason?: string } {
  const trimmed = text.trim();
  if (!trimmed) return { sensitive: false };
  if (RE_PRIVATE_KEY.test(trimmed)) return { sensitive: true, reason: 'Private key detected' };
  if (RE_JWT.test(trimmed)) return { sensitive: true, reason: 'JWT token detected' };
  if (RE_API_TOKEN.test(trimmed)) return { sensitive: true, reason: 'API secret key detected' };
  if (RE_SECRET_KV.test(trimmed)) return { sensitive: true, reason: 'Password/secret pattern detected' };

  const matches = trimmed.match(RE_CARD_CANDIDATE);
  if (matches) {
    for (const m of matches) {
      const digits = m.replace(/\D/g, '');
      if (passesLuhnCheck(digits)) {
        return { sensitive: true, reason: 'Payment card number detected' };
      }
    }
  }
  return { sensitive: false };
}
