package app.sahaj.shield

import android.app.Notification
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Parcelable
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.util.Log
import app.sahaj.shield.core.NotificationSignals

/**
 * WhatsApp / WhatsApp Business notifications only; every other package is ignored.
 * T6: logs three yes/no facts (has_text, is_call_notification, attachment_apk).
 * P2 (p2_video_call switch): an ongoing call notification whose title is not a saved contact starts
 * a timer; still there after 10 min (÷ demoScale) → red + line 4. Removal stops the timer.
 * P3 (p3_apk switch): an attachment / document name ending in .apk → red + line 5.
 * The text and title are read in memory only to answer those questions; they are never logged,
 * stored or sent. Only the signals leave the phone.
 */
class ShieldNotificationListener : NotificationListenerService() {
  override fun onNotificationPosted(sbn: StatusBarNotification?) {
    val pkg = sbn?.packageName ?: return
    if (pkg !in NotificationSignals.WATCHED_PACKAGES) return
    try {
      val n = sbn.notification ?: return
      val extras = n.extras
      val texts = mutableListOf<CharSequence?>()
      val attachments = mutableListOf<String?>()
      if (extras != null) {
        texts += extras.getCharSequence(Notification.EXTRA_TEXT)
        texts += extras.getCharSequence(Notification.EXTRA_BIG_TEXT)
        extras.getCharSequenceArray(Notification.EXTRA_TEXT_LINES)?.let { texts += it }
        @Suppress("DEPRECATION")
        val msgs: Array<Parcelable>? = extras.getParcelableArray(Notification.EXTRA_MESSAGES)
        // MessagingStyle bundles: "text" (CharSequence), optional "uri" (attachment) — same keys as the framework writes.
        msgs?.filterIsInstance<Bundle>()?.forEach { b ->
          texts += b.getCharSequence("text")
          @Suppress("DEPRECATION")
          (b.getParcelable<Parcelable>("uri") as? Uri)?.lastPathSegment?.let { attachments += it }
        }
      }
      val callType = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) extras?.getInt(Notification.EXTRA_CALL_TYPE, 0) ?: 0 else 0
      val callStyle = callType != 0
      val signals = NotificationSignals.from(pkg, texts, n.category, callStyle, attachments) ?: return
      val rt = ShieldRuntime.get(this)
      val line = signals.logLine()
      Log.i(TEST_LOG_TAG, line)
      rt.debugEvents.add(line)

      // P2: ongoing call (not the ringing one: CallStyle type 1 = incoming).
      val ongoing = (n.flags and Notification.FLAG_ONGOING_EVENT) != 0 || callType == CALL_TYPE_ONGOING
      if (signals.isCallNotification && ongoing && callType != CALL_TYPE_INCOMING) {
        val title = extras?.getCharSequence(Notification.EXTRA_TITLE)?.toString()
        if (rt.phase2.whatsAppCalls.onCallNotification(sbn.key, Contacts.isSavedName(this, title))) {
          rt.debugEvents.add("P2 timer started · ${rt.phase2.whatsAppCalls.thresholdMs() / 1000}s")
        }
      }
      // P3: .apk attachment.
      if (rt.phase2.apk.onSignals(sbn.key, signals)) rt.debugEvents.add("P3 apk warning shown")
    } catch (e: Exception) {
      Log.w(ShieldRuntime.TAG, "notification check failed: ${e.javaClass.simpleName}")
    }
  }

  override fun onNotificationRemoved(sbn: StatusBarNotification?) {
    val pkg = sbn?.packageName ?: return
    if (pkg !in NotificationSignals.WATCHED_PACKAGES) return
    runCatching { ShieldRuntime.get(this).phase2.whatsAppCalls.onNotificationRemoved(sbn.key) }
  }

  private companion object {
    /** Notification.CALL_TYPE_INCOMING (API 31). */
    const val CALL_TYPE_INCOMING = 1
    /** Notification.CALL_TYPE_ONGOING (API 31). */
    const val CALL_TYPE_ONGOING = 2
  }
}
