package app.sahaj.shield.core

/** Android-free audio selection: absent recordings always retain the same spoken fallback. */
object WarningAudio {
  data class Choice(val resourceName: String?, val resourceId: Int, val speech: String)

  fun resourceName(line: Int, drillHandled: Boolean? = null): String {
    require(line in 1..9) { "Unknown Shield warning line" }
    if (line == 9) {
      requireNotNull(drillHandled) { "Line 9 requires a drill outcome" }
      return if (drillHandled) "shield_line_9a" else "shield_line_9b"
    }
    return "shield_line_$line"
  }

  fun select(line: Int?, speech: String, drillHandled: Boolean? = null, lookup: (String) -> Int): Choice {
    val name = line?.let { resourceName(it, drillHandled) }
    val id = name?.let(lookup)?.takeIf { it > 0 } ?: 0
    return Choice(name, id, speech)
  }

  /** The banking-app warning has its own wording and no numbered clip; retain its TTS. */
  fun lineFor(warning: Warning): Int? = when (warning) {
    Warning.P8_PAUSE -> 3
    Warning.P2_VIDEO_CALL -> 4
    Warning.P3_APK, Warning.INSTALLED_APP -> 5
    Warning.P9_BANK_APP -> null
  }

  /** Lines not yet spoken by a local workflow can use the native playWarningLine port. */
  fun speech(line: Int, drillHandled: Boolean? = null): String {
    resourceName(line, drillHandled) // validate outcome before selecting words
    return when (line) {
      1 -> "रुकिए! यह धोखा हो सकता है। किसी को OTP, PIN या पैसे मत दीजिए।"
      2 -> "OTP किसी को मत बताइए जी। बैंक, पुलिस या कंपनी कभी OTP नहीं माँगते।"
      3 -> Warning.P8_PAUSE.speech
      4 -> Warning.P2_VIDEO_CALL.speech
      5 -> Warning.P3_APK.speech
      6 -> "क्या आपने किसी को OTP बताया है जी? बताया हो तो कोई बात नहीं, हम अभी मदद करते हैं।"
      // No unsupported claim that the family has already received a message.
      7 -> "पैसे चले गए हैं तो अभी 1930 पर कॉल कीजिए।"
      8 -> "एक मिनट रुकिए जी, मैं आपके घर वालों से पूछ रही हूँ।"
      9 -> if (drillHandled == true) "ये सिर्फ़ अभ्यास था जी। आपने बिल्कुल सही किया।"
        else "ये सिर्फ़ अभ्यास था जी। कोई बात नहीं। अगली बार पैसे या OTP मत दीजिए, पहले अपने घर वालों से पूछिए।"
      else -> error("Unknown Shield warning line")
    }
  }
}
