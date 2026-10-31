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

import org.json.JSONObject;

import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@CapacitorPlugin(name = "Discovery")
public class DiscoveryPlugin extends Plugin {

    private static final String TAG = "P2PDiscovery";
    // Android NsdManager service type must NOT have a trailing dot
    private static final String SERVICE_TYPE = "_p2plink._tcp";
    private static final int UDP_DISCOVER_PORT = 8089;
    private static final String DISCOVER_REQ_MSG = "P2P_DISCOVER_REQ";

    private NsdManager nsdManager;
    private NsdManager.DiscoveryListener discoveryListener;
    private WifiManager.MulticastLock multicastLock;
    private boolean isDiscovering = false;
    private ExecutorService udpExecutor;
    private volatile boolean stopUdp = false;

    @Override
    public void load() {
        super.load();
        nsdManager = (NsdManager) getContext().getSystemService(Context.NSD_SERVICE);
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

        // 3. Start Fast UDP Broadcast Ping (works across VLANs and routers that drop multicast)
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
                    try {
                        nsdManager.resolveService(serviceInfo, new NsdManager.ResolveListener() {
                            @Override
                            public void onResolveFailed(NsdServiceInfo serviceInfo, int errorCode) {
                                Log.w(TAG, "Resolve failed for " + serviceInfo.getServiceName() + ": " + errorCode);
                            }

                            @Override
                            public void onServiceResolved(NsdServiceInfo resolved) {
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

    private void startUdpBroadcastDiscovery() {
        udpExecutor = Executors.newSingleThreadExecutor();
        udpExecutor.execute(() -> {
            DatagramSocket socket = null;
            try {
                socket = new DatagramSocket();
                socket.setBroadcast(true);
                socket.setSoTimeout(1200);

                byte[] reqBytes = DISCOVER_REQ_MSG.getBytes(StandardCharsets.UTF_8);
                InetAddress broadcastAddr = InetAddress.getByName("255.255.255.255");
                DatagramPacket sendPacket = new DatagramPacket(reqBytes, reqBytes.length, broadcastAddr, UDP_DISCOVER_PORT);

                // Broadcast 3 times with interval
                for (int attempt = 0; attempt < 3 && !stopUdp; attempt++) {
                    try {
                        socket.send(sendPacket);
                    } catch (Exception ignored) {}

                    long deadline = System.currentTimeMillis() + 1000;
                    byte[] recvBuf = new byte[2048];
                    while (System.currentTimeMillis() < deadline && !stopUdp) {
                        DatagramPacket recvPacket = new DatagramPacket(recvBuf, recvBuf.length);
                        try {
                            socket.receive(recvPacket);
                            String jsonStr = new String(recvPacket.getData(), 0, recvPacket.getLength(), StandardCharsets.UTF_8);
                            JSONObject obj = new JSONObject(jsonStr);

                            JSObject ret = new JSObject();
                            ret.put("name", obj.optString("name", "Desktop"));
                            ret.put("host", recvPacket.getAddress().getHostAddress());
                            ret.put("port", obj.optInt("port", 8080));
                            ret.put("scheme", obj.optString("scheme", "http"));
                            ret.put("cert", obj.optString("cert", ""));
                            ret.put("serverName", obj.optString("name", "Desktop"));

                            notifyListeners("onDeviceDiscovered", ret);
                        } catch (Exception timeout) {
                            break;
                        }
                    }
                    try {
                        Thread.sleep(500);
                    } catch (InterruptedException e) {
                        break;
                    }
                }
            } catch (Exception e) {
                Log.d(TAG, "UDP discovery error: " + e.getMessage());
            } finally {
                if (socket != null && !socket.isClosed()) {
                    socket.close();
                }
            }
        });
    }

    @PluginMethod
    public void stopDiscovery(PluginCall call) {
        stopUdp = true;
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
        call.resolve();
    }
}
