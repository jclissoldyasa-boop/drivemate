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

/**
 * One-off notifications the page plans ahead: logbook finished or expiring, service / rego / insurance
 * due, the end-of-year report. The page sends the whole list [{"id","at","title","text","tab"}] each time
 * it changes; each alert fires once at its time (a changed time counts as a new alert).
 */
public class Alerts extends BroadcastReceiver {
    static void configure(Context c, String json) {
        Store.prefs(c).edit().putString("alerts", json).apply();
        schedule(c);
    }

    private static JSONArray list(Context c) {
        try { return new JSONArray(Store.prefs(c).getString("alerts", "[]")); } catch (Exception e) { return new JSONArray(); }
    }

    private static String key(JSONObject a) { return a.optString("id") + "@" + a.optLong("at"); }

    private static boolean fired(Context c, JSONObject a) {
        return Store.prefs(c).getString("alertsFired", "").contains("|" + key(a) + "|");
    }

    /** Sets one alarm for the soonest alert that hasn't fired. */
    static void schedule(Context c) {
        AlarmManager am = c.getSystemService(AlarmManager.class);
        PendingIntent pi = PendingIntent.getBroadcast(c, 0, new Intent(c, Alerts.class),
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        am.cancel(pi);
        long next = Long.MAX_VALUE;
        JSONArray a = list(c);
        for (int k = 0; k < a.length(); k++) {
            JSONObject x = a.optJSONObject(k);
            if (x != null && !fired(c, x)) next = Math.min(next, x.optLong("at"));
        }
        if (next == Long.MAX_VALUE) return;
        am.setWindow(AlarmManager.RTC_WAKEUP, Math.max(next, System.currentTimeMillis() + 5000), 15 * 60 * 1000, pi);
    }

    @Override public void onReceive(Context c, Intent i) {
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        nm.createNotificationChannel(new NotificationChannel("alerts", "Vehicle and logbook reminders", NotificationManager.IMPORTANCE_DEFAULT));
        JSONArray a = list(c);
        StringBuilder done = new StringBuilder(Store.prefs(c).getString("alertsFired", "|"));
        long now = System.currentTimeMillis();
        for (int k = 0; k < a.length(); k++) {
            JSONObject x = a.optJSONObject(k);
            if (x == null || fired(c, x) || x.optLong("at") > now + 60 * 1000) continue;
            // Way overdue (phone off for a week, say): still worth one reminder, but not a pile of old ones.
            if (now - x.optLong("at") < 30L * 24 * 60 * 60 * 1000) {
                Intent open = new Intent(c, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
                if (!x.optString("tab").isEmpty()) open.putExtra("tab", x.optString("tab"));
                int id = 2000 + (x.optString("id").hashCode() & 0xFFFF);
                PendingIntent pi = PendingIntent.getActivity(c, id, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
                nm.notify(id, new Notification.Builder(c, "alerts")
                        .setSmallIcon(R.drawable.ic_note)
                        .setContentTitle(x.optString("title"))
                        .setContentText(x.optString("text"))
                        .setStyle(new Notification.BigTextStyle().bigText(x.optString("text")))
                        .setContentIntent(pi)
                        .setAutoCancel(true)
                        .build());
            }
            done.append(key(x)).append('|');
        }
        String s = done.toString();
        if (s.length() > 4000) s = "|" + s.substring(s.length() - 3000).replaceFirst("^[^|]*\\|", ""); // keep the newest
        Store.prefs(c).edit().putString("alertsFired", s).apply();
        schedule(c);
    }
}
