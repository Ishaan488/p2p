package com.example.app;

import android.app.DownloadManager;
import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.ContentValues;
import android.content.Context;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.ParcelFileDescriptor;
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
import java.io.RandomAccessFile;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

@CapacitorPlugin(name = "FileSaver")
public class FileSaverPlugin extends Plugin {

    private static final Map<String, OutputStream> activeStreams = new ConcurrentHashMap<>();
    private static final Map<String, FileChannel> activeChannels = new ConcurrentHashMap<>();
    private static final Map<String, ParcelFileDescriptor> activePfds = new ConcurrentHashMap<>();
    private static final Map<String, RandomAccessFile> activeRaws = new ConcurrentHashMap<>();
    private static final Map<String, Uri> activeUris = new ConcurrentHashMap<>();
    private static final Map<String, ContentValues> activeContentValues = new ConcurrentHashMap<>();
    private static final Map<String, File> activeFiles = new ConcurrentHashMap<>();
    private static final Map<String, String> activePaths = new ConcurrentHashMap<>();
    private static final Map<String, String> activeDisplayNames = new ConcurrentHashMap<>();
    private static final Map<String, String> activeMimeTypes = new ConcurrentHashMap<>();
    private static final Map<String, String> activeSubDirs = new ConcurrentHashMap<>();

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
    public void startSaveFile(PluginCall call) {
        String fileId = call.getString("fileId");
        String filename = call.getString("filename");
        String mimeType = call.getString("mimeType");
        String subDir = sanitizeSubDir(call.getString("subDir"));

        if (fileId == null || fileId.trim().isEmpty() || filename == null || filename.trim().isEmpty()) {
            call.reject("fileId and filename are required");
            return;
        }

        if (activeChannels.containsKey(fileId) || activeStreams.containsKey(fileId)) {
            JSObject ret = new JSObject();
            ret.put("success", true);
            ret.put("fileId", fileId);
            ret.put("resumed", true);
            call.resolve(ret);
            return;
        }

        if (mimeType == null || mimeType.trim().isEmpty()) {
            mimeType = "application/octet-stream";
        }

        String relativeDir = subDir.isEmpty()
                ? Environment.DIRECTORY_DOWNLOADS
                : (Environment.DIRECTORY_DOWNLOADS + "/" + subDir);

        SharedPreferences prefs = getContext().getSharedPreferences("p2p_filesaver_resumption", Context.MODE_PRIVATE);

        // Check if an existing file descriptor is already open/persisted for this fileId
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            String savedUriStr = prefs.getString("uri_" + fileId, null);
            if (savedUriStr != null) {
                try {
                    Uri savedUri = Uri.parse(savedUriStr);
                    ContentResolver resolver = getContext().getContentResolver();
                    ParcelFileDescriptor pfd = resolver.openFileDescriptor(savedUri, "rw");
                    if (pfd != null) {
                        FileChannel channel = new FileOutputStream(pfd.getFileDescriptor()).getChannel();
                        activePfds.put(fileId, pfd);
                        activeChannels.put(fileId, channel);
                        activeUris.put(fileId, savedUri);
                        activePaths.put(fileId, prefs.getString("path_" + fileId, relativeDir + "/" + filename));
                        activeDisplayNames.put(fileId, prefs.getString("name_" + fileId, filename));
                        activeMimeTypes.put(fileId, prefs.getString("mime_" + fileId, mimeType));
                        activeSubDirs.put(fileId, prefs.getString("subdir_" + fileId, subDir));

                        JSObject ret = new JSObject();
                        ret.put("success", true);
                        ret.put("fileId", fileId);
                        ret.put("resumed", true);
                        call.resolve(ret);
                        return;
                    }
                } catch (Exception e) {
                    prefs.edit().remove("uri_" + fileId).apply();
                }
            }
        } else {
            String savedFilePath = prefs.getString("file_" + fileId, null);
            if (savedFilePath != null) {
                File targetFile = new File(savedFilePath);
                if (targetFile.exists()) {
                    try {
                        RandomAccessFile raf = new RandomAccessFile(targetFile, "rw");
                        FileChannel channel = raf.getChannel();
                        activeRaws.put(fileId, raf);
                        activeChannels.put(fileId, channel);
                        activeFiles.put(fileId, targetFile);
                        activePaths.put(fileId, targetFile.getAbsolutePath());
                        activeDisplayNames.put(fileId, prefs.getString("name_" + fileId, filename));
                        activeMimeTypes.put(fileId, prefs.getString("mime_" + fileId, mimeType));
                        activeSubDirs.put(fileId, prefs.getString("subdir_" + fileId, subDir));

                        JSObject ret = new JSObject();
                        ret.put("success", true);
                        ret.put("fileId", fileId);
                        ret.put("resumed", true);
                        call.resolve(ret);
                        return;
                    } catch (Exception e) {
                        prefs.edit().remove("file_" + fileId).apply();
                    }
                }
            }
        }

        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ContentResolver resolver = getContext().getContentResolver();
                ContentValues contentValues = new ContentValues();
                contentValues.put(MediaStore.MediaColumns.DISPLAY_NAME, filename);
                contentValues.put(MediaStore.MediaColumns.MIME_TYPE, mimeType);
                contentValues.put(MediaStore.MediaColumns.RELATIVE_PATH, relativeDir);
                contentValues.put(MediaStore.MediaColumns.IS_PENDING, 1);

                Uri uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, contentValues);
                if (uri == null) {
                    call.reject("Could not create MediaStore entry");
                    return;
                }
                ParcelFileDescriptor pfd = resolver.openFileDescriptor(uri, "rw");
                if (pfd == null) {
                    call.reject("Could not open ParcelFileDescriptor for MediaStore URI");
                    return;
                }
                FileChannel channel = new FileOutputStream(pfd.getFileDescriptor()).getChannel();

                activePfds.put(fileId, pfd);
                activeChannels.put(fileId, channel);
                activeUris.put(fileId, uri);
                activeContentValues.put(fileId, contentValues);
                activePaths.put(fileId, relativeDir + "/" + filename);
                activeDisplayNames.put(fileId, filename);
                activeMimeTypes.put(fileId, mimeType);
                activeSubDirs.put(fileId, subDir);

                prefs.edit()
                    .putString("uri_" + fileId, uri.toString())
                    .putString("path_" + fileId, relativeDir + "/" + filename)
                    .putString("name_" + fileId, filename)
                    .putString("mime_" + fileId, mimeType)
                    .putString("subdir_" + fileId, subDir)
                    .apply();

                JSObject ret = new JSObject();
                ret.put("success", true);
                ret.put("fileId", fileId);
                call.resolve(ret);
            } else {
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
                RandomAccessFile raf = new RandomAccessFile(targetFile, "rw");
                FileChannel channel = raf.getChannel();

                activeRaws.put(fileId, raf);
                activeChannels.put(fileId, channel);
                activeFiles.put(fileId, targetFile);
                activePaths.put(fileId, targetFile.getAbsolutePath());
                activeDisplayNames.put(fileId, filename);
                activeMimeTypes.put(fileId, mimeType);
                activeSubDirs.put(fileId, subDir);

                prefs.edit()
                    .putString("file_" + fileId, targetFile.getAbsolutePath())
                    .putString("name_" + fileId, filename)
                    .putString("mime_" + fileId, mimeType)
                    .putString("subdir_" + fileId, subDir)
                    .apply();

                JSObject ret = new JSObject();
                ret.put("success", true);
                ret.put("fileId", fileId);
                call.resolve(ret);
            }
        } catch (Exception e) {
            call.reject("startSaveFile failed: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void writeChunk(PluginCall call) {
        String fileId = call.getString("fileId");
        String base64Chunk = call.getString("base64Chunk");
        Long offset = call.hasOption("offset") ? call.getLong("offset") : null;

        if (fileId == null || base64Chunk == null) {
            call.reject("fileId and base64Chunk are required");
            return;
        }

        FileChannel channel = activeChannels.get(fileId);
        OutputStream os = activeStreams.get(fileId);

        if (channel == null && os == null) {
            call.reject("No active stream or channel found for fileId: " + fileId);
            return;
        }

        try {
            int commaIdx = base64Chunk.indexOf(',');
            if (commaIdx >= 0) {
                base64Chunk = base64Chunk.substring(commaIdx + 1);
            }
            byte[] bytes = Base64.decode(base64Chunk, Base64.NO_WRAP);
            ByteBuffer buffer = ByteBuffer.wrap(bytes);

            if (channel != null) {
                if (offset != null && offset >= 0) {
                    long currentPos = offset;
                    while (buffer.hasRemaining()) {
                        int written = channel.write(buffer, currentPos);
                        if (written <= 0) break;
                        currentPos += written;
                    }
                } else {
                    while (buffer.hasRemaining()) {
                        channel.write(buffer);
                    }
                }
            } else if (os != null) {
                os.write(bytes);
            }

            JSObject ret = new JSObject();
            ret.put("success", true);
            ret.put("bytesWritten", bytes.length);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("writeChunk failed: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void finishSaveFile(PluginCall call) {
        String fileId = call.getString("fileId");
        Long expectedSize = call.hasOption("expectedSize") ? call.getLong("expectedSize") : null;
        if (fileId == null) {
            call.reject("fileId is required");
            return;
        }

        FileChannel channel = activeChannels.remove(fileId);
        ParcelFileDescriptor pfd = activePfds.remove(fileId);
        RandomAccessFile raf = activeRaws.remove(fileId);
        OutputStream os = activeStreams.remove(fileId);

        if (channel == null && os == null) {
            call.reject("No active stream or channel found for fileId: " + fileId);
            return;
        }

        try {
            // Verify file size matches expected size before publication
            long currentSize = -1;
            if (channel != null) {
                currentSize = channel.size();
            } else if (activeFiles.containsKey(fileId)) {
                File f = activeFiles.get(fileId);
                if (f != null) currentSize = f.length();
            }

            if (expectedSize != null && expectedSize >= 0) {
                if (currentSize != expectedSize) {
                    // Size mismatch or truncated transfer! Abort and delete pending entry immediately
                    try { if (channel != null) channel.close(); } catch (Exception ignored) {}
                    try { if (pfd != null) pfd.close(); } catch (Exception ignored) {}
                    try { if (raf != null) raf.close(); } catch (Exception ignored) {}
                    try { if (os != null) os.close(); } catch (Exception ignored) {}

                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                        Uri uri = activeUris.remove(fileId);
                        if (uri != null) {
                            try { getContext().getContentResolver().delete(uri, null, null); } catch (Exception ignored) {}
                        }
                        activeContentValues.remove(fileId);
                    } else {
                        File targetFile = activeFiles.remove(fileId);
                        if (targetFile != null && targetFile.exists()) {
                            targetFile.delete();
                        }
                    }
                    activePaths.remove(fileId);
                    activeDisplayNames.remove(fileId);
                    activeMimeTypes.remove(fileId);
                    activeSubDirs.remove(fileId);

                    call.reject("File size mismatch: expected " + expectedSize + " bytes, but found " + currentSize + " bytes on disk");
                    return;
                }
            }

            if (channel != null) {
                channel.force(true);
                channel.close();
            }
            if (pfd != null) {
                pfd.close();
            }
            if (raf != null) {
                raf.close();
            }
            if (os != null) {
                os.flush();
                os.close();
            }

            String savedPath = activePaths.remove(fileId);
            String displayName = activeDisplayNames.remove(fileId);
            String mimeType = activeMimeTypes.remove(fileId);
            String subDir = activeSubDirs.remove(fileId);
            if (displayName == null) displayName = "file";
            if (mimeType == null) mimeType = "application/octet-stream";
            if (subDir == null) subDir = "";

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                Uri uri = activeUris.remove(fileId);
                ContentValues contentValues = activeContentValues.remove(fileId);
                if (uri != null && contentValues != null) {
                    ContentResolver resolver = getContext().getContentResolver();
                    contentValues.clear();
                    contentValues.put(MediaStore.MediaColumns.IS_PENDING, 0);
                    resolver.update(uri, contentValues, null, null);
                }
            } else {
                File targetFile = activeFiles.remove(fileId);
                if (targetFile != null) {
                    MediaScannerConnection.scanFile(getContext(), new String[]{targetFile.getAbsolutePath()}, new String[]{mimeType}, null);
                }
            }

            final String toastName = displayName;
            final String folderLabel = subDir.isEmpty() ? "Downloads" : ("Downloads/" + subDir);
            if (getActivity() != null) {
                getActivity().runOnUiThread(() ->
                    Toast.makeText(getContext(), "Saved to " + folderLabel + ": " + toastName, Toast.LENGTH_SHORT).show()
                );
            }

            SharedPreferences prefs = getContext().getSharedPreferences("p2p_filesaver_resumption", Context.MODE_PRIVATE);
            prefs.edit()
                .remove("uri_" + fileId)
                .remove("path_" + fileId)
                .remove("name_" + fileId)
                .remove("mime_" + fileId)
                .remove("subdir_" + fileId)
                .remove("file_" + fileId)
                .apply();

            JSObject ret = new JSObject();
            ret.put("success", true);
            ret.put("path", savedPath != null ? savedPath : displayName);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("finishSaveFile failed: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void abortSaveFile(PluginCall call) {
        String fileId = call.getString("fileId");
        if (fileId == null) {
            call.resolve();
            return;
        }

        FileChannel channel = activeChannels.remove(fileId);
        ParcelFileDescriptor pfd = activePfds.remove(fileId);
        RandomAccessFile raf = activeRaws.remove(fileId);
        OutputStream os = activeStreams.remove(fileId);

        try { if (channel != null) channel.close(); } catch (Exception ignored) {}
        try { if (pfd != null) pfd.close(); } catch (Exception ignored) {}
        try { if (raf != null) raf.close(); } catch (Exception ignored) {}
        try { if (os != null) os.close(); } catch (Exception ignored) {}

        SharedPreferences prefs = getContext().getSharedPreferences("p2p_filesaver_resumption", Context.MODE_PRIVATE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            Uri uri = activeUris.remove(fileId);
            if (uri == null) {
                String uriStr = prefs.getString("uri_" + fileId, null);
                if (uriStr != null) {
                    try { uri = Uri.parse(uriStr); } catch (Exception ignored) {}
                }
            }
            if (uri != null) {
                try {
                    getContext().getContentResolver().delete(uri, null, null);
                } catch (Exception ignored) {}
            }
            activeContentValues.remove(fileId);
        } else {
            File f = activeFiles.remove(fileId);
            if (f == null) {
                String legacyPath = prefs.getString("file_" + fileId, null);
                if (legacyPath != null) {
                    f = new File(legacyPath);
                }
            }
            if (f != null && f.exists()) {
                f.delete();
            }
        }
        activePaths.remove(fileId);
        activeDisplayNames.remove(fileId);
        activeMimeTypes.remove(fileId);
        activeSubDirs.remove(fileId);

        prefs.edit()
            .remove("uri_" + fileId)
            .remove("path_" + fileId)
            .remove("name_" + fileId)
            .remove("mime_" + fileId)
            .remove("subdir_" + fileId)
            .remove("file_" + fileId)
            .apply();

        JSObject ret = new JSObject();
        ret.put("aborted", true);
        call.resolve(ret);
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

    @PluginMethod
    public void cleanupAbandonedPendingDownloads(PluginCall call) {
        int cleanedCount = 0;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            try {
                ContentResolver resolver = getContext().getContentResolver();
                long oneHourAgoSec = (System.currentTimeMillis() / 1000) - 3600;
                String pkgName = getContext().getPackageName();

                String selection = MediaStore.MediaColumns.IS_PENDING + " = 1 AND " +
                        MediaStore.MediaColumns.OWNER_PACKAGE_NAME + " = ? AND " +
                        MediaStore.MediaColumns.DATE_ADDED + " < ?";
                String[] selectionArgs = new String[]{pkgName, String.valueOf(oneHourAgoSec)};
                String[] projection = new String[]{MediaStore.MediaColumns._ID};

                try (Cursor cursor = resolver.query(MediaStore.Downloads.EXTERNAL_CONTENT_URI, projection, selection, selectionArgs, null)) {
                    if (cursor != null) {
                        int idCol = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns._ID);
                        while (cursor.moveToNext()) {
                            long id = cursor.getLong(idCol);
                            Uri itemUri = ContentUris.withAppendedId(MediaStore.Downloads.EXTERNAL_CONTENT_URI, id);
                            if (!activeUris.containsValue(itemUri)) {
                                resolver.delete(itemUri, null, null);
                                cleanedCount++;
                            }
                        }
                    }
                }
            } catch (Exception ignored) {}
        }
        JSObject ret = new JSObject();
        ret.put("cleaned", cleanedCount);
        call.resolve(ret);
    }
}
