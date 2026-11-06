// Fakes shared by the multi-device tests. Not imported by the app.
import { HttpError, type Pairing } from './api';
import type { Cipher } from './crypto';
import type { ApiLike, TransportEvent, TransportLike } from './peerConnection';
import type { KeyValueStore } from './peers';

export class MemoryStore implements KeyValueStore {
  data = new Map<string, string>();
  getItem(k: string) { return this.data.has(k) ? this.data.get(k)! : null; }
  setItem(k: string, v: string) { this.data.set(k, v); }
  removeItem(k: string) { this.data.delete(k); }
}

export const pairing = (id: string, name = `PC ${id}`): Pairing => ({
  serverId: id, serverName: name, deviceId: 'phone-1', deviceName: 'My phone', key: 'ab'.repeat(32)
});

/** A timer the test advances by hand. */
export class ManualTimers {
  private next = 1;
  readonly pending = new Map<number, { fn: () => void; ms: number }>();
  setTimer = (fn: () => void, ms: number): unknown => { const id = this.next++; this.pending.set(id, { fn, ms }); return id; };
  clearTimer = (h: unknown): void => { this.pending.delete(h as number); };
  get delays(): number[] { return [...this.pending.values()].map(p => p.ms); }
  /** Runs the oldest pending timer; returns false if none. */
  runNext(): boolean {
    const first = this.pending.entries().next();
    if (first.done) return false;
    const [id, t] = first.value;
    this.pending.delete(id);
    t.fn();
    return true;
  }
}

export class FakeTransport implements TransportLike {
  connected = false;
  sent: string[] = [];
  connectCalls = 0;
  failNext: unknown = null;
  /** When set, connect() waits for it instead of finishing at once. */
  hold: Promise<void> | null = null;
  private messageCb: (d: string) => void = () => {};
  private statusCb: (s: TransportEvent) => void = () => {};
  async connect(): Promise<void> {
    this.connectCalls++;
    if (this.hold) await this.hold;
    if (this.failNext) { const e = this.failNext; this.failNext = null; throw e; }
    this.connected = true;
    this.statusCb('connected');
  }
  disconnect() { this.connected = false; }
  send(d: string) { this.sent.push(d); }
  isConnected() { return this.connected; }
  onMessage(cb: (d: string) => void) { this.messageCb = cb; }
  onStatusChange(cb: (s: TransportEvent) => void) { this.statusCb = cb; }
  // test helpers
  receive(d: string) { this.messageCb(d); }
  drop(kind: TransportEvent = 'disconnected') { this.connected = false; this.statusCb(kind); }
}

export class FakeApi implements ApiLike {
  host = '';
  scheme: 'http' | 'https' = 'http';
  pairing: Pairing | null = null;
  openCalls = 0;
  unpairCalls = 0;
  failWith: unknown = null;
  hold: Promise<void> | null = null;
  async openSocket() {
    this.openCalls++;
    if (this.hold) await this.hold;
    if (this.failWith) throw this.failWith;
    return { url: 'ws://fake', cipher: {} as Cipher };
  }
  async unpair() { this.unpairCalls++; }
}

export const networkError = () => new TypeError('Failed to fetch');
export const notPairedError = () => new HttpError(401, 'This device is not paired', { code: 'not_paired' });

export function deferred() {
  let release!: () => void;
  const promise = new Promise<void>(r => { release = r; });
  return { promise, release };
}

export const flush = () => new Promise<void>(r => setImmediate(r));
