import { registerPlugin, Capacitor, PluginListenerHandle } from '@capacitor/core';

export interface DiscoveredDevice {
  name: string;
  host: string;
  port: number;
  scheme: 'http' | 'https';
  cert?: string;
  serverName?: string;
}

interface DiscoveryNativePlugin {
  startDiscovery(): Promise<void>;
  stopDiscovery(): Promise<void>;
  addListener(eventName: 'onDeviceDiscovered', listenerFunc: (device: DiscoveredDevice) => void): Promise<PluginListenerHandle>;
  addListener(eventName: 'onDeviceLost', listenerFunc: (info: { name: string }) => void): Promise<PluginListenerHandle>;
}

export const DiscoveryNative = registerPlugin<DiscoveryNativePlugin>('Discovery');

/**
 * Starts multi-channel auto-discovery:
 * 1. Native mDNS / Zeroconf via NsdManager (on Android / native)
 * 2. HTTP probe against current host / subnet fallback (for browsers / web PWA)
 * Returns a teardown function to stop scanning.
 */
export function startAutoDiscovery(
  onDevice: (device: DiscoveredDevice) => void,
  onDiagnostics?: (msg: string) => void
): () => void {
  let active = true;
  let listenerHandle: PluginListenerHandle | null = null;
  const seenHosts = new Set<string>();

  // 1. Native Android mDNS
  if (Capacitor.isNativePlatform()) {
    DiscoveryNative.addListener('onDeviceDiscovered', (device) => {
      if (!active) return;
      const key = `${device.host}:${device.port}`;
      if (!seenHosts.has(key)) {
        seenHosts.add(key);
        onDevice(device);
      }
    }).then(handle => {
      listenerHandle = handle;
      DiscoveryNative.startDiscovery().catch(err => {
        console.debug('Native discovery start failed:', err);
      });
    });
  }

  // 2. Local network HTTP probe fallback (probes localhost, window origin, and common subnet IPs)
  const probeHost = async (host: string, port = 8080, scheme: 'http' | 'https' = 'http') => {
    if (!active) return;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 1200);
      const url = `${scheme}://${host}:${port}/discover`;
      const resp = await fetch(url, { signal: controller.signal });
      clearTimeout(timeoutId);

      if (resp.ok) {
        const data = await resp.json();
        const key = `${host}:${port}`;
        if (!seenHosts.has(key)) {
          seenHosts.add(key);
          onDevice({
            name: data.name || host,
            host,
            port,
            scheme: data.scheme || scheme,
            cert: data.cert,
            serverName: data.name
          });
        }
      }
    } catch {
      // Host not responding to probe
    }
  };

  // Probe current origin host if in browser
  if (typeof window !== 'undefined' && window.location.hostname && window.location.hostname !== 'localhost') {
    probeHost(window.location.hostname, parseInt(window.location.port) || 8080);
  }

  // Diagnostics timer: if no device is found within 6s, advise about AP isolation / VPN
  const diagTimeout = setTimeout(() => {
    if (active && seenHosts.size === 0 && onDiagnostics) {
      onDiagnostics('No PC auto-detected. If your Wi-Fi uses AP/Client Isolation or a VPN is active, enter the PC IP manually or scan the QR code.');
    }
  }, 6000);

  return () => {
    active = false;
    clearTimeout(diagTimeout);
    if (listenerHandle) {
      listenerHandle.remove();
    }
    if (Capacitor.isNativePlatform()) {
      DiscoveryNative.stopDiscovery().catch(() => {});
    }
  };
}

