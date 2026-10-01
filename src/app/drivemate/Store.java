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

    static void startTrip(Context c, long ts, boolean auto) {
        prefs(c).edit().putBoolean("tracking", true).putLong("startTs", ts).putFloat("km", 0f)
                .putBoolean("autoTrip", auto).putLong("fixAt", 0).putFloat("acc", 999f).apply();
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
