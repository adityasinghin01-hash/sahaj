package app.sahaj.shield

import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.MediaPlayer
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.provider.Settings
import android.speech.tts.TextToSpeech
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import app.sahaj.shield.core.AlertSink
import app.sahaj.shield.core.LocalVerdict
import app.sahaj.shield.core.Pairing
import app.sahaj.shield.core.Phase2Alerts
import app.sahaj.shield.core.Warning
import java.util.Locale

/**
 * Red screen: TYPE_APPLICATION_OVERLAY full-width card with a big Hindi line, the reason and
 * two big buttons. Vibrates, then plays res/raw/shield_warning_hi (placeholder) followed by a
 * hi-IN TextToSpeech line. During a call the overlay shows at once and the audio waits for the
 * call to end. Without overlay permission: heads-up notification + vibrate.
 */
internal class AlertController(
  private val context: Context,
  private val pairing: () -> Pairing?,
  /** Phase 2 fallback (no overlay permission): registers the pause-screen callbacks, returns a token for the notification actions. */
  private val registerPause: (onCallAnyway: () -> Unit, onDontCall: () -> Unit) -> Int = { _, _ -> 0 },
) : AlertSink, Phase2Alerts {
  private val main = Handler(Looper.getMainLooper())
  private var overlay: View? = null
  @Volatile private var pendingSpeech: String? = null
  /** Phase 2 lines are spoken by TTS only (the recorded clip is line 1, which does not fit them). */
  @Volatile private var pendingTtsOnly = false
  private var player: MediaPlayer? = null
  private var tts: TextToSpeech? = null

  override fun showRedScreen(verdict: LocalVerdict, callActive: Boolean) {
    val reason = verdict.reasons.firstOrNull()?.takeIf { it.isNotBlank() } ?: DEFAULT_REASON
    val p = pairing()
    val childName = p?.childName?.ifBlank { null } ?: "Riya"
    val childNumber = p?.childNumber ?: ""
    main.post {
      vibrate()
      if (canDrawOverlays()) {
        runCatching { showOverlay(HEADLINE, reason, childButtons(childName, childNumber)) }
          .onFailure {
            Log.w(ShieldRuntime.TAG, "overlay failed: ${it.javaClass.simpleName}")
            Notifications.postRed(context, HEADLINE, reason, "$childName ko call karo", childNumber)
          }
      } else {
        Notifications.postRed(context, HEADLINE, reason, "$childName ko call karo", childNumber)
      }
      val speech = "$HEADLINE $reason"
      if (callActive) { pendingSpeech = speech; pendingTtsOnly = false } else playClip(speech)
    }
  }

  /** Called by the call tracker when a call ends: play the clip that was held back. */
  fun onCallEnded() {
    val s = pendingSpeech ?: return
    pendingSpeech = null
    val ttsOnly = pendingTtsOnly
    main.postDelayed({ if (ttsOnly) speak(s) else playClip(s) }, 800)
  }

  fun canDrawOverlays() = Build.VERSION.SDK_INT < Build.VERSION_CODES.M || Settings.canDrawOverlays(context)

  private fun dp(v: Int) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), context.resources.displayMetrics).toInt()

  /** Phase 2: red screen with one of the fixed lines, plus [Theek hai] / [<child> ko call karo]. */
  override fun showWarning(warning: Warning, callActive: Boolean) {
    val p = pairing()
    val childName = p?.childName?.ifBlank { null } ?: "Riya"
    val childNumber = p?.childNumber ?: ""
    val text = warning.text.replace("Riya", childName)
    val speech = warning.speech.replace("Riya", childName)
    main.post {
      vibrate()
      val shown = canDrawOverlays() && runCatching { showOverlay(HEADLINE, text, childButtons(childName, childNumber)) }
        .onFailure { Log.w(ShieldRuntime.TAG, "overlay failed: ${it.javaClass.simpleName}") }.isSuccess
      if (!shown) Notifications.postRed(context, HEADLINE, text, "$childName ko call karo", childNumber)
      if (callActive) { pendingSpeech = speech; pendingTtsOnly = true } else speak(speech)
    }
  }

  /**
   * P8 pause screen: line 3, green [Phir bhi call karo] and [Mat karo]. Without the overlay
   * permission a heads-up notification carries the same two actions (via ShieldActionReceiver).
   */
  override fun showCallPause(onCallAnyway: () -> Unit, onDontCall: () -> Unit) {
    val once = java.util.concurrent.atomic.AtomicBoolean(false)
    val anyway = { if (once.compareAndSet(false, true)) onCallAnyway() }
    val dont = { if (once.compareAndSet(false, true)) onDontCall() }
    main.post {
      vibrate()
      val buttons = listOf(
        OverlayButton("Phir bhi call karo", Color.rgb(0x1B, 0x5E, 0x20), Color.WHITE) { dismissOverlay(); anyway() },
        OverlayButton("Mat karo", Color.WHITE, Color.rgb(0xC6, 0x28, 0x28)) { dismissOverlay(); dont() },
      )
      val shown = canDrawOverlays() && runCatching { showOverlay(HEADLINE, Warning.P8_PAUSE.text, buttons) }
        .onFailure { Log.w(ShieldRuntime.TAG, "overlay failed: ${it.javaClass.simpleName}") }.isSuccess
      if (!shown) {
        val token = registerPause(anyway, dont)
        Notifications.postCallPause(context, HEADLINE, Warning.P8_PAUSE.text, token)
      }
      speak(Warning.P8_PAUSE.speech)
    }
  }

  private class OverlayButton(val label: String, val bg: Int, val fg: Int, val onClick: () -> Unit)

  private fun childButtons(childName: String, childNumber: String) = listOf(
    OverlayButton("Theek hai", Color.WHITE, Color.rgb(0xC6, 0x28, 0x28)) { dismissOverlay() },
    OverlayButton("$childName ko call karo", Color.rgb(0x1B, 0x5E, 0x20), Color.WHITE) {
      dismissOverlay()
      runCatching {
        context.startActivity(
          Intent(Intent.ACTION_DIAL, Uri.parse("tel:" + Uri.encode(childNumber))).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        )
      }
    },
  )

  private fun showOverlay(headline: String, reason: String, buttons: List<OverlayButton>) {
    dismissOverlay()
    val wm = context.getSystemService(WindowManager::class.java) ?: return
    val root = LinearLayout(context).apply {
      orientation = LinearLayout.VERTICAL
      setPadding(dp(24), dp(28), dp(24), dp(24))
      background = GradientDrawable().apply { setColor(Color.rgb(0xC6, 0x28, 0x28)); cornerRadius = dp(8).toFloat() }
      importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_YES
    }
    root.addView(TextView(context).apply {
      text = headline
      setTextColor(Color.WHITE)
      setTextSize(TypedValue.COMPLEX_UNIT_SP, 32f)
      typeface = Typeface.DEFAULT_BOLD
      gravity = Gravity.CENTER
    })
    root.addView(TextView(context).apply {
      text = reason
      setTextColor(Color.WHITE)
      setTextSize(TypedValue.COMPLEX_UNIT_SP, 22f)
      gravity = Gravity.CENTER
      setPadding(0, dp(16), 0, dp(24))
    })
    buttons.forEachIndexed { i, b ->
      root.addView(bigButton(b.label, b.bg, b.fg, b.onClick).apply {
        if (i > 0) (layoutParams as LinearLayout.LayoutParams).topMargin = dp(16)
      })
    }

    @Suppress("DEPRECATION")
    val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
      else WindowManager.LayoutParams.TYPE_PHONE
    @Suppress("DEPRECATION")
    val lp = WindowManager.LayoutParams(
      WindowManager.LayoutParams.MATCH_PARENT,
      WindowManager.LayoutParams.WRAP_CONTENT,
      type,
      WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
        WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or
        WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON or
        WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON or
        WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED,
      PixelFormat.TRANSLUCENT,
    ).apply {
      gravity = Gravity.CENTER
      horizontalMargin = 0f
    }
    wm.addView(root, lp)
    overlay = root
  }

  private fun bigButton(label: String, bg: Int, fg: Int, onClick: () -> Unit) = Button(context).apply {
    text = label
    isAllCaps = false
    setTextColor(fg)
    setTextSize(TypedValue.COMPLEX_UNIT_SP, 24f)
    typeface = Typeface.DEFAULT_BOLD
    minHeight = dp(72)
    background = GradientDrawable().apply { setColor(bg); cornerRadius = dp(12).toFloat() }
    layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
    setOnClickListener { onClick() }
  }

  fun dismissOverlay() {
    val v = overlay ?: return
    overlay = null
    runCatching { context.getSystemService(WindowManager::class.java)?.removeView(v) }
  }

  @Suppress("DEPRECATION")
  private fun vibrate() {
    val vib: Vibrator? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      context.getSystemService(VibratorManager::class.java)?.defaultVibrator
    } else {
      context.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
    }
    if (vib == null || !vib.hasVibrator()) return
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) vib.vibrate(VibrationEffect.createWaveform(VIBRATION, -1))
    else vib.vibrate(VIBRATION, -1)
  }

  private fun playClip(speech: String) {
    stopAudio()
    val attrs = AudioAttributes.Builder()
      .setUsage(AudioAttributes.USAGE_ALARM)
      .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
      .build()
    val am = context.getSystemService(AudioManager::class.java)
    val mp = runCatching {
      MediaPlayer.create(context, R.raw.shield_warning_hi, attrs, am?.generateAudioSessionId() ?: 0)
    }.getOrNull()
    if (mp == null) { speak(speech); return }
    player = mp
    mp.setOnCompletionListener {
      it.release(); player = null
      if (CLIP_IS_PLACEHOLDER) speak(speech)
    }
    mp.setOnErrorListener { p, _, _ -> p.release(); player = null; speak(speech); true }
    mp.start()
  }

  /** TextToSpeech hi-IN fallback (and the real message while the clip is a placeholder). */
  private fun speak(text: String) {
    tts?.shutdown()
    var engine: TextToSpeech? = null
    engine = TextToSpeech(context) { status ->
      val t = engine ?: return@TextToSpeech
      if (status != TextToSpeech.SUCCESS) { t.shutdown(); return@TextToSpeech }
      t.language = Locale("hi", "IN")
      t.setAudioAttributes(
        AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build()
      )
      t.speak(text, TextToSpeech.QUEUE_FLUSH, Bundle(), "sahaj-red")
    }
    tts = engine
  }

  private fun stopAudio() {
    player?.runCatching { stop(); release() }
    player = null
  }

  companion object {
    const val HEADLINE = "रुकिए! यह धोखा हो सकता है।"
    const val DEFAULT_REASON = "किसी को OTP, PIN या पैसे मत दीजिए।"
    /** Flip to false once a real recorded Hindi clip replaces res/raw/shield_warning_hi.wav. */
    const val CLIP_IS_PLACEHOLDER = true
    val VIBRATION = longArrayOf(0, 600, 250, 600, 250, 900)
  }
}
