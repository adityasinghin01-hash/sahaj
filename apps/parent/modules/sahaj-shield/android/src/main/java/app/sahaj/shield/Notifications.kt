package app.sahaj.shield

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build

internal object Notifications {
  const val ID_ONGOING = 7101
  const val ID_RED = 7102
  const val ID_AFTER_CALL = 7103
  const val ID_CALL_PAUSE = 7104
  const val ID_BANK_NOTE = 7105

  private const val CH_ONGOING = "sahaj_shield_ongoing"
  private const val CH_RED = "sahaj_shield_red"
  private const val CH_AFTER_CALL = "sahaj_shield_after_call"
  private const val CH_NOTE = "sahaj_shield_note"

  /** Deep link the frontend's after-call screen will handle (app.json "scheme"). */
  const val AFTER_CALL_URI = "sahajmaa://after-call"

  private fun ensureChannels(ctx: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val nm = ctx.getSystemService(NotificationManager::class.java) ?: return
    nm.createNotificationChannel(NotificationChannel(CH_ONGOING, "Sahaj suraksha chalu hai", NotificationManager.IMPORTANCE_LOW))
    nm.createNotificationChannel(NotificationChannel(CH_RED, "Dhokhe ki chetavani", NotificationManager.IMPORTANCE_HIGH).apply {
      enableVibration(true)
      vibrationPattern = AlertController.VIBRATION
      lockscreenVisibility = Notification.VISIBILITY_PUBLIC
    })
    nm.createNotificationChannel(NotificationChannel(CH_AFTER_CALL, "Call ke baad sawaal", NotificationManager.IMPORTANCE_HIGH))
    // Quiet notes (no sound, no vibration, no heads-up).
    nm.createNotificationChannel(NotificationChannel(CH_NOTE, "Call ke baad jaankari", NotificationManager.IMPORTANCE_LOW).apply {
      enableVibration(false)
      setSound(null, null)
    })
  }

  @Suppress("DEPRECATION")
  private fun builder(ctx: Context, channel: String): Notification.Builder =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) Notification.Builder(ctx, channel) else Notification.Builder(ctx)

  private fun canPost(ctx: Context) =
    Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
      ctx.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

  private fun openApp(ctx: Context, uri: String? = null): PendingIntent? {
    val intent = if (uri != null) {
      Intent(Intent.ACTION_VIEW, Uri.parse(uri)).setPackage(ctx.packageName)
    } else {
      ctx.packageManager.getLaunchIntentForPackage(ctx.packageName)
    } ?: return null
    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
    return PendingIntent.getActivity(ctx, uri.hashCode(), intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
  }

  fun ongoing(ctx: Context): Notification {
    ensureChannels(ctx)
    return builder(ctx, CH_ONGOING)
      .setSmallIcon(android.R.drawable.ic_lock_idle_lock)
      .setContentTitle("सहज सुरक्षा चालू है")
      .setContentText("धोखे वाले SMS और कॉल पर नज़र रखी जा रही है")
      .setOngoing(true)
      .setContentIntent(openApp(ctx))
      .build()
  }

  /** Fallback when the overlay permission is missing: heads-up notification. */
  @Suppress("DEPRECATION")
  fun postRed(ctx: Context, title: String, reason: String, childLabel: String, childNumber: String) {
    if (!canPost(ctx)) return
    ensureChannels(ctx)
    val dial = PendingIntent.getActivity(
      ctx, 1,
      Intent(Intent.ACTION_DIAL, Uri.parse("tel:" + Uri.encode(childNumber))).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
    val b = builder(ctx, CH_RED)
      .setSmallIcon(android.R.drawable.stat_sys_warning)
      .setContentTitle(title)
      .setContentText(reason)
      .setStyle(Notification.BigTextStyle().bigText(reason))
      .setCategory(Notification.CATEGORY_ALARM)
      .setPriority(Notification.PRIORITY_MAX)
      .setVibrate(AlertController.VIBRATION)
      .setColor(0xFFC62828.toInt())
      .setAutoCancel(true)
      .setContentIntent(openApp(ctx))
      .addAction(Notification.Action.Builder(null, childLabel, dial).build())
    ctx.getSystemService(NotificationManager::class.java)?.notify(ID_RED, b.build())
  }

  /**
   * P8 fallback when the overlay permission is missing: line 3 with [Phir bhi call karo] / [Mat karo].
   * The actions go to ShieldActionReceiver with only a [token]; the number stays in process memory.
   */
  @Suppress("DEPRECATION")
  fun postCallPause(ctx: Context, title: String, text: String, token: Int) {
    if (!canPost(ctx)) return
    ensureChannels(ctx)
    fun action(label: String, action: String, req: Int): Notification.Action {
      val i = Intent(ctx, ShieldActionReceiver::class.java).setAction(action).putExtra(ShieldActionReceiver.EXTRA_TOKEN, token)
      val pi = PendingIntent.getBroadcast(ctx, req, i, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
      return Notification.Action.Builder(null, label, pi).build()
    }
    val b = builder(ctx, CH_RED)
      .setSmallIcon(android.R.drawable.stat_sys_warning)
      .setContentTitle(title)
      .setContentText(text)
      .setStyle(Notification.BigTextStyle().bigText(text))
      .setCategory(Notification.CATEGORY_ALARM)
      .setPriority(Notification.PRIORITY_MAX)
      .setVibrate(AlertController.VIBRATION)
      .setColor(0xFFC62828.toInt())
      .setAutoCancel(true)
      .addAction(action("Phir bhi call karo", ShieldActionReceiver.ACTION_CALL_ANYWAY, 11))
      .addAction(action("Mat karo", ShieldActionReceiver.ACTION_DONT_CALL, 12))
    ctx.getSystemService(NotificationManager::class.java)?.notify(ID_CALL_PAUSE, b.build())
  }

  fun cancel(ctx: Context, id: Int) {
    ctx.getSystemService(NotificationManager::class.java)?.cancel(id)
  }

  /**
   * Step 3.3: after an incoming 1600-series call (registered bank / insurer numbers), a small quiet
   * note. No alarm. Tapping it opens the after-call screen (which shows the same note).
   */
  @Suppress("DEPRECATION")
  fun postRegisteredBankNote(ctx: Context) {
    if (!canPost(ctx)) return
    ensureChannels(ctx)
    val b = builder(ctx, CH_NOTE)
      .setSmallIcon(android.R.drawable.ic_dialog_info)
      .setContentTitle("Ye registered bank number tha")
      .setContentText("ये रजिस्टर्ड बैंक नंबर था")
      .setPriority(Notification.PRIORITY_LOW)
      .setOnlyAlertOnce(true)
      .setAutoCancel(true)
      .setContentIntent(openApp(ctx, AFTER_CALL_URI))
    ctx.getSystemService(NotificationManager::class.java)?.notify(ID_BANK_NOTE, b.build())
  }

  /** After a P1 call ends: ask the parent what happened. Opens the app's after-call screen. */
  @Suppress("DEPRECATION")
  fun postAfterCallQuestion(ctx: Context) {
    if (!canPost(ctx)) return
    ensureChannels(ctx)
    val b = builder(ctx, CH_AFTER_CALL)
      .setSmallIcon(android.R.drawable.stat_sys_warning)
      .setContentTitle("अभी वाली कॉल के बारे में एक सवाल")
      .setContentText("क्या कॉल करने वाले ने OTP या पैसे माँगे? यहाँ दबाइए।")
      .setPriority(Notification.PRIORITY_HIGH)
      .setAutoCancel(true)
      .setContentIntent(openApp(ctx, AFTER_CALL_URI))
    ctx.getSystemService(NotificationManager::class.java)?.notify(ID_AFTER_CALL, b.build())
  }
}
