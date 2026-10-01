package app.drivemate;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Restarts the charger/Bluetooth watch / an unfinished trip after a reboot or an app update. */
public class BootReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context c, Intent i) {
        Reminder.schedule(c); // alarms are cleared by a reboot
        if ((Store.watching(c) || Store.tracking(c)) && Store.hasBackground(c)) TrackerService.sync(c);
    }
}
