package com.example.app;

import android.Manifest;
import android.app.DownloadManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.webkit.DownloadListener;
import android.webkit.URLUtil;
import android.webkit.WebSettings;
import android.widget.Toast;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.Plugin;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(FileSaverPlugin.class);
        registerPlugin(ForegroundServicePlugin.class);
        registerPlugin(ShareTargetPlugin.class);
        registerPlugin(DiscoveryPlugin.class);
        super.onCreate(savedInstanceState);

        ShareTargetPlugin.handleIncomingIntent(this, getIntent());

        if (Build.VERSION.SDK_INT >= 33) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                ActivityCompat.requestPermissions(this, new String[]{Manifest.permission.POST_NOTIFICATIONS}, 1001);
            }
        }

        try {
            if (getBridge() != null && getBridge().getWebView() != null) {
                WebSettings webSettings = getBridge().getWebView().getSettings();
                if (webSettings != null) {
                    webSettings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
                }
                getBridge().getWebView().setDownloadListener(new DownloadListener() {
                    @Override
                    public void onDownloadStart(String url, String userAgent, String contentDisposition, String mimetype, long contentLength) {
                        try {
                            DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));
                            request.setMimeType(mimetype);
                            String filename = URLUtil.guessFileName(url, contentDisposition, mimetype);
                            request.setTitle(filename);
                            request.setDescription("Downloading " + filename);
                            request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                            request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, filename);
                            DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
                            if (dm != null) {
                                dm.enqueue(request);
                                Toast.makeText(getApplicationContext(), "Downloading " + filename + "...", Toast.LENGTH_SHORT).show();
                            }
                        } catch (Exception e) {
                            e.printStackTrace();
                        }
                    }
                });
            }
        } catch (Exception ignored) {}
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        try {
            if (getBridge() != null) {
                com.getcapacitor.PluginHandle handle = getBridge().getPlugin("ShareTarget");
                if (handle != null && handle.getInstance() instanceof ShareTargetPlugin) {
                    ((ShareTargetPlugin) handle.getInstance()).onNewIntent(intent);
                    return;
                }
            }
        } catch (Exception ignored) {}
        ShareTargetPlugin.handleIncomingIntent(this, intent);
    }
}
