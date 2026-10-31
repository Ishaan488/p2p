package com.example.app;

import android.app.DownloadManager;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.webkit.DownloadListener;
import android.webkit.URLUtil;
import android.widget.Toast;
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

        try {
            if (getBridge() != null && getBridge().getWebView() != null) {
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
