import { HttpError, ServerApi } from './api';
import { SpeedTracker, calculateEta } from './telemetry';
import { playTransferSuccessChime } from './audio';
import { startTransferForeground, stopTransferForeground, updateTransferForeground } from './foregroundService';
import { computeFileHash } from './crypto';
import { removePendingUpload } from './storage';

export const CHUNK_SIZE = 1024 * 1024; // 1 MiB baseline
const MIN_CHUNK_SIZE = 256 * 1024;     // 256 KiB
const MAX_CHUNK_SIZE = 4 * 1024 * 1024; // 4 MiB

export type UploadStatus = 'queued' | 'uploading' | 'paused' | 'done' | 'error' | 'canceled';
export type UploadPriority = 'high' | 'normal' | 'low';

export interface UploadProgress {
  status: UploadStatus;
  priority: UploadPriority;
  sentBytes: number;
  totalBytes: number;
  speed: number; // bytes per second, 0 when not uploading
  eta?: string;
  error?: string;
}

interface UploadStatusResponse {
  totalChunks: number;
  chunkSize?: number;
  received: [number, number][];
}

// ============================================================================
// Adaptive Network Telemetry, Chunk Sizing (NFR 6) & Bandwidth Limiter (FR 54)
// ============================================================================

let avgChunkRttMs = 120;
let recentRetryCount = 0;
let clientBandwidthLimitBps = 0; // 0 = unlimited
let lastTokenTime = Date.now();
let availableTokens = 0;

export function setClientBandwidthLimitBps(bps: number) {
  clientBandwidthLimitBps = Math.max(0, bps);
  availableTokens = clientBandwidthLimitBps;
  lastTokenTime = Date.now();
  try {
    localStorage.setItem('p2p_bandwidth_limit_bps', String(clientBandwidthLimitBps));
  } catch {}
}

export function getClientBandwidthLimitBps(): number {
  try {
    const saved = localStorage.getItem('p2p_bandwidth_limit_bps');
    if (saved !== null) {
      const parsed = Number(saved);
      if (!Number.isNaN(parsed) && parsed >= 0) {
        clientBandwidthLimitBps = parsed;
      }
    }
  } catch {}
  return clientBandwidthLimitBps;
}

async function paceBandwidth(bytes: number, signal: AbortSignal): Promise<void> {
  const limit = clientBandwidthLimitBps;
  if (limit <= 0 || bytes <= 0) return;

  const now = Date.now();
  const elapsedSec = Math.max(0, (now - lastTokenTime) / 1000);
  lastTokenTime = now;
  availableTokens = Math.min(limit * 1.5, availableTokens + elapsedSec * limit);

  if (availableTokens >= bytes) {
    availableTokens -= bytes;
    return;
  }

  const deficit = bytes - availableTokens;
  availableTokens = 0;
  const waitMs = Math.min(2500, Math.ceil((deficit / limit) * 1000));
  if (waitMs > 10) {
    await sleep(waitMs, signal);
  }
}

/**
 * Computes optimal chunk size based on file size and measured network conditions (NFR 6).
 * Preserves previously negotiated chunk size for a transferId so resume across restarts stays aligned.
 */
export function computeAdaptiveChunkSize(transferId: string, fileSize: number): number {
  const cacheKey = `p2p_chunk_${transferId}`;
  try {
    const cached = localStorage.getItem(cacheKey);
    if (cached) {
      const n = Number(cached);
      if (n >= 64 * 1024 && n <= 8 * 1024 * 1024) return n;
    }
  } catch {}

  let chosen = CHUNK_SIZE; // 1 MiB default
  if (fileSize <= 1024 * 1024 || avgChunkRttMs > 900 || recentRetryCount > 2) {
    // Small files (<1 MB) or high-latency/lossy Wi-Fi: 256 KB chunks for fast feedback and cheap retries
    chosen = MIN_CHUNK_SIZE;
  } else if (fileSize >= 200 * 1024 * 1024 && avgChunkRttMs < 150 && recentRetryCount === 0) {
    // Very large files (>200 MB) on low-latency LAN: 4 MB chunks for maximum throughput
    chosen = MAX_CHUNK_SIZE;
  } else if (fileSize >= 32 * 1024 * 1024 && avgChunkRttMs < 250 && recentRetryCount === 0) {
    // Medium-large files (>32 MB) on good Wi-Fi: 2 MB chunks
    chosen = 2 * 1024 * 1024;
  }

  try {
    localStorage.setItem(cacheKey, String(chosen));
  } catch {}
  return chosen;
}

/**
 * Computes adaptive parallel chunk workers per file based on hardware resources & network health (NFR 7).
 */
export function computeAdaptiveChunkWorkers(): number {
  const cores = typeof navigator !== 'undefined' ? (navigator.hardwareConcurrency || 4) : 4;
  const memGb = typeof navigator !== 'undefined' ? ((navigator as any).deviceMemory || 4) : 4;

  if (recentRetryCount >= 2 || avgChunkRttMs > 1000) {
    return 2; // Step down on congested network
  }
  if (cores >= 8 && memGb >= 4 && avgChunkRttMs < 180) {
    return 6;
  }
  if (cores >= 4 && memGb >= 2) {
    return 4;
  }
  return 2;
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

export function priorityWeight(p: UploadPriority): number {
  if (p === 'high') return 2;
  if (p === 'normal') return 1;
  return 0;
}

export class Upload {
  readonly chunkSize: number;
  readonly totalChunks: number;
  status: UploadStatus = 'queued';
  priority: UploadPriority = 'normal';
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
    private onProgress: (progress: UploadProgress) => void,
    initialPriority: UploadPriority = 'normal'
  ) {
    this.priority = initialPriority;
    this.chunkSize = computeAdaptiveChunkSize(transferId, file.size);
    this.totalChunks = file.size === 0 ? 0 : Math.ceil(file.size / this.chunkSize);
  }

  get progress(): UploadProgress {
    return {
      status: this.status,
      priority: this.priority,
      sentBytes: this.sentBytes,
      totalBytes: this.file.size,
      speed: this.status === 'uploading' ? this.speed : 0,
      eta: this.status === 'uploading' ? this.eta : undefined,
      error: this.error
    };
  }

  setPriority(p: UploadPriority) {
    this.priority = p;
    this.onProgress(this.progress);
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
          await removePendingUpload(this.transferId);
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
      await removePendingUpload(this.transferId);
      try {
        localStorage.removeItem(`p2p_chunk_${this.transferId}`);
      } catch {}
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
    removePendingUpload(this.transferId).catch(() => {});
    try {
      localStorage.removeItem(`p2p_chunk_${this.transferId}`);
    } catch {}
    this.api.call('/upload_cancel', { transferId: this.transferId }).catch(() => { });
  }

  private chunkLength(index: number): number {
    return Math.min(this.chunkSize, this.file.size - index * this.chunkSize);
  }

  private async init(signal: AbortSignal): Promise<number[]> {
    const status = await this.api.call<UploadStatusResponse>('/upload_init', {
      transferId: this.transferId,
      filename: this.file.name,
      totalSize: this.file.size,
      chunkSize: this.chunkSize,
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
    const workerCount = Math.min(computeAdaptiveChunkWorkers(), missing.length);

    const worker = async () => {
      while (next < missing.length) {
        const index = missing[next++];
        const length = this.chunkLength(index);
        await paceBandwidth(length, signal);
        const t0 = performance.now();
        await this.sendChunk(index, signal);
        const rtt = performance.now() - t0;
        avgChunkRttMs = avgChunkRttMs * 0.8 + rtt * 0.2;
        if (recentRetryCount > 0) recentRetryCount = Math.max(0, recentRetryCount - 0.25);

        this.sentBytes += length;

        // Exponential Moving Average (EMA) dynamic telemetry calculation
        this.speed = this.tracker.update(this.sentBytes);
        const remainingBytes = Math.max(0, this.file.size - this.sentBytes);
        this.eta = calculateEta(remainingBytes, this.speed);

        updateTransferForeground(`Uploading ${this.file.name} (${Math.round((this.sentBytes / this.file.size) * 100)}%)`, Math.round((this.sentBytes / this.file.size) * 100));
        this.onProgress(this.progress);
      }
    };

    const workers = Array.from({ length: workerCount }, worker);
    try {
      await Promise.all(workers);
    } catch (err) {
      next = missing.length; // stop the other workers from picking up more chunks
      await Promise.allSettled(workers);
      throw err;
    }
  }

  private async sendChunk(index: number, signal: AbortSignal): Promise<void> {
    const start = index * this.chunkSize;
    const chunk = this.file.slice(start, start + this.chunkLength(index));
    for (let attempt = 1; ; attempt++) {
      try {
        await this.api.uploadChunk(this.transferId, index, chunk, signal);
        return;
      } catch (err) {
        signal.throwIfAborted();
        recentRetryCount = Math.min(10, recentRetryCount + 1);
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

// Queue supporting prioritized, sequential, and adaptive concurrent batch uploads (FR 21, FR 54, NFR 7)
export class UploadQueue {
  private pending: Upload[] = [];
  private active = new Set<Upload>();
  private concurrencyMode: 'auto' | number = 'auto';
  private batchListeners = new Set<(stats: BatchStats) => void>();

  constructor() {
    getClientBandwidthLimitBps();
    try {
      const savedConc = localStorage.getItem('p2p_concurrency_mode');
      if (savedConc && savedConc !== 'auto') {
        const n = Number(savedConc);
        if (n >= 1 && n <= 8) this.concurrencyMode = n;
      }
    } catch {}
  }

  getConcurrencyMode(): 'auto' | number {
    return this.concurrencyMode;
  }

  setConcurrency(mode: 'auto' | number) {
    if (mode === 'auto' || mode <= 0) {
      this.concurrencyMode = 'auto';
    } else {
      this.concurrencyMode = Math.max(1, Math.min(8, mode));
    }
    try {
      localStorage.setItem('p2p_concurrency_mode', String(this.concurrencyMode));
    } catch {}
    this.pump();
  }

  private getEffectiveConcurrency(): number {
    if (typeof this.concurrencyMode === 'number') {
      return this.concurrencyMode;
    }
    // Adaptive transfer concurrency based on system resources and live network health (NFR 7)
    const cores = typeof navigator !== 'undefined' ? (navigator.hardwareConcurrency || 4) : 4;
    const memGb = typeof navigator !== 'undefined' ? ((navigator as any).deviceMemory || 4) : 4;
    if (recentRetryCount >= 2 || avgChunkRttMs > 800) {
      return 1;
    }
    if (cores >= 8 && memGb >= 4 && avgChunkRttMs < 160) {
      return 4;
    }
    if (cores >= 4 && memGb >= 2 && avgChunkRttMs < 300) {
      return 3;
    }
    return 2;
  }

  private sortPendingByPriority() {
    this.pending.sort((a, b) => priorityWeight(b.priority) - priorityWeight(a.priority));
  }

  setUploadPriority(upload: Upload, priority: UploadPriority) {
    upload.setPriority(priority);
    this.sortPendingByPriority();
    this.notifyBatch();
    this.pump();
  }

  toggleUploadPriority(upload: Upload): UploadPriority {
    const next: UploadPriority = upload.priority === 'high' ? 'normal' : 'high';
    this.setUploadPriority(upload, next);
    return next;
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
    this.sortPendingByPriority();
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
    this.sortPendingByPriority();
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
      if (u.status === 'error' || u.status === 'paused' || u.status === 'queued') {
        this.enqueue(u);
      }
    }
  }

  private pump() {
    const limit = this.getEffectiveConcurrency();
    while (this.active.size < limit && this.pending.length > 0) {
      this.sortPendingByPriority();
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
