import { registerPlugin, Capacitor, PluginListenerHandle } from '@capacitor/core';

export interface DiscoveredDevice {
  name: string;
  host: string;
  port: number;
  scheme: 'http' | 'https';
  cert?: string;
  serverName?: string;
  id?: string;
  ips?: string[];
}

interface NetworkInfo {
  ip?: string;
  subnet?: string;
  broadcast?: string;
  prefixLength?: number;
}

interface LostInfo {
  id?: string;
  host?: string;
  name?: string;
}

interface DiscoveryNativePlugin {
  startDiscovery(): Promise<void>;
  stopDiscovery(): Promise<void>;
  getNetworkInfo(): Promise<NetworkInfo>;
  addListener(eventName: 'onDeviceDiscovered', listenerFunc: (device: DiscoveredDevice) => void): Promise<PluginListenerHandle>;
  addListener(eventName: 'onDeviceLost', listenerFunc: (info: LostInfo) => void): Promise<PluginListenerHandle>;
}

export const DiscoveryNative = registerPlugin<DiscoveryNativePlugin>('Discovery');

/** Identity of a PC: its server id when known, otherwise its address. */
export function deviceKey(d: Pick<DiscoveredDevice, 'id' | 'host' | 'port'>): string {
  return d.id ? `id:${d.id}` : `addr:${d.host}:${d.port}`;
}

// A PC announces itself every ~4s and says goodbye when it exits cleanly. If
// neither is heard for this long (crash, Wi-Fi drop, power loss) it is removed.
const DEVICE_TTL_MS = 15_000;
const SWEEP_INTERVAL_MS = 2_000;
// Known PCs not heard from over UDP/mDNS recently are probed directly over HTTP,
// which keeps them alive on networks that filter broadcast and multicast.
const PROBE_STALE_AFTER_MS = 6_000;
const PROBE_INTERVAL_MS = 5_000;
// Do not re-run the (relatively expensive) /24 sweep more often than this.
const MIN_SUBNET_SCAN_GAP_MS = 15_000;
// After a failed verification, ignore that address for a while.
const VERIFY_BACKOFF_MS = 10_000;
const SUBNET_SCAN_CONCURRENCY = 28;

interface Entry {
  device: DiscoveredDevice;
  lastSeen: number;
}

/**
 * Keeps a live list of the PCs reachable on the current Wi-Fi.
 *
 * Sources (all feed one registry, so a PC found by several is listed once):
 *  - saved address probe (answers in milliseconds)
 *  - native Android: mDNS (NsdManager) + UDP announcements/goodbyes
 *  - a one-off /24 HTTP sweep (also re-run when the app resumes or the network changes)
 *
 * The registry is event driven: `onDevice` fires only when a PC appears or its
 * details change, `onLost` when it leaves. Heartbeats just refresh a timestamp, so
 * a network with hundreds of PCs does not make the UI re-render.
 *
 * Returns a teardown function.
 */
export function startAutoDiscovery(
  onDevice: (device: DiscoveredDevice) => void,
  onDiagnostics?: (msg: string) => void,
  onLost?: (key: string) => void
): () => void {
  let active = true;
  const native = Capacitor.isNativePlatform();
  const known = new Map<string, Entry>();
  const verifying = new Set<string>();
  const failedUntil = new Map<string, number>();
  const handles: PluginListenerHandle[] = [];
  let lastSubnetScan = 0;

  const emitLost = (key: string) => {
    if (known.delete(key) && active) onLost?.(key);
  };

  /** Adds or refreshes a PC that is known to be reachable. */
  const accept = (device: DiscoveredDevice) => {
    if (!active) return;
    const key = deviceKey(device);
    const now = Date.now();
    const existing = known.get(key);
    if (existing) {
      existing.lastSeen = now;
      const d = existing.device;
      if (d.host === device.host && d.port === device.port && d.scheme === device.scheme &&
          d.name === device.name && d.cert === device.cert) {
        return; // nothing changed: heartbeat only
      }
    }
    // The same PC may reappear at another address (DHCP, Wi-Fi switch): keep one entry.
    if (device.id) {
      const stale = `addr:${device.host}:${device.port}`;
      if (stale !== key && known.has(stale)) emitLost(stale);
    }
    known.set(key, { device, lastSeen: now });
    onDevice(device);
  };

  /** HTTP probe of one address. Resolves true when a P2P Link PC answered. */
  const probe = async (host: string, port = 8080, scheme: 'http' | 'https' = 'http', timeoutMs = 450): Promise<boolean> => {
    if (!active) return false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(`${scheme}://${host}:${port}/discover`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal
      });
      if (!resp.ok) return false;
      const data = await resp.json();
      if (!data || typeof data !== 'object') return false;
      accept({
        name: data.name || host,
        host,
        port: Number(data.port) || port,
        scheme: data.scheme === 'https' ? 'https' : scheme,
        cert: data.cert,
        serverName: data.name,
        id: data.id
      });
      return true;
    } catch {
      return false; // unreachable, timed out, or not a P2P Link PC
    } finally {
      clearTimeout(timer);
    }
  };

  /**
   * A UDP/mDNS sighting is only a claim ("a PC lives at host:port"); it may name a
   * virtual adapter we cannot reach, or be forged. New sightings are therefore
   * verified once with a direct request, trying the PC's other addresses too.
   * HTTPS PCs cannot be probed from a page (self-signed certificate) and are trusted
   * as announced; pairing authenticates them anyway.
   */
  const sighting = (device: DiscoveredDevice) => {
    if (!active || !device.host) return;
    const key = deviceKey(device);
    const entry = known.get(key);
    if (entry) {
      entry.lastSeen = Date.now();
      const d = entry.device;
      if (d.host === device.host && d.port === device.port && d.name === device.name && d.scheme === device.scheme) return;
    }
    if (device.scheme === 'https') {
      accept(device);
      return;
    }
    if (verifying.has(key)) return;
    const blockedUntil = failedUntil.get(key) ?? 0;
    if (Date.now() < blockedUntil) return;

    verifying.add(key);
    (async () => {
      const candidates = [device.host, ...(device.ips ?? []).filter(ip => ip !== device.host)];
      for (const host of candidates) {
        if (!active) return;
        if (await probe(host, device.port || 8080, 'http', 700)) return;
      }
      failedUntil.set(key, Date.now() + VERIFY_BACKOFF_MS);
    })().finally(() => verifying.delete(key));
  };

  const remove = (info: LostInfo) => {
    for (const [key, entry] of [...known]) {
      const d = entry.device;
      if ((info.id && d.id === info.id) || (info.host && d.host === info.host && !info.id) || (info.name && !info.id && d.name === info.name)) {
        emitLost(key);
      }
    }
  };

  // High-speed concurrent subnet HTTP sweep.
  const scanSubnet = async (subnetPrefix: string, ports: number[]) => {
    if (!active) return;
    const queue: { ip: string; port: number }[] = [];
    for (const port of ports) {
      for (let i = 1; i <= 254; i++) queue.push({ ip: `${subnetPrefix}${i}`, port });
    }
    let next = 0;
    const worker = async () => {
      while (active && next < queue.length) {
        const item = queue[next++];
        await probe(item.ip, item.port, 'http', 420);
      }
    };
    await Promise.all(Array.from({ length: SUBNET_SCAN_CONCURRENCY }, worker));
  };

  let savedHost = '';
  let savedPort = 8080;
  try {
    const rawSaved = localStorage.getItem('p2p_address') || '';
    if (rawSaved) {
      const parts = rawSaved.split(':');
      savedHost = parts[0];
      if (parts[1]) savedPort = parseInt(parts[1], 10) || 8080;
    }
  } catch {
    // storage unavailable: skip the saved-address shortcut
  }

  const sweepSubnet = async () => {
    if (!active || Date.now() - lastSubnetScan < MIN_SUBNET_SCAN_GAP_MS) return;
    lastSubnetScan = Date.now();
    const ports = savedPort !== 8080 ? [8080, savedPort] : [8080];
    let subnet = '';
    if (native) {
      try {
        subnet = (await DiscoveryNative.getNetworkInfo())?.subnet || '';
      } catch (err) {
        console.debug('getNetworkInfo failed:', err);
      }
    }
    if (!subnet && savedHost.includes('.')) subnet = savedHost.substring(0, savedHost.lastIndexOf('.') + 1);
    if (subnet) await scanSubnet(subnet, ports);
  };

  const startNative = () =>
    DiscoveryNative.startDiscovery().catch(err => console.debug('Native discovery start failed:', err));

  // The phone may have changed network or been asleep: rebind native sockets,
  // re-probe, and give everything a fresh grace period before expiring it.
  const rescan = () => {
    if (!active) return;
    const now = Date.now();
    known.forEach(entry => { entry.lastSeen = now; });
    if (savedHost) void probe(savedHost, savedPort, 'http', 600);
    if (native) {
      DiscoveryNative.stopDiscovery().catch(() => {}).then(() => {
        if (active) void startNative();
      });
    }
    void sweepSubnet();
  };

  // 1. Saved address: answers in milliseconds.
  if (savedHost) void probe(savedHost, savedPort, 'http', 600);

  // 2. Native listeners first, then start, so no early event is missed.
  if (native) {
    void (async () => {
      try {
        handles.push(await DiscoveryNative.addListener('onDeviceDiscovered', sighting));
        handles.push(await DiscoveryNative.addListener('onDeviceLost', remove));
      } catch (err) {
        console.debug('Native discovery listeners failed:', err);
      }
      if (active) await startNative();
      else handles.splice(0).forEach(h => h.remove());
    })();
  } else if (typeof window !== 'undefined' && window.location.hostname && window.location.hostname !== 'localhost') {
    // Served by the PC itself (browser/PWA): the page's own origin is the PC.
    void probe(window.location.hostname, parseInt(window.location.port, 10) || 8080);
  }

  // 3. Subnet sweep.
  void sweepSubnet();

  // Expire PCs that stopped announcing; probe those that are only quiet on UDP.
  const sweepTimer = setInterval(() => {
    if (!active || (typeof document !== 'undefined' && document.hidden)) return;
    const now = Date.now();
    known.forEach((entry, key) => {
      if (now - entry.lastSeen > DEVICE_TTL_MS) emitLost(key);
    });
  }, SWEEP_INTERVAL_MS);

  const probeTimer = setInterval(() => {
    if (!active || (typeof document !== 'undefined' && document.hidden)) return;
    const now = Date.now();
    known.forEach(entry => {
      const d = entry.device;
      if (d.scheme === 'http' && now - entry.lastSeen > PROBE_STALE_AFTER_MS) void probe(d.host, d.port, 'http', 500);
    });
    if (savedHost && !known.size) void probe(savedHost, savedPort, 'http', 500);
  }, PROBE_INTERVAL_MS);

  const onVisible = () => { if (!document.hidden) rescan(); };
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('online', rescan);

  const diagTimeout = setTimeout(() => {
    if (active && known.size === 0 && onDiagnostics) {
      onDiagnostics('No PC auto-detected. Ensure your PC and phone are on the same Wi-Fi network, or scan the desktop QR code.');
    }
  }, 7000);

  return () => {
    active = false;
    clearInterval(sweepTimer);
    clearInterval(probeTimer);
    clearTimeout(diagTimeout);
    document.removeEventListener('visibilitychange', onVisible);
    window.removeEventListener('online', rescan);
    handles.splice(0).forEach(h => h.remove());
    known.clear();
    if (native) DiscoveryNative.stopDiscovery().catch(() => {});
  };
}
