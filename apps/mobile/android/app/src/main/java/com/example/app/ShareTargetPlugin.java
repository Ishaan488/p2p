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
    // Shared (static) so metadata resolution at intent time and chunk reads later see the same copies.
    private static final Map<String, File> spooledCacheFiles = new ConcurrentHashMap<>();

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
                    long cutoff = System.currentTimeMillis() - 24 * 3600_000L; // 24 hours
                    for (File f : files) {
                        if (f.lastModified() < cutoff) {
                            f.delete();
                        }
                    }
                }
            }
        } catch (Exception ignored) {}
    }

    private static final String EXTRA_SHARE_CONSUMED = "com.example.app.SHARE_CONSUMED";

    private static Long getLongOption(PluginCall call, String name) {
        if (call == null || call.getData() == null || !call.getData().has(name) || call.getData().isNull(name)) {
            return null;
        }
        Object value = call.getData().opt(name);
        if (value instanceof Number) {
            return ((Number) value).longValue();
        }
        if (value instanceof String) {
            try {
                return Long.parseLong(((String) value).trim());
            } catch (NumberFormatException ignored) {}
        }
        return null;
    }

    private static Integer getIntOption(PluginCall call, String name) {
        if (call == null || call.getData() == null || !call.getData().has(name) || call.getData().isNull(name)) {
            return null;
        }
        Object value = call.getData().opt(name);
        if (value instanceof Number) {
            return ((Number) value).intValue();
        }
        if (value instanceof String) {
            try {
                return Integer.parseInt(((String) value).trim());
            } catch (NumberFormatException ignored) {}
        }
        return null;
    }

    public static void handleIncomingIntent(Context context, Intent intent) {
        if (intent == null || intent.getBooleanExtra(EXTRA_SHARE_CONSUMED, false)) return;
        String action = intent.getAction();
        if (Intent.ACTION_SEND.equals(action) || Intent.ACTION_SEND_MULTIPLE.equals(action)) {
            intent.putExtra(EXTRA_SHARE_CONSUMED, true);
            pendingShare = processIntent(context, intent);
        }
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        onNewIntent(intent);
    }

    public void onNewIntent(Intent intent) {
        Context context = getContext();
        if (intent == null || context == null || intent.getBooleanExtra(EXTRA_SHARE_CONSUMED, false)) return;
        String action = intent.getAction();
        if (Intent.ACTION_SEND.equals(action) || Intent.ACTION_SEND_MULTIPLE.equals(action)) {
            intent.putExtra(EXTRA_SHARE_CONSUMED, true);
            JSObject data = processIntent(context, intent);
            if (data != null) {
                if (hasListeners("sharedData")) {
                    pendingShare = null;
                    notifyListeners("sharedData", data, false);
                } else {
                    pendingShare = data;
                }
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
            if (streamUri == null && intent.getClipData() != null && intent.getClipData().getItemCount() > 0) {
                streamUri = intent.getClipData().getItemAt(0).getUri();
            }
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

            // The size a provider reports in its cursor is not always the size of the bytes it streams
            // (edited images, re-encoded media, cloud providers). A seekable file descriptor knows the real
            // length, so it wins. If there is none (a pipe), copy the stream into the app cache once and use
            // the length of that copy, so what is announced is exactly what will be sent.
            long statSize = -1;
            try (ParcelFileDescriptor pfd = resolver.openFileDescriptor(uri, "r")) {
                if (pfd != null) statSize = pfd.getStatSize();
            } catch (Exception ignored) {}

            if (statSize > 0) {
                size = statSize;
            } else {
                try {
                    File spooled = getOrCreateSpooledFile(context, uri);
                    if (spooled.length() > 0) size = spooled.length();
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
        Long offsetObj = getLongOption(call, "offset");
        Integer lengthObj = getIntOption(call, "length");

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

    private static synchronized File getOrCreateSpooledFile(Context context, Uri uri) throws IOException {
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
            out.getFD().sync();
        }

        spooledCacheFiles.put(key, tempSpool);
        spooledCacheFiles.put(tempSpool.getAbsolutePath(), tempSpool);
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


    /**
     * Copies a shared content:// file into app-private storage with a plain InputStream (the one way every
     * provider supports) and reports the copy's exact size. Transfers then read this local copy, so they
     * do not depend on the sending app's file descriptor, its reported size or its URI permission lasting.
     * Runs off the main thread; large files are copied in 64 KiB steps.
     */
    @PluginMethod
    public void stageSharedFile(final PluginCall call) {
        final String uriString = call.getString("uri");
        if (uriString == null || uriString.trim().isEmpty()) {
            call.reject("uri is required");
            return;
        }
        new Thread(() -> {
            try {
                Uri uri = Uri.parse(uriString);
                Context ctx = getContext();
                File out = getOrCreateSpooledFile(ctx, uri);
                long total = out.length();
                if (total <= 0) {
                    spooledCacheFiles.remove(uriString);
                    spooledCacheFiles.remove(out.getAbsolutePath());
                    out.delete();
                    call.reject("Shared file was empty or copy was incomplete");
                    return;
                }
                JSObject ret = new JSObject();
                ret.put("path", out.getAbsolutePath());
                ret.put("size", total);
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("Failed to stage shared file: " + e.getMessage(), e);
            }
        }).start();
    }

    @PluginMethod
    public void releaseSharedUri(PluginCall call) {
        String uriString = call.getString("uri");
        if (uriString != null && uriString.startsWith("/")) {
            spooledCacheFiles.remove(uriString);
            // A staged copy: delete it, but only if it really lives in our spool directory.
            try {
                File f = new File(uriString).getCanonicalFile();
                spooledCacheFiles.values().removeIf(val -> val != null && val.getAbsolutePath().equals(f.getAbsolutePath()));
                File spoolDir = new File(getContext().getCacheDir(), "shared_spool").getCanonicalFile();
                if (f.getPath().startsWith(spoolDir.getPath() + File.separator)) f.delete();
            } catch (Exception ignored) {}
        } else if (uriString != null) {
            File spooled = spooledCacheFiles.remove(uriString);
            if (spooled != null && spooled.exists()) {
                spooledCacheFiles.remove(spooled.getAbsolutePath());
                spooled.delete();
            }
        }
        JSObject ret = new JSObject();
        ret.put("released", true);
        call.resolve(ret);
    }
}
