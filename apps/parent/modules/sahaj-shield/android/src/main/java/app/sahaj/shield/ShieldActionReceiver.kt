package app.sahaj.shield

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Not exported. Receives the two P8 pause-notification actions (used only when the overlay
 * permission is missing). The intent carries a token; the callbacks (and the dialled number)
 * live in ShieldRuntime memory only.
 */
class ShieldActionReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val token = intent.getIntExtra(EXTRA_TOKEN, 0)
    val rt = ShieldRuntime.get(context)
    Notifications.cancel(context, Notifications.ID_CALL_PAUSE)
    when (intent.action) {
      ACTION_CALL_ANYWAY -> rt.resolvePause(token, callAnyway = true)
      ACTION_DONT_CALL -> rt.resolvePause(token, callAnyway = false)
    }
  }

  companion object {
    const val ACTION_CALL_ANYWAY = "app.sahaj.shield.action.CALL_ANYWAY"
    const val ACTION_DONT_CALL = "app.sahaj.shield.action.DONT_CALL"
    const val EXTRA_TOKEN = "token"
  }
}
