package app.sahaj.shield.rules

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Test
import java.io.File
import java.util.regex.Pattern
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class RulesEngineTest {
    private fun resolveRepoFile(relativeFromShieldKotlin: String, relativeFromRoot: String): File {
        val f1 = File(relativeFromShieldKotlin)
        if (f1.exists()) return f1
        val f2 = File(relativeFromRoot)
        if (f2.exists()) return f2
        error("Could not find $relativeFromShieldKotlin or $relativeFromRoot (cwd=${File(".").absolutePath})")
    }

    private val rulesJsonText: String by lazy {
        resolveRepoFile("../shield/rules/rules.json", "packages/shield/rules/rules.json").readText(Charsets.UTF_8)
    }

    private val fixturesJsonText: String by lazy {
        resolveRepoFile("../shield/test/rules/fixtures.json", "packages/shield/test/rules/fixtures.json").readText(Charsets.UTF_8)
    }

    private val engine: JsonRulesEngine by lazy { JsonRulesEngine(rulesJsonText) }

    private data class Fixture(
        val id: String,
        val label: String,
        val expect: Level,
        val sender: String,
        val text: String,
    )

    private fun loadFixtures(): List<Fixture> {
        val arr = Json.parseToJsonElement(fixturesJsonText).jsonArray
        return arr.map { el ->
            val o = el.jsonObject
            Fixture(
                id = o.getValue("id").jsonPrimitive.content,
                label = o.getValue("label").jsonPrimitive.content,
                expect = parseLevel(o.getValue("expect").jsonPrimitive.content),
                sender = o.getValue("sender").jsonPrimitive.content,
                text = o.getValue("text").jsonPrimitive.content,
            )
        }
    }

    @Test
    fun fixturesMatchExpectedLevelsAndScamTypes() {
        val fixtures = loadFixtures()
        assertEquals(15, fixtures.count { it.label == "scam" })
        assertEquals(15, fixtures.count { it.label == "normal" })

        val noCall = PhoneContext(onCallWithUnsaved = false, callStartedAtMs = null)
        val fourDigits = Regex("[0-9]{4,}")
        for (f in fixtures) {
            val v = engine.check(SmsInput(f.sender, f.text, 1_700_000_000_000L), noCall)
            assertEquals(f.expect, v.level, "Fixture ${f.id} (${f.label}) expected ${f.expect} but got ${v.level}")
            assertFalse(fourDigits.containsMatchIn(v.maskedText), "Fixture ${f.id} maskedText leaked digits: ${v.maskedText}")
            if (f.label == "normal") {
                assertTrue(v.reasons.isEmpty(), "Normal fixture ${f.id} should have no reasons")
            } else {
                assertTrue(v.reasons.isNotEmpty(), "Scam fixture ${f.id} should have Hindi reasons")
            }
        }

        // Verify scamType on key script fixtures (matches TS scoreText)
        val s01 = fixtures.first { it.id == "s01" }
        assertEquals("kyc_block", engine.check(SmsInput(s01.sender, s01.text, 1_700_000_000_000L), noCall).scamType)
        val s02 = fixtures.first { it.id == "s02" }
        assertEquals("digital_arrest", engine.check(SmsInput(s02.sender, s02.text, 1_700_000_000_000L), noCall).scamType)
        val s03 = fixtures.first { it.id == "s03" }
        assertEquals("electricity_cut", engine.check(SmsInput(s03.sender, s03.text, 1_700_000_000_000L), noCall).scamType)
        val s04 = fixtures.first { it.id == "s04" }
        assertEquals("parcel_customs", engine.check(SmsInput(s04.sender, s04.text, 1_700_000_000_000L), noCall).scamType)
        val s05 = fixtures.first { it.id == "s05" }
        assertEquals("lottery_prize", engine.check(SmsInput(s05.sender, s05.text, 1_700_000_000_000L), noCall).scamType)
    }

    @Test
    fun kycSmsFrom10DigitSenderIsRedWithAtLeast3Reasons() {
        val v = engine.check(
            SmsInput("9876501234", "SBI KYC expire ho raha hai, update karein: bit.ly/xyz", 1_700_000_000_000L),
            PhoneContext(onCallWithUnsaved = false, callStartedAtMs = null),
        )
        assertEquals(Level.RED, v.level)
        assertEquals("kyc_block", v.scamType)
        assertTrue(v.reasons.size >= 3, "Expected >= 3 reasons, got ${v.reasons}")
        assertTrue(v.reasons.all { it.isNotBlank() })
        assertEquals("mobile_10", v.senderType)
        assertEquals(listOf("bit.ly"), v.linkDomains)
    }

    @Test
    fun hdfcOtpFromBusinessHeaderWithNoCallIsGreen() {
        val v = engine.check(
            SmsInput("AX-HDFCBK-S", "482913 is your OTP for HDFC Bank. Do not share.", 1_700_000_000_000L),
            PhoneContext(onCallWithUnsaved = false, callStartedAtMs = null),
        )
        assertEquals(Level.GREEN, v.level)
        assertTrue(v.reasons.isEmpty())
        assertEquals("business_header", v.senderType)
    }

    @Test
    fun otpDuringUnsavedCallFiresP1Red() {
        val v = engine.check(
            SmsInput("AX-HDFCBK-S", "482913 is your OTP for HDFC Bank. Do not share.", 1_700_000_060_000L),
            PhoneContext(onCallWithUnsaved = true, callStartedAtMs = 1_700_000_000_000L),
        )
        assertEquals(Level.RED, v.level)
        assertTrue(v.matchedRules.contains("pattern.P1"))
        assertEquals("otp_theft", v.scamType)
        assertTrue(v.reasons.isNotEmpty())
    }

    @Test
    fun lookAlikeChecks() {
        assertTrue(engine.lookAlike("sbi-kyc-update.in"))
        assertFalse(engine.lookAlike("onlinesbi.sbi"))
        assertFalse(engine.lookAlike("www.sbi.co.in"))
        assertTrue(engine.lookAlike("xn--sb-kyc-9ya.com"))
        assertFalse(engine.lookAlike("example.com"))
    }

    @Test
    fun maskNeverLeaves4PlusDigitRuns() {
        val fourDigits = Regex("[0-9]{4,}")
        for (f in loadFixtures()) {
            assertFalse(fourDigits.containsMatchIn(engine.mask(f.text)), "Fixture ${f.id} left 4+ digits")
        }
        val no1600 = engine.mask("Call 98765 43210 or +1 415 555 0123, OTP 482913 pay at http://x12345.com/a?id=998877 acct 123456789")
        assertFalse(fourDigits.containsMatchIn(no1600), "Masked text leaked 4+ digits: $no1600")

        val m = engine.mask("Call 98765 43210 or +1 415 555 0123 or 1600123456, OTP 482913 pay at http://x12345.com/a?id=998877 acct 123456789")
        assertFalse(fourDigits.containsMatchIn(m.replace("<1600_NUMBER>", "")), "Masked text leaked 4+ digits: $m")
        assertTrue(m.contains("<MOBILE_10>"))
        assertTrue(m.contains("<INTL>"))
        assertTrue(m.contains("<1600_NUMBER>"))
        assertTrue(m.contains("<URL:"))
        assertTrue(m.contains("******"))
        assertTrue(m.contains("<NUM>"))
    }

    @Test
    fun everyRegexInRulesJsonCompilesInJava() {
        val root = Json.parseToJsonElement(rulesJsonText)
        val patterns = mutableListOf<Pair<String, String>>()

        fun walk(el: kotlinx.serialization.json.JsonElement) {
            when (el) {
                is JsonObject -> {
                    for ((k, v) in el) {
                        if (v is JsonPrimitive && v.isString && (k == "pattern" || k.endsWith("_pattern"))) {
                            val flagsKey = if (k == "pattern") "flags" else k.removeSuffix("pattern") + "flags"
                            val flags = el[flagsKey]?.jsonPrimitive?.content ?: ""
                            patterns.add(v.content to flags)
                        } else {
                            walk(v)
                        }
                    }
                }
                is JsonArray -> el.forEach(::walk)
                else -> {}
            }
        }

        walk(root)
        assertTrue(patterns.size > 10)
        for ((pattern, flags) in patterns) {
            val flagBits = if (flags == "i") Pattern.CASE_INSENSITIVE else 0
            Pattern.compile(pattern, flagBits)
            Pattern.compile(pattern, Pattern.CASE_INSENSITIVE)
        }
    }

    @Test
    fun helpersMirrorTypeScript() {
        assertEquals("business_header", engine.senderType("VM-SBIBNK-S"))
        assertEquals("business_header", engine.senderType("AX-HDFCBK"))
        assertEquals("mobile_10", engine.senderType("9876543210"))
        assertEquals("mobile_10", engine.senderType("+91 98765 43210"))
        assertEquals("international", engine.senderType("+14155550123"))
        assertEquals("short_code", engine.senderType("56767"))
        assertEquals("unknown", engine.senderType(""))

        val links = engine.findLinks("Open https://www.onlinesbi.sbi/login. or bit.ly/xyz, and mail a@b.com")
        assertEquals(listOf("onlinesbi.sbi", "bit.ly"), links.map { it.registrableDomain })
        assertEquals("bseskarnataka.co.in", engine.registrableDomain("https://pay.bseskarnataka.co.in/bill"))

        assertTrue(engine.isOtp("123456 is your OTP"))
        assertTrue(engine.isOtp("आपका ओटीपी 4821 है"))
        assertFalse(engine.isOtp("Rs 2500 debited from account"))
        assertTrue(engine.isOtp("Your code is ******"))

        assertTrue(engine.isApk("download app.apk now"))
        assertFalse(engine.isApk("apkpure is fine"))

        val maskedScore = engine.scoreText(engine.mask("SBI KYC expire ho raha hai, update karein: bit.ly/xyz"))
        assertEquals("kyc_block", maskedScore.scamType)
        assertTrue(maskedScore.hits.any { it.ruleId == "link.shortener" })

        val p5Yellow = engine.check(
            SmsInput("9876543210", "Track your order at example.com/t/123", 1_700_000_000_000L),
            PhoneContext(onCallWithUnsaved = false, callStartedAtMs = null),
        )
        assertEquals(Level.YELLOW, p5Yellow.level)

        val needsAi = engine.check(
            SmsInput("AX-ABCDEF-S", "You have won a lottery", 1_700_000_000_000L),
            PhoneContext(onCallWithUnsaved = false, callStartedAtMs = null),
        )
        assertTrue(needsAi.needsAi)
    }
}

