package app.sahaj.shield

import android.app.Notification
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log

/**
 * Keeps the process (call-state listener + send queue) alive with the app screen closed.
 * Type specialUse: none of the standard FGS types fits "watch calls/SMS for scams"
 * (phoneCall needs the dialer role). Needs a Play Console declaration.
 */
class ShieldForegroundService : Service() {
  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    val n: Notification = Notifications.ongoing(this)
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
        startForeground(Notifications.ID_ONGOING, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
      } else {
        startForeground(Notifications.ID_ONGOING, n)
      }
    } catch (e: Exception) {
      Log.w(ShieldRuntime.TAG, "startForeground failed: ${e.javaClass.simpleName}")
      stopSelf()
    }
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val rt = ShieldRuntime.get(this)
    rt.ensureCallMonitor()
    rt.kickSender()
    return START_STICKY
  }

  companion object {
    /** Best effort. Background starts are refused on Android 12+ unless an exemption applies. */
    fun startIfAllowed(context: Context) {
      try {
        val i = Intent(context, ShieldForegroundService::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(i) else context.startService(i)
      } catch (e: Exception) {
        Log.w(ShieldRuntime.TAG, "fgs start refused: ${e.javaClass.simpleName}")
      }
    }
  }
}

/** BOOT_COMPLETED (and app update) → restart the watcher if the phone is paired. */
class BootReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    when (intent.action) {
      Intent.ACTION_BOOT_COMPLETED, Intent.ACTION_MY_PACKAGE_REPLACED -> {
        val rt = ShieldRuntime.get(context)
        if (rt.isPaired()) ShieldForegroundService.startIfAllowed(context)
        rt.ensureCallMonitor()
        rt.kickSender()
      }
    }
  }
}
