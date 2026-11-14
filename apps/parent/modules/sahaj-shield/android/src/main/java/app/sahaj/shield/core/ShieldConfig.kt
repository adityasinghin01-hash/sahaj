package app.sahaj.shield.core

import kotlinx.serialization.json.Json as KJson
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.longOrNull

/**
 * Phase 2/3 thresholds and package lists, read from the bundled rules.json (the same asset the
 * Kotlin rules engine reads, see ShieldRuntime.rulesJson). Every field falls back to the old
 * hard-coded constant on its own when it is missing or invalid; [Parsed.fallbacks] names those
 * fields (field names only, never file content) so the runtime can log them once.
 */
data class ShieldConfig(
  /** P2: WhatsApp call with an unsaved contact still running after this long → red. */
  val p2MinDurationMs: Long = DEFAULT_P2_MIN_DURATION_MS,
  /** P9: banking / UPI apps. */
  val p9Packages: Set<String> = AppLists.BANKING_UPI,
  /** P9: foreground poll period during an unsaved call. */
  val p9PollMs: Long = DEFAULT_P9_POLL_MS,
  /** P3: installers that count as the Play Store. */
  val p3PlayStoreInstallers: Set<String> = AppLists.PLAY_STORE_INSTALLERS,
  /** P3: a non-Play app installed within this window is flagged. */
  val p3RecentInstallMs: Long = DEFAULT_P3_RECENT_INSTALL_MS,
  /** P4: remote-control / screen-sharing apps. */
  val p4Packages: Set<String> = AppLists.REMOTE_CONTROL,
  /** P8: how long numbers from flagged SMS are kept (hashes only). */
  val p8KeepMs: Long = FlaggedNumberStore.TTL_MS,
  /** P8: at most this many number hashes are kept. */
  val p8MaxNumbers: Int = DEFAULT_P8_MAX_NUMBERS,
  /** caller.rules from rules.json: (caller type, pattern), first match wins. */
  val callerRules: List<Pair<String, Regex>> = DEFAULT_CALLER_RULES,
) {
  data class Parsed(val config: ShieldConfig, val fallbacks: List<String>) {
    /** True when every field came from rules.json. */
    val complete: Boolean get() = fallbacks.isEmpty()
  }

  /**
   * CallerType (packages/shared/src/shield.ts) of a number, in memory only. [saved] wins.
   * Separators are removed first ("+91 1600-123 456" → "+911600123456").
   */
  fun callerType(number: String?, saved: Boolean): String {
    if (saved) return "saved_contact"
    val n = number?.replace(SEPARATORS, "").orEmpty()
    if (n.isEmpty()) return "unknown"
    for ((type, re) in callerRules) if (re.matches(n)) return type
    return "unknown"
  }

  companion object {
    const val DEFAULT_P2_MIN_DURATION_MS = 10L * 60 * 1000
    const val DEFAULT_P9_POLL_MS = 2_000L
    const val DEFAULT_P3_RECENT_INSTALL_MS = 24L * 60 * 60 * 1000
    const val DEFAULT_P8_MAX_NUMBERS = 300

    val CALLER_TYPES = setOf("series_1600", "series_140", "mobile_10", "international", "saved_contact", "unknown")

    /** Same patterns as rules.json v1.0.0 caller.rules (Java + JS compatible). */
    val DEFAULT_CALLER_RULES: List<Pair<String, Regex>> = listOf(
      "series_1600" to Regex("^(\\+91|0091|91|0)?1600[0-9]{6}$"),
      "series_140" to Regex("^(\\+91|0091|91|0)?140[0-9]{7}$"),
      "mobile_10" to Regex("^(\\+91|0091|91|0)?[6-9][0-9]{9}$"),
      "international" to Regex("^(\\+|00)(?!91)[1-9][0-9]{6,14}$"),
    )

    private val SEPARATORS = Regex("[\\s\\-().]")
    private val parser = KJson { ignoreUnknownKeys = true; isLenient = false }

    val DEFAULT = ShieldConfig()

    /** Never throws. Unparseable JSON → every field falls back (fallbacks = ["rules.json"]). */
    fun fromRulesJson(rulesJson: String?): Parsed {
      val root = runCatching { parser.parseToJsonElement(rulesJson ?: "") as? JsonObject }.getOrNull()
        ?: return Parsed(DEFAULT, listOf("rules.json"))
      val fb = mutableListOf<String>()
      val patterns = root["patterns"] as? JsonObject

      fun obj(id: String) = patterns?.get(id) as? JsonObject

      fun positiveLong(id: String, key: String, def: Long, scale: Long = 1): Long {
        val v = (obj(id)?.get(key) as? JsonPrimitive)?.takeIf { !it.isString }?.longOrNull
        if (v == null || v <= 0) { fb += "$id.$key"; return def }
        return v * scale
      }

      fun packages(id: String, key: String, def: Set<String>): Set<String> {
        val arr = obj(id)?.get(key) as? JsonArray
        val list = arr?.mapNotNull { e -> (e as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull?.trim() }
          ?.filter { PACKAGE.matches(it) }
        if (arr == null || list.isNullOrEmpty() || list.size != arr.size) { fb += "$id.$key"; return def }
        return list.toSet()
      }

      val config = ShieldConfig(
        p2MinDurationMs = positiveLong("P2", "min_duration_ms", DEFAULT_P2_MIN_DURATION_MS),
        p9Packages = packages("P9", "packages", AppLists.BANKING_UPI),
        p9PollMs = positiveLong("P9", "poll_ms", DEFAULT_P9_POLL_MS),
        p3PlayStoreInstallers = packages("P3", "play_store_installers", AppLists.PLAY_STORE_INSTALLERS),
        p3RecentInstallMs = positiveLong("P3", "recent_install_hours", DEFAULT_P3_RECENT_INSTALL_MS, 3_600_000L),
        p4Packages = packages("P4", "packages", AppLists.REMOTE_CONTROL),
        p8KeepMs = positiveLong("P8", "keep_hours", FlaggedNumberStore.TTL_MS, 3_600_000L),
        p8MaxNumbers = positiveLong("P8", "max_numbers", DEFAULT_P8_MAX_NUMBERS.toLong())
          .coerceAtMost(10_000).toInt(),
        callerRules = callerRules(root, fb),
      )
      return Parsed(config, fb)
    }

    private fun callerRules(root: JsonObject, fb: MutableList<String>): List<Pair<String, Regex>> {
      val rules = ((root["caller"] as? JsonObject)?.get("rules") as? JsonArray)
      val out = rules?.mapNotNull { r ->
        val o = r as? JsonObject ?: return@mapNotNull null
        val type = o.str("type") ?: return@mapNotNull null
        val pattern = o.str("pattern") ?: return@mapNotNull null
        if (type !in CALLER_TYPES) return@mapNotNull null
        val flags = o.str("flags").orEmpty()
        val opts = if (flags.contains('i')) setOf(RegexOption.IGNORE_CASE) else emptySet()
        runCatching { type to Regex(pattern, opts) }.getOrNull()
      }
      if (rules == null || out.isNullOrEmpty() || out.size != rules.size) { fb += "caller.rules"; return DEFAULT_CALLER_RULES }
      return out
    }

    private fun JsonObject.str(k: String): String? = (this[k] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull

    private val PACKAGE = Regex("^[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z0-9_]+)+$")
  }
}
