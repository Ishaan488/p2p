import type { Pairing } from './api';
import { PeerConnection, type ApiLike, type ConnectResult, type PeerStatus, type TransportLike } from './peerConnection';
import {
  MAX_CONNECTED_PEERS, MAX_PAIRED_PEERS, displayNames, loadExcluded, loadPeers, pruneExcluded, removePeer,
  saveExcluded, savePeers, upsertPeer, STORAGE_KEYS, type KeyValueStore, type PeerRecord
} from './peers';

/**
 * Owns every paired PC and its live connection, and turns them into one
 * immutable snapshot the UI renders. All the multi-device rules live here:
 * the connection cap, who a send goes to, which PC settings apply to, and
 * what happens when a PC is added, re-paired, moved or removed.
 */

export interface PeerView {
  id: string;
  /** Name to show (made unique when two PCs share a name). */
  name: string;
  serverName: string;
  deviceName: string;
  address: string;
  status: PeerStatus;
  error?: string;
  autoAccept: boolean;
  autoConnect: boolean;
  /** The user switched "send to" off for this PC. */
  excluded: boolean;
  /** Connected and not excluded: receives what the user sends. */
  isTarget: boolean;
  lastConnectedAt?: number;
}

export type AggregateStatus = 'connected' | 'connecting' | 'error' | 'disconnected';

export interface PeersSnapshot {
  peers: PeerView[];
  connected: PeerView[];
  targets: PeerView[];
  /** The PC that "device" settings and the header refer to. */
  focused: PeerView | null;
  aggregate: AggregateStatus;
}

export interface StatusInfo {
  status: PeerStatus;
  error?: string;
}

/** Pure: records + live statuses + user choices -> what the UI shows. */
export function buildSnapshot(
  records: readonly PeerRecord[],
  statuses: ReadonlyMap<string, StatusInfo>,
  excluded: ReadonlySet<string>,
  focusedPref: string | null
): PeersSnapshot {
  const names = displayNames(records.map(r => ({ id: r.id, name: r.pairing.serverName, address: r.address })));
  const peers: PeerView[] = records.map(r => {
    const s = statuses.get(r.id) ?? { status: 'idle' as PeerStatus };
    const isExcluded = excluded.has(r.id);
    return {
      id: r.id,
      name: names.get(r.id) ?? r.pairing.serverName,
      serverName: r.pairing.serverName,
      deviceName: r.pairing.deviceName,
      address: r.address,
      status: s.status,
      error: s.error,
      autoAccept: r.autoAccept,
      autoConnect: r.autoConnect,
      excluded: isExcluded,
      isTarget: s.status === 'connected' && !isExcluded,
      lastConnectedAt: r.lastConnectedAt
    };
  });
  const connected = peers.filter(p => p.status === 'connected');
  const pref = peers.find(p => p.id === focusedPref);
  const focused = (pref && pref.status === 'connected' ? pref : connected[0]) ?? pref ?? peers[0] ?? null;

  let aggregate: AggregateStatus = 'disconnected';
  if (connected.length > 0) aggregate = 'connected';
  else if (peers.some(p => p.status === 'connecting' || p.status === 'reconnecting')) aggregate = 'connecting';
  else if (peers.some(p => p.status === 'offline' || p.status === 'unpaired')) aggregate = 'error';

  return { peers, connected, targets: connected.filter(p => p.isTarget), focused, aggregate };
}

export type ManagerConnectResult = ConnectResult | { ok: false; kind: 'limit'; error: unknown; message: string };

export type PeerEvent =
  | { type: 'connected'; peerId: string }
  | { type: 'dropped'; peerId: string }
  | { type: 'added'; peerId: string; replaced: boolean }
  | { type: 'removed'; peerId: string };

export interface ManagerDeps {
  store: KeyValueStore;
  createApi(pairing: Pairing, address: string): ApiLike & { unpair?: () => Promise<void> };
  createTransport(): TransportLike;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  random?: () => number;
  /** Delay between starting the connections of several PCs at launch. */
  staggerMs?: number;
}

type Listener = () => void;

export class PeerManager {
  private records: PeerRecord[];
  private excluded: Set<string>;
  private focusedPref: string | null;
  private readonly conns = new Map<string, PeerConnection>();
  private readonly listeners = new Set<Listener>();
  private messageHandler: ((peerId: string, data: string) => void) | null = null;
  private eventHandlers = new Set<(ev: PeerEvent) => void>();
  private snapshot: PeersSnapshot;
  private disposed = false;

  constructor(private readonly deps: ManagerDeps) {
    this.records = loadPeers(deps.store, deps.now);
    this.excluded = pruneExcluded(loadExcluded(deps.store), this.records.map(r => r.id));
    this.focusedPref = deps.store.getItem(STORAGE_KEYS.focused);
    for (const r of this.records) this.conns.set(r.id, this.makeConnection(r));
    this.snapshot = this.build();
  }

  // ---- React binding (useSyncExternalStore) ------------------------------

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): PeersSnapshot => this.snapshot;

  onMessage(handler: (peerId: string, data: string) => void): void {
    this.messageHandler = handler;
  }

  onEvent(handler: (ev: PeerEvent) => void): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  // ---- queries -----------------------------------------------------------

  record(id: string): PeerRecord | undefined {
    return this.records.find(r => r.id === id);
  }

  connection(id: string): PeerConnection | undefined {
    return this.conns.get(id);
  }

  api(id: string): ApiLike | undefined {
    return this.conns.get(id)?.api;
  }

  /** Which paired PC (if any) lives at this server id. */
  has(id: string): boolean {
    return this.conns.has(id);
  }

  get pairedCount(): number {
    return this.records.length;
  }

  private activeCount(except?: string): number {
    let n = 0;
    for (const [id, c] of this.conns) {
      if (id !== except && (c.status === 'connected' || c.status === 'connecting' || c.status === 'reconnecting')) n++;
    }
    return n;
  }

  // ---- lifecycle ---------------------------------------------------------

  /** Connects the PCs that want to be connected, most recently used first, a few hundred ms apart. */
  start(): void {
    const wanted = this.records
      .filter(r => r.autoConnect)
      .sort((a, b) => (b.lastConnectedAt ?? 0) - (a.lastConnectedAt ?? 0))
      .slice(0, MAX_CONNECTED_PEERS);
    const gap = this.deps.staggerMs ?? 250;
    const setTimer = this.deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    wanted.forEach((r, i) => {
      if (i === 0 || gap === 0) void this.connect(r.id);
      else setTimer(() => { if (!this.disposed) void this.connect(r.id); }, i * gap);
    });
  }

  /** The app came back to the foreground, or the network returned. */
  wakeAll(): void {
    for (const conn of this.conns.values()) {
      // Never wake more PCs than the connection cap allows.
      if (conn.status !== 'connected' && this.activeCount() >= MAX_CONNECTED_PEERS) continue;
      conn.wake();
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const c of this.conns.values()) c.dispose();
    this.conns.clear();
    this.listeners.clear();
  }

  // ---- actions -----------------------------------------------------------

  async connect(id: string, address?: string): Promise<ManagerConnectResult> {
    const conn = this.conns.get(id);
    if (!conn) return { ok: false, kind: 'other', error: new Error('unknown peer'), message: 'This device is not paired.' };
    if (conn.status !== 'connected' && conn.status !== 'connecting' && conn.status !== 'reconnecting' &&
        this.activeCount(id) >= MAX_CONNECTED_PEERS) {
      const message = `You can connect up to ${MAX_CONNECTED_PEERS} devices at once. Disconnect one first.`;
      return { ok: false, kind: 'limit', error: new Error(message), message };
    }
    this.patchRecord(id, { autoConnect: true });
    conn.setAutoConnect(true);
    if (address) this.patchRecord(id, { address });
    return conn.connect(address);
  }

  disconnect(id: string): void {
    const conn = this.conns.get(id);
    if (!conn) return;
    this.patchRecord(id, { autoConnect: false });
    conn.setAutoConnect(false);
    conn.disconnect();
  }

  /**
   * Adds a newly paired PC, or refreshes an existing one (pairing again with the
   * same PC replaces its key and keeps its settings). Does not connect.
   */
  add(pairing: Pairing, address: string): { ok: true; id: string; replaced: boolean } | { ok: false; reason: 'limit'; message: string } {
    const id = pairing.serverId;
    const replaced = this.conns.has(id);
    if (!replaced && this.records.length >= MAX_PAIRED_PEERS) {
      return { ok: false, reason: 'limit', message: `You can pair up to ${MAX_PAIRED_PEERS} devices. Remove one first.` };
    }
    const now = (this.deps.now ?? Date.now)();
    this.records = upsertPeer(this.records, {
      id, pairing, address, autoConnect: true, autoAccept: true, addedAt: now
    });
    const record = this.records.find(r => r.id === id)!;
    this.conns.get(id)?.dispose();
    this.conns.set(id, this.makeConnection(record));
    if (this.excluded.delete(id)) saveExcluded(this.deps.store, this.excluded);
    this.persist();
    this.emitEvent({ type: 'added', peerId: id, replaced });
    this.emit();
    return { ok: true, id, replaced };
  }

  /** Forgets a PC: tells it (best effort), closes the link, drops the record. */
  async remove(id: string): Promise<void> {
    const conn = this.conns.get(id);
    if (!conn) return;
    const api = conn.api as ApiLike & { unpair?: () => Promise<void> };
    if (conn.status === 'connected' && api.unpair) {
      try {
        await api.unpair();
      } catch {
        // the PC was unreachable: it will notice on its own
      }
    }
    conn.dispose();
    this.conns.delete(id);
    this.records = removePeer(this.records, id);
    this.excluded.delete(id);
    saveExcluded(this.deps.store, this.excluded);
    if (this.focusedPref === id) {
      this.focusedPref = null;
      this.deps.store.removeItem(STORAGE_KEYS.focused);
    }
    this.persist();
    this.emitEvent({ type: 'removed', peerId: id });
    this.emit();
  }

  setExcluded(id: string, excluded: boolean): void {
    if (!this.conns.has(id) || this.excluded.has(id) === excluded) return;
    if (excluded) this.excluded.add(id);
    else this.excluded.delete(id);
    saveExcluded(this.deps.store, this.excluded);
    this.emit();
  }

  setFocused(id: string): void {
    if (!this.conns.has(id) || this.focusedPref === id) return;
    this.focusedPref = id;
    this.deps.store.setItem(STORAGE_KEYS.focused, id);
    this.emit();
  }

  setAutoAccept(id: string, value: boolean): void {
    this.patchRecord(id, { autoAccept: value });
  }

  /**
   * The PC announced itself at a new address (DHCP, Wi-Fi switch): remember it and reconnect if it is down.
   * A PC that is connected is left alone: a PC with several network adapters announces from each of them,
   * and following those would rewrite the address of a perfectly healthy link every few seconds.
   */
  updateAddress(id: string, address: string): void {
    const rec = this.record(id);
    const conn = this.conns.get(id);
    if (!rec || !conn || rec.address === address) return;
    if (conn.status === 'connected') return;
    this.patchRecord(id, { address });
    conn.address = address;
    conn.wake();
  }

  /** The PC's own name changed (it was renamed on the desktop). */
  setServerName(id: string, serverName: string): void {
    const rec = this.record(id);
    if (!rec || !serverName || rec.pairing.serverName === serverName) return;
    this.records = this.records.map(r => (r.id === id ? { ...r, pairing: { ...r.pairing, serverName } } : r));
    this.persist();
    this.emit();
  }

  /** Sends to one PC. Returns false if it is not connected. */
  send(id: string, data: string): boolean {
    return this.conns.get(id)?.send(data) ?? false;
  }

  // ---- internals ---------------------------------------------------------

  private makeConnection(record: PeerRecord): PeerConnection {
    const id = record.id;
    const api = this.deps.createApi(record.pairing, record.address);
    return new PeerConnection(record.address, record.autoConnect, {
      api,
      transport: this.deps.createTransport(),
      getName: () => this.snapshot?.peers.find(p => p.id === id)?.name ?? this.record(id)?.pairing.serverName ?? 'the PC',
      onChange: () => this.emit(),
      onMessage: data => this.messageHandler?.(id, data),
      onConnected: () => {
        this.patchRecord(id, { lastConnectedAt: (this.deps.now ?? Date.now)() });
        this.emitEvent({ type: 'connected', peerId: id });
      },
      onDropped: () => this.emitEvent({ type: 'dropped', peerId: id }),
      setTimer: this.deps.setTimer,
      clearTimer: this.deps.clearTimer,
      random: this.deps.random
    });
  }

  private patchRecord(id: string, patch: Partial<PeerRecord>): void {
    this.records = this.records.map(r => (r.id === id ? { ...r, ...patch } : r));
    this.persist();
    this.emit();
  }

  private persist(): void {
    savePeers(this.deps.store, this.records);
  }

  private build(): PeersSnapshot {
    const statuses = new Map<string, StatusInfo>();
    for (const [id, c] of this.conns) statuses.set(id, { status: c.status, error: c.error });
    return buildSnapshot(this.records, statuses, this.excluded, this.focusedPref);
  }

  private emit(): void {
    if (this.disposed) return;
    this.snapshot = this.build();
    for (const l of [...this.listeners]) l();
  }

  private emitEvent(ev: PeerEvent): void {
    for (const h of [...this.eventHandlers]) h(ev);
  }
}
