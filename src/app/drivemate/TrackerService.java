package app.drivemate;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.bluetooth.BluetoothDevice;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.ServiceInfo;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.BatteryManager;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;

import org.json.JSONObject;

import java.util.Locale;

/**
 * Foreground service that counts GPS kilometres during a trip and, when automatic trips are on,
 * starts a trip when the phone goes on a wireless charger or connects to a car's Bluetooth.
 */
public class TrackerService extends Service implements LocationListener {
    static final String ACTION_SYNC = "sync";            // bring the service in line with Store
    static final String ACTION_DISCARD = "discard";      // cancel the current trip
    private static final int NOTE_ONGOING = 1, NOTE_ARRIVED = 2;
    private static final long AUTO_CANCEL_MS = 10 * 60 * 1000;
    private static final double AUTO_MIN_KM = 0.3;

    private final Handler main = new Handler(Looper.getMainLooper());
    private LocationManager lm;
    private boolean gpsOn, chargerWatch, btWatch;
    private Location anchor;
    private long lastNoteAt;
    private PowerManager.WakeLock wake;
    private Runnable autoCancel;

    static void sync(Context c) { send(c, ACTION_SYNC); }

    static void send(Context c, String action) {
        // A location service can't go foreground without permission; it starts once that's granted.
        boolean needed = (Store.tracking(c) || Store.watching(c)) && Store.hasFine(c);
        if (!needed && !ACTION_SYNC.equals(action)) return;
        Intent i = new Intent(c, TrackerService.class).setAction(action);
        try {
            if (needed) c.startForegroundService(i); else c.startService(i);
        } catch (Exception e) {
            Store.log(c, "starting the trip service", e);
            // Not allowed to start from the background right now; the activity retries on resume.
        }
    }

    @Override public void onCreate() {
        super.onCreate();
        Store.installCrashLog(this);
        lm = (LocationManager) getSystemService(LOCATION_SERVICE);
        NotificationManager nm = getSystemService(NotificationManager.class);
        nm.createNotificationChannel(new NotificationChannel("trip", "Trip in progress", NotificationManager.IMPORTANCE_LOW));
        nm.createNotificationChannel(new NotificationChannel("arrived", "Arrival reminders", NotificationManager.IMPORTANCE_HIGH));
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : ACTION_SYNC;
        if (ACTION_DISCARD.equals(action) && Store.tracking(this)) {
            Store.endTrip(this, true);
            MainActivity.ping("discard");
        }
        apply();
        return START_STICKY;
    }

    /** Make GPS, the charger watch and the notification match the stored state. */
    private void apply() {
        boolean tracking = Store.tracking(this), auto = Store.auto(this), bt = Store.hasBtCars(this);
        if (!tracking && !auto && !bt) {
            stopGps();
            watchCharger(false);
            watchBluetooth(false);
            stopForeground(STOP_FOREGROUND_REMOVE);
            stopSelf();
            return;
        }
        try {
            startForeground(NOTE_ONGOING, ongoing(), ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
        } catch (Exception e) {
            // Location permission missing: nothing useful can run until it is granted.
            Store.log(this, "showing the trip notification", e);
            stopSelf();
            return;
        }
        watchCharger(auto);
        watchBluetooth(bt);
        if (tracking) startGps(); else stopGps();
    }

    // ---------- GPS ----------

    private void startGps() {
        if (gpsOn || !Store.hasFine(this)) return;
        try {
            lm.requestLocationUpdates(LocationManager.GPS_PROVIDER, 2000, 0, this, Looper.getMainLooper());
            gpsOn = true;
            anchor = null;
            if (wake == null) {
                wake = ((PowerManager) getSystemService(POWER_SERVICE)).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "DriveMate:trip");
                wake.acquire(12 * 60 * 60 * 1000L);
            }
            if (Store.autoTrip(this)) {
                final long ts = Store.startTs(this);
                autoCancel = () -> autoCancelCheck(ts);
                main.postDelayed(autoCancel, AUTO_CANCEL_MS);
            }
        } catch (SecurityException e) {
            Store.log(this, "starting GPS", e);
        }
    }

    private void stopGps() {
        if (gpsOn) { try { lm.removeUpdates(this); } catch (Exception ignored) {} }
        gpsOn = false;
        anchor = null;
        if (autoCancel != null) { main.removeCallbacks(autoCancel); autoCancel = null; }
        if (wake != null) { if (wake.isHeld()) wake.release(); wake = null; }
        getSystemService(NotificationManager.class).cancel(NOTE_ARRIVED);
    }

    private void autoCancelCheck(long ts) {
        if (Store.tracking(this) && Store.autoTrip(this) && Store.startTs(this) == ts && Store.km(this) < AUTO_MIN_KM) {
            Store.endTrip(this, true);
            MainActivity.ping("discard");
            apply();
        }
    }

    @Override public void onLocationChanged(Location loc) {
        Store.prefs(this).edit().putLong("fixAt", SystemClock.elapsedRealtime()).putFloat("acc", loc.getAccuracy()).apply();
        if (!Store.tracking(this) || loc.getAccuracy() > 60) return;
        if (anchor == null) { anchor = loc; return; }
        double d = anchor.distanceTo(loc) / 1000.0;
        if (d > 5) { anchor = loc; return; }                       // jump after a signal gap: re-anchor
        if (d < Math.max(0.02, loc.getAccuracy() / 1000.0)) return; // within the noise: wait for more movement
        anchor = loc;
        float km = (float) (Store.km(this) + d);
        Store.prefs(this).edit().putFloat("km", km).apply();
        long now = SystemClock.elapsedRealtime();
        if (now - lastNoteAt > 15000) {
            lastNoteAt = now;
            getSystemService(NotificationManager.class).notify(NOTE_ONGOING, ongoing());
        }
    }

    @Override public void onProviderEnabled(String p) {}
    @Override public void onProviderDisabled(String p) {}
    @Override public void onStatusChanged(String p, int s, Bundle b) {}

    // ---------- wireless charger ----------

    private final BroadcastReceiver power = new BroadcastReceiver() {
        @Override public void onReceive(Context c, Intent i) {
            if (Intent.ACTION_POWER_CONNECTED.equals(i.getAction())) {
                // The plugged type can lag the broadcast; check shortly after.
                main.postDelayed(TrackerService.this::onCharger, 2000);
            } else if (Intent.ACTION_POWER_DISCONNECTED.equals(i.getAction())) {
                onLifted();
            }
        }
    };

    private void watchCharger(boolean on) {
        if (on == chargerWatch) return;
        chargerWatch = on;
        if (on) {
            IntentFilter f = new IntentFilter(Intent.ACTION_POWER_CONNECTED);
            f.addAction(Intent.ACTION_POWER_DISCONNECTED);
            registerReceiver(power, f);
        } else {
            try { unregisterReceiver(power); } catch (Exception ignored) {}
        }
    }

    private boolean onWireless() {
        Intent b = registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
        return b != null && b.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) == BatteryManager.BATTERY_PLUGGED_WIRELESS;
    }

    private void onCharger() {
        getSystemService(NotificationManager.class).cancel(NOTE_ARRIVED);
        if (!Store.auto(this) || Store.tracking(this) || !onWireless()) return;
        Store.startTrip(this, System.currentTimeMillis(), true);
        apply();
        MainActivity.ping("start");
    }

    private void onLifted() {
        if (!Store.tracking(this) || !Store.autoTrip(this) || Store.km(this) < AUTO_MIN_KM) return;
        Notification n = new Notification.Builder(this, "arrived")
                .setSmallIcon(R.drawable.ic_note)
                .setContentTitle("Arrived?")
                .setContentText(String.format(Locale.US, "Tap End trip to save it · %.1f km", Store.km(this)))
                .setContentIntent(open(false))
                .addAction(new Notification.Action.Builder(null, "End trip", open(true)).build())
                .setAutoCancel(true)
                .build();
        getSystemService(NotificationManager.class).notify(NOTE_ARRIVED, n);
    }

    // ---------- car Bluetooth ----------

    private final BroadcastReceiver bluetooth = new BroadcastReceiver() {
        @Override public void onReceive(Context c, Intent i) {
            BluetoothDevice d = i.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE);
            if (d == null) return;
            String addr = d.getAddress();
            if (BluetoothDevice.ACTION_ACL_CONNECTED.equals(i.getAction())) onCarConnected(addr);
            else if (BluetoothDevice.ACTION_ACL_DISCONNECTED.equals(i.getAction())) onCarDisconnected(addr);
        }
    };

    private void watchBluetooth(boolean on) {
        if (on == btWatch) return;
        btWatch = on;
        if (on) {
            IntentFilter f = new IntentFilter(BluetoothDevice.ACTION_ACL_CONNECTED);
            f.addAction(BluetoothDevice.ACTION_ACL_DISCONNECTED);
            registerReceiver(bluetooth, f);
        } else {
            try { unregisterReceiver(bluetooth); } catch (Exception ignored) {}
        }
    }

    private String carFor(String addr) {
        try { return new JSONObject(Store.btCars(this)).optString(addr, null); } catch (Exception e) { return null; }
    }

    private void onCarConnected(String addr) {
        String vid = carFor(addr);
        if (vid == null) return;
        getSystemService(NotificationManager.class).cancel(NOTE_ARRIVED);
        if (Store.tracking(this)) {
            // A charger trip that started moments ago: it's in this car.
            if (Store.autoTrip(this) && Store.prefs(this).getString("tripVid", null) == null
                    && System.currentTimeMillis() - Store.startTs(this) < 5 * 60 * 1000) {
                Store.prefs(this).edit().putString("tripVid", vid).putString("btAddr", addr).apply();
                MainActivity.ping("vehicle");
            }
            return;
        }
        Store.startTrip(this, System.currentTimeMillis(), true);
        Store.prefs(this).edit().putString("tripVid", vid).putString("btAddr", addr).apply();
        apply();
        MainActivity.ping("start");
    }

    private void onCarDisconnected(String addr) {
        if (addr.equals(Store.prefs(this).getString("btAddr", null))) onLifted();
    }

    // ---------- notifications ----------

    private PendingIntent open(boolean end) {
        Intent i = new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (end) i.putExtra("end", true);
        return PendingIntent.getActivity(this, end ? 2 : 1, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private Notification ongoing() {
        boolean tracking = Store.tracking(this);
        Notification.Builder b = new Notification.Builder(this, "trip")
                .setSmallIcon(R.drawable.ic_note)
                .setOngoing(true)
                .setContentIntent(open(false));
        if (tracking) {
            b.setContentTitle("Trip in progress")
             .setContentText(String.format(Locale.US, "%.1f km so far", Store.km(this)))
             .setWhen(Store.startTs(this)).setUsesChronometer(true).setShowWhen(true)
             .addAction(new Notification.Action.Builder(null, "End trip", open(true)).build());
        } else {
            b.setContentTitle("Automatic trips on")
             .setContentText(Store.auto(this) && Store.hasBtCars(this) ? "A trip starts on the wireless charger or when your car's Bluetooth connects"
                     : Store.auto(this) ? "A trip starts when the phone goes on the wireless charger"
                     : "A trip starts when your car's Bluetooth connects");
        }
        return b.build();
    }

    @Override public void onDestroy() {
        stopGps();
        watchCharger(false);
        watchBluetooth(false);
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) { return null; }
}
