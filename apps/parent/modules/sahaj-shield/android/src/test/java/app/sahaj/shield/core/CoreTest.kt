package app.sahaj.shield.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class SignerTest {
  @Test fun rfc4231_case2() {
    assertEquals(
      "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
      Signer.hmacSha256Hex("Jefe", "what do ya want for nothing?"),
    )
  }

  /** Vector produced with Node: crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex'). */
  @Test fun matchesNodeShieldSignature() {
    val secret = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
    val body = """{"idempotency_key":"0b7c2f0e-1c1e-4d7a-9a51-3f4d9d2b6a11","kind":"sms"}"""
    val ts = 1763113399038L
    assertEquals("ffd07b3ad742c07ddba7d90580a597a4565d18b5b3db247213a3fe513174debf", Signer.sign(secret, ts, body))
    val h = Signer.headers("dev-1", secret, ts, body)
    assertEquals(setOf("x-shield-device", "x-shield-ts", "x-shield-sig"), h.keys)
    assertEquals("1763113399038", h["x-shield-ts"])
    assertNotEquals(h["x-shield-sig"], Signer.sign(secret, ts + 1, body))
  }
}

class MaskerTest {
  @Test fun masksOtpsPhoneNumbersAndSplitDigits() {
    val cases = listOf(
      "Your OTP is 482913. Do not share.",
      "Call 9876543210 now",
      "Call +91 98765 43210 now",
      "OTP 4 8 2 9",
      "code: 12-34-56",
      "A/c XX1234 debited Rs 5,000",
      "ओटीपी ४८२९१३ है", // Devanagari digits
      "id 1234.5678/90",
      "(123) 456",
      "(12) 34",
      "98(76)54",
    )
    for (c in cases) {
      val m = Masker.mask(c)
      assertFalse("$c -> $m", Masker.hasLongDigitRun(m))
      assertFalse("$c -> $m", Regex("""\p{Nd}(?:[\s\-.,/()]*\p{Nd}){3,}""").containsMatchIn(m))
    }
    assertTrue(Masker.hasLongDigitRun("OTP 4 8 2 9"))
    assertTrue(Masker.hasLongDigitRun("(123) 456"))
  }

  @Test fun keepsShortNumbers() {
    assertEquals("Pay Rs 500 in 2 days", Masker.mask("Pay Rs 500 in 2 days"))
  }

  @Test fun capsLength() {
    assertEquals(Masker.MAX_LEN, Masker.mask("a".repeat(5000)).length)
  }
}

class JsonTest {
  @Test fun escapes() {
    assertEquals("\"a\\\"b\\\\c\\n\\u0001\"", Json.quote("a\"b\\c\n\u0001"))
  }
}

class CallStateTrackerTest {
  @Test fun unsavedCallLifecycle() {
    var now = 1_000L
    val t = CallStateTracker { now }
    var ended: Boolean? = null
    t.addListener { ended = it }

    t.onIncomingScreened(isSavedContact = false)
    t.onCallState(CallStateTracker.State.RINGING)
    now = 5_000
    t.onCallState(CallStateTracker.State.OFFHOOK)
    val s = t.snapshot()
    assertTrue(s.callActive); assertTrue(s.onCallWithUnsaved); assertEquals(5_000L, s.callStartedAtMs)

    t.markP1()
    t.onCallState(CallStateTracker.State.IDLE)
    assertEquals(true, ended)
    assertFalse(t.snapshot().callActive)
  }

  @Test fun savedContactIsNotUnsaved() {
    val t = CallStateTracker { 0L }
    t.onIncomingScreened(isSavedContact = true)
    t.onCallState(CallStateTracker.State.RINGING)
    assertFalse(t.snapshot().onCallWithUnsaved)
  }

  @Test fun staleScreeningIsIgnored() {
    var now = 0L
    val t = CallStateTracker { now }
    t.onIncomingScreened(isSavedContact = false)
    now = CallStateTracker.SCREEN_MATCH_WINDOW_MS + 1
    t.onCallState(CallStateTracker.State.OFFHOOK) // e.g. an outgoing call much later
    assertFalse(t.snapshot().onCallWithUnsaved)
  }
}
