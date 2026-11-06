import { HttpError, type Pairing } from './api';
import type { Cipher } from './crypto';
import { describeConnectFailure } from './connectErrors';
import { reconnectDelay } from './reconnect';

/**
 * One PC the phone is paired with: its own session, WebSocket, and reconnect loop.
 * Several of these run side by side; none knows about the others.
 *
 *   idle         not trying (the user disconnected it)
 *   connecting   first attempt in progress
 *   reconnecting an attempt after a drop or failure
 *   connected    live
 *   offline      unreachable right now; will retry unless auto-connect is off
 *   unpaired     the PC says it no longer knows this phone: needs pairing again
 */
export type PeerStatus = 'idle' | 'connecting' | 'reconnecting' | 'connected' | 'offline' | 'unpaired';

export interface ApiLike {
  host: string;
  scheme: 'http' | 'https';
  pairing: Pairing | null;
  openSocket(): Promise<{ url: string; cipher: Cipher }>;
}

export type TransportEvent = 'connected' | 'disconnected' | 'connecting' | 'error';

export interface TransportLike {
  connect(url: string, cipher: Cipher): Promise<void>;
  disconnect(): void;
  send(data: string): void;
  isConnected(): boolean;
  onMessage(callback: (data: string) => void): void;
  onStatusChange(callback: (status: TransportEvent) => void): void;
}

export type ConnectResult =
  | { ok: true }
  | { ok: false; kind: 'unreachable' | 'unpaired' | 'other'; error: unknown; message: string };

export interface PeerConnectionDeps {
  api: ApiLike;
  transport: TransportLike;
  /** Display name for error messages. */
  getName: () => string;
  onChange: () => void;
  onMessage: (data: string) => void;
  /** Fired each time the link comes up / goes down after having been up. */
  onConnected?: () => void;
  onDropped?: () => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  random?: () => number;
}

const hostOf = (address: string) => address.replace(/^https?:\/\//, '').split('/')[0];

export class PeerConnection {
  status: PeerStatus = 'idle';
  /** Human-readable reason for the current offline/unpaired state. */
  error: string | undefined;
  address: string;
  autoConnect: boolean;

  private attempt = 0;
  private generation = 0;
  private inFlight: Promise<ConnectResult> | null = null;
  private timer: unknown = null;
  private disposed = false;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(address: string, autoConnect: boolean, private readonly deps: PeerConnectionDeps) {
    this.address = address;
    this.autoConnect = autoConnect;
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? (h => clearTimeout(h as ReturnType<typeof setTimeout>));

    deps.transport.onMessage(data => {
      if (!this.disposed) deps.onMessage(data);
    });
    deps.transport.onStatusChange(ev => this.onTransportStatus(ev));
  }

  get api(): ApiLike {
    return this.deps.api;
  }

  get transport(): TransportLike {
    return this.deps.transport;
  }

  get isConnected(): boolean {
    return this.status === 'connected' && this.deps.transport.isConnected();
  }

  /**
   * Connects (or reconnects). Safe to call repeatedly: a connect already in
   * progress is shared. Never throws; the result says what happened.
   */
  connect(address?: string): Promise<ConnectResult> {
    if (this.disposed) return Promise.resolve({ ok: false, kind: 'other', error: new Error('closed'), message: 'Closed' });
    if (address) this.address = address;
    if (this.inFlight) return this.inFlight;
    if (this.isConnected) return Promise.resolve({ ok: true });

    this.cancelTimer();
    const gen = ++this.generation;
    this.error = undefined;
    this.setStatus(this.attempt > 0 ? 'reconnecting' : 'connecting');

    const run = (async (): Promise<ConnectResult> => {
      try {
        this.deps.api.host = hostOf(this.address);
        const socket = await this.deps.api.openSocket();
        if (gen !== this.generation) return this.superseded();
        await this.deps.transport.connect(socket.url, socket.cipher);
        if (gen !== this.generation) {
          this.deps.transport.disconnect(); // the user disconnected while we were connecting
          return this.superseded();
        }
        this.attempt = 0;
        this.error = undefined;
        this.setStatus('connected');
        this.deps.onConnected?.();
        return { ok: true };
      } catch (err) {
        if (gen !== this.generation) return this.superseded();
        return this.fail(err);
      }
    })().finally(() => {
      if (this.generation === gen) this.inFlight = null;
    });
    this.inFlight = run;
    return run;
  }

  /** The user turned this PC off: stop trying, close the socket. */
  disconnect(): void {
    this.generation++; // voids anything in flight
    this.inFlight = null;
    this.cancelTimer();
    this.attempt = 0;
    this.error = undefined;
    this.deps.transport.disconnect();
    this.setStatus('idle');
  }

  /** The app is back in front, or the network returned: try now instead of waiting out the backoff. */
  wake(): void {
    if (this.disposed || !this.autoConnect) return;
    if (this.status === 'connected' || this.status === 'unpaired' || this.inFlight) return;
    this.attempt = 0;
    void this.connect();
  }

  setAutoConnect(value: boolean): void {
    this.autoConnect = value;
    if (!value) this.cancelTimer();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disconnect();
    this.disposed = true;
  }

  send(data: string): boolean {
    if (!this.isConnected) return false;
    this.deps.transport.send(data);
    return true;
  }

  // ---- internals -------------------------------------------------------

  private superseded(): ConnectResult {
    return { ok: false, kind: 'other', error: new Error('superseded'), message: 'Cancelled' };
  }

  private fail(err: unknown): ConnectResult {
    if (err instanceof HttpError && err.code === 'not_paired') {
      const message = `${this.deps.getName()} no longer recognises this phone. Scan its QR code to pair again.`;
      this.error = message;
      this.attempt = 0;
      this.setStatus('unpaired');
      return { ok: false, kind: 'unpaired', error: err, message };
    }
    const message = describeConnectFailure(err, hostOf(this.address), this.deps.getName());
    const unreachable = !(err instanceof HttpError);
    this.error = message;
    this.setStatus('offline');
    this.scheduleRetry();
    return { ok: false, kind: unreachable ? 'unreachable' : 'other', error: err, message };
  }

  private scheduleRetry(): void {
    if (this.disposed || !this.autoConnect) return;
    this.cancelTimer();
    const delay = reconnectDelay(this.attempt++, this.deps.random);
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.connect();
    }, delay);
  }

  private cancelTimer(): void {
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
  }

  private onTransportStatus(ev: TransportEvent): void {
    if (this.disposed) return;
    // Only a drop of an established link matters here; the attempt in connect() reports its own failures.
    if (this.status !== 'connected' || (ev !== 'disconnected' && ev !== 'error')) return;
    this.generation++;
    this.inFlight = null;
    this.error = 'Connection lost';
    this.setStatus('offline');
    this.deps.onDropped?.();
    this.scheduleRetry();
  }

  private setStatus(next: PeerStatus): void {
    if (this.status === next && next !== 'offline') return;
    this.status = next;
    this.deps.onChange();
  }
}
