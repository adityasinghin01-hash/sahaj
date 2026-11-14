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
  /** ScamType from rules.json ("kyc_block", "otp_theft", …). Only shown on the debug screen. */
  val scamType: String = "unknown",
) {
  companion object {
    /** Rule ids that mean "OTP during an unsaved call". rules.json v1 uses "pattern.P1". */
    val P1_RULE_IDS = setOf("P1", "pattern.P1")
  }
}

/** Implemented by the rules-engine card. Must be pure and fast (runs inside a BroadcastReceiver). */
interface RulesEngine {
  fun check(input: SmsInput, ctx: PhoneContext): LocalVerdict
}

/** Builds a RulesEngine from the bundled asset shield/rules.json. */
fun interface RulesEngineFactory {
  fun create(rulesJson: String): RulesEngine
}

/**
 * Fallback when rules.json cannot be parsed (e.g. the placeholder): everything is GREEN,
 * so nothing leaves the phone. See [RulesEngineRegistry.load].
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

/**
 * The real engine from packages/shield-kotlin (compiled into this module from its source dir).
 * Maps the module's types to the engine's types and back. The pipeline still re-masks every text field.
 */
class JsonRulesEngineAdapter(rulesJson: String) : RulesEngine {
  private val engine = app.sahaj.shield.rules.JsonRulesEngine(rulesJson)

  override fun check(input: SmsInput, ctx: PhoneContext): LocalVerdict {
    val v = engine.check(
      app.sahaj.shield.rules.SmsInput(input.sender, input.body, input.receivedAtMs),
      app.sahaj.shield.rules.PhoneContext(ctx.onCallWithUnsaved, ctx.callStartedAtMs),
    )
    return LocalVerdict(
      level = when (v.level) {
        app.sahaj.shield.rules.Level.RED -> LocalLevel.RED
        app.sahaj.shield.rules.Level.YELLOW -> LocalLevel.YELLOW
        app.sahaj.shield.rules.Level.GREEN -> LocalLevel.GREEN
      },
      reasons = v.reasons,
      matchedRules = v.matchedRules,
      maskedText = v.maskedText,
      senderType = v.senderType,
      linkDomains = v.linkDomains,
      scamType = v.scamType,
    )
  }
}

object RulesEngineRegistry {
  @Volatile
  var factory: RulesEngineFactory = RulesEngineFactory { json -> JsonRulesEngineAdapter(json) }

  /** Name of the engine that is actually running, for getStatus(): "json" or "none". */
  data class Loaded(val engine: RulesEngine, val name: String, val error: String?)

  /**
   * Builds the engine from rules.json. A missing or placeholder rules file ({"version":"0"}) cannot be
   * parsed by the real engine; then everything stays GREEN (nothing leaves the phone) and [Loaded.error] says why.
   */
  fun load(rulesJson: String): Loaded = try {
    val e = factory.create(rulesJson)
    Loaded(e, if (e is NoRulesEngine) "none" else "json", null)
  } catch (e: Exception) {
    Loaded(NoRulesEngine(), "none", "${e.javaClass.simpleName}: ${e.message?.take(120)}")
  }
}
