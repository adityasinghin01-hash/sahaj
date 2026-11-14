package app.sahaj.shield.core

/**
 * Last line of defence before anything leaves the phone.
 * Any group of digits (ASCII or other scripts, e.g. Devanagari) that adds up to 4 or more digits,
 * even when split by spaces, dashes, dots, commas or slashes ("98 765-43210", "1 2 3 4"),
 * becomes [MASK]. Short groups (1–3 digits, e.g. "Rs 500") stay so the text still makes sense.
 */
object Masker {
  const val MASK = "[num]"
  const val MAX_LEN = 2000 // ShieldEvent.masked_text max

  private val digitGroup = Regex("""\p{Nd}(?:[\s\-.,/()]*\p{Nd})*""")
  private val digit = Regex("""\p{Nd}""")
  private val longRun = Regex("""\p{Nd}(?:[\s\-.,/()]{0,2}\p{Nd}){3,}""")

  fun mask(text: String): String {
    val masked = digitGroup.replace(text) { m ->
      if (digit.findAll(m.value).count() >= 4) MASK else m.value
    }
    return if (masked.length <= MAX_LEN) masked else masked.substring(0, MAX_LEN)
  }

  /** True if [text] still has 4 or more digits in a row. Used by tests and as a send-time guard. */
  fun hasLongDigitRun(text: String): Boolean = longRun.containsMatchIn(text)
}
