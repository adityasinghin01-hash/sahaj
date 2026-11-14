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

/**
 * android.provider.Telephony.SMS_RECEIVED → rules engine → (maybe) red screen + masked event.
 * Gateway mode (Step 3.4, spare phone): every SMS is forwarded to /api/sms/gateway instead; no rules,
 * no red screen. Neither path logs the number or the text.
 */
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
    if (rt.gateway.isOn()) {
      rt.worker.execute {
        try {
          var n = 0
          for ((sender, body) in bySender) if (rt.gateway.enqueue(sender, body.toString(), ts)) n++
          rt.debugEvents.add("gateway · queued=$n")
          rt.kickSender()
        } catch (e: Exception) {
          Log.w(ShieldRuntime.TAG, "gateway forward failed: ${e.javaClass.simpleName}")
        } finally {
          pending.finish()
        }
      }
      ShieldForegroundService.startIfAllowed(context)
      return
    }
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

  /**
   * P2: is a WhatsApp notification title the name of a saved contact? WhatsApp shows the saved name
   * for saved contacts and the number (or "~ name") for others. null = cannot tell (no READ_CONTACTS).
   * The title is used for this lookup only; it is never logged, stored or sent.
   */
  fun isSavedName(context: Context, title: String?): Boolean? {
    val t = title?.trim().orEmpty()
    if (t.isEmpty() || t.startsWith("~")) return false
    if (PhoneNumbersCompat.digitCount(t) >= 7) return isSaved(context, t)
    if (context.checkSelfPermission(Manifest.permission.READ_CONTACTS) != PackageManager.PERMISSION_GRANTED) return null
    return try {
      context.contentResolver.query(
        ContactsContract.Contacts.CONTENT_URI,
        arrayOf(ContactsContract.Contacts._ID),
        "${ContactsContract.Contacts.DISPLAY_NAME} = ? COLLATE NOCASE",
        arrayOf(t),
        null,
      )?.use { it.count > 0 } ?: false
    } catch (e: Exception) {
      null
    }
  }
}

private object PhoneNumbersCompat {
  fun digitCount(s: String) = s.count { Character.isDigit(it) }
}
