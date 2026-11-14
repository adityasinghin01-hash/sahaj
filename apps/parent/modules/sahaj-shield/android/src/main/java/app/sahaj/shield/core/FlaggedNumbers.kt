package app.sahaj.shield.core

import java.io.File
import java.security.MessageDigest

/**
 * P8: numbers seen in flagged (YELLOW/RED) SMS, kept for 24 h ON THE PHONE ONLY.
 * Only SHA-256(last 10 digits) is kept, never the number. Nothing here is ever sent.
 * [file] = null keeps everything in memory (tests).
 */
class FlaggedNumberStore(
  private val file: File? = null,
  private val ttlMs: Long = TTL_MS,
  private val maxItems: Int = 300,
) {
  private val lock = Any()
  /** hash → expiresAtMs */
  private val hashes = LinkedHashMap<String, Long>()
  /** hash → expiresAtMs. "Phir bhi call karo" lets the next placement of that number through once. Memory only. */
  private val allowOnce = HashMap<String, Long>()

  init { load() }

  /** Remembers every phone number in the SMS body and the sender (if it is a phone number). Returns how many. */
  fun recordFromSms(sender: String, body: String, nowMs: Long): Int = synchronized(lock) {
    val found = (PhoneNumbers.extract(body) + listOfNotNull(PhoneNumbers.last10(sender))).distinct()
    found.forEach { hashes[PhoneNumbers.hash10(it)] = nowMs + ttlMs }
    prune(nowMs)
    while (hashes.size > maxItems) hashes.remove(hashes.keys.first())
    if (found.isNotEmpty()) save()
    found.size
  }

  fun containsNumber(number: String, nowMs: Long): Boolean {
    val h = PhoneNumbers.hashOf(number) ?: return false
    return synchronized(lock) { (hashes[h] ?: 0L) > nowMs }
  }

  fun allowOnce(number: String, nowMs: Long) {
    val h = PhoneNumbers.hashOf(number) ?: return
    synchronized(lock) { allowOnce[h] = nowMs + ALLOW_ONCE_MS }
  }

  /** True (and forgets it) if the user chose "call anyway" for this number in the last [ALLOW_ONCE_MS]. */
  fun consumeAllowOnce(number: String, nowMs: Long): Boolean {
    val h = PhoneNumbers.hashOf(number) ?: return false
    return synchronized(lock) { (allowOnce.remove(h) ?: 0L) > nowMs }
  }

  fun size(nowMs: Long): Int = synchronized(lock) { prune(nowMs); hashes.size }

  fun clear() = synchronized(lock) {
    hashes.clear()
    allowOnce.clear()
    save()
  }

  /** For tests: the file must only ever contain hashes. */
  internal fun storedLines(): List<String> = file?.takeIf { it.exists() }?.readLines() ?: emptyList()

  private fun prune(nowMs: Long) {
    hashes.entries.removeAll { it.value <= nowMs }
    allowOnce.entries.removeAll { it.value <= nowMs }
  }

  private fun load() {
    val f = file ?: return
    if (!f.exists()) return
    runCatching {
      f.readLines().forEach { line ->
        val parts = line.split('\t')
        if (parts.size == 2 && HEX64.matches(parts[0])) parts[1].toLongOrNull()?.let { hashes[parts[0]] = it }
      }
    }
  }

  private fun save() {
    val f = file ?: return
    f.parentFile?.mkdirs()
    val tmp = File(f.parentFile, f.name + ".tmp")
    tmp.writeText(hashes.entries.joinToString("") { "${it.key}\t${it.value}\n" })
    if (!tmp.renameTo(f)) { f.delete(); tmp.renameTo(f) }
  }

  companion object {
    const val TTL_MS = 24L * 60 * 60 * 1000
    const val ALLOW_ONCE_MS = 2L * 60 * 1000
    private val HEX64 = Regex("^[0-9a-f]{64}$")
  }
}

/** Phone-number helpers for P8. Results stay in memory; only [hash10] output may be stored. */
object PhoneNumbers {
  /** A run of digits with phone-style separators: "+91 98765-43210", "(022) 2345 6789". */
  private val candidate = Regex("""\+?\p{Nd}(?:[\s\-.()]{0,2}\p{Nd})*""")

  /** Digits only (any script → ASCII). */
  fun digits(s: String): String {
    val sb = StringBuilder()
    for (c in s) { val d = Character.digit(c, 10); if (d >= 0) sb.append(('0' + d)) }
    return sb.toString()
  }

  /** Last 10 digits if [s] has 10–13 digits (a phone number with or without +91/0), else null. */
  fun last10(s: String): String? {
    val d = digits(s)
    return if (d.length in 10..13) d.takeLast(10) else null
  }

  /** Every phone-number-looking run in [text], as last-10-digit strings. */
  fun extract(text: String): List<String> =
    candidate.findAll(text).mapNotNull { last10(it.value) }.distinct().toList()

  fun hash10(last10: String): String {
    val md = MessageDigest.getInstance("SHA-256").digest(last10.toByteArray(Charsets.US_ASCII))
    return md.joinToString("") { "%02x".format(it) }
  }

  /** Hash of a dialled number, or null if it is not a 10–13 digit phone number (short codes, *codes#). */
  fun hashOf(number: String): String? = last10(number)?.let { hash10(it) }
}
