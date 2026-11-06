package com.example.app;

import android.content.Context;
import android.net.DhcpInfo;
import android.net.nsd.NsdManager;
import android.net.nsd.NsdServiceInfo;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.util.Log;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONObject;

import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.MulticastSocket;
import java.net.InterfaceAddress;
import java.net.NetworkInterface;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Enumeration;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

@CapacitorPlugin(name = "Discovery")
public class DiscoveryPlugin extends Plugin {

    private static final String TAG = "P2PDiscovery";
    // Android NsdManager service type must NOT have a trailing dot
    private static final String SERVICE_TYPE = "_p2plink._tcp";
    private static final int UDP_DISCOVER_PORT = 8089;
    private static final String DISCOVER_REQ_MSG = "P2P_DISCOVER_REQ";
    private static final String MULTICAST_GROUP = "224.0.0.167";
    private static final int REQUEST_BURSTS = 4;
    private static final long REQUEST_BURST_GAP_MS = 2000;
    // A PC that is unchanged is re-sent to JS this often, so any lost JS-side state heals itself.
    private static final long NOTIFY_REFRESH_MS = 8000;
    private static final long ALIVE_FLUSH_MS = 500;
    private static final long STATE_RETAIN_MS = 60_000;
    private static final int MAX_STATES = 512;

    private NsdManager nsdManager;
    private NsdManager.DiscoveryListener discoveryListener;
    private WifiManager.MulticastLock multicastLock;
    private boolean isDiscovering = false;
    private ExecutorService udpExecutor;
    private volatile DatagramSocket udpSocket;
    private final Object stateLock = new Object();
    private final Map<String, Seen> states = new HashMap<>(); // guarded by stateLock
    private final Set<String> aliveBatch = ConcurrentHashMap.newKeySet();
    private ScheduledExecutorService ticker;
    // Discovery was asked for by the app; it is paused (not forgotten) while backgrounded.
    private volatile boolean wantDiscovery = false;
    private volatile boolean stopUdp = false;
    private final AtomicBoolean isResolvingNsd = new AtomicBoolean(false);
    private final ConcurrentLinkedQueue<NsdServiceInfo> nsdResolveQueue = new ConcurrentLinkedQueue<>();

    @Override
    public void load() {
        super.load();
        nsdManager = (NsdManager) getContext().getSystemService(Context.NSD_SERVICE);
    }

    /**
     * getNetworkInfo provides the device's local Wi-Fi / LAN IP, subnet prefix,
     * and broadcast address to the TypeScript discovery client for fast subnet HTTP scanning.
     */
    @PluginMethod
    public void getNetworkInfo(PluginCall call) {
        JSObject ret = new JSObject();
        try {
            String localIp = null;
            String subnetPrefix = null;
            String broadcastIp = null;
            int prefixLength = 24;

            Enumeration<NetworkInterface> interfaces = NetworkInterface.getNetworkInterfaces();
            if (interfaces != null) {
                while (interfaces.hasMoreElements()) {
                    NetworkInterface iface = interfaces.nextElement();
                    if (iface.isLoopback() || !iface.isUp() || iface.isVirtual()) {
                        continue;
                    }
                    String ifaceName = iface.getName().toLowerCase();
                    for (InterfaceAddress addr : iface.getInterfaceAddresses()) {
                        InetAddress inet = addr.getAddress();
                        if (inet instanceof java.net.Inet4Address && !inet.isLoopbackAddress()) {
                            String ipStr = inet.getHostAddress();
                            if (ipStr.startsWith("192.168.") || ipStr.startsWith("10.") || ipStr.startsWith("172.")) {
                                localIp = ipStr;
                                short pLen = addr.getNetworkPrefixLength();
                                if (pLen > 0 && pLen <= 32) {
                                    prefixLength = pLen;
                                }
                                InetAddress bcast = addr.getBroadcast();
                                if (bcast != null) {
                                    broadcastIp = bcast.getHostAddress();
                                }
                                if (ifaceName.contains("wlan") || ifaceName.contains("wifi") || ifaceName.contains("p2p")) {
                                    break;
                                }
                            }
                        }
                    }
                    if (localIp != null && (ifaceName.contains("wlan") || ifaceName.contains("wifi"))) {
                        break;
                    }
                }
            }

            if (localIp == null) {
                WifiManager wifi = (WifiManager) getContext().getApplicationContext().getSystemService(Context.WIFI_SERVICE);
                if (wifi != null && wifi.getConnectionInfo() != null) {
                    int ipInt = wifi.getConnectionInfo().getIpAddress();
                    if (ipInt != 0) {
                        localIp = String.format("%d.%d.%d.%d",
                            (ipInt & 0xff),
                            (ipInt >> 8 & 0xff),
                            (ipInt >> 16 & 0xff),
                            (ipInt >> 24 & 0xff));
                    }
                }
            }

            if (localIp != null) {
                ret.put("ip", localIp);
                int lastDot = localIp.lastIndexOf('.');
                if (lastDot > 0) {
                    subnetPrefix = localIp.substring(0, lastDot + 1);
                }
                ret.put("subnet", subnetPrefix);
                ret.put("prefixLength", prefixLength);
                if (broadcastIp != null) {
                    ret.put("broadcast", broadcastIp);
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "Error obtaining network info: " + e.getMessage());
        }
        call.resolve(ret);
    }

    @PluginMethod
    public void startDiscovery(PluginCall call) {
        wantDiscovery = true;
        startDiscoveryInternal();
        call.resolve();
    }

    /** Rebinds the sockets (e.g. after a Wi-Fi change) without losing track of whether discovery is wanted. */
    @PluginMethod
    public void restartDiscovery(PluginCall call) {
        stopAllDiscovery();
        if (wantDiscovery) startDiscoveryInternal();
        call.resolve();
    }

    private synchronized void startDiscoveryInternal() {
        if (isDiscovering) return;
        isDiscovering = true;
        stopUdp = false;

        // 1. Acquire Wi-Fi Multicast Lock so Android kernel does not drop mDNS packets
        try {
            WifiManager wifi = (WifiManager) getContext().getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            if (wifi != null) {
                multicastLock = wifi.createMulticastLock("p2p_multicast_lock");
                multicastLock.setReferenceCounted(true);
                multicastLock.acquire();
            }
        } catch (Exception e) {
            Log.w(TAG, "Could not acquire MulticastLock: " + e.getMessage());
        }

        // 2. Start Android Native mDNS Discovery
        startNsdDiscovery();

        // 3. UDP announcements/goodbyes (works where multicast is dropped by the router)
        startUdpBroadcastDiscovery();
    }

    private void startNsdDiscovery() {
        if (nsdManager == null) return;

        discoveryListener = new NsdManager.DiscoveryListener() {
            @Override
            public void onStartDiscoveryFailed(String serviceType, int errorCode) {
                Log.e(TAG, "Discovery failed to start: " + errorCode);
            }

            @Override
            public void onStopDiscoveryFailed(String serviceType, int errorCode) {
                Log.e(TAG, "Discovery failed to stop: " + errorCode);
            }

            @Override
            public void onDiscoveryStarted(String serviceType) {
                Log.d(TAG, "mDNS Service discovery started for " + serviceType);
            }

            @Override
            public void onDiscoveryStopped(String serviceType) {
                Log.d(TAG, "mDNS Service discovery stopped");
            }

            @Override
            public void onServiceFound(NsdServiceInfo serviceInfo) {
                Log.d(TAG, "Found mDNS service: " + serviceInfo.getServiceName());
                if (serviceInfo.getServiceType() != null && serviceInfo.getServiceType().contains("_p2plink._tcp")) {
                    nsdResolveQueue.offer(serviceInfo);
                    drainNsdResolveQueue();
                }
            }

            @Override
            public void onServiceLost(NsdServiceInfo serviceInfo) {
                Log.d(TAG, "mDNS Service lost: " + serviceInfo.getServiceName());
                JSObject ret = new JSObject();
                ret.put("nsdName", serviceInfo.getServiceName());
                notifyListeners("onDeviceLost", ret);
            }
        };

        try {
            nsdManager.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, discoveryListener);
        } catch (Exception e) {
            Log.w(TAG, "Failed to start NSD discovery: " + e.getMessage());
        }
    }

    private void drainNsdResolveQueue() {
        if (nsdManager == null || !isDiscovering) return;
        if (!isResolvingNsd.compareAndSet(false, true)) {
            return;
        }
        NsdServiceInfo next = nsdResolveQueue.poll();
        if (next == null) {
            isResolvingNsd.set(false);
            return;
        }
        try {
            nsdManager.resolveService(next, new NsdManager.ResolveListener() {
                @Override
                public void onResolveFailed(NsdServiceInfo serviceInfo, int errorCode) {
                    isResolvingNsd.set(false);
                    Log.w(TAG, "Resolve failed for " + serviceInfo.getServiceName() + ": " + errorCode);
                    drainNsdResolveQueue();
                }

                @Override
                public void onServiceResolved(NsdServiceInfo resolved) {
                    isResolvingNsd.set(false);
                    try {
                        InetAddress host = resolved.getHost();
                        if (host != null) {
                            JSObject ret = new JSObject();
                            ret.put("host", host.getHostAddress());
                            ret.put("port", resolved.getPort());

                            String scheme = "http";
                            String certFP = "";
                            String pcName = resolved.getServiceName();
                            String pcId = "";

                            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                                Map<String, byte[]> attributes = resolved.getAttributes();
                                if (attributes != null) {
                                    if (attributes.containsKey("scheme")) {
                                        scheme = new String(attributes.get("scheme"), StandardCharsets.UTF_8);
                                    }
                                    if (attributes.containsKey("cert")) {
                                        certFP = new String(attributes.get("cert"), StandardCharsets.UTF_8);
                                    }
                                    if (attributes.containsKey("name")) {
                                        pcName = new String(attributes.get("name"), StandardCharsets.UTF_8);
                                    }
                                    if (attributes.containsKey("id")) {
                                        pcId = new String(attributes.get("id"), StandardCharsets.UTF_8);
                                    }
                                }
                            }

                            ret.put("scheme", scheme);
                            ret.put("cert", certFP);
                            ret.put("name", pcName);
                            ret.put("serverName", pcName);
                            ret.put("nsdName", resolved.getServiceName());
                            if (!pcId.isEmpty()) ret.put("id", pcId);

                            notifyListeners("onDeviceDiscovered", ret);
                        }
                    } finally {
                        drainNsdResolveQueue();
                    }
                }
            });
        } catch (Exception e) {
            isResolvingNsd.set(false);
            Log.w(TAG, "Error invoking resolveService: " + e.getMessage());
            drainNsdResolveQueue();
        }
    }

    private List<InetAddress> getAllBroadcastAddresses() {
        List<InetAddress> list = new ArrayList<>();
        try {
            Enumeration<NetworkInterface> interfaces = NetworkInterface.getNetworkInterfaces();
            if (interfaces != null) {
                while (interfaces.hasMoreElements()) {
                    NetworkInterface iface = interfaces.nextElement();
                    if (iface.isLoopback() || !iface.isUp()) continue;
                    for (InterfaceAddress ifaceAddr : iface.getInterfaceAddresses()) {
                        InetAddress bcast = ifaceAddr.getBroadcast();
                        if (bcast != null && !list.contains(bcast)) {
                            list.add(bcast);
                        }
                    }
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "Error enumerating broadcast addresses: " + e.getMessage());
        }
        try {
            InetAddress generic = InetAddress.getByName("255.255.255.255");
            if (!list.contains(generic)) {
                list.add(generic);
            }
        } catch (Exception ignored) {}
        return list;
    }

    /** What is remembered about a PC heard over UDP, for ordering and de-duplication. */
    private static final class Seen {
        long boot;
        long seq;
        boolean alive;
        String fingerprint;
        long notifiedAt;
        long lastMs;
    }

    /**
     * True when a datagram is older than what was already seen from that PC: it was
     * sent before a newer one (reordered), or by an earlier run of the PC. A goodbye
     * is stored with the highest seq, so an announce sent before it is "older" too and
     * cannot resurrect the PC. Packets without boot/seq (older PCs) are never older.
     */
    private static boolean isOlder(Seen seen, long boot, long seq) {
        if (seen.boot == 0 || boot == 0) return false;
        if (boot < seen.boot) return true;
        return boot == seen.boot && seq != 0 && seq < seen.seq;
    }

    /**
     * UDP presence channel. One socket bound to the discovery port receives the PC's
     * unsolicited announcements (every 1-2 s) and goodbyes, so the list updates the moment
     * a PC appears or leaves. Requests are only sent as a short burst at the start, to
     * find PCs that announced before we listened.
     *
     * Only changes cross the WebView bridge (appeared / changed / left). Liveness is sent
     * as ONE batched event every 500 ms listing the keys heard from, so the bridge cost
     * does not grow with the number of PCs on the network.
     */
    private void startUdpBroadcastDiscovery() {
        final DatagramSocket socket = openDiscoverySocket();
        if (socket == null) return;
        udpSocket = socket;
        aliveBatch.clear();
        udpExecutor = Executors.newFixedThreadPool(2);
        ticker = Executors.newSingleThreadScheduledExecutor();
        ticker.scheduleWithFixedDelay(this::flushAlive, ALIVE_FLUSH_MS, ALIVE_FLUSH_MS, TimeUnit.MILLISECONDS);

        // Receiver: blocks until stopAllDiscovery() closes the socket.
        udpExecutor.execute(() -> {
            byte[] recvBuf = new byte[2048];
            while (!stopUdp && !socket.isClosed()) {
                DatagramPacket packet = new DatagramPacket(recvBuf, recvBuf.length);
                try {
                    socket.receive(packet);
                    handleDatagram(packet);
                } catch (Exception e) {
                    if (stopUdp || socket.isClosed()) break;
                    Log.d(TAG, "UDP receive error: " + e.getMessage());
                }
            }
        });

        // Sender: a few request bursts, then listen-only.
        udpExecutor.execute(() -> {
            byte[] reqBytes = DISCOVER_REQ_MSG.getBytes(StandardCharsets.UTF_8);
            for (int round = 0; round < REQUEST_BURSTS && !stopUdp; round++) {
                sendRequest(socket, reqBytes);
                try {
                    Thread.sleep(REQUEST_BURST_GAP_MS);
                } catch (InterruptedException e) {
                    return;
                }
            }
        });
    }

    /** Binds the shared discovery port (to receive broadcasts); falls back to any free port. */
    private DatagramSocket openDiscoverySocket() {
        try {
            MulticastSocket ms = new MulticastSocket(null);
            ms.setReuseAddress(true);
            ms.bind(new InetSocketAddress(UDP_DISCOVER_PORT));
            ms.setBroadcast(true);
            try {
                ms.joinGroup(InetAddress.getByName(MULTICAST_GROUP));
            } catch (Exception e) {
                Log.d(TAG, "Could not join multicast group: " + e.getMessage());
            }
            return ms;
        } catch (Exception e) {
            Log.w(TAG, "Discovery port busy, using an ephemeral port (announcements may be missed): " + e.getMessage());
        }
        try {
            DatagramSocket fallback = new DatagramSocket();
            fallback.setBroadcast(true);
            return fallback;
        } catch (Exception e) {
            Log.w(TAG, "UDP discovery unavailable: " + e.getMessage());
            return null;
        }
    }

    private void sendRequest(DatagramSocket socket, byte[] reqBytes) {
        for (InetAddress bcast : getAllBroadcastAddresses()) {
            try {
                socket.send(new DatagramPacket(reqBytes, reqBytes.length, bcast, UDP_DISCOVER_PORT));
            } catch (Exception ignored) {}
        }
        try {
            InetAddress mcast = InetAddress.getByName(MULTICAST_GROUP);
            socket.send(new DatagramPacket(reqBytes, reqBytes.length, mcast, UDP_DISCOVER_PORT));
        } catch (Exception ignored) {}
    }

    private void handleDatagram(DatagramPacket packet) {
        String json = new String(packet.getData(), 0, packet.getLength(), StandardCharsets.UTF_8).trim();
        if (!json.startsWith("{")) return; // includes our own "P2P_DISCOVER_REQ" echo
        try {
            JSONObject obj = new JSONObject(json);
            String host = packet.getAddress().getHostAddress();
            String id = obj.optString("id", "");
            long boot = obj.optLong("boot", 0);
            long seq = obj.optLong("seq", 0);
            int port = obj.optInt("port", 0);
            String key = keyFor(id, host, port);
            long now = System.currentTimeMillis();

            if ("bye".equals(obj.optString("type"))) {
                synchronized (stateLock) {
                    Seen seen = states.get(key);
                    if (seen == null) {
                        seen = new Seen();
                        states.put(key, seen);
                    } else if (isOlder(seen, boot, seq)) {
                        return; // a goodbye that a newer announce already overtook
                    }
                    seen.boot = boot;
                    seen.seq = seq;
                    seen.alive = false;
                    seen.fingerprint = null;
                    seen.lastMs = now;
                }
                aliveBatch.remove(key);
                JSObject lost = new JSObject();
                lost.put("id", id);
                lost.put("host", host);
                lost.put("name", obj.optString("name", ""));
                lost.put("boot", boot);
                lost.put("seq", seq);
                notifyListeners("onDeviceLost", lost);
                return;
            }
            if (!obj.has("port")) return;

            String name = obj.optString("name", "Desktop");
            String scheme = obj.optString("scheme", "http");
            String cert = obj.optString("cert", "");
            String fingerprint = host + "|" + port + "|" + name + "|" + scheme + "|" + cert;

            boolean emit;
            synchronized (stateLock) {
                Seen seen = states.get(key);
                boolean first = seen == null;
                if (first) {
                    seen = new Seen();
                    states.put(key, seen);
                } else if (isOlder(seen, boot, seq)) {
                    return; // reordered, or sent before a goodbye / by an earlier run of the PC
                }
                boolean wasAlive = seen.alive;
                if (boot != 0) seen.boot = boot;
                if (seq > seen.seq || boot > seen.boot) seen.seq = seq;
                seen.alive = true;
                seen.lastMs = now;
                // The same announce arrives once per broadcast address: only a new PC, a changed
                // one, one back from a goodbye, or a slow self-healing refresh is forwarded.
                emit = first || !wasAlive || !fingerprint.equals(seen.fingerprint) || now - seen.notifiedAt >= NOTIFY_REFRESH_MS;
                if (emit) {
                    seen.fingerprint = fingerprint;
                    seen.notifiedAt = now;
                }
            }
            aliveBatch.add(key);
            if (!emit) return;

            JSObject ret = new JSObject();
            ret.put("name", name);
            ret.put("host", host);
            ret.put("port", port);
            ret.put("scheme", scheme);
            ret.put("cert", cert);
            ret.put("serverName", name);
            if (!id.isEmpty()) ret.put("id", id);
            if (boot != 0) ret.put("boot", boot);
            if (seq != 0) ret.put("seq", seq);
            JSONArray ips = obj.optJSONArray("ips");
            if (ips != null) ret.put("ips", ips);
            notifyListeners("onDeviceDiscovered", ret);
        } catch (Exception e) {
            Log.d(TAG, "UDP parse error: " + e.getMessage());
        }
    }

    /** Sends the keys heard from since the last tick as one event, and trims old state. */
    private void flushAlive() {
        try {
            long now = System.currentTimeMillis();
            synchronized (stateLock) {
                Iterator<Map.Entry<String, Seen>> it = states.entrySet().iterator();
                while (it.hasNext()) {
                    if (now - it.next().getValue().lastMs > STATE_RETAIN_MS) it.remove();
                }
                while (states.size() > MAX_STATES) {
                    String oldest = null;
                    long oldestMs = Long.MAX_VALUE;
                    for (Map.Entry<String, Seen> e : states.entrySet()) {
                        if (e.getValue().lastMs < oldestMs) {
                            oldestMs = e.getValue().lastMs;
                            oldest = e.getKey();
                        }
                    }
                    if (oldest == null) break;
                    states.remove(oldest);
                }
            }
            if (aliveBatch.isEmpty()) return;
            JSArray keys = new JSArray();
            Iterator<String> it = aliveBatch.iterator();
            while (it.hasNext()) {
                keys.put(it.next());
                it.remove();
            }
            JSObject ret = new JSObject();
            ret.put("keys", keys);
            notifyListeners("onDevicesAlive", ret);
        } catch (Exception e) {
            Log.d(TAG, "flushAlive error: " + e.getMessage());
        }
    }

    // Same format as deviceKey() in discoveryRegistry.ts.
    private static String keyFor(String id, String host, int port) {
        return id != null && !id.isEmpty() ? "id:" + id : "addr:" + host + ":" + port;
    }

    @PluginMethod
    public void stopDiscovery(PluginCall call) {
        wantDiscovery = false;
        stopAllDiscovery();
        synchronized (stateLock) {
            states.clear();
        }
        call.resolve();
    }

    /** Backgrounded: release the sockets, threads and multicast lock (battery) but remember we want discovery. */
    @Override
    protected void handleOnPause() {
        stopAllDiscovery();
        super.handleOnPause();
    }

    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        if (wantDiscovery) startDiscoveryInternal();
    }

    /** Release the UDP thread, NSD listener and multicast lock if the WebView/activity goes away. */
    @Override
    protected void handleOnDestroy() {
        wantDiscovery = false;
        stopAllDiscovery();
        super.handleOnDestroy();
    }

    private synchronized void stopAllDiscovery() {
        stopUdp = true;
        DatagramSocket socket = udpSocket;
        udpSocket = null;
        if (socket != null) {
            socket.close(); // unblocks the receiver thread
        }
        if (udpExecutor != null) {
            udpExecutor.shutdownNow();
            udpExecutor = null;
        }
        if (ticker != null) {
            ticker.shutdownNow();
            ticker = null;
        }
        aliveBatch.clear();

        if (nsdManager != null && discoveryListener != null) {
            try {
                nsdManager.stopServiceDiscovery(discoveryListener);
            } catch (Exception ignored) {}
            discoveryListener = null;
        }

        if (multicastLock != null && multicastLock.isHeld()) {
            try {
                multicastLock.release();
            } catch (Exception ignored) {}
            multicastLock = null;
        }

        isDiscovering = false;
        nsdResolveQueue.clear();
        isResolvingNsd.set(false);
    }
}
