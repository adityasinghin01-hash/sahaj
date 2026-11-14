package app.sahaj.shield.rules

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import java.util.Locale
import java.util.regex.Pattern

internal data class ReasonText(val hi: String, val en: String)

internal data class TypedRegexRule(
    val id: String,
    val type: String,
    val pattern: Pattern,
    val score: Int,
    val reason: ReasonText,
)

internal data class ScoredRule(val id: String, val score: Int, val reason: ReasonText)

internal data class MaskStep(val id: String, val token: String, val pattern: Pattern)

internal data class BrandConfig(val brand: String, val tokens: List<String>, val official: List<String>)

internal data class ScriptPhrase(val text: String, val lang: String, val w: Int)

internal data class ScriptTypeConfig(val reason: ReasonText, val phrases: List<ScriptPhrase>)

internal data class GenericSignalConfig(
    val id: String,
    val score: Int,
    val phrases: List<String>,
    val scamType: String?,
    val reason: ReasonText,
)

internal data class OtpConfig(
    val id: String,
    val keywordPattern: Pattern,
    val numberPattern: Pattern,
    val numberGroup: Int,
    val currencyBeforePattern: Pattern,
    val windowChars: Int,
    val reason: ReasonText,
)

internal data class MaskConfig(
    val urlTokenPrefix: String,
    val urlTokenSuffix: String,
    val apkMarker: String,
    val otpToken: String,
    val steps: List<MaskStep>,
)

internal data class LinksConfig(
    val urlPattern: Pattern,
    val urlGroup: Int,
    val trailingPunctPattern: Pattern,
    val multiPartSuffixes: Set<String>,
    val present: ScoredRule,
    val shortener: ScoredRule,
    val shortenerDomains: Set<String>,
    val apkId: String,
    val apkScore: Int,
    val apkForceLevel: Level,
    val apkPattern: Pattern,
    val apkReason: ReasonText,
    val lookAlike: ScoredRule,
    val punycode: ScoredRule,
    val trustedSuffixes: List<String>,
    val brands: List<BrandConfig>,
)

internal data class P1Config(
    val id: String,
    val level: Level,
    val scamType: String,
    val callerTypes: Set<String>,
    val windowAfterCallMs: Long,
    val reason: ReasonText,
)

internal data class P5Config(
    val id: String,
    val riskySenderTypes: Set<String>,
    val redReason: ReasonText,
    val yellowReason: ReasonText,
)

internal data class P2Config(
    val id: String,
    val level: Level,
    val scamType: String,
    val callerTypes: Set<String>,
    val minDurationMs: Long,
    val minDurationSeconds: Long,
    val requireVideoOrWhatsApp: Boolean,
    val reason: ReasonText,
)

internal data class P3Config(
    val id: String,
    val level: Level,
    val scamType: String,
    val playStoreInstallers: Set<String>,
    val recentInstallHours: Int,
    val reason: ReasonText,
)

internal data class P4Config(
    val id: String,
    val level: Level,
    val scamType: String,
    val packages: Set<String>,
    val reason: ReasonText,
)

internal data class P6Config(
    val id: String,
    val level: Level,
    val scamType: String,
    val callerTypes: Set<String>,
    val minDurationMs: Long,
    val multiplierVsNormal: Int,
    val reason: ReasonText,
)

internal data class P7Config(
    val id: String,
    val level: Level,
    val scamType: String,
    val trustedCallerTypes: Set<String>,
    val reason: ReasonText,
)

internal data class P8Config(
    val id: String,
    val level: Level,
    val localOnly: Boolean,
    val keepHours: Int,
    val maxNumbers: Int,
    val reason: ReasonText,
)

internal data class P9Config(
    val id: String,
    val level: Level,
    val scamType: String,
    val callerTypes: Set<String>,
    val pollMs: Long,
    val packages: Set<String>,
    val reason: ReasonText,
)

internal data class ThresholdsConfig(
    val redAt: Int,
    val yellowAt: Int,
    val askAiLow: Int,
    val askAiHigh: Int,
    val maxScore: Int,
)

internal class ParsedRules(rulesJson: String) {
    val numberStripPattern: Pattern
    val senderRules: List<TypedRegexRule>
    val mobileClaimsBrand: ScoredRule
    val savedContact: ScoredRule
    val callerRules: List<TypedRegexRule>
    val otp: OtpConfig
    val mask: MaskConfig
    val links: LinksConfig
    val topicWords: List<String>
    val genericSignals: List<GenericSignalConfig>
    val minTypeScore: Int
    val scriptTypes: Map<String, ScriptTypeConfig>
    val p1: P1Config
    val p5: P5Config
    val p2: P2Config
    val p3: P3Config
    val p4: P4Config
    val p6: P6Config
    val p7: P7Config
    val p8: P8Config
    val p9: P9Config
    val thresholds: ThresholdsConfig
    val reasonsById: Map<String, ReasonText>

    init {
        val root = Json.parseToJsonElement(rulesJson).jsonObject

        val norm = root.reqObj("normalize")
        numberStripPattern = compilePattern(norm.reqStr("number_strip_pattern"), "")

        val senderObj = root.reqObj("sender")
        senderRules = senderObj.reqArr("rules").map { el ->
            val o = el.jsonObject
            TypedRegexRule(
                id = o.reqStr("id"),
                type = o.reqStr("type"),
                pattern = compilePattern(o.reqStr("pattern"), o.reqStr("flags")),
                score = o.reqInt("score"),
                reason = o.reqReason("reason"),
            )
        }
        mobileClaimsBrand = senderObj.reqScoredRule("mobile_claims_brand")
        savedContact = senderObj.reqScoredRule("saved_contact")

        val callerObj = root.reqObj("caller")
        callerRules = callerObj.reqArr("rules").map { el ->
            val o = el.jsonObject
            TypedRegexRule(
                id = o.reqStr("id"),
                type = o.reqStr("type"),
                pattern = compilePattern(o.reqStr("pattern"), o.reqStr("flags")),
                score = o.reqInt("score"),
                reason = o.reqReason("reason"),
            )
        }

        val otpObj = root.reqObj("otp")
        otp = OtpConfig(
            id = otpObj.reqStr("id"),
            keywordPattern = compilePattern(otpObj.reqStr("keyword_pattern"), otpObj.reqStr("keyword_flags")),
            numberPattern = compilePattern(otpObj.reqStr("number_pattern"), otpObj.reqStr("number_flags")),
            numberGroup = otpObj.reqInt("number_group"),
            currencyBeforePattern = compilePattern(
                otpObj.reqStr("currency_before_pattern"),
                otpObj.reqStr("currency_before_flags"),
            ),
            windowChars = otpObj.reqInt("window_chars"),
            reason = otpObj.reqReason("reason"),
        )

        val maskObj = root.reqObj("mask")
        mask = MaskConfig(
            urlTokenPrefix = maskObj.reqStr("url_token_prefix"),
            urlTokenSuffix = maskObj.reqStr("url_token_suffix"),
            apkMarker = maskObj.reqStr("apk_marker"),
            otpToken = maskObj.reqStr("otp_token"),
            steps = maskObj.reqArr("steps").map { el ->
                val o = el.jsonObject
                MaskStep(
                    id = o.reqStr("id"),
                    token = o.reqStr("token"),
                    pattern = compilePattern(o.reqStr("pattern"), o.reqStr("flags")),
                )
            },
        )

        val linksObj = root.reqObj("links")
        val shortObj = linksObj.reqObj("shortener")
        val apkObj = linksObj.reqObj("apk")
        links = LinksConfig(
            urlPattern = compilePattern(linksObj.reqStr("url_pattern"), linksObj.reqStr("url_flags")),
            urlGroup = linksObj.reqInt("url_group"),
            trailingPunctPattern = compilePattern(linksObj.reqStr("trailing_punct_pattern"), ""),
            multiPartSuffixes = linksObj.reqStrList("multi_part_suffixes")
                .map { it.lowercase(Locale.ROOT) }
                .toSet(),
            present = linksObj.reqScoredRule("present"),
            shortener = ScoredRule(shortObj.reqStr("id"), shortObj.reqInt("score"), shortObj.reqReason("reason")),
            shortenerDomains = shortObj.reqStrList("domains").map { it.lowercase(Locale.ROOT) }.toSet(),
            apkId = apkObj.reqStr("id"),
            apkScore = apkObj.reqInt("score"),
            apkForceLevel = parseLevel(apkObj.reqStr("force_level")),
            apkPattern = compilePattern(apkObj.reqStr("pattern"), apkObj.reqStr("flags")),
            apkReason = apkObj.reqReason("reason"),
            lookAlike = linksObj.reqScoredRule("look_alike"),
            punycode = linksObj.reqScoredRule("punycode"),
            trustedSuffixes = linksObj.reqStrList("trusted_suffixes"),
            brands = linksObj.reqArr("brands").map { el ->
                val o = el.jsonObject
                BrandConfig(
                    brand = o.reqStr("brand"),
                    tokens = o.reqStrList("tokens"),
                    official = o.reqStrList("official"),
                )
            },
        )

        val topicsObj = root.reqObj("topic_words")
        topicWords = topicsObj.reqStrList("bank") + topicsObj.reqStrList("electricity") + topicsObj.reqStrList("courier")

        genericSignals = root.reqArr("generic_signals").map { el ->
            val o = el.jsonObject
            GenericSignalConfig(
                id = o.reqStr("id"),
                score = o.reqInt("score"),
                phrases = o.reqStrList("phrases"),
                scamType = o["scam_type"]?.jsonPrimitive?.content,
                reason = o.reqReason("reason"),
            )
        }

        val scriptsObj = root.reqObj("scam_scripts")
        minTypeScore = scriptsObj.reqInt("min_type_score")
        val typesObj = scriptsObj.reqObj("types")
        val parsedTypes = linkedMapOf<String, ScriptTypeConfig>()
        for ((typeId, el) in typesObj) {
            val o = el.jsonObject
            parsedTypes[typeId] = ScriptTypeConfig(
                reason = o.reqReason("reason"),
                phrases = o.reqArr("phrases").map { p ->
                    val po = p.jsonObject
                    ScriptPhrase(po.reqStr("text"), po.reqStr("lang"), po.reqInt("w"))
                },
            )
        }
        scriptTypes = parsedTypes

        val patternsObj = root.reqObj("patterns")
        val p1Obj = patternsObj.reqObj("P1")
        p1 = P1Config(
            id = p1Obj.reqStr("id"),
            level = parseLevel(p1Obj.reqStr("level")),
            scamType = p1Obj.reqStr("scam_type"),
            callerTypes = p1Obj.reqStrList("caller_types").toSet(),
            windowAfterCallMs = p1Obj["window_after_call_ms"]!!.jsonPrimitive.content.toLong(),
            reason = p1Obj.reqReason("reason"),
        )
        val p5Obj = patternsObj.reqObj("P5")
        p5 = P5Config(
            id = p5Obj.reqStr("id"),
            riskySenderTypes = p5Obj.reqStrList("risky_sender_types").toSet(),
            redReason = p5Obj.reqObj("red").reqReason("reason"),
            yellowReason = p5Obj.reqObj("yellow").reqReason("reason"),
        )
        val p2Obj = patternsObj.reqObj("P2")
        p2 = P2Config(
            id = p2Obj.reqStr("id"),
            level = parseLevel(p2Obj.reqStr("level")),
            scamType = p2Obj.reqStr("scam_type"),
            callerTypes = p2Obj.reqStrList("caller_types").toSet(),
            minDurationMs = p2Obj.reqLong("min_duration_ms"),
            minDurationSeconds = p2Obj.reqLong("min_duration_seconds"),
            requireVideoOrWhatsApp = p2Obj.reqBool("require_video_or_whatsapp"),
            reason = p2Obj.reqReason("reason"),
        )
        val p3Obj = patternsObj.reqObj("P3")
        p3 = P3Config(
            id = p3Obj.reqStr("id"),
            level = parseLevel(p3Obj.reqStr("level")),
            scamType = p3Obj.reqStr("scam_type"),
            playStoreInstallers = p3Obj.reqStrList("play_store_installers").toSet(),
            recentInstallHours = p3Obj.reqInt("recent_install_hours"),
            reason = p3Obj.reqReason("reason"),
        )
        val p4Obj = patternsObj.reqObj("P4")
        p4 = P4Config(
            id = p4Obj.reqStr("id"),
            level = parseLevel(p4Obj.reqStr("level")),
            scamType = p4Obj.reqStr("scam_type"),
            packages = p4Obj.reqStrList("packages").toSet(),
            reason = p4Obj.reqReason("reason"),
        )
        val p6Obj = patternsObj.reqObj("P6")
        p6 = P6Config(
            id = p6Obj.reqStr("id"),
            level = parseLevel(p6Obj.reqStr("level")),
            scamType = p6Obj.reqStr("scam_type"),
            callerTypes = p6Obj.reqStrList("caller_types").toSet(),
            minDurationMs = p6Obj.reqLong("min_duration_ms"),
            multiplierVsNormal = p6Obj.reqInt("multiplier_vs_normal"),
            reason = p6Obj.reqReason("reason"),
        )
        val p7Obj = patternsObj.reqObj("P7")
        p7 = P7Config(
            id = p7Obj.reqStr("id"),
            level = parseLevel(p7Obj.reqStr("level")),
            scamType = p7Obj.reqStr("scam_type"),
            trustedCallerTypes = p7Obj.reqStrList("trusted_caller_types").toSet(),
            reason = p7Obj.reqReason("reason"),
        )
        val p8Obj = patternsObj.reqObj("P8")
        p8 = P8Config(
            id = p8Obj.reqStr("id"),
            level = parseLevel(p8Obj.reqStr("level")),
            localOnly = p8Obj.reqBool("local_only"),
            keepHours = p8Obj.reqInt("keep_hours"),
            maxNumbers = p8Obj.reqInt("max_numbers"),
            reason = p8Obj.reqReason("reason"),
        )
        val p9Obj = patternsObj.reqObj("P9")
        p9 = P9Config(
            id = p9Obj.reqStr("id"),
            level = parseLevel(p9Obj.reqStr("level")),
            scamType = p9Obj.reqStr("scam_type"),
            callerTypes = p9Obj.reqStrList("caller_types").toSet(),
            pollMs = p9Obj.reqLong("poll_ms"),
            packages = p9Obj.reqStrList("packages").toSet(),
            reason = p9Obj.reqReason("reason"),
        )

        val threshObj = root.reqObj("thresholds")
        val aiRange = threshObj.reqArr("ask_ai_between")
        thresholds = ThresholdsConfig(
            redAt = threshObj.reqInt("red_at"),
            yellowAt = threshObj.reqInt("yellow_at"),
            askAiLow = aiRange[0].jsonPrimitive.int,
            askAiHigh = aiRange[1].jsonPrimitive.int,
            maxScore = threshObj.reqInt("max_score"),
        )

        val reasons = linkedMapOf<String, ReasonText>()
        for (s in senderRules) reasons[s.id] = s.reason
        reasons[mobileClaimsBrand.id] = mobileClaimsBrand.reason
        reasons[savedContact.id] = savedContact.reason
        for (c in callerRules) reasons[c.id] = c.reason
        reasons[otp.id] = otp.reason
        reasons[links.present.id] = links.present.reason
        reasons[links.shortener.id] = links.shortener.reason
        reasons[links.apkId] = links.apkReason
        reasons[links.lookAlike.id] = links.lookAlike.reason
        reasons[links.punycode.id] = links.punycode.reason
        for (g in genericSignals) reasons[g.id] = g.reason
        for ((typeId, cfg) in scriptTypes) reasons["script.$typeId"] = cfg.reason
        reasons[p1.id] = p1.reason
        reasons["${p5.id}.red"] = p5.redReason
        reasons["${p5.id}.yellow"] = p5.yellowReason
        reasons[p2.id] = p2.reason
        reasons[p3.id] = p3.reason
        reasons[p4.id] = p4.reason
        reasons[p6.id] = p6.reason
        reasons[p7.id] = p7.reason
        reasons[p8.id] = p8.reason
        reasons[p9.id] = p9.reason
        reasonsById = reasons
    }
}

internal fun compilePattern(pattern: String, flags: String): Pattern {
    require(flags.isEmpty() || flags == "i") { "Unsupported regex flag '$flags' (only '' or 'i' allowed)" }
    val flagBits = if (flags == "i") Pattern.CASE_INSENSITIVE else 0
    return Pattern.compile(pattern, flagBits)
}

internal fun parseLevel(raw: String): Level = when (raw.lowercase(Locale.ROOT)) {
    "red" -> Level.RED
    "yellow" -> Level.YELLOW
    "green" -> Level.GREEN
    else -> error("Unknown alert level: $raw")
}

private fun JsonObject.reqObj(key: String) = getValue(key).jsonObject
private fun JsonObject.reqArr(key: String) = getValue(key).jsonArray
private fun JsonObject.reqStr(key: String) = getValue(key).jsonPrimitive.content
private fun JsonObject.reqInt(key: String) = getValue(key).jsonPrimitive.int
private fun JsonObject.reqLong(key: String) = getValue(key).jsonPrimitive.long
private fun JsonObject.reqBool(key: String) = getValue(key).jsonPrimitive.boolean
private fun JsonObject.reqStrList(key: String) = reqArr(key).map { it.jsonPrimitive.content }
private fun JsonObject.reqReason(key: String): ReasonText {
    val o = reqObj(key)
    return ReasonText(o.reqStr("hi"), o.reqStr("en"))
}

private fun JsonObject.reqScoredRule(key: String): ScoredRule {
    val o = reqObj(key)
    return ScoredRule(o.reqStr("id"), o.reqInt("score"), o.reqReason("reason"))
}

