/**
 * The live list of PCs found on the Wi-Fi, independent of how they were found.
 *
 * This module is pure logic (no network, no timers, no DOM): the caller feeds it
 * sightings / liveness / goodbyes and drives `sweep()` on a timer, and supplies
 * `verify()` to confirm a PC over HTTP. That keeps every correctness rule below
 * unit-testable with a fake clock.
 *
 * Rules, in the order they matter:
 *  - A sighting shows the PC at once as `appearing`; a successful `verify()` makes
 *    it `confirmed`; a failed one drops it silently (and backs off exponentially).
 *  - A PC is removed when nothing was heard for `ttlMs` (the reliable path), or at
 *    once on a goodbye (the fast path - UDP can lose it, a crash never sends it).
 *  - Announces carry `boot` (process start) and `seq`. Duplicates are no-ops,
 *    reordered older packets are ignored, and an announce that was sent before a
 *    goodbye cannot resurrect the PC. A new boot (the PC restarted) supersedes all.
 *  - The same PC reached through different channels (UDP knows its id, mDNS only
 *    its address) is one entry.
 *  - Bounded: at most `maxDevices` entries, `maxQueued` pending verifications and
 *    `verifyConcurrency` in flight, with per-device exponential backoff, so many
 *    devices flapping at once cannot cause a probe storm or unbounded memory.
 */

export type DeviceState = 'appearing' | 'confirmed';

export interface DiscoveredDevice {
  name: string;
  host: string;
  port: number;
  scheme: 'http' | 'https';
  cert?: string;
  serverName?: string;
  id?: string;
  ips?: string[];
  /** mDNS service instance name, used to match mDNS "service lost" events. */
  nsdName?: string;
  /** Sender's process start (unix ms) and datagram counter; see the Go side. */
  boot?: number;
  seq?: number;
  state?: DeviceState;
}

export interface LostInfo {
  id?: string;
  host?: string;
  name?: string;
  nsdName?: string;
  boot?: number;
  seq?: number;
}

/** Identity of a PC: its server id when known, otherwise its address. */
export function deviceKey(d: Pick<DiscoveredDevice, 'id' | 'host' | 'port'>): string {
  return d.id ? `id:${d.id}` : `addr:${d.host}:${d.port}`;
}

const addrOf = (d: Pick<DiscoveredDevice, 'host' | 'port'>) => `${d.host}:${d.port}`;

export interface RegistryConfig {
  /** Confirms a PC is reachable. Resolve with its details, or null when unreachable. */
  verify: (device: DiscoveredDevice) => Promise<DiscoveredDevice | null>;
  onDevice: (device: DiscoveredDevice) => void;
  onLost: (key: string) => void;
  now?: () => number;
  ttlMs?: number;
  maxDevices?: number;
  verifyConcurrency?: number;
  maxQueued?: number;
  verifiedMemoryMs?: number;
  backoffBaseMs?: number;
  backoffCapMs?: number;
  tombstoneMs?: number;
}

type Job = 'verify' | 'refresh';

interface Entry {
  key: string;
  device: DiscoveredDevice;
  lastSeen: number;
  token: number;
  queued: Job | null;
  verifying: Job | null;
}

interface Tombstone {
  boot?: number;
  seq?: number;
  at: number;
  until: number;
}

const MAX_BOOKKEEPING = 512;
/** Packets without a sequence number (mDNS, HTTP) are ignored this long after a goodbye. */
const QUIET_AFTER_BYE_MS = 2000;

export class DeviceRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly addrIndex = new Map<string, string>();
  private readonly tombstones = new Map<string, Tombstone>();
  private readonly failures = new Map<string, { count: number; until: number }>();
  private readonly verified = new Map<string, { addr: string; until: number }>();
  private readonly reprobing = new Map<string, Promise<boolean>>();
  private queue: Array<{ key: string; job: Job }> = [];
  private inFlight = 0;
  private disposed = false;

  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxDevices: number;
  private readonly concurrency: number;
  private readonly maxQueued: number;
  private readonly verifiedMemoryMs: number;
  private readonly backoffBaseMs: number;
  private readonly backoffCapMs: number;
  private readonly tombstoneMs: number;

  constructor(private readonly cfg: RegistryConfig) {
    this.now = cfg.now ?? Date.now;
    this.ttlMs = cfg.ttlMs ?? 5000;
    this.maxDevices = cfg.maxDevices ?? 200;
    this.concurrency = cfg.verifyConcurrency ?? 4;
    this.maxQueued = cfg.maxQueued ?? 64;
    this.verifiedMemoryMs = cfg.verifiedMemoryMs ?? 30_000;
    this.backoffBaseMs = cfg.backoffBaseMs ?? 5000;
    this.backoffCapMs = cfg.backoffCapMs ?? 60_000;
    this.tombstoneMs = cfg.tombstoneMs ?? 30_000;
  }

  // ---- inputs ----------------------------------------------------------

  /** A PC claims to be at host:port (UDP announce, mDNS). It may be stale, unreachable or forged. */
  sighting(input: DiscoveredDevice): void {
    if (this.disposed || !input.host || !input.port) return;
    const now = this.now();
    const d: DiscoveredDevice = { ...input, state: undefined };
    if (this.isAfterGoodbye(d, now)) return;

    const existing = this.find(d);
    if (existing) {
      this.refresh(existing, d, now);
      return;
    }

    const key = deviceKey(d);
    if (this.isBlocked(key, addrOf(d), now) || !this.makeRoom(now)) return;

    const memo = this.verified.get(key);
    const recentlyVerified = !!memo && memo.addr === addrOf(d) && memo.until > now;
    if (d.scheme === 'https' || recentlyVerified) {
      // HTTPS PCs cannot be probed from a page; and a PC verified moments ago that
      // flapped back needs no second probe (this is what stops flap-driven probe storms).
      this.insert(d, 'confirmed', now);
      return;
    }
    const entry = this.insert(d, 'appearing', now);
    this.enqueue(entry, 'verify');
  }

  /** A PC is known to be reachable (answered an HTTP probe itself). */
  confirmed(input: DiscoveredDevice): void {
    if (this.disposed || !input.host || !input.port) return;
    const now = this.now();
    const d: DiscoveredDevice = { ...input };
    const existing = this.find(d);
    this.failures.delete(deviceKey(d));
    this.failures.delete(`addr:${addrOf(d)}`);
    this.noteVerified(d, now);
    if (existing) {
      existing.lastSeen = now;
      this.apply(existing, d, 'confirmed');
      return;
    }
    if (!this.makeRoom(now)) return;
    this.insert(d, 'confirmed', now);
  }

  /** Keys heard from during the last native tick: proves they are alive without re-describing them. */
  alive(keys: readonly string[]): void {
    if (this.disposed) return;
    const now = this.now();
    for (const key of keys) {
      const entry = this.entries.get(key);
      if (entry) entry.lastSeen = now;
    }
  }

  /** A goodbye (UDP "bye", mDNS goodbye). Ignored when a newer announce already overtook it. */
  remove(info: LostInfo): void {
    if (this.disposed) return;
    const now = this.now();
    if (info.id) {
      const entry = this.entries.get(`id:${info.id}`);
      const older = (e: Entry) => {
        const dev = e.device;
        if (info.boot === undefined || dev.boot === undefined) return false;
        if (dev.boot !== info.boot) return dev.boot > info.boot;
        return (dev.seq ?? 0) > (info.seq ?? 0);
      };
      if (entry && older(entry)) return; // stale goodbye from a previous run of the PC
      this.tombstones.set(info.id, { boot: info.boot, seq: info.seq, at: now, until: now + this.tombstoneMs });
      this.trim(this.tombstones, t => t.until);
      if (entry) this.drop(entry);
      return;
    }
    for (const entry of [...this.entries.values()]) {
      const d = entry.device;
      const byNsd = !!info.nsdName && d.nsdName === info.nsdName;
      const byHost = !!info.host && !d.id && d.host === info.host;
      if (byNsd || byHost) this.drop(entry);
    }
  }

  /** The user's connection to this PC just failed: forget it now and keep it away for a while. */
  forget(key: string): void {
    const entry = this.entries.get(key);
    const addr = entry ? addrOf(entry.device) : undefined;
    if (entry) this.drop(entry);
    this.verified.delete(key);
    if (addr) this.bumpFailure(key, `addr:${addr}`);
    else this.bumpFailure(key);
  }

  /**
   * One-shot re-check of a PC after a failed connect. Bypasses the backoff and the
   * verification queue; concurrent calls for the same PC share one probe.
   */
  reprobe(device: DiscoveredDevice): Promise<boolean> {
    const key = deviceKey(device);
    const running = this.reprobing.get(key);
    if (running) return running;
    const run = (async () => {
      let result: DiscoveredDevice | null = null;
      try {
        result = await this.cfg.verify({ ...device, state: undefined });
      } catch {
        result = null;
      }
      if (this.disposed || !result) return false;
      this.confirmed({ ...device, ...result });
      return true;
    })().finally(() => this.reprobing.delete(key));
    this.reprobing.set(key, run);
    return run;
  }

  // ---- time-driven -----------------------------------------------------

  /** Removes PCs not heard from for `ttlMs`. Safe to call as often as wanted. */
  sweep(): void {
    if (this.disposed) return;
    const stale: string[] = [];
    for (const [key, entry] of this.entries) {
      if (this.now() - entry.lastSeen > this.ttlMs) stale.push(key);
    }
    for (const key of stale) {
      // Re-read: whatever touched the entry since the scan above wins.
      const entry = this.entries.get(key);
      if (entry && this.now() - entry.lastSeen > this.ttlMs) this.drop(entry);
    }
    const now = this.now();
    for (const [id, t] of this.tombstones) if (t.until <= now) this.tombstones.delete(id);
    for (const [k, v] of this.verified) if (v.until <= now) this.verified.delete(k);
    for (const [k, f] of this.failures) if (f.until + this.backoffCapMs <= now) this.failures.delete(k);
  }

  /**
   * Re-checks confirmed PCs that have gone quiet (broadcast filtered, so only
   * unicast works). At most `max` per call, oldest first, through the shared queue.
   */
  refreshQuiet(quietMs: number, max: number): void {
    if (this.disposed) return;
    const now = this.now();
    const quiet = [...this.entries.values()]
      .filter(e => e.device.state === 'confirmed' && e.device.scheme === 'http' && !e.queued && !e.verifying && now - e.lastSeen > quietMs)
      .sort((a, b) => a.lastSeen - b.lastSeen)
      .slice(0, max);
    for (const entry of quiet) this.enqueue(entry, 'refresh');
  }

  /** After the app returns from the background: nothing is judged stale until it has had time to be heard again. */
  touchAll(): void {
    const now = this.now();
    this.entries.forEach(e => { e.lastSeen = now; });
  }

  snapshot(): DiscoveredDevice[] {
    return [...this.entries.values()].map(e => ({ ...e.device }));
  }

  get size(): number {
    return this.entries.size;
  }

  /** Sizes of the internal memory maps (all capped); exposed so tests can assert they stay bounded. */
  get bookkeeping(): { failures: number; verified: number; tombstones: number; queued: number } {
    return { failures: this.failures.size, verified: this.verified.size, tombstones: this.tombstones.size, queued: this.queue.length };
  }

  dispose(): void {
    this.disposed = true;
    this.entries.clear();
    this.addrIndex.clear();
    this.tombstones.clear();
    this.failures.clear();
    this.verified.clear();
    this.reprobing.clear();
    this.queue = [];
  }

  // ---- internals -------------------------------------------------------

  private find(d: DiscoveredDevice): Entry | undefined {
    const byKey = this.entries.get(deviceKey(d));
    if (byKey) return byKey;
    const viaAddr = this.addrIndex.get(addrOf(d));
    return viaAddr ? this.entries.get(viaAddr) : undefined;
  }

  /** True for an announce that was sent before a goodbye we already processed. */
  private isAfterGoodbye(d: DiscoveredDevice, now: number): boolean {
    if (!d.id) return false;
    const t = this.tombstones.get(d.id);
    if (!t || t.until <= now) return false;
    if (d.boot !== undefined && t.boot !== undefined) {
      if (d.boot > t.boot) { this.tombstones.delete(d.id); return false; } // the PC restarted
      return d.boot < t.boot || (d.seq ?? 0) <= (t.seq ?? 0);
    }
    return now - t.at < QUIET_AFTER_BYE_MS;
  }

  /** Sequence ordering against what the entry has already seen. */
  private order(entry: Entry, d: DiscoveredDevice): 'older' | 'same' | 'newer' {
    const cur = entry.device;
    if (d.boot === undefined || cur.boot === undefined) return 'newer';
    if (d.boot !== cur.boot) return d.boot > cur.boot ? 'newer' : 'older';
    const a = d.seq ?? 0;
    const b = cur.seq ?? 0;
    if (a === 0 && b === 0) return 'newer';
    return a > b ? 'newer' : a === b ? 'same' : 'older';
  }

  private refresh(entry: Entry, d: DiscoveredDevice, now: number): void {
    const order = this.order(entry, d);
    if (order === 'older') return; // reordered packet: says nothing about now
    entry.lastSeen = now;
    if (order === 'same') return; // duplicate copy (same announce via another broadcast address)
    const changed = this.apply(entry, d);
    if (!changed && entry.device.state === 'appearing' && !entry.queued && !entry.verifying) this.enqueue(entry, 'verify');
  }

  /**
   * Merges `d` into the entry. A different address means the PC moved (DHCP,
   * Wi-Fi switch): it goes back to `appearing` until the new address is verified
   * (HTTPS PCs, which cannot be probed, are trusted as announced). `explicit` is
   * a state the caller has established, e.g. `confirmed` after an HTTP answer.
   * Returns whether anything visible changed.
   */
  private apply(entry: Entry, d: DiscoveredDevice, explicit?: DeviceState): boolean {
    const old = entry.device;
    const moved = old.host !== d.host || old.port !== d.port;
    const state: DeviceState =
      explicit ?? (moved ? (d.scheme === 'https' ? 'confirmed' : 'appearing') : old.state ?? 'appearing');
    const next: DiscoveredDevice = {
      ...old,
      name: d.name || old.name,
      serverName: d.serverName ?? old.serverName,
      host: d.host,
      port: d.port,
      scheme: d.scheme,
      cert: d.cert ?? old.cert,
      id: d.id ?? old.id,
      ips: d.ips ?? old.ips,
      nsdName: d.nsdName ?? old.nsdName,
      boot: d.boot ?? old.boot,
      seq: d.seq ?? old.seq,
      state
    };
    const visible =
      old.name !== next.name || old.host !== next.host || old.port !== next.port || old.scheme !== next.scheme ||
      old.cert !== next.cert || old.id !== next.id || old.state !== next.state;
    const oldKey = entry.key;
    const newKey = deviceKey(next);
    if (oldKey !== newKey) {
      this.entries.delete(oldKey);
      entry.key = newKey;
      this.entries.set(newKey, entry);
      this.cfg.onLost(oldKey); // the list is keyed by id once known: swap, never duplicate
    }
    if (moved) {
      if (this.addrIndex.get(addrOf(old)) === oldKey) this.addrIndex.delete(addrOf(old));
      entry.token++; // a verification of the old address is void...
      entry.verifying = null; // ...and must not block verifying the new one
      entry.queued = null;
    }
    entry.device = next;
    this.addrIndex.set(addrOf(next), entry.key);
    if (visible || oldKey !== newKey) this.emit(entry);
    if (moved && next.state === 'appearing') this.enqueue(entry, 'verify');
    return visible;
  }

  private insert(d: DiscoveredDevice, state: DeviceState, now: number): Entry {
    const key = deviceKey(d);
    const entry: Entry = { key, device: { ...d, state }, lastSeen: now, token: 0, queued: null, verifying: null };
    this.entries.set(key, entry);
    this.addrIndex.set(addrOf(d), key);
    if (state === 'confirmed') this.noteVerified(d, now);
    this.emit(entry);
    return entry;
  }

  /** Makes space for one more PC; false means the newcomer is turned away. */
  private makeRoom(now: number): boolean {
    if (this.entries.size < this.maxDevices) return true;
    let victim: Entry | undefined;
    for (const e of this.entries.values()) {
      if (e.device.state === 'appearing' && (!victim || e.lastSeen < victim.lastSeen)) victim = e;
    }
    if (!victim) {
      for (const e of this.entries.values()) {
        if (now - e.lastSeen > 2000 && (!victim || e.lastSeen < victim.lastSeen)) victim = e;
      }
    }
    if (!victim) return false;
    this.drop(victim);
    return true;
  }

  private emit(entry: Entry): void {
    if (!this.disposed) this.cfg.onDevice({ ...entry.device });
  }

  private drop(entry: Entry): void {
    if (this.entries.get(entry.key) !== entry) return;
    this.entries.delete(entry.key);
    if (this.addrIndex.get(addrOf(entry.device)) === entry.key) this.addrIndex.delete(addrOf(entry.device));
    entry.token++;
    entry.queued = null;
    if (!this.disposed) this.cfg.onLost(entry.key);
  }

  private noteVerified(d: DiscoveredDevice, now: number): void {
    this.verified.set(deviceKey(d), { addr: addrOf(d), until: now + this.verifiedMemoryMs });
    this.trim(this.verified, v => v.until);
  }

  private isBlocked(key: string, addr: string, now: number): boolean {
    const a = this.failures.get(key);
    const b = this.failures.get(`addr:${addr}`);
    return (!!a && now < a.until) || (!!b && now < b.until);
  }

  private bumpFailure(...keys: string[]): void {
    const now = this.now();
    for (const key of keys) {
      const prev = this.failures.get(key);
      const count = (prev?.count ?? 0) + 1;
      const wait = Math.min(this.backoffCapMs, this.backoffBaseMs * 2 ** (count - 1));
      this.failures.set(key, { count, until: now + wait });
    }
    this.trim(this.failures, f => f.until);
  }

  /** Keeps a bookkeeping map bounded by discarding the entries that expire soonest. */
  private trim<V>(map: Map<string, V>, expiry: (v: V) => number): void {
    if (map.size <= MAX_BOOKKEEPING) return;
    const sorted = [...map.entries()].sort((a, b) => expiry(a[1]) - expiry(b[1]));
    for (const [k] of sorted.slice(0, map.size - MAX_BOOKKEEPING)) map.delete(k);
  }

  private enqueue(entry: Entry, job: Job): void {
    if (entry.queued || entry.verifying) return;
    if (this.queue.length >= this.maxQueued) {
      // Overloaded: an unverified newcomer is dropped (it will be seen again), a known PC is left alone.
      if (job === 'verify') {
        this.drop(entry);
        this.bumpFailure(entry.key);
      }
      return;
    }
    entry.queued = job;
    this.queue.push({ key: entry.key, job });
    this.pump();
  }

  private pump(): void {
    while (!this.disposed && this.inFlight < this.concurrency && this.queue.length > 0) {
      const next = this.queue.shift()!;
      const entry = this.entries.get(next.key);
      if (!entry || entry.queued !== next.job) continue; // dropped or superseded while waiting
      entry.queued = null;
      entry.verifying = next.job;
      const token = ++entry.token;
      this.inFlight++;
      this.cfg.verify({ ...entry.device })
        .then(
          result => this.finish(entry, token, next.job, result),
          () => this.finish(entry, token, next.job, null)
        )
        .finally(() => {
          this.inFlight--;
          this.pump();
        });
    }
  }

  private finish(entry: Entry, token: number, job: Job, result: DiscoveredDevice | null): void {
    // Ignore the answer if the entry was removed, replaced or re-addressed meanwhile.
    if (this.disposed || entry.token !== token || this.entries.get(entry.key) !== entry) return;
    entry.verifying = null;
    const now = this.now();
    if (result) {
      if (entry.device.id && result.id && entry.device.id !== result.id) {
        // The address answers, but as a different PC: the sighting was stale or forged.
        this.failVerification(entry, job);
        return;
      }
      entry.lastSeen = now;
      this.failures.delete(entry.key);
      this.noteVerified({ ...entry.device, ...result }, now);
      this.apply(entry, { ...entry.device, ...result, state: 'confirmed' }, 'confirmed');
      return;
    }
    this.failVerification(entry, job);
  }

  private failVerification(entry: Entry, job: Job): void {
    if (job === 'verify' && entry.device.state === 'appearing') {
      const key = entry.key;
      const addr = addrOf(entry.device);
      this.drop(entry); // silently: it never became real
      this.bumpFailure(key, `addr:${addr}`);
    }
    // A confirmed PC that misses a refresh probe is left to the TTL: one lost packet must not remove it.
  }
}
