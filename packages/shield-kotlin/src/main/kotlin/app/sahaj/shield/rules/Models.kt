package app.sahaj.shield.rules

data class SmsInput(val sender: String, val body: String, val receivedAtMs: Long)

data class PhoneContext(val onCallWithUnsaved: Boolean, val callStartedAtMs: Long?)

enum class Level(val wireName: String) {
    GREEN("green"),
    YELLOW("yellow"),
    RED("red"),
}

data class LocalVerdict(
    val level: Level,
    val scamType: String,
    val reasons: List<String>,
    val matchedRules: List<String>,
    val maskedText: String,
    val senderType: String,
    val linkDomains: List<String>,
    val needsAi: Boolean,
    val score: Int,
)

interface RulesEngine {
    fun check(input: SmsInput, ctx: PhoneContext): LocalVerdict
}

data class FoundLink(
    val url: String,
    val host: String,
    val registrableDomain: String,
    val start: Int,
    val end: Int,
)

data class LookAlikeResult(
    val lookAlike: Boolean,
    val brand: String?,
    val punycode: Boolean,
    val official: Boolean,
)

data class RuleHit(
    val ruleId: String,
    val weight: Int,
    val detail: String? = null,
    val scamType: String? = null,
)

data class TextScore(
    val score: Int,
    val scamType: String,
    val hits: List<RuleHit>,
    val typeScore: Int,
    val links: List<FoundLink>,
    val apk: Boolean,
    val topic: Boolean,
)

data class Span(val start: Int, val end: Int)

