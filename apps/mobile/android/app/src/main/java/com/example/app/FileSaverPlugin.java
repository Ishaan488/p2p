package com.example.app;

import android.app.DownloadManager;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.widget.Toast;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;

@CapacitorPlugin(name = "FileSaver")
public class FileSaverPlugin extends Plugin {

    @PluginMethod
    public void saveToDownloads(PluginCall call) {
        String filename = call.getString("filename");
        String base64Data = call.getString("base64Data");
        String mimeType = call.getString("mimeType");
        if (mimeType == null || mimeType.trim().isEmpty()) {
            mimeType = "application/octet-stream";
        }

        if (filename == null || filename.trim().isEmpty() || base64Data == null || base64Data.trim().isEmpty()) {
            call.reject("Filename and base64Data are required");
            return;
        }

        try {
            // Strip data URL scheme prefix if present (e.g. data:image/png;base64,...)
            int commaIdx = base64Data.indexOf(',');
            if (commaIdx >= 0) {
                base64Data = base64Data.substring(commaIdx + 1);
            }

            byte[] bytes = Base64.decode(base64Data, Base64.DEFAULT);
            boolean saved = false;
            String savedPath = "";

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ContentResolver resolver = getContext().getContentResolver();
                ContentValues contentValues = new ContentValues();
                contentValues.put(MediaStore.MediaColumns.DISPLAY_NAME, filename);
                contentValues.put(MediaStore.MediaColumns.MIME_TYPE, mimeType);
                contentValues.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);

                Uri uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, contentValues);
                if (uri != null) {
                    try (OutputStream os = resolver.openOutputStream(uri)) {
                        if (os != null) {
                            os.write(bytes);
                            os.flush();
                            saved = true;
                            savedPath = Environment.DIRECTORY_DOWNLOADS + "/" + filename;
                        }
                    }
                }
            } else {
                File dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
                if (!dir.exists()) {
                    dir.mkdirs();
                }
                File targetFile = new File(dir, filename);
                try (FileOutputStream fos = new FileOutputStream(targetFile)) {
                    fos.write(bytes);
                    fos.flush();
                    saved = true;
                    savedPath = targetFile.getAbsolutePath();
                }
                MediaScannerConnection.scanFile(getContext(), new String[]{targetFile.getAbsolutePath()}, null, null);
            }

            if (saved) {
                final String displayName = filename;
                if (getActivity() != null) {
                    getActivity().runOnUiThread(() -> 
                        Toast.makeText(getContext(), "Saved to Downloads: " + displayName, Toast.LENGTH_SHORT).show()
                    );
                }

                JSObject ret = new JSObject();
                ret.put("success", true);
                ret.put("path", savedPath);
                call.resolve(ret);
            } else {
                call.reject("Could not write file to Downloads directory");
            }
        } catch (Exception e) {
            call.reject("Failed to save file: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void downloadWithSystemManager(PluginCall call) {
        String urlStr = call.getString("url");
        String filename = call.getString("filename");
        String mimeType = call.getString("mimeType");

        if (urlStr == null || urlStr.trim().isEmpty()) {
            call.reject("Download URL is required");
            return;
        }
        if (filename == null || filename.trim().isEmpty()) {
            filename = "download";
        }
        if (mimeType == null || mimeType.trim().isEmpty()) {
            mimeType = "*/*";
        }

        try {
            DownloadManager.Request request = new DownloadManager.Request(Uri.parse(urlStr));
            request.setMimeType(mimeType);
            request.setTitle(filename);
            request.setDescription("P2P Link file transfer");
            request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, filename);

            DownloadManager manager = (DownloadManager) getContext().getSystemService(Context.DOWNLOAD_SERVICE);
            if (manager != null) {
                manager.enqueue(request);
                final String displayName = filename;
                if (getActivity() != null) {
                    getActivity().runOnUiThread(() ->
                        Toast.makeText(getContext(), "Downloading " + displayName + "...", Toast.LENGTH_SHORT).show()
                    );
                }

                JSObject ret = new JSObject();
                ret.put("enqueued", true);
                call.resolve(ret);
            } else {
                call.reject("System DownloadManager not available");
            }
        } catch (Exception e) {
            call.reject("DownloadManager error: " + e.getMessage(), e);
        }
    }
}

