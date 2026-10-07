import { HttpError, ServerApi } from './api';

export const CHUNK_SIZE = 1024 * 1024;
const PARALLEL_CHUNKS = 4;
const CHUNK_ATTEMPTS = 4;

export type UploadStatus = 'queued' | 'uploading' | 'paused' | 'done' | 'error' | 'canceled';

export interface UploadProgress {
  status: UploadStatus;
  sentBytes: number;
  totalBytes: number;
  speed: number; // bytes per second, 0 when not uploading
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
  private sentBytes = 0;
  private speed = 0;
  private error?: string;
  private abort: AbortController | null = null;

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
      error: this.error
    };
  }

  private setStatus(status: UploadStatus, error?: string) {
    this.status = status;
    this.error = error;
    this.onProgress(this.progress);
  }

  // Runs until the upload finishes, fails, or is paused/cancelled. Safe to call
  // again afterwards: it only sends what the server is still missing.
  async run(): Promise<void> {
    if (this.status === 'done' || this.status === 'canceled' || this.abort) return;
    const abort = new AbortController();
    this.abort = abort;
    try {
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
    } catch (err) {
      if (!abort.signal.aborted) {
        this.setStatus('error', err instanceof Error ? err.message : String(err));
      }
    } finally {
      abort.abort();
      this.abort = null;
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
    const startedAt = Date.now();
    let sentThisRun = 0;
    let next = 0;

    const worker = async () => {
      while (next < missing.length) {
        const index = missing[next++];
        await this.sendChunk(index, signal);
        const length = this.chunkLength(index);
        this.sentBytes += length;
        sentThisRun += length;
        this.speed = sentThisRun / Math.max((Date.now() - startedAt) / 1000, 0.25);
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
        const fatal = err instanceof HttpError && err.status >= 400 && err.status < 500;
        if (fatal || attempt >= CHUNK_ATTEMPTS) throw err;
        await sleep(400 * 2 ** attempt, signal);
      }
    }
  }
}

// Sends files one at a time so each gets the full set of parallel chunk slots.
export class UploadQueue {
  private pending: Upload[] = [];
  private active: Upload | null = null;

  enqueue(upload: Upload) {
    // A paused upload may still be unwinding as the active one; queueing it
    // again is fine, it simply starts over once that run has returned.
    if (upload.status === 'uploading' || this.pending.includes(upload)) return;
    upload.markQueued();
    this.pending.push(upload);
    this.pump();
  }

  pause(upload: Upload) {
    this.pending = this.pending.filter(u => u !== upload);
    upload.pause();
  }

  cancel(upload: Upload) {
    this.pending = this.pending.filter(u => u !== upload);
    upload.cancel();
  }

  private pump() {
    if (this.active) return;
    const upload = this.pending.shift();
    if (!upload) return;
    this.active = upload;
    upload.run().finally(() => {
      this.active = null;
      this.pump();
    });
  }
}
