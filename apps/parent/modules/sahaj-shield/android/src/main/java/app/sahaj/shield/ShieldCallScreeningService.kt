package app.sahaj.shield

import android.os.Build
import android.telecom.Call
import android.telecom.CallScreeningService
import android.util.Log

/**
 * Runs for every incoming call once the app holds ROLE_CALL_SCREENING.
 * Notes only "saved contact or not" and the caller type in memory, then ALWAYS lets the call through.
 * It never blocks, rejects, silences or hangs up.
 */
class ShieldCallScreeningService : CallScreeningService() {
  override fun onScreenCall(details: Call.Details) {
    try {
      val incoming = Build.VERSION.SDK_INT < Build.VERSION_CODES.Q ||
        details.callDirection == Call.Details.DIRECTION_INCOMING
      if (incoming) {
        val number = details.handle?.schemeSpecificPart
        // Unknown (no READ_CONTACTS) or hidden number counts as unsaved.
        val saved = Contacts.isSaved(this, number) == true
        val rt = ShieldRuntime.get(this)
        // CallerType (series_1600, mobile_10, …) from the rules.json caller patterns; the number stays in memory.
        rt.calls.onIncomingScreened(saved, rt.config.callerType(number, saved))
        rt.ensureCallMonitor()
      }
    } catch (e: Exception) {
      Log.w(ShieldRuntime.TAG, "screening note failed: ${e.javaClass.simpleName}")
    } finally {
      respondToCall(details, allowResponse())
    }
  }

  companion object {
    fun allowResponse(): CallResponse = CallResponse.Builder()
      .setDisallowCall(false)
      .setRejectCall(false)
      .setSkipCallLog(false)
      .setSkipNotification(false)
      .build()
  }
}
