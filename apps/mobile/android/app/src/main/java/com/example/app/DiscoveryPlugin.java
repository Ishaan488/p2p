package com.example.app;

import android.content.Context;
import android.net.DhcpInfo;
import android.net.nsd.NsdManager;
import android.net.nsd.NsdServiceInfo;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.util.Log;

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
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
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
    private static final long NOTIFY_REFRESH_MS = 3000;

    private NsdManager nsdManager;
    private NsdManager.DiscoveryListener discoveryListener;
    private WifiManager.MulticastLock multicastLock;
    private boolean isDiscovering = false;
    private ExecutorService udpExecutor;
    private volatile DatagramSocket udpSocket;
    private final Map<String, Notified> notified = new ConcurrentHashMap<>();
    private volatile boolean stopUdp = false;
    private final AtomicBoolean isResolvingNsd = new AtomicBoolean(false);

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
        if (isDiscovering) {
            call.resolve();
            return;
        }
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

        // 3. Start Continuous Fast UDP Broadcast Ping (works across VLANs and routers that drop multicast)
        startUdpBroadcastDiscovery();

        call.resolve();
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
                    if (!isResolvingNsd.compareAndSet(false, true)) {
                        // Skip if a resolve is currently in-flight to prevent FAILURE_ALREADY_ACTIVE
                        return;
                    }
                    try {
                        nsdManager.resolveService(serviceInfo, new NsdManager.ResolveListener() {
                            @Override
                            public void onResolveFailed(NsdServiceInfo serviceInfo, int errorCode) {
                                isResolvingNsd.set(false);
                                Log.w(TAG, "Resolve failed for " + serviceInfo.getServiceName() + ": " + errorCode);
                            }

                            @Override
                            public void onServiceResolved(NsdServiceInfo resolved) {
                                isResolvingNsd.set(false);
                                InetAddress host = resolved.getHost();
                                if (host == null) return;

                                JSObject ret = new JSObject();
                                ret.put("name", resolved.getServiceName());
                                ret.put("host", host.getHostAddress());
                                ret.put("port", resolved.getPort());

                                String scheme = "http";
                                String certFP = "";
                                String pcName = resolved.getServiceName();

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
                                    }
                                }

                                ret.put("scheme", scheme);
                                ret.put("cert", certFP);
                                ret.put("serverName", pcName);

                                notifyListeners("onDeviceDiscovered", ret);
                            }
                        });
                    } catch (Exception e) {
                        isResolvingNsd.set(false);
                        Log.w(TAG, "Error invoking resolveService: " + e.getMessage());
                    }
                }
            }

            @Override
            public void onServiceLost(NsdServiceInfo serviceInfo) {
                Log.d(TAG, "mDNS Service lost: " + serviceInfo.getServiceName());
                JSObject ret = new JSObject();
                ret.put("name", serviceInfo.getServiceName());
                notifyListeners("onDeviceLost", ret);
            }
        };

        try {
            nsdManager.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, discoveryListener);
        } catch (Exception e) {
            Log.w(TAG, "Failed to start NSD discovery: " + e.getMessage());
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

    /**
     * UDP presence channel. One socket bound to the discovery port receives the PC's
     * unsolicited announcements (sent on start, then every few seconds) and goodbyes
     * ("bye" on a clean exit), so the list updates the moment a PC appears or leaves.
     * Because announcements scale linearly with the number of PCs, requests are only
     * sent as a short burst at the start to find PCs that announced before we listened.
     */
    private void startUdpBroadcastDiscovery() {
        final DatagramSocket socket = openDiscoverySocket();
        if (socket == null) return;
        udpSocket = socket;
        notified.clear();
        udpExecutor = Executors.newFixedThreadPool(2);

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

            if ("bye".equals(obj.optString("type"))) {
                notified.remove(keyFor(id, host, obj.optInt("port", 0)));
                JSObject lost = new JSObject();
                lost.put("id", id);
                lost.put("host", host);
                lost.put("name", obj.optString("name", ""));
                notifyListeners("onDeviceLost", lost);
                return;
            }
            if (!obj.has("port")) return;

            int port = obj.optInt("port", 8080);
            String name = obj.optString("name", "Desktop");
            String scheme = obj.optString("scheme", "http");
            String cert = obj.optString("cert", "");

            // Heartbeats arrive every few seconds from every PC; only cross the JS
            // bridge when something changed or the JS side needs a liveness refresh.
            String key = keyFor(id, host, port);
            String fingerprint = host + "|" + port + "|" + name + "|" + scheme + "|" + cert;
            long now = System.currentTimeMillis();
            Notified previous = notified.get(key);
            if (previous != null && previous.fingerprint.equals(fingerprint) && now - previous.at < NOTIFY_REFRESH_MS) {
                return;
            }
            notified.put(key, new Notified(fingerprint, now));

            JSObject ret = new JSObject();
            ret.put("name", name);
            ret.put("host", host);
            ret.put("port", port);
            ret.put("scheme", scheme);
            ret.put("cert", cert);
            ret.put("serverName", name);
            if (!id.isEmpty()) ret.put("id", id);
            JSONArray ips = obj.optJSONArray("ips");
            if (ips != null) ret.put("ips", ips);
            notifyListeners("onDeviceDiscovered", ret);
        } catch (Exception e) {
            Log.d(TAG, "UDP parse error: " + e.getMessage());
        }
    }

    private static String keyFor(String id, String host, int port) {
        return id != null && !id.isEmpty() ? id : host + ":" + port;
    }

    private static final class Notified {
        final String fingerprint;
        final long at;

        Notified(String fingerprint, long at) {
            this.fingerprint = fingerprint;
            this.at = at;
        }
    }

    @PluginMethod
    public void stopDiscovery(PluginCall call) {
        stopAllDiscovery();
        call.resolve();
    }

    /** Release the UDP thread, NSD listener and multicast lock if the WebView/activity goes away. */
    @Override
    protected void handleOnDestroy() {
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
        isResolvingNsd.set(false);
    }
}
