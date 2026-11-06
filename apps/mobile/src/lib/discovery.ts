import { registerPlugin, Capacitor, PluginListenerHandle } from '@capacitor/core';
import { DeviceRegistry, deviceKey, type DiscoveredDevice, type LostInfo } from './discoveryRegistry';

export { deviceKey };
export type { DiscoveredDevice, DeviceState, LostInfo } from './discoveryRegistry';

interface NetworkInfo {
  ip?: string;
  subnet?: string;
  broadcast?: string;
  prefixLength?: number;
}

interface DiscoveryNativePlugin {
  startDiscovery(): Promise<void>;
  stopDiscovery(): Promise<void>;
  /** Rebinds the sockets (after a Wi-Fi change) without forgetting that discovery is wanted. */
  restartDiscovery(): Promise<void>;
  getNetworkInfo(): Promise<NetworkInfo>;
  addListener(eventName: 'onDeviceDiscovered', listenerFunc: (device: DiscoveredDevice) => void): Promise<PluginListenerHandle>;
  addListener(eventName: 'onDeviceLost', listenerFunc: (info: LostInfo) => void): Promise<PluginListenerHandle>;
  addListener(eventName: 'onDevicesAlive', listenerFunc: (info: { keys: string[] }) => void): Promise<PluginListenerHandle>;
}

export const DiscoveryNative = registerPlugin<DiscoveryNativePlugin>('Discovery');

// A PC announces every 1-2 s. Three missed announces (about 5 s) mean it is gone;
// a clean exit's goodbye only makes that instant. This timeout is the reliable path.
const DEVICE_TTL_MS = 5_000;
const SWEEP_INTERVAL_MS = 1_000;
// PCs that go quiet on UDP/mDNS (broadcast filtered) are re-checked over HTTP, a few at a time.
const QUIET_AFTER_MS = 3_000;
const REFRESH_INTERVAL_MS = 1_500;
const REFRESH_MAX_PER_TICK = 8;
// Do not re-run the (relatively expensive) /24 sweep more often than this.
const MIN_SUBNET_SCAN_GAP_MS = 15_000;
const SUBNET_SCAN_CONCURRENCY = 28;
const MAX_DEVICES = 200;

interface Controls {
  forget(key: string): void;
  reprobe(device: DiscoveredDevice): Promise<boolean>;
}
let controls: Controls | null = null;

/** Removes a PC from the live list now and keeps it away for a short, growing backoff. */
export function forgetDiscoveredDevice(key: string): void {
  controls?.forget(key);
}

/** One HTTP check of a PC (used right after a failed connect). Resolves true if it answered. */
export function reprobeDiscoveredDevice(device: DiscoveredDevice): Promise<boolean> {
  return controls ? controls.reprobe(device) : Promise.resolve(false);
}

/**
 * Keeps a live list of the PCs reachable on the current Wi-Fi.
 *
 * Sources feed one {@link DeviceRegistry}, so a PC found by several is listed once:
 *  - the saved address (answers in milliseconds)
 *  - native Android: mDNS (NsdManager) + UDP announcements/goodbyes
 *  - a /24 HTTP sweep, re-run when the app returns to the foreground
 *
 * `onDevice` fires when a PC appears (state `appearing`, before it is verified),
 * is confirmed, or changes; `onLost` when it leaves. `knownAddresses` are the
 * host:port of PCs already paired with this phone: they are probed straight away
 * (a PC answers in milliseconds) instead of waiting to be heard. Returns a teardown function.
 */
export function startAutoDiscovery(
  onDevice: (device: DiscoveredDevice) => void,
  onDiagnostics?: (msg: string) => void,
  onLost?: (key: string) => void,
  options: { knownAddresses?: readonly string[] } = {}
): () => void {
  let active = true;
  const native = Capacitor.isNativePlatform();
  const handles: PluginListenerHandle[] = [];
  let lastSubnetScan = 0;
  let everSeen = false;

  /** One HTTP request to /discover. Resolves with the PC's details, or null. */
  const probeOnce = async (host: string, port = 8080, scheme: 'http' | 'https' = 'http', timeoutMs = 450): Promise<DiscoveredDevice | null> => {
    if (!active) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(`${scheme}://${host}:${port}/discover`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal
      });
      if (!resp.ok) return null;
      const data = await resp.json();
      if (!data || typeof data !== 'object') return null;
      return {
        name: data.name || host,
        host,
        port: Number(data.port) || port,
        scheme: data.scheme === 'https' ? 'https' : scheme,
        cert: data.cert,
        serverName: data.name,
        id: data.id
      };
    } catch {
      return null; // unreachable, timed out, or not a P2P Link PC
    } finally {
      clearTimeout(timer);
    }
  };

  /**
   * Confirms a sighting. A sighting only claims "a PC lives at host:port": the source
   * address may be a virtual adapter we cannot reach, so the PC's other addresses
   * are tried too.
   */
  const verify = async (device: DiscoveredDevice): Promise<DiscoveredDevice | null> => {
    const candidates = [device.host, ...(device.ips ?? []).filter(ip => ip !== device.host)];
    for (const host of candidates) {
      if (!active) return null;
      const found = await probeOnce(host, device.port || 8080, 'http', 700);
      if (found) return { ...device, ...found, state: undefined };
    }
    return null;
  };

  const registry = new DeviceRegistry({
    verify,
    onDevice: d => {
      if (!active) return;
      everSeen = true;
      onDevice(d);
    },
    onLost: key => { if (active) onLost?.(key); },
    ttlMs: DEVICE_TTL_MS,
    maxDevices: MAX_DEVICES
  });

  controls = {
    forget: key => registry.forget(key),
    reprobe: device => registry.reprobe(device)
  };

  /** Probes an address and, if a PC answers, records it as confirmed. */
  const probeAndConfirm = async (host: string, port: number, timeoutMs: number) => {
    const found = await probeOnce(host, port, 'http', timeoutMs);
    if (found && active) registry.confirmed(found);
  };

  const scanSubnet = async (subnetPrefix: string, ports: number[]) => {
    const queue: { ip: string; port: number }[] = [];
    for (const port of ports) {
      for (let i = 1; i <= 254; i++) queue.push({ ip: `${subnetPrefix}${i}`, port });
    }
    let next = 0;
    const worker = async () => {
      while (active && next < queue.length) {
        const item = queue[next++];
        await probeAndConfirm(item.ip, item.port, 420);
      }
    };
    await Promise.all(Array.from({ length: SUBNET_SCAN_CONCURRENCY }, worker));
  };

  // Addresses of already paired PCs (deduplicated, capped), as { host, port }.
  const known: Array<{ host: string; port: number }> = [];
  for (const raw of options.knownAddresses ?? []) {
    const [host, portText] = raw.replace(/^https?:\/\//, '').split('/')[0].split(':');
    const port = parseInt(portText, 10) || 8080;
    if (host && !known.some(k => k.host === host && k.port === port) && known.length < 12) known.push({ host, port });
  }
  const knownPorts = [...new Set([8080, ...known.map(k => k.port)])];
  const probeKnown = (timeoutMs: number) => known.forEach(k => void probeAndConfirm(k.host, k.port, timeoutMs));

  const sweepSubnet = async () => {
    if (!active || Date.now() - lastSubnetScan < MIN_SUBNET_SCAN_GAP_MS) return;
    lastSubnetScan = Date.now();
    const ports = knownPorts;
    let subnet = '';
    if (native) {
      try {
        subnet = (await DiscoveryNative.getNetworkInfo())?.subnet || '';
      } catch (err) {
        console.debug('getNetworkInfo failed:', err);
      }
    }
    const guess = known.find(k => k.host.includes('.'))?.host;
    if (!subnet && guess) subnet = guess.substring(0, guess.lastIndexOf('.') + 1);
    if (subnet) await scanSubnet(subnet, ports);
  };

  // 1. Paired PCs' last addresses: answer in milliseconds.
  probeKnown(600);

  // 2. Native listeners first, then start, so no early event is missed. The
  // native side pauses itself when the app is backgrounded and resumes with it.
  if (native) {
    void (async () => {
      try {
        handles.push(await DiscoveryNative.addListener('onDeviceDiscovered', d => registry.sighting(d)));
        handles.push(await DiscoveryNative.addListener('onDeviceLost', info => registry.remove(info)));
        handles.push(await DiscoveryNative.addListener('onDevicesAlive', info => registry.alive(info?.keys ?? [])));
      } catch (err) {
        console.debug('Native discovery listeners failed:', err);
      }
      if (active) await DiscoveryNative.startDiscovery().catch(err => console.debug('Native discovery start failed:', err));
      else handles.splice(0).forEach(h => h.remove());
    })();
  } else if (typeof window !== 'undefined' && window.location.hostname && window.location.hostname !== 'localhost') {
    // Served by the PC itself (browser/PWA): the page's own origin is the PC.
    void probeAndConfirm(window.location.hostname, parseInt(window.location.port, 10) || 8080, 450);
  }

  // 3. Subnet sweep.
  void sweepSubnet();

  const isHidden = () => typeof document !== 'undefined' && document.hidden;
  const sweepTimer = setInterval(() => { if (active && !isHidden()) registry.sweep(); }, SWEEP_INTERVAL_MS);
  const refreshTimer = setInterval(() => {
    if (!active || isHidden()) return;
    registry.refreshQuiet(QUIET_AFTER_MS, REFRESH_MAX_PER_TICK);
    if (registry.size === 0) probeKnown(500);
  }, REFRESH_INTERVAL_MS);

  // Back in the foreground: nothing may be judged stale before it had a chance to be heard again.
  const onVisible = () => {
    if (!active || isHidden()) return;
    registry.touchAll();
    probeKnown(600);
    void sweepSubnet();
    if (native) DiscoveryNative.startDiscovery().catch(() => {}); // idempotent; resumes if native did not
  };
  // The network changed: multicast membership and broadcast addresses are tied to the old one.
  const onOnline = () => {
    if (!active) return;
    registry.touchAll();
    if (native) DiscoveryNative.restartDiscovery().catch(() => {});
    void sweepSubnet();
  };
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('online', onOnline);

  const diagTimeout = setTimeout(() => {
    if (active && !everSeen && onDiagnostics) {
      onDiagnostics('No PC auto-detected. Ensure your PC and phone are on the same Wi-Fi network, or scan the desktop QR code.');
    }
  }, 7000);

  return () => {
    active = false;
    clearInterval(sweepTimer);
    clearInterval(refreshTimer);
    clearTimeout(diagTimeout);
    document.removeEventListener('visibilitychange', onVisible);
    window.removeEventListener('online', onOnline);
    handles.splice(0).forEach(h => h.remove());
    registry.dispose();
    controls = null;
    if (native) DiscoveryNative.stopDiscovery().catch(() => {});
  };
}
