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
 * T6 (Phase 1, logging only). For WhatsApp / WhatsApp Business notifications it logs three
 * yes/no facts: has_text, is_call_notification, attachment ends with .apk. The text itself is
 * read in memory only to answer those questions; it is never logged, stored or sent.
 * Every other package is ignored.
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
      val callStyle = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S &&
        extras?.containsKey(Notification.EXTRA_CALL_TYPE) == true
      val signals = NotificationSignals.from(pkg, texts, n.category, callStyle, attachments) ?: return
      val line = signals.logLine()
      Log.i(TEST_LOG_TAG, line)
      ShieldRuntime.get(this).debugEvents.add(line)
    } catch (e: Exception) {
      Log.w(ShieldRuntime.TAG, "notification check failed: ${e.javaClass.simpleName}")
    }
  }
}
