package app.sahaj.shield

import android.annotation.TargetApi
import android.net.Uri
import android.os.Build
import android.telecom.CallRedirectionService
import android.telecom.PhoneAccountHandle
import android.util.Log
import app.sahaj.shield.core.OutgoingCallGuard
import app.sahaj.shield.core.RedirectionLog

/**
 * Bound by Telecom for every outgoing call once the app holds ROLE_CALL_REDIRECTION.
 * T4: logs only whether the dialled number is a saved contact.
 * P8 (Step 2.1, behind the p8_pause_call switch): if the dialled number appeared in a flagged SMS
 * in the last 24 h, the call is cancelled and the pause screen (line 3) asks
 * [Phir bhi call karo] / [Mat karo]. Every other call is placed unmodified, as before.
 * The number is held in memory only; it is never logged, stored or sent (the store keeps a hash).
 */
@TargetApi(Build.VERSION_CODES.Q)
class ShieldCallRedirectionService : CallRedirectionService() {
  override fun onPlaceCall(handle: Uri, initialPhoneAccount: PhoneAccountHandle, allowInteractiveResponsePresentation: Boolean) {
    var decision = OutgoingCallGuard.Decision.PLACE_UNMODIFIED
    try {
      val rt = ShieldRuntime.get(this)
      val number = handle.schemeSpecificPart.orEmpty()
      val saved = Contacts.isSaved(this, number)
      // P9 also covers calls she dials to an unsaved number.
      rt.calls.onOutgoingDialled(saved == true, rt.config.callerType(number, saved == true))
      // Telecom says when UI is not allowed (e.g. car mode): then we never pause.
      if (allowInteractiveResponsePresentation) {
        decision = rt.phase2.outgoing.onOutgoingCall(number, replace = { rt.replaceCall(number) })
      }
      val line = RedirectionLog.line(saved, paused = decision == OutgoingCallGuard.Decision.PAUSED)
      Log.i(TEST_LOG_TAG, line)
      rt.debugEvents.add(line)
    } catch (e: Exception) {
      Log.w(ShieldRuntime.TAG, "redirection check failed: ${e.javaClass.simpleName}")
      decision = OutgoingCallGuard.Decision.PLACE_UNMODIFIED
    } finally {
      // Must answer within 5 s; we always answer at once. Anything unexpected → the call goes through.
      if (decision == OutgoingCallGuard.Decision.PAUSED) cancelCall() else placeCallUnmodified()
    }
  }
}
