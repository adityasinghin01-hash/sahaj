package app.sahaj.shield.rules

import java.util.Locale

/** Devanagari digits U+0966..U+096F -> ASCII '0'..'9'. */
internal fun asciiDigits(text: String): String {
    val sb = StringBuilder(text.length)
    for (ch in text) {
        val code = ch.code
        if (code in 0x0966..0x096F) {
            sb.append(('0'.code + (code - 0x0966)).toChar())
        } else {
            sb.append(ch)
        }
    }
    return sb.toString()
}

private fun keepChar(code: Int): Boolean {
    if (code in 0x61..0x7A) return true // a-z
    if (code in 0x30..0x39) return true // 0-9
    // Devanagari block minus danda (U+0964) and double danda (U+0965)
    return code in 0x0900..0x097F && code != 0x0964 && code != 0x0965
}

/** Lowercase, drop ZWJ/ZWNJ, map everything outside [a-z0-9]/Devanagari to one space. */
internal fun normalizeText(text: String): String {
    val lower = asciiDigits(text).lowercase(Locale.ROOT)
    val sb = StringBuilder(lower.length)
    var lastSpace = true
    for (ch in lower) {
        val code = ch.code
        if (code == 0x200C || code == 0x200D) continue
        if (keepChar(code)) {
            sb.append(ch)
            lastSpace = false
        } else if (!lastSpace) {
            sb.append(' ')
            lastSpace = true
        }
    }
    return sb.toString().trim()
}

internal data class PhraseMatch<T>(
    val item: T,
    val phrase: String,
    val start: Int,
    val end: Int,
)

/** Whole-word phrase matching on normalized text with longest-match-wins overlap filtering. */
internal fun <T> matchPhrases(
    normalized: String,
    items: List<T>,
    phraseText: (T) -> String,
): List<PhraseMatch<T>> {
    val hay = " $normalized "
    val found = mutableListOf<PhraseMatch<T>>()
    for (item in items) {
        val phrase = normalizeText(phraseText(item))
        if (phrase.isEmpty()) continue
        val idx = hay.indexOf(" $phrase ")
        if (idx >= 0) {
            found.add(PhraseMatch(item, phrase, idx + 1, idx + 1 + phrase.length))
        }
    }
    val sorted = found.sortedByDescending { it.end - it.start }
    val accepted = mutableListOf<PhraseMatch<T>>()
    for (m in sorted) {
        if (accepted.none { a -> a.start <= m.start && m.end <= a.end }) {
            accepted.add(m)
        }
    }
    return accepted
}

internal fun hasAnyPhrase(normalized: String, phrases: List<String>): Boolean {
    val hay = " $normalized "
    return phrases.any { p ->
        val n = normalizeText(p)
        n.isNotEmpty() && hay.contains(" $n ")
    }
}

