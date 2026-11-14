package app.sahaj.shield.core

// Pure-Kotlin types shared by the Android glue and the JVM unit tests.
// Nothing in app.sahaj.shield.core may import android.*.

enum class LocalLevel { GREEN, YELLOW, RED;
  /** Matches AlertLevel in packages/shared/src/shield.ts. */
  val wire: String get() = name.lowercase()
}

/** One incoming SMS (multi-part messages already joined). Lives only on the phone. */
data class SmsInput(
  val sender: String,
  val body: String,
  val receivedAtMs: Long,
)

/** What the phone knows at the moment the SMS arrives. Numbers are never stored here. */
data class PhoneContext(
  val callActive: Boolean = false,
  /** True while a call with a number that is not a saved contact is in progress. */
  val onCallWithUnsaved: Boolean = false,
  val callStartedAtMs: Long? = null,
  /** Whether the SMS sender is a saved contact (null = unknown, e.g. no READ_CONTACTS). */
  val senderIsSavedContact: Boolean? = null,
)

/**
 * Output of the rules engine. The engine is written separately (see RulesEngine);
 * the module treats every field except [level] as untrusted and re-masks text before sending.
 */
data class LocalVerdict(
  val level: LocalLevel,
  val reasons: List<String>,
  val matchedRules: List<String>,
  val maskedText: String,
  val senderType: String,
  val linkDomains: List<String>,
)

/** Implemented by the rules-engine card. Must be pure and fast (runs inside a BroadcastReceiver). */
interface RulesEngine {
  fun check(input: SmsInput, ctx: PhoneContext): LocalVerdict
}

/** Builds a RulesEngine from the bundled asset shield/rules.json. */
fun interface RulesEngineFactory {
  fun create(rulesJson: String): RulesEngine
}

/**
 * Used until the real engine lands: everything is GREEN, so nothing leaves the phone.
 * The rules-engine card replaces [RulesEngineRegistry.factory].
 */
class NoRulesEngine : RulesEngine {
  override fun check(input: SmsInput, ctx: PhoneContext) = LocalVerdict(
    level = LocalLevel.GREEN,
    reasons = emptyList(),
    matchedRules = emptyList(),
    maskedText = Masker.mask(input.body),
    senderType = "unknown",
    linkDomains = emptyList(),
  )
}

object RulesEngineRegistry {
  @Volatile
  var factory: RulesEngineFactory = RulesEngineFactory { NoRulesEngine() }
}
