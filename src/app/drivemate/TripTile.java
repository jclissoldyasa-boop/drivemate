package app.drivemate;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.service.quicksettings.Tile;
import android.service.quicksettings.TileService;

import java.util.Locale;

/** Quick-settings tile: tap to start a trip; while one runs, tap to end it in the app. */
public class TripTile extends TileService {
    static void refresh(Context c) {
        try { TileService.requestListeningState(c, new ComponentName(c, TripTile.class)); } catch (Exception ignored) {}
    }

    @Override public void onStartListening() { show(); }

    @Override public void onClick() {
        if (!Store.tracking(this)) { TripControl.start(this); show(); return; }
        if (Build.VERSION.SDK_INT >= 34) startActivityAndCollapse(TripControl.endIntent(this));
        else startEnd();
    }

    @SuppressWarnings("deprecation")
    private void startEnd() {
        startActivityAndCollapse(new Intent(this, MainActivity.class).putExtra("end", true)
                .setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP));
    }

    private void show() {
        Tile t = getQsTile();
        if (t == null) return;
        boolean on = Store.tracking(this);
        t.setState(on ? Tile.STATE_ACTIVE : Tile.STATE_INACTIVE);
        t.setLabel(on ? "End trip" : "Start trip");
        if (Build.VERSION.SDK_INT >= 29) t.setSubtitle(on ? String.format(Locale.US, "%.1f km", Store.km(this)) : "DriveMate");
        t.updateTile();
    }
}
