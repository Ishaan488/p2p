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

    private String sanitizeSubDir(String subDir) {
        if (subDir == null) return "";
        String cleaned = subDir.replace('\\', '/').trim();
        while (cleaned.startsWith("/")) cleaned = cleaned.substring(1);
        while (cleaned.endsWith("/")) cleaned = cleaned.substring(0, cleaned.length() - 1);
        if (cleaned.contains("..") || cleaned.isEmpty()) {
            return "";
        }
        return cleaned.replaceAll("[<>:\"|?*]", "_");
    }

    @PluginMethod
    public void saveToDownloads(PluginCall call) {
        String filename = call.getString("filename");
        String base64Data = call.getString("base64Data");
        String mimeType = call.getString("mimeType");
        String subDir = sanitizeSubDir(call.getString("subDir"));

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
            String relativeDir = subDir.isEmpty()
                    ? Environment.DIRECTORY_DOWNLOADS
                    : (Environment.DIRECTORY_DOWNLOADS + "/" + subDir);

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ContentResolver resolver = getContext().getContentResolver();
                ContentValues contentValues = new ContentValues();
                contentValues.put(MediaStore.MediaColumns.DISPLAY_NAME, filename);
                contentValues.put(MediaStore.MediaColumns.MIME_TYPE, mimeType);
                contentValues.put(MediaStore.MediaColumns.RELATIVE_PATH, relativeDir);
                contentValues.put(MediaStore.MediaColumns.IS_PENDING, 1);

                Uri uri = null;
                try {
                    uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, contentValues);
                } catch (Exception ex) {
                    // Fallback handled below
                }

                if (uri != null) {
                    try (OutputStream os = resolver.openOutputStream(uri)) {
                        if (os != null) {
                            os.write(bytes);
                            os.flush();
                            saved = true;
                            savedPath = relativeDir + "/" + filename;
                        }
                    }
                    contentValues.clear();
                    contentValues.put(MediaStore.MediaColumns.IS_PENDING, 0);
                    resolver.update(uri, contentValues, null, null);
                }
            }

            // Fallback for Android < Q or if MediaStore insert returned null
            if (!saved) {
                File dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
                if (!subDir.isEmpty()) {
                    dir = new File(dir, subDir);
                }
                if (!dir.exists()) {
                    dir.mkdirs();
                }
                File targetFile = new File(dir, filename);
                if (targetFile.exists()) {
                    String base = filename;
                    String ext = "";
                    int dot = filename.lastIndexOf('.');
                    if (dot > 0) {
                        base = filename.substring(0, dot);
                        ext = filename.substring(dot);
                    }
                    int counter = 1;
                    while (targetFile.exists() && counter < 1000) {
                        targetFile = new File(dir, base + " (" + counter + ")" + ext);
                        counter++;
                    }
                }
                try (FileOutputStream fos = new FileOutputStream(targetFile)) {
                    fos.write(bytes);
                    fos.flush();
                    saved = true;
                    savedPath = targetFile.getAbsolutePath();
                }
                MediaScannerConnection.scanFile(getContext(), new String[]{targetFile.getAbsolutePath()}, new String[]{mimeType}, null);
            }

            if (saved) {
                final String displayName = filename;
                final String folderLabel = subDir.isEmpty() ? "Downloads" : ("Downloads/" + subDir);
                if (getActivity() != null) {
                    getActivity().runOnUiThread(() ->
                        Toast.makeText(getContext(), "Saved to " + folderLabel + ": " + displayName, Toast.LENGTH_SHORT).show()
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
        String subDir = sanitizeSubDir(call.getString("subDir"));

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

        String destSubPath = subDir.isEmpty() ? filename : (subDir + "/" + filename);

        try {
            DownloadManager.Request request = new DownloadManager.Request(Uri.parse(urlStr));
            request.setMimeType(mimeType);
            request.setTitle(filename);
            request.setDescription("P2P Link file transfer");
            request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, destSubPath);

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
