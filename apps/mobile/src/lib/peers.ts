import type { Pairing } from './api';

/**
 * The phone's list of paired PCs ("peers") and the small pieces of per-peer state
 * that must survive a restart. Everything here is pure data handling on top of an
 * injected key/value store, so it is unit-testable and has no UI or network deps.
 */

export interface PeerRecord {
  /** Same as pairing.serverId. */
  id: string;
  pairing: Pairing;
  /** Last known host:port; refreshed when the PC moves (DHCP) or is found by discovery. */
  address: string;
  /** Reconnect on its own. Switched off by an explicit Disconnect. */
  autoConnect: boolean;
  /** Accept files from this PC without asking. */
  autoAccept: boolean;
  addedAt: number;
  lastConnectedAt?: number;
}

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Hard limits that keep the phone's battery, sockets and screen sane. */
export const MAX_PAIRED_PEERS = 12;
export const MAX_CONNECTED_PEERS = 5;

export const STORAGE_KEYS = {
  peers: 'p2p_peers_v2',
  excluded: 'p2p_send_excluded',
  focused: 'p2p_focused_peer',
  // Pre-multi-device keys, read once for migration.
  legacyPairing: 'p2p_pairing',
  legacyAddress: 'p2p_address',
  legacyAutoConnect: 'p2p_auto_connect',
  legacyTrust: 'p2p_trust_pc'
} as const;

const isString = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

function parseJSON<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** A stored pairing is only usable with all of its identity and key material. */
export function isValidPairing(p: unknown): p is Pairing {
  const x = p as Partial<Pairing> | null;
  return !!x && isString(x.serverId) && isString(x.deviceId) && isString(x.key) && /^[0-9a-f]{64}$/i.test(x.key);
}

function sanitizeRecord(raw: unknown): PeerRecord | null {
  const r = raw as Partial<PeerRecord> | null;
  if (!r || !isValidPairing(r.pairing)) return null;
  return {
    id: r.pairing.serverId,
    pairing: r.pairing,
    address: typeof r.address === 'string' ? r.address : '',
    autoConnect: r.autoConnect !== false,
    autoAccept: r.autoAccept !== false,
    addedAt: typeof r.addedAt === 'number' ? r.addedAt : Date.now(),
    lastConnectedAt: typeof r.lastConnectedAt === 'number' ? r.lastConnectedAt : undefined
  };
}

/**
 * Loads the paired PCs. The first run after the multi-device update migrates the
 * single pairing that older versions stored under separate keys.
 */
export function loadPeers(store: KeyValueStore, now: () => number = Date.now): PeerRecord[] {
  const stored = store.getItem(STORAGE_KEYS.peers);
  if (stored !== null) {
    const list = parseJSON<unknown[]>(stored, []);
    const seen = new Set<string>();
    const out: PeerRecord[] = [];
    for (const item of Array.isArray(list) ? list : []) {
      const rec = sanitizeRecord(item);
      if (rec && !seen.has(rec.id)) {
        seen.add(rec.id);
        out.push(rec);
      }
    }
    return out.slice(0, MAX_PAIRED_PEERS);
  }

  const legacy = parseJSON<unknown>(store.getItem(STORAGE_KEYS.legacyPairing), null);
  if (!isValidPairing(legacy)) return [];
  const record: PeerRecord = {
    id: legacy.serverId,
    pairing: legacy,
    address: store.getItem(STORAGE_KEYS.legacyAddress) || '',
    autoConnect: store.getItem(STORAGE_KEYS.legacyAutoConnect) !== 'false',
    autoAccept: store.getItem(STORAGE_KEYS.legacyTrust) !== 'false',
    addedAt: now()
  };
  savePeers(store, [record]);
  store.removeItem(STORAGE_KEYS.legacyPairing); // one source of truth from now on
  return [record];
}

export function savePeers(store: KeyValueStore, peers: readonly PeerRecord[]): void {
  try {
    store.setItem(STORAGE_KEYS.peers, JSON.stringify(peers));
  } catch {
    // storage full or unavailable: the in-memory list keeps working for this session
  }
}

/** Adds a peer, or replaces the existing record with the same id (re-pairing keeps its settings). */
export function upsertPeer(peers: readonly PeerRecord[], incoming: PeerRecord): PeerRecord[] {
  const i = peers.findIndex(p => p.id === incoming.id);
  if (i === -1) return [...peers, incoming];
  const prev = peers[i];
  const next = peers.slice();
  next[i] = { ...incoming, addedAt: prev.addedAt, autoAccept: prev.autoAccept };
  return next;
}

export function removePeer(peers: readonly PeerRecord[], id: string): PeerRecord[] {
  return peers.filter(p => p.id !== id);
}

// ---- who a send goes to ------------------------------------------------

export function loadExcluded(store: KeyValueStore): Set<string> {
  const list = parseJSON<unknown[]>(store.getItem(STORAGE_KEYS.excluded), []);
  return new Set((Array.isArray(list) ? list : []).filter(isString));
}

export function saveExcluded(store: KeyValueStore, excluded: ReadonlySet<string>): void {
  try {
    store.setItem(STORAGE_KEYS.excluded, JSON.stringify([...excluded]));
  } catch {
    // ignore
  }
}

/** Forgets exclusions for PCs that are no longer paired. */
export function pruneExcluded(excluded: ReadonlySet<string>, pairedIds: readonly string[]): Set<string> {
  const keep = new Set(pairedIds);
  return new Set([...excluded].filter(id => keep.has(id)));
}

// ---- names -------------------------------------------------------------

const hostOnly = (address: string) => address.replace(/^https?:\/\//, '').split('/')[0].split(':')[0];

/**
 * Names shown to the user. Two PCs both called "LAPTOP" would be
 * indistinguishable in a picker, so duplicates get their address appended.
 */
export function displayNames(peers: ReadonlyArray<{ id: string; name: string; address: string }>): Map<string, string> {
  const clean = (n: string) => (n || '').trim() || 'Desktop PC';
  const counts = new Map<string, number>();
  for (const p of peers) {
    const k = clean(p.name).toLowerCase();
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const names = new Map<string, string>();
  const used = new Set<string>();
  for (const p of peers) {
    const base = clean(p.name);
    let label = (counts.get(base.toLowerCase()) ?? 0) > 1 && hostOnly(p.address) ? `${base} (${hostOnly(p.address)})` : base;
    for (let n = 2; used.has(label.toLowerCase()); n++) label = `${base} (${n})`;
    used.add(label.toLowerCase());
    names.set(p.id, label);
  }
  return names;
}

/** Wording for "who will receive this": one name, two names, or a count. */
export function describeTargets(names: readonly string[]): string {
  if (names.length === 0) return '';
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names[0]}, ${names[1]} +${names.length - 2}`;
}

/** Short form for a chip: the name when there is one recipient, otherwise a count. */
export function chipLabel(names: readonly string[]): string {
  if (names.length === 0) return 'No device';
  if (names.length === 1) return names[0];
  return `${names.length} devices`;
}

/**
 * History written before multi-device support has no peer. When there is
 * exactly one paired PC it can only have come from that one.
 */
export function attributeLegacyItems<T extends { peerId?: string; peerName?: string }>(
  items: readonly T[],
  peers: ReadonlyArray<{ id: string; name: string }>
): T[] {
  if (peers.length !== 1) return items.slice();
  const only = peers[0];
  return items.map(it => (it.peerId ? it : { ...it, peerId: only.id, peerName: only.name }));
}
