package app.sahaj.shield

import android.Manifest
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.ContactsContract
import android.provider.Telephony
import android.util.Log
import app.sahaj.shield.core.SmsInput

/** android.provider.Telephony.SMS_RECEIVED → rules engine → (maybe) red screen + masked event. */
class SmsReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION) return
    val parts = runCatching { Telephony.Sms.Intents.getMessagesFromIntent(intent) }.getOrNull() ?: return
    // Join multi-part messages per sender. Raw text stays in memory only.
    val bySender = linkedMapOf<String, StringBuilder>()
    var ts = System.currentTimeMillis()
    for (m in parts) {
      if (m == null) continue
      bySender.getOrPut(m.originatingAddress ?: "") { StringBuilder() }.append(m.messageBody ?: "")
      if (m.timestampMillis > 0) ts = m.timestampMillis
    }
    if (bySender.isEmpty()) return

    val pending = goAsync()
    val rt = ShieldRuntime.get(context)
    rt.worker.execute {
      try {
        for ((sender, body) in bySender) {
          val saved = Contacts.isSaved(context, sender)
          rt.pipeline.onSms(SmsInput(sender, body.toString(), ts), saved)
        }
      } catch (e: Exception) {
        Log.w(ShieldRuntime.TAG, "sms handling failed: ${e.javaClass.simpleName}")
      } finally {
        pending.finish()
      }
    }
    ShieldForegroundService.startIfAllowed(context)
  }
}

internal object Contacts {
  /** True/false if READ_CONTACTS is granted, null if we cannot tell. Never logs the number. */
  fun isSaved(context: Context, number: String?): Boolean? {
    if (number.isNullOrBlank()) return false
    if (context.checkSelfPermission(Manifest.permission.READ_CONTACTS) != PackageManager.PERMISSION_GRANTED) return null
    return try {
      val uri = Uri.withAppendedPath(ContactsContract.PhoneLookup.CONTENT_FILTER_URI, Uri.encode(number))
      context.contentResolver.query(uri, arrayOf(ContactsContract.PhoneLookup._ID), null, null, null)
        ?.use { it.count > 0 } ?: false
    } catch (e: Exception) {
      null
    }
  }
}
