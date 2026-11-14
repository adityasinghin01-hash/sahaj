package app.sahaj.shield.rules

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import org.junit.Test
import java.io.File
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class ParityTest {
    private fun resolveRepoFile(relativeFromShieldKotlin: String, relativeFromRoot: String): File {
        val f1 = File(relativeFromShieldKotlin)
        if (f1.exists()) return f1
        val f2 = File(relativeFromRoot)
        if (f2.exists()) return f2
        error("Could not find $relativeFromShieldKotlin or $relativeFromRoot (cwd=${File(".").absolutePath})")
    }

    private val engine: JsonRulesEngine by lazy {
        val rulesText = resolveRepoFile("../shield/rules/rules.json", "packages/shield/rules/rules.json")
            .readText(Charsets.UTF_8)
        JsonRulesEngine(rulesText)
    }

    private val parityCasesJson: String by lazy {
        resolveRepoFile("../../harness/shield/parity/cases.json", "harness/shield/parity/cases.json")
            .readText(Charsets.UTF_8)
    }

    private val sequencesJson: String by lazy {
        resolveRepoFile("../../harness/shield/sequences.json", "harness/shield/sequences.json")
            .readText(Charsets.UTF_8)
    }

    private fun JsonObject.strOrNull(key: String): String? =
        (this[key] as? JsonPrimitive)?.let { if (it.isString) it.content else null }

    private fun JsonObject.boolOrDefault(key: String, default: Boolean = false): Boolean =
        (this[key] as? JsonPrimitive)?.booleanOrNull ?: default

    private fun JsonObject.longOrNull(key: String): Long? =
        (this[key] as? JsonPrimitive)?.let { if (it.isString) null else it.longOrNull }

    private fun JsonObject.doubleOrNull(key: String): Double? =
        (this[key] as? JsonPrimitive)?.let { if (it.isString) null else it.doubleOrNull }

    private fun JsonObject.ctx(): JsonObject? = this["context"] as? JsonObject

    private fun toSignalEvent(o: JsonObject): SignalEvent {
        val kind = o.getValue("kind").jsonPrimitive.content
        val at = o.longOrNull("at")
            ?: error("Missing integer 'at' in sequence event: $o")
        val ctx = o.ctx()
        return when (kind) {
            "call", "call_in", "call_out", "call_state" -> SignalEvent.Call(
                atMs = at,
                endedAtMs = o.longOrNull("ended_at") ?: ctx?.longOrNull("ended_at"),
                number = o.strOrNull("number"),
                callerType = o.strOrNull("caller_type"),
                savedContact = o.boolOrDefault("saved_contact") || (ctx?.boolOrDefault("saved_contact") ?: false),
                direction = o.strOrNull("direction") ?: when (kind) {
                    "call_in" -> "in"
                    "call_out" -> "out"
                    else -> null
                },
                video = o.boolOrDefault("video") || (ctx?.boolOrDefault("video") ?: false),
                source = o.strOrNull("source") ?: ctx?.strOrNull("source"),
                whatsappCallUnsaved = o.boolOrDefault("whatsapp_call_unsaved") || (ctx?.boolOrDefault("whatsapp_call_unsaved") ?: false),
                durationMs = o.longOrNull("duration_ms") ?: ctx?.longOrNull("duration_ms"),
                longVsNormal = o.boolOrDefault("long_vs_normal") || (ctx?.boolOrDefault("long_vs_normal") ?: false),
                claimedBank = o.boolOrDefault("claimed_bank") || (ctx?.boolOrDefault("claimed_bank") ?: false),
                cancelled = o.boolOrDefault("cancelled") || (ctx?.boolOrDefault("cancelled") ?: false),
            )
            "voice_report" -> SignalEvent.VoiceReport(
                atMs = at,
                number = o.strOrNull("number"),
                callerType = o.strOrNull("caller_type"),
                savedContact = o.boolOrDefault("saved_contact") || (ctx?.boolOrDefault("saved_contact") ?: false),
                claimedBank = o.boolOrDefault("claimed_bank") || (ctx?.boolOrDefault("claimed_bank") ?: false),
                text = o.strOrNull("text"),
            )
            "sms" -> SignalEvent.Sms(
                atMs = at,
                sender = o.strOrNull("sender"),
                senderType = o.strOrNull("sender_type"),
                senderSaved = o.boolOrDefault("sender_saved"),
                text = o.strOrNull("text") ?: "",
            )
            "app_open" -> SignalEvent.AppOpen(
                atMs = at,
                packageName = o.strOrNull("package") ?: ctx?.strOrNull("package"),
                onCallWithUnsaved = o.boolOrDefault("on_call_with_unsaved") || (ctx?.boolOrDefault("on_call_with_unsaved") ?: false),
                savedContact = o.boolOrDefault("saved_contact") || (ctx?.boolOrDefault("saved_contact") ?: false),
                callerType = o.strOrNull("caller_type"),
            )
            "notification" -> SignalEvent.Notification(
                atMs = at,
                source = o.strOrNull("source") ?: ctx?.strOrNull("source"),
                whatsappCallUnsaved = o.boolOrDefault("whatsapp_call_unsaved") || (ctx?.boolOrDefault("whatsapp_call_unsaved") ?: false),
                callSeconds = o.longOrNull("call_seconds") ?: ctx?.longOrNull("call_seconds"),
                attachmentApk = o.boolOrDefault("attachment_apk") || (ctx?.boolOrDefault("attachment_apk") ?: false),
                cancelled = o.boolOrDefault("cancelled") || (ctx?.boolOrDefault("cancelled") ?: false),
                endedAtMs = o.longOrNull("ended_at") ?: ctx?.longOrNull("ended_at"),
                savedContact = o.boolOrDefault("saved_contact") || (ctx?.boolOrDefault("saved_contact") ?: false),
                callerType = o.strOrNull("caller_type"),
                text = o.strOrNull("text"),
            )
            "install" -> SignalEvent.Install(
                atMs = at,
                packageName = o.strOrNull("package") ?: ctx?.strOrNull("package"),
                installer = o.strOrNull("installer") ?: ctx?.strOrNull("installer"),
                installedHoursAgo = o.doubleOrNull("installed_hours_ago") ?: ctx?.doubleOrNull("installed_hours_ago"),
                isSystem = o.boolOrDefault("is_system") || (ctx?.boolOrDefault("is_system") ?: false),
            )
            else -> error("Unsupported sequence event kind: $kind")
        }
    }

    @Test
    fun all60HarnessMessagesMatchTypeScriptParitySnapshot() {
        val cases = Json.parseToJsonElement(parityCasesJson).jsonArray
        assertEquals(60, cases.size, "Expected 60 parity cases")
        val fourPlusDigits = Regex("[0-9]{4,}")

        for (el in cases) {
            val c = el.jsonObject
            val id = c.getValue("id").jsonPrimitive.content
            val sender = c.getValue("sender").jsonPrimitive.content
            val body = c.getValue("body").jsonPrimitive.content
            val expectedLevel = parseLevel(c.getValue("level").jsonPrimitive.content)
            val expectedScamType = c.getValue("scam_type").jsonPrimitive.content
            val expectedSenderType = c.strOrNull("sender_type")
            val expectedMasked = c.getValue("masked_text").jsonPrimitive.content
            val expectedRuleIds = c.getValue("matched_rule_ids").jsonArray.map { it.jsonPrimitive.content }

            val verdict = engine.check(
                SmsInput(sender = sender, body = body, receivedAtMs = 1_763_114_400_000L),
                PhoneContext(onCallWithUnsaved = false, callStartedAtMs = null),
            )

            assertEquals(expectedLevel, verdict.level, "$id level mismatch")
            assertEquals(expectedScamType, verdict.scamType, "$id scamType mismatch")
            if (expectedSenderType != null) {
                assertEquals(expectedSenderType, verdict.senderType, "$id senderType mismatch")
            }
            assertEquals(expectedMasked, verdict.maskedText, "$id maskedText mismatch")
            assertEquals(expectedRuleIds, verdict.matchedRules, "$id matchedRules mismatch")

            val cleaned = verdict.maskedText.replace("<1600_NUMBER>", "")
            assertFalse(fourPlusDigits.containsMatchIn(cleaned), "$id leaked 4+ digits in ${verdict.maskedText}")
        }
    }

    @Test
    fun allSequencesMatchTypeScriptExpectations() {
        val sequences = Json.parseToJsonElement(sequencesJson).jsonArray
        assertTrue(sequences.size >= 29, "Expected at least 29 harness sequences (seq_01..seq_29+)")

        for (el in sequences) {
            val s = el.jsonObject
            val id = s.getValue("id").jsonPrimitive.content
            val events = s.getValue("events").jsonArray.map { toSignalEvent(it.jsonObject) }
            val expectObj = s.getValue("expect").jsonObject
            val expectLevel = parseLevel(expectObj.getValue("level").jsonPrimitive.content)
            val expectPattern = (expectObj["pattern"] as? JsonPrimitive)?.let { if (it.isString) it.content else null }
            val notPatterns = expectObj["not_patterns"]?.jsonArray?.map { it.jsonPrimitive.content } ?: emptyList()
            val expectReasonNote = expectObj.strOrNull("reason_includes")

            val lastRaw = s.getValue("events").jsonArray.last().jsonObject
            val spoofedLocalLevel = lastRaw.strOrNull("local_level")?.let { parseLevel(it) }
            val spoofedRules = lastRaw["matched_rules"]?.jsonArray?.map { it.jsonPrimitive.content } ?: emptyList()

            val verdict = engine.evaluateSequence(
                events = events,
                evalAtMs = events.lastOrNull()?.atMs,
                localLevel = spoofedLocalLevel,
                clientMatchedRules = spoofedRules,
            )

            assertEquals(expectLevel, verdict.level, "$id level mismatch")
            if (expectPattern == null) {
                assertTrue(verdict.patterns.isEmpty(), "$id expected no patterns, got ${verdict.patterns}")
            } else {
                assertTrue(
                    verdict.patterns.contains(expectPattern),
                    "$id expected pattern $expectPattern, got ${verdict.patterns}",
                )
            }
            for (np in notPatterns) {
                assertFalse(verdict.patterns.contains(np), "$id should not fire $np, got ${verdict.patterns}")
            }
            if (expectReasonNote != null) {
                assertTrue(verdict.reasons.isNotEmpty(), "$id expected informational reason, got empty reasons")
            }
        }
    }

    @Test
    fun phase2AndPhase3ThresholdsPackagesAndSpoofingDefenseMatchRulesJson() {
        assertEquals(600_000L, engine.p2MinDurationMs())
        assertEquals(1_200_000L, engine.p6MinDurationMs())
        assertEquals(3, engine.p6MultiplierVsNormal())
        assertEquals(2_000L, engine.p9PollMs())
        assertTrue(engine.p9Packages().contains("com.phonepe.app"))
        assertTrue(engine.p4Packages().contains("com.anydesk.anydeskandroid"))

        val spoofed = engine.evaluateSequence(
            events = listOf(
                SignalEvent.AppOpen(atMs = 1_763_114_490_000L, packageName = "com.whatsapp", onCallWithUnsaved = true),
            ),
            localLevel = Level.RED,
            clientMatchedRules = listOf("pattern.P9"),
        )
        assertEquals(Level.GREEN, spoofed.level)
        assertTrue(spoofed.patterns.isEmpty())
    }
}
