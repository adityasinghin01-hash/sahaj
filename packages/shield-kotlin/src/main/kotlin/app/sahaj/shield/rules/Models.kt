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

sealed interface SignalEvent {
    val atMs: Long

    data class Sms(
        override val atMs: Long,
        val sender: String? = null,
        val senderType: String? = null,
        val senderSaved: Boolean = false,
        val text: String,
    ) : SignalEvent

    data class Call(
        override val atMs: Long,
        val endedAtMs: Long? = null,
        val number: String? = null,
        val callerType: String? = null,
        val savedContact: Boolean = false,
        val direction: String? = null,
        val video: Boolean = false,
        val source: String? = null,
        val whatsappCallUnsaved: Boolean = false,
        val durationMs: Long? = null,
        val cancelled: Boolean = false,
    ) : SignalEvent

    data class AppOpen(
        override val atMs: Long,
        val packageName: String? = null,
        val onCallWithUnsaved: Boolean = false,
        val savedContact: Boolean = false,
        val callerType: String? = null,
    ) : SignalEvent

    data class Notification(
        override val atMs: Long,
        val source: String? = null,
        val whatsappCallUnsaved: Boolean = false,
        val callSeconds: Long? = null,
        val attachmentApk: Boolean = false,
        val cancelled: Boolean = false,
        val endedAtMs: Long? = null,
        val savedContact: Boolean = false,
        val callerType: String? = null,
        val text: String? = null,
    ) : SignalEvent

    data class Install(
        override val atMs: Long,
        val packageName: String? = null,
        val installer: String? = null,
        val installedHoursAgo: Double? = null,
        val isSystem: Boolean = false,
    ) : SignalEvent
}

data class SequenceVerdict(
    val level: Level,
    val scamType: String,
    val patterns: List<String>,
    val matchedRules: List<String>,
    val reasons: List<String>,
)

