package com.example.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import androidx.core.app.NotificationCompat;

public class TransferForegroundService extends Service {
    private static final String CHANNEL_ID = "p2p_transfer_channel";
    private static final int NOTIFICATION_ID = 2001;
    public static final String ACTION_START = "ACTION_START";
    public static final String ACTION_UPDATE = "ACTION_UPDATE";
    public static final String ACTION_STOP = "ACTION_STOP";
    public static final String EXTRA_TITLE = "EXTRA_TITLE";
    public static final String EXTRA_TEXT = "EXTRA_TEXT";
    public static final String EXTRA_PROGRESS = "EXTRA_PROGRESS"; // int 0-100 or -1

    private PowerManager.WakeLock wakeLock;
    private WifiManager.WifiLock wifiLock;
    private boolean isForegroundActive = false;

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannel();
        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        if (pm != null) {
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "p2plink:transfer_wake_lock");
            wakeLock.setReferenceCounted(false);
        }
        try {
            WifiManager wm = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            if (wm != null) {
                // On API 29+ (including API 34+), use WIFI_MODE_FULL_LOW_LATENCY.
                // Note on Android API 34+ (Android 14+): WIFI_MODE_FULL_HIGH_PERF is deprecated and
                // automatically re-routed by the OS to WIFI_MODE_FULL_LOW_LATENCY.
                // Crucial limitation: Android OS disables low latency Wi-Fi power saving locks
                // when the screen is turned off. A Wi-Fi lock does NOT guarantee screen-off
                // connectivity. CPU execution is maintained separately by PARTIAL_WAKE_LOCK.
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    wifiLock = wm.createWifiLock(WifiManager.WIFI_MODE_FULL_LOW_LATENCY, "p2plink:transfer_wifi_lock");
                } else {
                    wifiLock = wm.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "p2plink:transfer_wifi_lock");
                }
                wifiLock.setReferenceCounted(false);
            }
        } catch (Exception ignored) {}
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null) {
            String action = intent.getAction();
            if (ACTION_STOP.equals(action)) {
                stopTransferService();
                return START_NOT_STICKY;
            }

            String title = intent.getStringExtra(EXTRA_TITLE);
            if (title == null || title.isEmpty()) {
                title = "P2P Link Transfer";
            }
            String text = intent.getStringExtra(EXTRA_TEXT);
            if (text == null || text.isEmpty()) {
                text = "Transfer in progress (screen off safe)";
            }
            int progress = intent.getIntExtra(EXTRA_PROGRESS, -1);

            Notification notification = buildNotification(title, text, progress);

            if (ACTION_START.equals(action) || !isForegroundActive) {
                try {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                        startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
                    } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                        startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
                    } else {
                        startForeground(NOTIFICATION_ID, notification);
                    }
                    isForegroundActive = true;
                } catch (Exception e) {
                    try {
                        startForeground(NOTIFICATION_ID, notification);
                        isForegroundActive = true;
                    } catch (Exception ignored) {}
                }

                if (wakeLock != null && !wakeLock.isHeld()) {
                    try {
                        wakeLock.acquire(60 * 60 * 1000L); // 1 hour timeout safety
                    } catch (Exception ignored) {}
                }
                if (wifiLock != null && !wifiLock.isHeld()) {
                    try {
                        wifiLock.acquire();
                    } catch (Exception ignored) {}
                }
            } else if (ACTION_UPDATE.equals(action) && isForegroundActive) {
                NotificationManager nm = getSystemService(NotificationManager.class);
                if (nm != null) {
                    nm.notify(NOTIFICATION_ID, notification);
                }
            }
        }
        return START_NOT_STICKY;
    }

    private Notification buildNotification(String title, String text, int progress) {
        Intent launchIntent = new Intent(this, MainActivity.class);
        launchIntent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pendingIntent = PendingIntent.getActivity(
                this, 0, launchIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0)
        );

        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle(title)
                .setContentText(text)
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentIntent(pendingIntent)
                .setOngoing(true)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setCategory(NotificationCompat.CATEGORY_SERVICE);

        if (progress >= 0 && progress <= 100) {
            builder.setProgress(100, progress, false);
        } else if (progress == -2) {
            builder.setProgress(100, 0, true);
        }

        return builder.build();
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID,
                    "P2P Link File Transfers",
                    NotificationManager.IMPORTANCE_LOW
            );
            channel.setDescription("Maintains background network socket and prevents Doze sleep during transfers");
            NotificationManager nm = getSystemService(NotificationManager.class);
            if (nm != null) {
                nm.createNotificationChannel(channel);
            }
        }
    }

    private synchronized void releaseLocks() {
        if (wakeLock != null && wakeLock.isHeld()) {
            try {
                wakeLock.release();
            } catch (Exception ignored) {}
        }
        if (wifiLock != null && wifiLock.isHeld()) {
            try {
                wifiLock.release();
            } catch (Exception ignored) {}
        }
    }

    private void stopTransferService() {
        releaseLocks();
        isForegroundActive = false;
        stopForeground(STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    @Override
    public void onDestroy() {
        releaseLocks();
        isForegroundActive = false;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    // Android 15 (API 35+) enforces a 6-hour runtime limit for dataSync foreground services.
    // Handling onTimeout allows the service to stop gracefully and release locks without crashing.
    public void onTimeout(int startId, int fgsType) {
        stopTransferService();
    }
}
