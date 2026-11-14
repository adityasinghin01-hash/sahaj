package app.sahaj.shield

import android.annotation.TargetApi
import android.net.Uri
import android.os.Build
import android.telecom.CallRedirectionService
import android.telecom.PhoneAccountHandle
import android.util.Log
import app.sahaj.shield.core.RedirectionLog

/**
 * T4 (Phase 1, logging only). Bound by Telecom for every outgoing call once the app holds
 * ROLE_CALL_REDIRECTION. It ALWAYS places the call unmodified. It logs only whether the dialled
 * number is a saved contact; the number is never logged, stored or sent. Phase 2 adds the real behaviour.
 */
@TargetApi(Build.VERSION_CODES.Q)
class ShieldCallRedirectionService : CallRedirectionService() {
  override fun onPlaceCall(handle: Uri, initialPhoneAccount: PhoneAccountHandle, allowInteractiveResponsePresentation: Boolean) {
    try {
      val saved = Contacts.isSaved(this, handle.schemeSpecificPart)
      val line = RedirectionLog.line(saved)
      Log.i(TEST_LOG_TAG, line)
      ShieldRuntime.get(this).debugEvents.add(line)
    } catch (e: Exception) {
      Log.w(ShieldRuntime.TAG, "redirection log failed: ${e.javaClass.simpleName}")
    } finally {
      // Must answer within 5 s or Telecom places the call anyway; we always answer at once.
      placeCallUnmodified()
    }
  }
}
