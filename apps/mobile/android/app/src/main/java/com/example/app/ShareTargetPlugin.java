package com.example.app;

import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.util.ArrayList;

@CapacitorPlugin(name = "ShareTarget")
public class ShareTargetPlugin extends Plugin {
    private static JSObject pendingShare = null;

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
                JSArray filesArray = new JSArray();
                JSObject fileObj = copyUriToCache(context, streamUri);
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
                    JSObject fileObj = copyUriToCache(context, uri);
                    if (fileObj != null) {
                        filesArray.put(fileObj);
                    }
                }
                result.put("files", filesArray);
            }
        }
        return result;
    }

    private static JSObject copyUriToCache(Context context, Uri uri) {
        try {
            ContentResolver resolver = context.getContentResolver();
            String name = "shared_file";
            long size = 0;

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

            String mimeType = resolver.getType(uri);
            if (mimeType == null) mimeType = "application/octet-stream";

            File cacheDir = new File(context.getCacheDir(), "shared");
            if (!cacheDir.exists()) cacheDir.mkdirs();
            File destFile = new File(cacheDir, System.currentTimeMillis() + "_" + name);

            InputStream in = resolver.openInputStream(uri);
            if (in == null) return null;

            FileOutputStream out = new FileOutputStream(destFile);
            byte[] buf = new byte[64 * 1024];
            int len;
            long copied = 0;
            while ((len = in.read(buf)) > 0) {
                out.write(buf, 0, len);
                copied += len;
            }
            in.close();
            out.close();

            if (size <= 0) size = copied;

            JSObject fileObj = new JSObject();
            fileObj.put("name", name);
            fileObj.put("size", size);
            fileObj.put("mimeType", mimeType);
            fileObj.put("path", destFile.getAbsolutePath());
            return fileObj;
        } catch (Exception e) {
            e.printStackTrace();
            return null;
        }
    }
}

