package app.sahaj.shield

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.telephony.PhoneStateListener
import android.telephony.TelephonyCallback
import android.telephony.TelephonyManager
import android.util.Log
import androidx.annotation.RequiresApi
import app.sahaj.shield.core.CallStateTracker

/**
 * Call active / ended. TelephonyCallback.CallStateListener on Android 12+, PhoneStateListener before.
 * Both need only READ_PHONE_STATE for the state itself (the number would need READ_CALL_LOG,
 * which we do not ask for: the CallScreeningService gives us saved/unsaved instead).
 */
internal class CallStateMonitor(private val context: Context, private val tracker: CallStateTracker) {
  private var registered: Any? = null

  @Synchronized
  fun start() {
    if (registered != null) return
    if (context.checkSelfPermission(Manifest.permission.READ_PHONE_STATE) != PackageManager.PERMISSION_GRANTED) return
    val tm = context.getSystemService(TelephonyManager::class.java) ?: return
    try {
      registered = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) registerModern(tm) else registerLegacy(tm)
    } catch (e: SecurityException) {
      Log.w(ShieldRuntime.TAG, "call state listener not allowed")
    }
  }

  @RequiresApi(Build.VERSION_CODES.S)
  private fun registerModern(tm: TelephonyManager): Any {
    val cb = object : TelephonyCallback(), TelephonyCallback.CallStateListener {
      override fun onCallStateChanged(state: Int) = deliver(state)
    }
    tm.registerTelephonyCallback(context.mainExecutor, cb)
    return cb
  }

  @Suppress("DEPRECATION")
  private fun registerLegacy(tm: TelephonyManager): Any {
    var listener: PhoneStateListener? = null
    // PhoneStateListener must be created on a Looper thread.
    val create = Runnable {
      listener = object : PhoneStateListener() {
        override fun onCallStateChanged(state: Int, phoneNumber: String?) = deliver(state)
      }
      tm.listen(listener, PhoneStateListener.LISTEN_CALL_STATE)
    }
    if (Looper.myLooper() == Looper.getMainLooper()) create.run() else Handler(Looper.getMainLooper()).post(create)
    return create
  }

  private fun deliver(state: Int) {
    tracker.onCallState(map(state))
  }

  companion object {
    fun map(state: Int): CallStateTracker.State = when (state) {
      TelephonyManager.CALL_STATE_RINGING -> CallStateTracker.State.RINGING
      TelephonyManager.CALL_STATE_OFFHOOK -> CallStateTracker.State.OFFHOOK
      else -> CallStateTracker.State.IDLE
    }
  }
}
