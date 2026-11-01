package com.example.app;

import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;
import android.util.Base64;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.util.ArrayList;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

@CapacitorPlugin(name = "ShareTarget")
public class ShareTargetPlugin extends Plugin {
    private static JSObject pendingShare = null;
    private final Map<String, File> spooledCacheFiles = new ConcurrentHashMap<>();

    @Override
    public void load() {
        super.load();
        cleanupOldSpooledFiles();
    }

    private void cleanupOldSpooledFiles() {
        try {
            Context ctx = getContext();
            if (ctx == null) return;
            File spoolDir = new File(ctx.getCacheDir(), "shared_spool");
            if (spoolDir.exists() && spoolDir.isDirectory()) {
                File[] files = spoolDir.listFiles();
                if (files != null) {
                    long cutoff = System.currentTimeMillis() - 3600_000L; // 1 hour
                    for (File f : files) {
                        if (f.lastModified() < cutoff) {
                            f.delete();
                        }
                    }
                }
            }
        } catch (Exception ignored) {}
    }

    public static void handleIncomingIntent(Context context, Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        if (Intent.ACTION_SEND.equals(action) || Intent.ACTION_SEND_MULTIPLE.equals(action)) {
            pendingShare = processIntent(context, intent);
        }
    }

    public void onNewIntent(Intent intent) {
        Context context = getContext();
        if (intent == null || context == null) return;
        String action = intent.getAction();
        if (Intent.ACTION_SEND.equals(action) || Intent.ACTION_SEND_MULTIPLE.equals(action)) {
            JSObject data = processIntent(context, intent);
            if (data != null) {
                pendingShare = data;
                notifyListeners("sharedData", data, true);
            }
        }
    }

    @PluginMethod
    public void getPendingShare(PluginCall call) {
        if (pendingShare != null) {
            call.resolve(pendingShare);
            pendingShare = null;
        } else {
            JSObject res = new JSObject();
            res.put("hasShare", false);
            call.resolve(res);
        }
    }

    private static JSObject processIntent(Context context, Intent intent) {
        JSObject result = new JSObject();
        result.put("hasShare", true);
        String action = intent.getAction();

        if (Intent.ACTION_SEND.equals(action)) {
            String text = intent.getStringExtra(Intent.EXTRA_TEXT);
            if (text != null && !text.isEmpty()) {
                result.put("text", text);
            }
            Uri streamUri = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if (streamUri != null) {
                try {
                    final int takeFlags = intent.getFlags() & (Intent.FLAG_GRANT_READ_URI_PERMISSION);
                    context.getContentResolver().takePersistableUriPermission(streamUri, takeFlags);
                } catch (Exception ignored) {}
                JSArray filesArray = new JSArray();
                JSObject fileObj = resolveUriMetadata(context, streamUri);
                if (fileObj != null) {
                    filesArray.put(fileObj);
                    result.put("files", filesArray);
                }
            }
        } else if (Intent.ACTION_SEND_MULTIPLE.equals(action)) {
            ArrayList<Uri> uris = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            if (uris != null && !uris.isEmpty()) {
                JSArray filesArray = new JSArray();
                for (Uri uri : uris) {
                    try {
                        final int takeFlags = intent.getFlags() & (Intent.FLAG_GRANT_READ_URI_PERMISSION);
                        context.getContentResolver().takePersistableUriPermission(uri, takeFlags);
                    } catch (Exception ignored) {}
                    JSObject fileObj = resolveUriMetadata(context, uri);
                    if (fileObj != null) {
                        filesArray.put(fileObj);
                    }
                }
                result.put("files", filesArray);
            }
        }
        return result;
    }

    /**
     * Resolves metadata without copying the file to cache.
     * Prevents disk space duplication and avoids out-of-memory errors on multi-GB files.
     */
    private static JSObject resolveUriMetadata(Context context, Uri uri) {
        try {
            ContentResolver resolver = context.getContentResolver();
            String name = "shared_file";
            long size = 0;

            try {
                Cursor cursor = resolver.query(uri, null, null, null, null);
                if (cursor != null) {
                    int nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                    int sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE);
                    if (cursor.moveToFirst()) {
                        if (nameIndex != -1) name = cursor.getString(nameIndex);
                        if (sizeIndex != -1) size = cursor.getLong(sizeIndex);
                    }
                    cursor.close();
                }
            } catch (Exception ignored) {}

            String mimeType = null;
            try {
                mimeType = resolver.getType(uri);
            } catch (Exception ignored) {}
            if (mimeType == null || mimeType.trim().isEmpty()) {
                mimeType = "application/octet-stream";
            }

            // If size was not available via Cursor, query ParcelFileDescriptor stat
            if (size <= 0) {
                try (ParcelFileDescriptor pfd = resolver.openFileDescriptor(uri, "r")) {
                    if (pfd != null) {
                        long statSize = pfd.getStatSize();
                        if (statSize > 0) size = statSize;
                    }
                } catch (Exception ignored) {}
            }

            JSObject fileObj = new JSObject();
            fileObj.put("name", name);
            fileObj.put("size", size);
            fileObj.put("mimeType", mimeType);
            fileObj.put("uri", uri.toString());
            fileObj.put("isNativeUri", true);
            return fileObj;
        } catch (Exception e) {
            e.printStackTrace();
            return null;
        }
    }

    /**
     * Reads a bounded chunk from an Android content:// URI or native file path.
     * If the content provider stream is non-seekable (e.g. pipe, cloud provider),
     * it spools to an app-private cache file and seeks there with RandomAccessFile.
     * Memory overhead is strictly limited to the requested length (e.g. 1 MiB).
     */
    @PluginMethod
    public void readChunk(PluginCall call) {
        String uriString = call.getString("uri");
        Long offsetObj = call.getLong("offset");
        Integer lengthObj = call.getInt("length");

        long offset = (offsetObj != null) ? offsetObj : 0L;
        int length = (lengthObj != null) ? lengthObj : 1024 * 1024;

        if (uriString == null || uriString.trim().isEmpty()) {
            call.reject("uri is required");
            return;
        }

        try {
            byte[] data;
            if (uriString.startsWith("content://")) {
                Uri uri = Uri.parse(uriString);
                ContentResolver resolver = getContext().getContentResolver();

                File spooled = spooledCacheFiles.get(uriString);
                if (spooled != null && spooled.exists()) {
                    data = readFromSeekableFile(spooled, offset, length);
                } else {
                    byte[] readData = null;
                    try (ParcelFileDescriptor pfd = resolver.openFileDescriptor(uri, "r")) {
                        if (pfd != null) {
                            try (FileInputStream fis = new FileInputStream(pfd.getFileDescriptor())) {
                                FileChannel channel = fis.getChannel();
                                channel.position(offset);

                                ByteBuffer buffer = ByteBuffer.allocate(length);
                                int totalRead = 0;
                                while (totalRead < length) {
                                    int r = channel.read(buffer);
                                    if (r <= 0) break;
                                    totalRead += r;
                                }
                                buffer.flip();
                                readData = new byte[buffer.remaining()];
                                buffer.get(readData);
                            }
                        }
                    } catch (IOException ex) {
                        // Channel positioning or reading failed (e.g. non-seekable pipe / ESPIPE)
                        readData = null;
                    }

                    if (readData != null) {
                        data = readData;
                    } else {
                        // Fallback: Spool stream to app-private cache file and read with RandomAccessFile
                        File spoolFile = getOrCreateSpooledFile(getContext(), uri);
                        data = readFromSeekableFile(spoolFile, offset, length);
                    }
                }
            } else {
                // Fallback for regular filesystem path or file:// URI
                String path = uriString.startsWith("file://") ? uriString.substring(7) : uriString;
                File f = new File(path);
                data = readFromSeekableFile(f, offset, length);
            }

            String base64 = Base64.encodeToString(data, Base64.NO_WRAP);
            JSObject ret = new JSObject();
            ret.put("base64Data", base64);
            ret.put("bytesRead", data.length);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Failed to read chunk from URI: " + e.getMessage(), e);
        }
    }

    private synchronized File getOrCreateSpooledFile(Context context, Uri uri) throws IOException {
        String key = uri.toString();
        File existing = spooledCacheFiles.get(key);
        if (existing != null && existing.exists()) {
            return existing;
        }

        File cacheDir = context.getCacheDir();
        File spoolDir = new File(cacheDir, "shared_spool");
        if (!spoolDir.exists()) {
            spoolDir.mkdirs();
        }

        String safeName = "spool_" + Math.abs(key.hashCode()) + "_" + System.currentTimeMillis() + ".tmp";
        File tempSpool = new File(spoolDir, safeName);

        try (InputStream in = context.getContentResolver().openInputStream(uri);
             FileOutputStream out = new FileOutputStream(tempSpool)) {
            if (in == null) {
                throw new IOException("Unable to open input stream for " + uri);
            }
            byte[] buf = new byte[64 * 1024];
            int read;
            while ((read = in.read(buf)) != -1) {
                out.write(buf, 0, read);
            }
            out.flush();
        }

        spooledCacheFiles.put(key, tempSpool);
        return tempSpool;
    }

    private byte[] readFromSeekableFile(File file, long offset, int length) throws IOException {
        try (RandomAccessFile raf = new RandomAccessFile(file, "r")) {
            long fileLen = raf.length();
            if (offset >= fileLen) {
                return new byte[0];
            }
            raf.seek(offset);
            int toRead = (int) Math.min(length, fileLen - offset);
            byte[] buf = new byte[toRead];
            int read = 0;
            while (read < toRead) {
                int r = raf.read(buf, read, toRead - read);
                if (r <= 0) break;
                read += r;
            }
            if (read == toRead) return buf;
            byte[] trimmed = new byte[read];
            System.arraycopy(buf, 0, trimmed, 0, read);
            return trimmed;
        }
    }

    @PluginMethod
    public void releaseSharedUri(PluginCall call) {
        String uriString = call.getString("uri");
        if (uriString != null) {
            File spooled = spooledCacheFiles.remove(uriString);
            if (spooled != null && spooled.exists()) {
                spooled.delete();
            }
        }
        JSObject ret = new JSObject();
        ret.put("released", true);
        call.resolve(ret);
    }
}
