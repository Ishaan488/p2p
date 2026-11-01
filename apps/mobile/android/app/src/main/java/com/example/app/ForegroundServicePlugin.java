package com.example.app;

import android.content.Context;
import android.content.Intent;
import androidx.core.content.ContextCompat;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "ForegroundService")
public class ForegroundServicePlugin extends Plugin {

    private static volatile boolean isServiceRunning = false;
    private static volatile long lastUpdateTimestamp = 0;
    private static final long UPDATE_THROTTLE_MS = 500;

    @PluginMethod
    public void start(PluginCall call) {
        Context context = getContext();
        String title = call.getString("title", "P2P Link Transfer");
        String text = call.getString("text", "Transfer in progress (screen off safe)");
        int progress = call.getInt("progress", -1);

        Intent intent = new Intent(context, TransferForegroundService.class);
        intent.setAction(TransferForegroundService.ACTION_START);
        intent.putExtra(TransferForegroundService.EXTRA_TITLE, title);
        intent.putExtra(TransferForegroundService.EXTRA_TEXT, text);
        intent.putExtra(TransferForegroundService.EXTRA_PROGRESS, progress);

        try {
            ContextCompat.startForegroundService(context, intent);
            isServiceRunning = true;
            lastUpdateTimestamp = System.currentTimeMillis();
            call.resolve();
        } catch (Exception e) {
            call.reject("Failed to start foreground service: " + e.getMessage());
        }
    }

    @PluginMethod
    public void update(PluginCall call) {
        if (!isServiceRunning) {
            call.resolve();
            return;
        }

        int progress = call.getInt("progress", -1);
        long now = System.currentTimeMillis();
        boolean isCrucial = (progress == 0 || progress >= 100 || progress == -2);

        if (!isCrucial && (now - lastUpdateTimestamp < UPDATE_THROTTLE_MS)) {
            // Throttled: drop redundant intermediate progress IPC to system NotificationManager
            call.resolve();
            return;
        }
        lastUpdateTimestamp = now;

        Context context = getContext();
        String title = call.getString("title", "P2P Link Transfer");
        String text = call.getString("text", "Transfer in progress");

        Intent intent = new Intent(context, TransferForegroundService.class);
        intent.setAction(TransferForegroundService.ACTION_UPDATE);
        intent.putExtra(TransferForegroundService.EXTRA_TITLE, title);
        intent.putExtra(TransferForegroundService.EXTRA_TEXT, text);
        intent.putExtra(TransferForegroundService.EXTRA_PROGRESS, progress);

        try {
            // Send update intent to existing running service without invoking startForegroundService() contract
            context.startService(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject("Failed to update foreground service: " + e.getMessage());
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        Context context = getContext();
        Intent intent = new Intent(context, TransferForegroundService.class);
        intent.setAction(TransferForegroundService.ACTION_STOP);
        try {
            context.startService(intent);
            isServiceRunning = false;
            lastUpdateTimestamp = 0;
            call.resolve();
        } catch (Exception e) {
            call.reject("Failed to stop foreground service: " + e.getMessage());
        }
    }
}
