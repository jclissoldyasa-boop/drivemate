package app.drivemate;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.Calendar;

/**
 * Weekly odometer reminder. The page sends the chosen day/time and each vehicle's last reading;
 * at that time every vehicle without a reading in the past 6 days gets its own notification.
 */
public class Reminder extends BroadcastReceiver {
    private static final long DUE_MS = 6L * 24 * 60 * 60 * 1000;

    /** Called by the page with {"on","day"(0=Sun),"hour","min","vehicles":[{"id","name","last"}]}. */
    static void configure(Context c, String json) {
        Store.prefs(c).edit().putString("reminder", json).apply();
        // A vehicle that now has a recent reading shouldn't keep a stale reminder showing.
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        for (JSONObject v : vehicles(c)) if (!due(v)) nm.cancel(noteId(v.optString("id")));
        schedule(c);
    }

    static void schedule(Context c) {
        AlarmManager am = c.getSystemService(AlarmManager.class);
        PendingIntent pi = PendingIntent.getBroadcast(c, 0, new Intent(c, Reminder.class),
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        am.cancel(pi);
        JSONObject cfg = config(c);
        if (cfg == null || !cfg.optBoolean("on", false)) return;
        Calendar t = Calendar.getInstance();
        t.set(Calendar.DAY_OF_WEEK, cfg.optInt("day", 0) + 1);
        t.set(Calendar.HOUR_OF_DAY, cfg.optInt("hour", 18));
        t.set(Calendar.MINUTE, cfg.optInt("min", 0));
        t.set(Calendar.SECOND, 0);
        t.set(Calendar.MILLISECOND, 0);
        while (t.getTimeInMillis() <= System.currentTimeMillis()) t.add(Calendar.WEEK_OF_YEAR, 1);
        // A 15-minute window doesn't need the exact-alarm permission and still arrives on time.
        am.setWindow(AlarmManager.RTC_WAKEUP, t.getTimeInMillis(), 15 * 60 * 1000, pi);
    }

    @Override public void onReceive(Context c, Intent i) {
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        nm.createNotificationChannel(new NotificationChannel("odo", "Weekly odometer reminders", NotificationManager.IMPORTANCE_DEFAULT));
        for (JSONObject v : vehicles(c)) {
            if (!due(v)) continue;
            String id = v.optString("id"), name = v.optString("name", "your vehicle");
            Intent open = new Intent(c, MainActivity.class).putExtra("odo", id)
                    .setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            PendingIntent pi = PendingIntent.getActivity(c, noteId(id), open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
            Notification n = new Notification.Builder(c, "odo")
                    .setSmallIcon(R.drawable.ic_note)
                    .setContentTitle("Odometer reading due")
                    .setContentText("Tap to record this week's reading for " + name)
                    .setContentIntent(pi)
                    .setAutoCancel(true)
                    .build();
            nm.notify(noteId(id), n);
        }
        schedule(c);
    }

    private static JSONObject config(Context c) {
        try { return new JSONObject(Store.prefs(c).getString("reminder", "{}")); } catch (Exception e) { return null; }
    }

    private static java.util.List<JSONObject> vehicles(Context c) {
        java.util.List<JSONObject> out = new java.util.ArrayList<>();
        JSONObject cfg = config(c);
        JSONArray a = cfg == null ? null : cfg.optJSONArray("vehicles");
        if (a != null) for (int k = 0; k < a.length(); k++) { JSONObject v = a.optJSONObject(k); if (v != null) out.add(v); }
        return out;
    }

    private static boolean due(JSONObject v) {
        return System.currentTimeMillis() - v.optLong("last", 0) > DUE_MS;
    }

    /** One notification per vehicle, clear of the trip notifications (ids 1 and 2). */
    private static int noteId(String vid) { return 1000 + (vid.hashCode() & 0xFFFF); }
}
