package app.sahaj.shield.core

/**
 * In-memory ring buffer of debug lines for the phone test screen (T4/T6). Process memory only,
 * never written to disk or sent. Callers must only add yes/no facts and package names:
 * never a phone number and never message text.
 */
class DebugEvents(private val max: Int = 50, private val clock: () -> Long = System::currentTimeMillis) {
  private val lines = ArrayDeque<String>()

  @Synchronized fun add(line: String) {
    lines.addFirst("${IsoTime.format(clock())} $line")
    while (lines.size > max) lines.removeLast()
  }

  /** Newest first. */
  @Synchronized fun snapshot(): List<String> = lines.toList()
}

/** T4: what the CallRedirectionService logs about one outgoing call. The number itself is never included. */
object RedirectionLog {
  fun line(savedContact: Boolean?, paused: Boolean = false): String =
    "T4 redirection seen · saved_contact=${yesNoUnknown(savedContact)} · ${if (paused) "P8 paused" else "placed unmodified"}"
}

/**
 * T6: the three facts we log about a WhatsApp notification. Built from the notification fields,
 * but only booleans leave this object; the text is never stored or logged.
 */
data class NotificationSignals(
  val packageName: String,
  val hasText: Boolean,
  val isCallNotification: Boolean,
  val apkAttachment: Boolean,
) {
  fun logLine(): String =
    "T6 notification · pkg=$packageName · has_text=${yesNo(hasText)} · " +
      "is_call_notification=${yesNo(isCallNotification)} · attachment_apk=${yesNo(apkAttachment)}"

  companion object {
    val WATCHED_PACKAGES = setOf("com.whatsapp", "com.whatsapp.w4b")

    /**
     * Returns null for any package other than WhatsApp / WhatsApp Business.
     * [texts]: title-less text fields (EXTRA_TEXT, EXTRA_BIG_TEXT, text lines, message texts).
     * [category]: Notification.category. [callStyle]: true if the notification uses CallStyle.
     * [attachmentNames]: file names / URI paths of attachments, when the notification carries any.
     */
    fun from(
      packageName: String,
      texts: List<CharSequence?>,
      category: String?,
      callStyle: Boolean,
      attachmentNames: List<String?>,
    ): NotificationSignals? {
      if (packageName !in WATCHED_PACKAGES) return null
      val nonBlank = texts.filterNotNull().map { it.toString().trim() }.filter { it.isNotEmpty() }
      // WhatsApp shows a document as "📄 name.apk" in the text, so check the end of each text too.
      val apk = (attachmentNames.filterNotNull().map { it.trim() } + nonBlank).any { endsWithApk(it) }
      return NotificationSignals(
        packageName = packageName,
        hasText = nonBlank.isNotEmpty(),
        isCallNotification = callStyle || category == "call",
        apkAttachment = apk,
      )
    }

    private fun endsWithApk(s: String): Boolean = s.trimEnd('"', '\'', ')', ' ').lowercase().endsWith(".apk")
  }
}

private fun yesNo(b: Boolean) = if (b) "yes" else "no"
private fun yesNoUnknown(b: Boolean?) = when (b) { true -> "yes"; false -> "no"; null -> "unknown" }
