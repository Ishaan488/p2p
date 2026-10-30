// Persistent binary and thumbnail storage using browser IndexedDB and lightweight data URLs.
// Guarantees media previews and cached files survive app restarts, reloads, and offline mode.

const DB_NAME = 'p2p_media_cache';
const DB_VERSION = 1;
const STORE_NAME = 'blobs';

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

