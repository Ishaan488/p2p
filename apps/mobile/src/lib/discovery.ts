import { registerPlugin, Capacitor, PluginListenerHandle } from '@capacitor/core';

export interface DiscoveredDevice {
  name: string;
  host: string;
  port: number;
  scheme: 'http' | 'https';
  cert?: string;
  serverName?: string;
  id?: string;
}

interface NetworkInfo {
  ip?: string;
  subnet?: string;
  broadcast?: string;
  prefixLength?: number;
}

interface DiscoveryNativePlugin {
  startDiscovery(): Promise<void>;
  stopDiscovery(): Promise<void>;
  getNetworkInfo(): Promise<NetworkInfo>;
  addListener(eventName: 'onDeviceDiscovered', listenerFunc: (device: DiscoveredDevice) => void): Promise<PluginListenerHandle>;
  addListener(eventName: 'onDeviceLost', listenerFunc: (info: { name: string }) => void): Promise<PluginListenerHandle>;
}

export const DiscoveryNative = registerPlugin<DiscoveryNativePlugin>('Discovery');

/**
 * Starts multi-channel auto-discovery:
 * 1. Immediate HTTP probe of last known saved host (0-50ms)
 * 2. Native Android mDNS via NsdManager
 * 3. Continuous UDP broadcast ping across all subnet broadcast addresses + 224.0.0.167
 * 4. High-speed concurrent subnet HTTP scan (LocalSend-style /24 scan)
 * Returns a teardown function to stop scanning.
 */
export function startAutoDiscovery(
  onDevice: (device: DiscoveredDevice) => void,
  onDiagnostics?: (msg: string) => void
): () => void {
  let active = true;
  let listenerHandle: PluginListenerHandle | null = null;
  const seenHosts = new Set<string>();

  const recordDevice = (device: DiscoveredDevice) => {
    if (!active) return;
    const key = `${device.host}:${device.port}`;
    if (!seenHosts.has(key)) {
      seenHosts.add(key);
      onDevice(device);
    }
  };

  // HTTP probe against a specific host and port
  const probeHost = async (host: string, port = 8080, scheme: 'http' | 'https' = 'http', timeoutMs = 450): Promise<boolean> => {
    if (!active) return false;
    const key = `${host}:${port}`;
    if (seenHosts.has(key)) return true;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const url = `${scheme}://${host}:${port}/discover`;
      const resp = await fetch(url, {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
        signal: controller.signal
      });
      clearTimeout(timer);

      if (resp.ok) {
        const data = await resp.json();
        recordDevice({
          name: data.name || host,
          host,
          port: data.port || port,
          scheme: data.scheme || scheme,
          cert: data.cert,
          serverName: data.name,
          id: data.id
        });
        return true;
      }
    } catch {
      // Unreachable or timed out
    }
    return false;
  };

  // High-speed concurrent subnet HTTP scan (LocalSend architecture reference)
  const scanSubnet = async (subnetPrefix: string, ports: number[]) => {
    if (!active) return;

    // Prioritize: gateway (.1), then remaining 253 hosts
    const candidateIps: string[] = [`${subnetPrefix}1`];
    for (let i = 2; i <= 254; i++) {
      candidateIps.push(`${subnetPrefix}${i}`);
    }

    const queue: { ip: string; port: number }[] = [];
    for (const p of ports) {
      for (const ip of candidateIps) {
        queue.push({ ip, port: p });
      }
    }

    const CONCURRENCY = 28;
    let nextIdx = 0;

    const worker = async () => {
      while (nextIdx < queue.length && active) {
        const item = queue[nextIdx++];
        if (!item) break;
        await probeHost(item.ip, item.port, 'http', 420);
      }
    };

    const workers = Array.from({ length: CONCURRENCY }, () => worker());
    await Promise.all(workers);
  };

  // 1. Immediate check: saved address in localStorage
  let savedHost = '';
  let savedPort = 8080;
  try {
    const rawSaved = localStorage.getItem('p2p_address') || '';
    if (rawSaved) {
      const parts = rawSaved.split(':');
      savedHost = parts[0];
      if (parts[1]) savedPort = parseInt(parts[1], 10) || 8080;
      // Fast probe the saved address immediately (typically answers in 3-10ms)
      probeHost(savedHost, savedPort, 'http', 600);
    }
  } catch {}

  // 2. Native Android Discovery (mDNS + continuous UDP broadcast/multicast ping)
  if (Capacitor.isNativePlatform()) {
    DiscoveryNative.addListener('onDeviceDiscovered', (device) => {
      recordDevice(device);
    }).then(handle => {
      listenerHandle = handle;
      DiscoveryNative.startDiscovery().catch(err => {
        console.debug('Native discovery start failed:', err);
      });
    });

    // 3. Subnet HTTP Scan using device's actual Wi-Fi network interface
    DiscoveryNative.getNetworkInfo().then(netInfo => {
      if (!active) return;
      const targetPorts = [8080];
      if (savedPort && savedPort !== 8080) targetPorts.push(savedPort);

      if (netInfo && netInfo.subnet) {
        scanSubnet(netInfo.subnet, targetPorts);
      } else if (savedHost && savedHost.includes('.')) {
        const lastDot = savedHost.lastIndexOf('.');
        const fallbackSubnet = savedHost.substring(0, lastDot + 1);
        scanSubnet(fallbackSubnet, targetPorts);
      }
    }).catch(err => {
      console.debug('getNetworkInfo failed:', err);
    });
  } else {
    // Web / PWA browser environment fallback
    if (typeof window !== 'undefined' && window.location.hostname && window.location.hostname !== 'localhost') {
      probeHost(window.location.hostname, parseInt(window.location.port, 10) || 8080);
    }
    if (savedHost && savedHost.includes('.')) {
      const lastDot = savedHost.lastIndexOf('.');
      const fallbackSubnet = savedHost.substring(0, lastDot + 1);
      scanSubnet(fallbackSubnet, [savedPort, 8080]);
    }
  }

  // Periodic rescan every 5 seconds for saved host & gateway
  const intervalId = setInterval(() => {
    if (!active) return;
    if (savedHost) {
      probeHost(savedHost, savedPort, 'http', 500);
    }
  }, 5000);

  // Diagnostics timer: if no device is found within 7 seconds, provide helpful instructions
  const diagTimeout = setTimeout(() => {
    if (active && seenHosts.size === 0 && onDiagnostics) {
      onDiagnostics('No PC auto-detected. Ensure your PC and phone are on the same Wi-Fi network, or scan the desktop QR code.');
    }
  }, 7000);

  return () => {
    active = false;
    clearInterval(intervalId);
    clearTimeout(diagTimeout);
    if (listenerHandle) {
      listenerHandle.remove();
    }
    if (Capacitor.isNativePlatform()) {
      DiscoveryNative.stopDiscovery().catch(() => {});
    }
  };
}
