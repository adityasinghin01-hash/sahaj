package app.sahaj.shield.rules

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
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
        this[key]?.jsonPrimitive?.let { if (it.isString) it.content else null }

    private fun JsonObject.boolOrDefault(key: String, default: Boolean = false): Boolean =
        this[key]?.jsonPrimitive?.booleanOrNull ?: default

    private fun toSignalEvent(o: JsonObject): SignalEvent {
        val kind = o.getValue("kind").jsonPrimitive.content
        val at = o.getValue("at").jsonPrimitive.longOrNull
            ?: error("Missing integer 'at' in sequence event: $o")
        return when (kind) {
            "call" -> SignalEvent.Call(
                atMs = at,
                endedAtMs = o["ended_at"]?.jsonPrimitive?.longOrNull,
                number = o.strOrNull("number"),
                callerType = o.strOrNull("caller_type"),
                savedContact = o.boolOrDefault("saved_contact"),
                direction = o.strOrNull("direction"),
                video = o.boolOrDefault("video"),
                source = o.strOrNull("source"),
                whatsappCallUnsaved = o.boolOrDefault("whatsapp_call_unsaved"),
                durationMs = o["duration_ms"]?.jsonPrimitive?.longOrNull,
                cancelled = o.boolOrDefault("cancelled"),
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
                packageName = o.strOrNull("package"),
                onCallWithUnsaved = o.boolOrDefault("on_call_with_unsaved"),
                savedContact = o.boolOrDefault("saved_contact"),
                callerType = o.strOrNull("caller_type"),
            )
            "notification" -> SignalEvent.Notification(
                atMs = at,
                source = o.strOrNull("source"),
                whatsappCallUnsaved = o.boolOrDefault("whatsapp_call_unsaved"),
                callSeconds = o["call_seconds"]?.jsonPrimitive?.longOrNull,
                attachmentApk = o.boolOrDefault("attachment_apk"),
                cancelled = o.boolOrDefault("cancelled"),
                endedAtMs = o["ended_at"]?.jsonPrimitive?.longOrNull,
                savedContact = o.boolOrDefault("saved_contact"),
                callerType = o.strOrNull("caller_type"),
                text = o.strOrNull("text"),
            )
            "install" -> SignalEvent.Install(
                atMs = at,
                packageName = o.strOrNull("package"),
                installer = o.strOrNull("installer"),
                installedHoursAgo = o["installed_hours_ago"]?.jsonPrimitive?.doubleOrNull,
                isSystem = o.boolOrDefault("is_system"),
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
        assertTrue(sequences.size >= 21, "Expected at least 21 harness sequences")

        for (el in sequences) {
            val s = el.jsonObject
            val id = s.getValue("id").jsonPrimitive.content
            val events = s.getValue("events").jsonArray.map { toSignalEvent(it.jsonObject) }
            val expectObj = s.getValue("expect").jsonObject
            val expectLevel = parseLevel(expectObj.getValue("level").jsonPrimitive.content)
            val expectPattern = expectObj["pattern"]?.jsonPrimitive?.let { if (it.isString) it.content else null }

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
        }
    }

    @Test
    fun phase2ThresholdsPackagesAndSpoofingDefenseMatchRulesJson() {
        assertEquals(600_000L, engine.p2MinDurationMs())
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
