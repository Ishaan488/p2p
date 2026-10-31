import { HttpError, ServerApi } from './api';
import { SpeedTracker, calculateEta } from './telemetry';
import { playTransferSuccessChime } from './audio';
import { startTransferForeground, stopTransferForeground, updateTransferForeground } from './foregroundService';
import { computeFileHash } from './crypto';

export const CHUNK_SIZE = 1024 * 1024;
const PARALLEL_CHUNKS = 4;

export type UploadStatus = 'queued' | 'uploading' | 'paused' | 'done' | 'error' | 'canceled';

export interface UploadProgress {
  status: UploadStatus;
  sentBytes: number;
  totalBytes: number;
  speed: number; // bytes per second, 0 when not uploading
  eta?: string;
  error?: string;
}

interface UploadStatusResponse {
  totalChunks: number;
  received: [number, number][];
}

function hashString(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

// The same file sent from the same device always maps to the same id, which is
// what lets a transfer resume after a reload: pick the file again and the
// server reports the chunks it already has.
export function transferIdFor(clientId: string, file: File): string {
  return `up-${clientId}-${file.size.toString(36)}-${file.lastModified.toString(36)}-${hashString(file.name)}`;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });

export class Upload {
  readonly totalChunks: number;
  status: UploadStatus = 'queued';
  sentBytes = 0;
  speed = 0;
  eta = '';
  private error?: string;
  private abort: AbortController | null = null;
  private tracker = new SpeedTracker();

  constructor(
    private api: ServerApi,
    readonly file: File,
    readonly transferId: string,
    private onProgress: (progress: UploadProgress) => void
  ) {
    this.totalChunks = Math.ceil(file.size / CHUNK_SIZE);
  }

  get progress(): UploadProgress {
    return {
      status: this.status,
      sentBytes: this.sentBytes,
      totalBytes: this.file.size,
      speed: this.status === 'uploading' ? this.speed : 0,
      eta: this.status === 'uploading' ? this.eta : undefined,
      error: this.error
    };
  }

  private setStatus(status: UploadStatus, error?: string) {
    this.status = status;
    this.error = error;
    if (status !== 'uploading') {
      this.speed = 0;
      this.eta = '';
      this.tracker.reset();
    }
    this.onProgress(this.progress);
  }

  // Runs until the upload finishes, fails, or is paused/cancelled. Safe to call
  // again afterwards: it only sends what the server is still missing.
  async run(): Promise<void> {
    if (this.status === 'done' || this.status === 'canceled' || this.abort) return;
    const abort = new AbortController();
    this.abort = abort;
    this.tracker.reset();

    try {
      // Pre-flight content deduplication check: skip upload if PC already has this exact file
      try {
        const hash = await computeFileHash(this.file, abort.signal);
        const check = await this.api.call<{ exists: boolean; filename?: string }>('/upload_check_hash', {
          hash,
          filename: this.file.name,
          totalSize: this.file.size
        }, abort.signal);

        if (check.exists) {
          this.sentBytes = this.file.size;
          this.speed = 0;
          this.eta = 'Instant (Dedup)';
          this.setStatus('done');
          playTransferSuccessChime();
          return;
        }
      } catch (e) {
        // If dedup check fails (e.g. older server version or timeout), proceed with standard chunk upload
        console.debug('Dedup check bypassed:', e);
      }

      await startTransferForeground('P2P Link Transfer', `Uploading ${this.file.name}...`);
      // A second pass covers the server having lost the transfer mid-way (e.g. it restarted).
      for (let pass = 0; ; pass++) {
        const missing = await this.init(abort.signal);
        try {
          await this.sendChunks(missing, abort.signal);
          await this.api.call('/upload_complete', { transferId: this.transferId }, abort.signal);
          break;
        } catch (err) {
          const recoverable = err instanceof HttpError && (err.status === 404 || err.status === 409);
          if (!recoverable || pass >= 1) throw err;
        }
      }
      this.sentBytes = this.file.size;
      this.setStatus('done');
      playTransferSuccessChime();
    } catch (err) {
      if (!abort.signal.aborted) {
        this.setStatus('error', err instanceof Error ? err.message : String(err));
      }
    } finally {
      abort.abort();
      this.abort = null;
      await stopTransferForeground();
    }
  }

  markQueued() {
    this.setStatus('queued');
  }

  pause() {
    if (this.status !== 'uploading' && this.status !== 'queued') return;
    this.abort?.abort();
    this.setStatus('paused');
  }

  cancel() {
    if (this.status === 'done' || this.status === 'canceled') return;
    this.abort?.abort();
    this.setStatus('canceled');
    this.api.call('/upload_cancel', { transferId: this.transferId }).catch(() => { });
  }

  private chunkLength(index: number): number {
    return Math.min(CHUNK_SIZE, this.file.size - index * CHUNK_SIZE);
  }

  private async init(signal: AbortSignal): Promise<number[]> {
    const status = await this.api.call<UploadStatusResponse>('/upload_init', {
      transferId: this.transferId,
      filename: this.file.name,
      totalSize: this.file.size,
      chunkSize: CHUNK_SIZE,
      totalChunks: this.totalChunks
    }, signal);

    const have = new Uint8Array(this.totalChunks);
    for (const [first, last] of status.received) have.fill(1, first, last + 1);

    const missing: number[] = [];
    let sent = 0;
    for (let i = 0; i < this.totalChunks; i++) {
      if (have[i]) sent += this.chunkLength(i);
      else missing.push(i);
    }
    this.sentBytes = sent;
    this.setStatus('uploading');
    return missing;
  }

  private async sendChunks(missing: number[], signal: AbortSignal): Promise<void> {
    let next = 0;

    const worker = async () => {
      while (next < missing.length) {
        const index = missing[next++];
        await this.sendChunk(index, signal);
        const length = this.chunkLength(index);
        this.sentBytes += length;

        // Exponential Moving Average (EMA) dynamic telemetry calculation
        this.speed = this.tracker.update(this.sentBytes);
        const remainingBytes = Math.max(0, this.file.size - this.sentBytes);
        this.eta = calculateEta(remainingBytes, this.speed);

        updateTransferForeground(`Uploading ${this.file.name} (${Math.round((this.sentBytes / this.file.size) * 100)}%)`, Math.round((this.sentBytes / this.file.size) * 100));
        this.onProgress(this.progress);
      }
    };

    const workers = Array.from({ length: Math.min(PARALLEL_CHUNKS, missing.length) }, worker);
    try {
      await Promise.all(workers);
    } catch (err) {
      next = missing.length; // stop the other workers from picking up more chunks
      await Promise.allSettled(workers);
      throw err;
    }
  }

  private async sendChunk(index: number, signal: AbortSignal): Promise<void> {
    const start = index * CHUNK_SIZE;
    const chunk = this.file.slice(start, start + this.chunkLength(index));
    for (let attempt = 1; ; attempt++) {
      try {
        await this.api.uploadChunk(this.transferId, index, chunk, signal);
        return;
      } catch (err) {
        signal.throwIfAborted();
        const fatal = err instanceof HttpError && err.status >= 400 && err.status < 500 && err.status !== 408;
        if (fatal) throw err;
        // Resilient auto-retry for transient Wi-Fi drops (up to 8 attempts with backoff)
        if (attempt >= 8) throw err;
        await sleep(Math.min(3000, 300 * 2 ** attempt), signal);
      }
    }
  }
}

export interface BatchStats {
  activeCount: number;
  pendingCount: number;
  totalCount: number;
  totalBytes: number;
  sentBytes: number;
  speed: number;
  eta: string;
}

// Queue supporting sequential and controlled concurrent batch uploads
export class UploadQueue {
  private pending: Upload[] = [];
  private active = new Set<Upload>();
  // 2 concurrent file transfers gives optimal throughput without saturated connection
  private concurrency = 2;
  private batchListeners = new Set<(stats: BatchStats) => void>();

  setConcurrency(limit: number) {
    this.concurrency = Math.max(1, limit);
    this.pump();
  }

  onBatchChange(callback: (stats: BatchStats) => void): () => void {
    this.batchListeners.add(callback);
    return () => this.batchListeners.delete(callback);
  }

  getStats(): BatchStats {
    let totalBytes = 0;
    let sentBytes = 0;
    let combinedSpeed = 0;

    const all = [...Array.from(this.active), ...this.pending];
    for (const u of all) {
      totalBytes += u.file.size;
      sentBytes += u.sentBytes;
      if (u.status === 'uploading') combinedSpeed += u.speed;
    }

    const remaining = Math.max(0, totalBytes - sentBytes);
    const eta = calculateEta(remaining, combinedSpeed);

    return {
      activeCount: this.active.size,
      pendingCount: this.pending.length,
      totalCount: all.length,
      totalBytes,
      sentBytes,
      speed: combinedSpeed,
      eta
    };
  }

  private notifyBatch() {
    const stats = this.getStats();
    for (const listener of this.batchListeners) {
      try {
        listener(stats);
      } catch {}
    }
  }

  enqueue(upload: Upload) {
    if (this.active.has(upload) || this.pending.includes(upload)) return;
    upload.markQueued();
    this.pending.push(upload);
    this.notifyBatch();
    this.pump();
  }

  enqueueBatch(uploads: Upload[]) {
    for (const u of uploads) {
      if (!this.active.has(u) && !this.pending.includes(u)) {
        u.markQueued();
        this.pending.push(u);
      }
    }
    this.notifyBatch();
    this.pump();
  }

  pause(upload: Upload) {
    this.pending = this.pending.filter(u => u !== upload);
    this.active.delete(upload);
    upload.pause();
    this.notifyBatch();
    this.pump();
  }

  pauseAll() {
    for (const u of Array.from(this.active)) {
      u.pause();
    }
    this.active.clear();
    for (const u of this.pending) {
      u.pause();
    }
    this.pending = [];
    this.notifyBatch();
  }

  cancel(upload: Upload) {
    this.pending = this.pending.filter(u => u !== upload);
    this.active.delete(upload);
    upload.cancel();
    this.notifyBatch();
    this.pump();
  }

  cancelAll() {
    for (const u of Array.from(this.active)) {
      u.cancel();
    }
    this.active.clear();
    for (const u of this.pending) {
      u.cancel();
    }
    this.pending = [];
    this.notifyBatch();
  }

  resumeInterrupted(allUploads: Iterable<Upload>) {
    for (const u of allUploads) {
      if (u.status === 'error' || u.status === 'paused') {
        this.enqueue(u);
      }
    }
  }

  private pump() {
    while (this.active.size < this.concurrency && this.pending.length > 0) {
      const upload = this.pending.shift();
      if (!upload) break;
      this.active.add(upload);
      this.notifyBatch();

      upload.run().finally(() => {
        this.active.delete(upload);
        this.notifyBatch();
        this.pump();
      });
    }
  }
}
