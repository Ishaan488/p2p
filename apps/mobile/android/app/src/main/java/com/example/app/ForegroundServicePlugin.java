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
            call.resolve();
        } catch (Exception e) {
            call.reject("Failed to start foreground service: " + e.getMessage());
        }
    }

    @PluginMethod
    public void update(PluginCall call) {
        Context context = getContext();
        String title = call.getString("title", "P2P Link Transfer");
        String text = call.getString("text", "Transfer in progress");
        int progress = call.getInt("progress", -1);

        Intent intent = new Intent(context, TransferForegroundService.class);
        intent.setAction(TransferForegroundService.ACTION_UPDATE);
        intent.putExtra(TransferForegroundService.EXTRA_TITLE, title);
        intent.putExtra(TransferForegroundService.EXTRA_TEXT, text);
        intent.putExtra(TransferForegroundService.EXTRA_PROGRESS, progress);

        try {
            ContextCompat.startForegroundService(context, intent);
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
            call.resolve();
        } catch (Exception e) {
            call.reject("Failed to stop foreground service: " + e.getMessage());
        }
    }
}

