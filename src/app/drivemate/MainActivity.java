package app.drivemate;

import android.Manifest;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.PowerManager;
import android.os.SystemClock;
import android.provider.MediaStore;
import android.provider.Settings;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONObject;

import java.io.OutputStream;
import java.lang.ref.WeakReference;
import java.nio.charset.StandardCharsets;

/** Hosts the DriveMate page and gives it the DriveMateNative bridge. */
public class MainActivity extends Activity {
    /**
     * The page is bundled in the APK but shown under the real site address, so it works offline,
     * talks to the API as the same site, and password managers recognise the sign-in form.
     */
    static final String HOST = "drivemate.drivemate-app.workers.dev";
    static final String HOME = "https://" + HOST + "/";
    private static final int REQ_LOCATION = 1, REQ_BACKGROUND = 2, REQ_NOTIF = 3, REQ_BT = 4, REQ_FILE = 10;
    private static WeakReference<MainActivity> current = new WeakReference<>(null);

    private WebView web;
    private boolean loaded, pendingEnd;
    private String pendingOdo;
    private ValueCallback<Uri[]> fileCallback;
    private Uri cameraUri;
    private long askedAt;

    /** Tell the page something changed (called from the service). */
    static void ping(String evt) {
        MainActivity a = current.get();
        if (a != null) a.runOnUiThread(() -> a.js("window.dmNative&&window.dmNative('" + evt + "')"));
    }

    @Override protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        Store.installCrashLog(this);
        current = new WeakReference<>(this);
        web = new WebView(this);
        web.setBackgroundColor(0xFF0F121C);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(false);
        s.setTextZoom(100);
        web.addJavascriptInterface(new Bridge(), "DriveMateNative");
        web.setWebViewClient(new WebViewClient() {
            @Override public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest r) {
                Uri u = r.getUrl();
                String path = u.getPath() == null ? "/" : u.getPath();
                if (!HOST.equals(u.getHost()) || !"GET".equals(r.getMethod())) return null;
                String asset = null, type = "text/html";
                if (path.equals("/") || path.equals("/index.html") || path.equals("/auth/done")) asset = "index.html";
                else if (path.equals("/privacy") || path.equals("/terms")) asset = path.substring(1) + ".html";
                else if (path.matches("/fonts/[A-Za-z0-9-]+\\.(woff2|css)")) {
                    asset = path.substring(1);
                    type = path.endsWith(".css") ? "text/css" : "font/woff2";
                }
                if (asset == null) return null; // API calls go to the network as normal
                try {
                    WebResourceResponse res = new WebResourceResponse(type, "utf-8", getAssets().open(asset));
                    res.setResponseHeaders(pageHeaders());
                    return res;
                } catch (java.io.IOException e) { return null; }
            }
            @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                Uri u = r.getUrl();
                if (HOST.equals(u.getHost())) return false;
                try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (ActivityNotFoundException ignored) {}
                return true;
            }
            @Override public void onPageFinished(WebView v, String url) {
                loaded = true;
                if (pendingEnd) { pendingEnd = false; js("window.dmNative&&window.dmNative('end')"); }
                if (pendingOdo != null) { openOdo(pendingOdo); pendingOdo = null; }
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams p) {
                return chooseFile(cb, p);
            }
        });

        pendingEnd = getIntent().getBooleanExtra("end", false);
        pendingOdo = getIntent().getStringExtra("odo");
        String auth = authCode(getIntent());
        if (auth != null) web.loadUrl(HOME + "auth/done#code=" + auth);
        else if (saved != null) web.restoreState(saved);
        else web.loadUrl(HOME);
    }

    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        String auth = authCode(intent);
        if (auth != null) {
            if (loaded) js("window.dmAuth&&window.dmAuth('" + auth + "')"); else web.loadUrl(HOME + "auth/done#code=" + auth);
            return;
        }
        String odo = intent.getStringExtra("odo");
        if (odo != null) {
            if (loaded) openOdo(odo); else pendingOdo = odo;
            return;
        }
        if (intent.getBooleanExtra("end", false)) {
            if (loaded) js("window.dmNative&&window.dmNative('end')"); else pendingEnd = true;
        }
    }

    @Override protected void onResume() {
        super.onResume();
        current = new WeakReference<>(this);
        TrackerService.sync(this);
        if (loaded) js("window.dmNative&&window.dmNative('resume')");
    }

    @Override protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @SuppressWarnings("deprecation")
    @Override public void onBackPressed() {
        web.evaluateJavascript("(window.dmBack&&window.dmBack())?'y':'n'", r -> {
            if ("\"y\"".equals(r)) return;
            if (web.canGoBack()) web.goBack(); else super.onBackPressed();
        });
    }

    private void js(String code) { web.evaluateJavascript(code, null); }

    /** Opens the Record odometer screen for a vehicle (from a reminder notification). */
    private void openOdo(String vid) {
        js("window.dmNative&&window.dmNative('odo'," + JSONObject.quote(vid) + ")");
    }

    /**
     * The one-time code from a Google/Facebook sign-in, arriving either as the App Link
     * https://HOST/auth/done#code=… or, as a fallback, drivemate://auth?code=….
     */
    private static String authCode(Intent intent) {
        Uri u = intent == null ? null : intent.getData();
        if (u == null) return null;
        String code = null;
        if ("https".equals(u.getScheme()) && HOST.equals(u.getHost()) && "/auth/done".equals(u.getPath())) {
            String frag = u.getEncodedFragment();
            if (frag != null) for (String kv : frag.split("&")) if (kv.startsWith("code=")) code = kv.substring(5);
        } else if ("drivemate".equals(u.getScheme()) && "auth".equals(u.getHost())) {
            code = u.getQueryParameter("code");
        }
        return code != null && code.matches("[A-Za-z0-9_-]{43}") ? code : null;
    }

    private java.util.Map<String, String> pageHeaders() {
        java.util.Map<String, String> h = new java.util.HashMap<>();
        try (java.io.InputStream in = getAssets().open("csp.txt")) {
            java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
            h.put("Content-Security-Policy", out.toString("UTF-8").trim());
        } catch (java.io.IOException ignored) {}
        h.put("X-Content-Type-Options", "nosniff");
        h.put("Referrer-Policy", "no-referrer");
        return h;
    }

    // ---------- permissions ----------

    private void askLocation() {
        askedAt = SystemClock.elapsedRealtime();
        if (!Store.hasFine(this)) {
            requestPermissions(new String[]{Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION}, REQ_LOCATION);
        } else if (!Store.hasBackground(this)) {
            requestPermissions(new String[]{Manifest.permission.ACCESS_BACKGROUND_LOCATION}, REQ_BACKGROUND);
        }
    }

    @Override public void onRequestPermissionsResult(int req, String[] perms, int[] res) {
        boolean granted = res.length > 0 && res[0] == 0;
        // Android stops showing the prompt after a couple of refusals and denies instantly; open settings instead.
        if (!granted && SystemClock.elapsedRealtime() - askedAt < 400) openAppSettings();
        if (req == REQ_LOCATION && granted && Store.auto(this) && !Store.hasBackground(this)) {
            askLocation();
        }
        TrackerService.sync(this);
        js("window.dmNative&&window.dmNative('perms')");
    }

    private void openAppSettings() {
        startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", getPackageName(), null)));
    }

    // ---------- receipt photos ----------

    private boolean chooseFile(ValueCallback<Uri[]> cb, WebChromeClient.FileChooserParams p) {
        if (fileCallback != null) fileCallback.onReceiveValue(null);
        fileCallback = cb;
        cameraUri = null;
        Intent pick = p.createIntent();
        Intent launch = pick;
        boolean image = false;
        for (String t : p.getAcceptTypes()) if (t != null && t.startsWith("image")) image = true;
        if (image && p.isCaptureEnabled()) {
            // Save the full-size photo to Pictures/DriveMate so it's kept with the phone's photos.
            ContentValues v = new ContentValues();
            v.put(MediaStore.Images.Media.DISPLAY_NAME, "receipt-" + System.currentTimeMillis() + ".jpg");
            v.put(MediaStore.Images.Media.MIME_TYPE, "image/jpeg");
            v.put(MediaStore.Images.Media.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/DriveMate");
            cameraUri = getContentResolver().insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, v);
            Intent cam = new Intent(MediaStore.ACTION_IMAGE_CAPTURE).putExtra(MediaStore.EXTRA_OUTPUT, cameraUri)
                    .addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            launch = Intent.createChooser(cam, "Receipt photo");
            launch.putExtra(Intent.EXTRA_INITIAL_INTENTS, new Intent[]{pick});
        }
        try {
            startActivityForResult(launch, REQ_FILE);
        } catch (ActivityNotFoundException e) {
            fileCallback = null;
            cb.onReceiveValue(null);
        }
        return true;
    }

    @Override protected void onActivityResult(int req, int res, Intent data) {
        if (req != REQ_FILE || fileCallback == null) return;
        Uri[] out = null;
        if (res == RESULT_OK) {
            if (data != null && data.getData() != null) out = new Uri[]{data.getData()};
            else if (cameraUri != null) out = new Uri[]{cameraUri};
        }
        if (cameraUri != null && (out == null || !out[0].equals(cameraUri))) {
            try { getContentResolver().delete(cameraUri, null, null); } catch (Exception ignored) {}
        }
        fileCallback.onReceiveValue(out);
        fileCallback = null;
    }

    // ---------- bridge ----------

    private class Bridge {
        @JavascriptInterface public String state() {
            MainActivity c = MainActivity.this;
            try {
                return new JSONObject()
                        .put("tracking", Store.tracking(c))
                        .put("startTs", Store.startTs(c))
                        .put("km", Store.km(c))
                        .put("status", Store.status(c))
                        .put("auto", Store.auto(c))
                        .put("discardedTs", Store.prefs(c).getLong("discardedTs", 0))
                        .put("vid", Store.prefs(c).getString("tripVid", ""))
                        .toString();
            } catch (Exception e) { return "{}"; }
        }

        @JavascriptInterface public String perms() {
            MainActivity c = MainActivity.this;
            boolean notif = Build.VERSION.SDK_INT < 33
                    ? getSystemService(android.app.NotificationManager.class).areNotificationsEnabled()
                    : checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == 0;
            boolean battery = ((PowerManager) getSystemService(POWER_SERVICE)).isIgnoringBatteryOptimizations(getPackageName());
            try {
                return new JSONObject().put("fine", Store.hasFine(c)).put("background", Store.hasBackground(c))
                        .put("notif", notif).put("battery", battery).put("bluetooth", Store.hasBluetooth(c)).toString();
            } catch (Exception e) { return "{}"; }
        }

        @JavascriptInterface public void startTrip(String ts) {
            long t;
            try { t = Long.parseLong(ts); } catch (NumberFormatException e) { t = System.currentTimeMillis(); }
            MainActivity c = MainActivity.this;
            if (!(Store.tracking(c) && Store.startTs(c) == t)) Store.startTrip(c, t, false);
            TrackerService.sync(c);
        }

        @JavascriptInterface public void stopTrip() {
            Store.endTrip(MainActivity.this, false);
            TrackerService.sync(MainActivity.this);
        }

        @JavascriptInterface public void setAuto(boolean on) {
            Store.prefs(MainActivity.this).edit().putBoolean("auto", on).apply();
            TrackerService.sync(MainActivity.this);
        }

        /** Paired Bluetooth devices, so the page can link one to a vehicle. */
        @JavascriptInterface public String btDevices() {
            org.json.JSONArray out = new org.json.JSONArray();
            try {
                android.bluetooth.BluetoothManager bm = getSystemService(android.bluetooth.BluetoothManager.class);
                if (bm == null || bm.getAdapter() == null || !Store.hasBluetooth(MainActivity.this)) return "[]";
                for (android.bluetooth.BluetoothDevice d : bm.getAdapter().getBondedDevices()) {
                    out.put(new JSONObject().put("addr", d.getAddress()).put("name", d.getName() == null ? d.getAddress() : d.getName()));
                }
            } catch (Exception ignored) {}
            return out.toString();
        }

        @JavascriptInterface public void askBluetooth() {
            if (Build.VERSION.SDK_INT < 31) return;
            runOnUiThread(() -> {
                askedAt = SystemClock.elapsedRealtime();
                requestPermissions(new String[]{Manifest.permission.BLUETOOTH_CONNECT}, REQ_BT);
            });
        }

        @JavascriptInterface public String takeErrors() { return Store.takeLog(MainActivity.this); }

        @JavascriptInterface public void setReminder(String json) {
            try { new JSONObject(json); } catch (Exception e) { return; }
            Reminder.configure(MainActivity.this, json);
        }

        @JavascriptInterface public void setBtCars(String json) {
            try { new JSONObject(json); } catch (Exception e) { return; }
            if (json.equals(Store.btCars(MainActivity.this))) return;
            Store.prefs(MainActivity.this).edit().putString("btCars", json).apply();
            TrackerService.sync(MainActivity.this);
        }

        @JavascriptInterface public void askLocation() { runOnUiThread(MainActivity.this::askLocation); }

        @JavascriptInterface public void openLocationSettings() {
            runOnUiThread(() -> startActivity(new Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS)));
        }

        @JavascriptInterface public void askNotifications() {
            runOnUiThread(() -> {
                askedAt = SystemClock.elapsedRealtime();
                if (Build.VERSION.SDK_INT >= 33) {
                    requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQ_NOTIF);
                } else {
                    startActivity(new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName()));
                }
            });
        }

        @JavascriptInterface public void askBattery() {
            runOnUiThread(() -> {
                try {
                    startActivity(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + getPackageName())));
                } catch (ActivityNotFoundException e) {
                    openAppSettings();
                }
            });
        }

        @JavascriptInterface public String version() {
            try {
                return String.valueOf(getPackageManager().getPackageInfo(getPackageName(), 0).getLongVersionCode());
            } catch (Exception e) { return "0"; }
        }

        /** Opens a link outside the app, e.g. a new APK so the browser downloads it. */
        @JavascriptInterface public void openUrl(String url) {
            if (url == null || !url.startsWith("https://")) return;
            runOnUiThread(() -> {
                try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url))); } catch (ActivityNotFoundException ignored) {}
            });
        }

        @JavascriptInterface public String saveFile(String name, String text, String mime) {
            ContentResolver cr = getContentResolver();
            ContentValues v = new ContentValues();
            v.put(MediaStore.Downloads.DISPLAY_NAME, name);
            v.put(MediaStore.Downloads.MIME_TYPE, mime);
            v.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
            Uri uri = null;
            try {
                uri = cr.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
                if (uri == null) return "error";
                try (OutputStream os = cr.openOutputStream(uri)) {
                    os.write(text.getBytes(StandardCharsets.UTF_8));
                }
                return "saved";
            } catch (Exception e) {
                if (uri != null) { try { cr.delete(uri, null, null); } catch (Exception ignored) {} }
                return "error";
            }
        }
    }
}
