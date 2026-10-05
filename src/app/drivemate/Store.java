package app.drivemate;

import android.Manifest;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.location.LocationManager;
import android.os.SystemClock;

/** Trip state shared by the activity, the service and the page (via the bridge). */
final class Store {
    private Store() {}

    static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences("dm", Context.MODE_PRIVATE);
    }

    static boolean tracking(Context c) { return prefs(c).getBoolean("tracking", false); }
    static long startTs(Context c) { return prefs(c).getLong("startTs", 0); }
    static double km(Context c) { return prefs(c).getFloat("km", 0f); }
    static boolean auto(Context c) { return prefs(c).getBoolean("auto", false); }
    static boolean autoTrip(Context c) { return prefs(c).getBoolean("autoTrip", false); }
    /** Car Bluetooth devices that start a trip, as JSON {"AA:BB:…": "vehicleId"}. */
    static String btCars(Context c) { return prefs(c).getString("btCars", "{}"); }
    static boolean hasBtCars(Context c) { return !"{}".equals(btCars(c)) && hasBluetooth(c); }
    /** Anything that needs the background service watching for a trip to start. */
    static boolean watching(Context c) { return auto(c) || hasBtCars(c); }
    /** Minutes without movement before a trip ends by itself; 0 = never. */
    static int idleMin(Context c) { return prefs(c).getInt("idleMin", 20); }

    static void startTrip(Context c, long ts, boolean auto) {
        prefs(c).edit().putBoolean("tracking", true).putLong("startTs", ts).putFloat("km", 0f)
                .putBoolean("autoTrip", auto).remove("tripVid").remove("btAddr").putLong("fixAt", 0).putFloat("acc", 999f)
                .putLong("moveAt", ts).putFloat("moveKm", 0f).putBoolean("moveFix", false).apply();
    }

    static void endTrip(Context c, boolean discarded) {
        SharedPreferences.Editor e = prefs(c).edit().putBoolean("tracking", false).putBoolean("autoTrip", false);
        if (discarded) e.putLong("discardedTs", startTs(c));
        e.apply();
    }

    static boolean hasFine(Context c) {
        return c.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    static boolean hasBackground(Context c) {
        return c.checkSelfPermission(Manifest.permission.ACCESS_BACKGROUND_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    // ---------- error log: kept on the phone until the page collects it ----------

    private static final int LOG_MAX = 30;

    /** Records an error so it shows in the page's error log (Setup → Help). Safe to call from any thread. */
    static synchronized void log(Context c, String where, Throwable t) {
        try {
            org.json.JSONArray a = new org.json.JSONArray(prefs(c).getString("errlog", "[]"));
            java.io.StringWriter sw = new java.io.StringWriter();
            t.printStackTrace(new java.io.PrintWriter(sw));
            String stack = sw.toString();
            a.put(new org.json.JSONObject().put("ts", System.currentTimeMillis()).put("src", "Android: " + where)
                    .put("msg", t.getClass().getSimpleName() + ": " + t.getMessage())
                    .put("detail", stack.length() > 1500 ? stack.substring(0, 1500) : stack));
            while (a.length() > LOG_MAX) a.remove(0);
            prefs(c).edit().putString("errlog", a.toString()).commit(); // commit: we may be about to crash
        } catch (Exception ignored) {}
    }

    /** Hands the logged errors to the page and clears them here. */
    static synchronized String takeLog(Context c) {
        String s = prefs(c).getString("errlog", "[]");
        prefs(c).edit().remove("errlog").apply();
        return s;
    }

    private static boolean crashHook;

    /** Logs any crash before Android closes the app. */
    static synchronized void installCrashLog(Context c) {
        if (crashHook) return;
        crashHook = true;
        final Context app = c.getApplicationContext();
        final Thread.UncaughtExceptionHandler prev = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler((th, e) -> {
            log(app, "crash", e);
            if (prev != null) prev.uncaughtException(th, e);
        });
    }

    static boolean hasBluetooth(Context c) {
        return android.os.Build.VERSION.SDK_INT < 31
                || c.checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED;
    }

    static String status(Context c) {
        if (!hasFine(c)) return "no-permission";
        LocationManager lm = (LocationManager) c.getSystemService(Context.LOCATION_SERVICE);
        if (lm == null || !lm.isLocationEnabled()) return "gps-off";
        long fixAt = prefs(c).getLong("fixAt", 0);
        if (fixAt == 0) return "searching";
        if (SystemClock.elapsedRealtime() - fixAt > 30000 || prefs(c).getFloat("acc", 999f) > 40f) return "weak";
        return "ok";
    }
}
