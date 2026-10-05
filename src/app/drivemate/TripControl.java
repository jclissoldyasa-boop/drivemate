package app.drivemate;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.widget.RemoteViews;

import java.util.Locale;

/** Home-screen widget: Start trip, or while one runs, its kilometres and End trip. */
public class TripControl extends AppWidgetProvider {
    static final String ACTION_START = "app.drivemate.START_TRIP";

    /** Starts a trip from outside the app (widget or quick-settings tile). The page picks the vehicle when it opens. */
    static void start(Context c) {
        if (Store.tracking(c)) return;
        Store.startTrip(c, System.currentTimeMillis(), false);
        TrackerService.sync(c);
        MainActivity.ping("start");
        update(c);
    }

    /** Opens the app on the End trip screen. */
    static PendingIntent endIntent(Context c) {
        Intent i = new Intent(c, MainActivity.class).putExtra("end", true)
                .setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(c, 5, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    static void update(Context c) {
        AppWidgetManager wm = AppWidgetManager.getInstance(c);
        int[] ids = wm.getAppWidgetIds(new ComponentName(c, TripControl.class));
        if (ids.length > 0) wm.updateAppWidget(ids, views(c));
        TripTile.refresh(c);
    }

    private static RemoteViews views(Context c) {
        RemoteViews v = new RemoteViews(c.getPackageName(), R.layout.widget_trip);
        boolean on = Store.tracking(c);
        v.setTextViewText(R.id.w_title, on ? "Trip in progress" : "DriveMate");
        v.setTextViewText(R.id.w_sub, on ? String.format(Locale.US, "%.1f km so far", Store.km(c)) : "No trip running");
        v.setTextViewText(R.id.w_btn, on ? "End trip" : "Start trip");
        PendingIntent pi = on ? endIntent(c)
                : PendingIntent.getBroadcast(c, 6, new Intent(c, TripControl.class).setAction(ACTION_START),
                        PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        v.setOnClickPendingIntent(R.id.w_btn, pi);
        Intent open = new Intent(c, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        v.setOnClickPendingIntent(R.id.w_text, PendingIntent.getActivity(c, 7, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT));
        return v;
    }

    @Override public void onUpdate(Context c, AppWidgetManager wm, int[] ids) { wm.updateAppWidget(ids, views(c)); }

    @Override public void onReceive(Context c, Intent i) {
        if (ACTION_START.equals(i.getAction())) start(c);
        else super.onReceive(c, i);
    }
}
