package app.sahaj.shield.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

/** Same rules.json that prebuild bundles as asset shield/rules.json (path set in android/build.gradle). */
private val realRulesJson: String by lazy {
  val path = System.getProperty("sahaj.rulesJson") ?: error("system property sahaj.rulesJson not set")
  File(path).readText(Charsets.UTF_8)
}

private class Alerts : AlertSink {
  val shown = mutableListOf<Pair<LocalVerdict, Boolean>>()
  override fun showRedScreen(verdict: LocalVerdict, callActive: Boolean) { shown += verdict to callActive }
}

/** The module pipeline driven by the REAL JsonRulesEngine from packages/shield-kotlin. */
class RealEngineTest {
  @get:Rule val tmp = TemporaryFolder()

  private val identity = EventIdentity("fam-1", "par-1", "dev-1")

  private fun pipeline(queue: FileEventQueue, alerts: AlertSink, calls: CallStateTracker = CallStateTracker { 0L }): ShieldPipeline {
    val loaded = RulesEngineRegistry.load(realRulesJson)
    assertEquals("real rules.json must load: ${loaded.error}", "json", loaded.name)
    return ShieldPipeline(
      engine = { loaded.engine },
      calls = calls,
      queue = queue,
      alerts = alerts,
      identity = { identity },
      kickSender = {},
      newKey = { "7d0b8d52-3a43-4d6e-9d0a-111122223333" },
      clock = { 1_000L },
    )
  }

  @Test fun bundledRulesAreTheRealFileNotThePlaceholder() {
    assertFalse(realRulesJson.replace(" ", "").contains("\"version\":\"0\""))
    assertTrue(realRulesJson.contains("\"patterns\""))
    assertTrue(RulesEngineRegistry.load(realRulesJson).engine is JsonRulesEngineAdapter)
  }

  @Test fun kycScamSmsFrom10DigitSenderIsRedAndEnqueuedMasked() {
    val q = FileEventQueue(tmp.newFolder())
    val alerts = Alerts()
    val sms = SmsInput(
      "9876501234",
      "SBI KYC expire ho raha hai, a/c 004512349876 band hoga. Turant update karein: bit.ly/xyz ya call 9123456780",
      1_763_113_399_038L,
    )
    val out = pipeline(q, alerts).onSms(sms, false)

    assertEquals(ShieldPipeline.Outcome.QUEUED, out)
    assertEquals(1, alerts.shown.size)
    assertEquals(LocalLevel.RED, alerts.shown[0].first.level)
    assertEquals("kyc_block", alerts.shown[0].first.scamType)
    assertTrue(alerts.shown[0].first.reasons.isNotEmpty())
    assertEquals(1, q.size())

    val body = q.all()[0].body
    assertTrue(body.contains("\"local_level\":\"red\""))
    assertTrue(body.contains("\"sender_type\":\"mobile_10\""))
    assertTrue(body.contains("\"masked_text\":"))
    assertTrue(body.contains("bit.ly"))
    for (raw in listOf("9876501234", "004512349876", "9123456780")) assertFalse(raw, body.contains(raw))
    // Ids and timestamps contain digits by design; everything else may not have a 4+ digit run.
    val stripped = body.replace(Regex(""""(idempotency_key|occurred_at|call_started_at|family_id|parent_id|device_id)":"[^"]*""""), "")
    assertFalse(stripped, Masker.hasLongDigitRun(stripped))
    assertFalse(stripped, Regex("[0-9]{4,}").containsMatchIn(stripped))
  }

  @Test fun normalSmsIsGreenAndNothingLeaves() {
    val q = FileEventQueue(tmp.newFolder())
    val alerts = Alerts()
    val out = pipeline(q, alerts).onSms(SmsInput("9876501234", "Beta khana kha liya? Shaam ko phone karna.", 1L), true)
    assertEquals(ShieldPipeline.Outcome.GREEN_DROPPED, out)
    assertEquals(0, q.size())
    assertTrue(alerts.shown.isEmpty())
  }

  @Test fun otpDuringUnsavedCallFiresRealP1AndMarksTheCall() {
    var now = 10_000L
    val calls = CallStateTracker { now }
    var endedP1: Boolean? = null
    calls.addListener { endedP1 = it }
    calls.onIncomingScreened(isSavedContact = false)
    calls.onCallState(CallStateTracker.State.RINGING)
    calls.onCallState(CallStateTracker.State.OFFHOOK)
    val q = FileEventQueue(tmp.newFolder())
    val alerts = Alerts()
    pipeline(q, alerts, calls).onSms(SmsInput("AX-HDFCBK-S", "482913 is your OTP for HDFC Bank. Do not share.", 15_000L), null)

    assertEquals(LocalLevel.RED, alerts.shown.single().first.level)
    assertTrue(alerts.shown[0].first.matchedRules.toString(), "pattern.P1" in alerts.shown[0].first.matchedRules)
    assertTrue(alerts.shown[0].second) // clip waits for call end
    assertFalse(q.all()[0].body.contains("482913"))
    now = 20_000L
    calls.onCallState(CallStateTracker.State.IDLE)
    assertEquals(true, endedP1)
  }

  @Test fun placeholderRulesFallBackToAllGreen() {
    val l = RulesEngineRegistry.load("""{ "version": "0" }""")
    assertEquals("none", l.name)
    assertTrue(l.error != null)
    assertEquals(LocalLevel.GREEN, l.engine.check(SmsInput("9876501234", "SBI KYC update bit.ly/x", 1L), PhoneContext()).level)
  }
}

/** T4/T6 log lines carry only yes/no facts and package names. */
class DebugSignalsTest {
  @Test fun onlyWhatsAppPackagesAreLooked() {
    assertNull(NotificationSignals.from("com.google.android.apps.messaging", listOf("hi"), null, false, emptyList()))
    assertTrue(NotificationSignals.from("com.whatsapp", emptyList(), null, false, emptyList()) != null)
    assertTrue(NotificationSignals.from("com.whatsapp.w4b", emptyList(), null, false, emptyList()) != null)
  }

  @Test fun logsFactsButNeverTheText() {
    val secret = "Mera OTP 482913 hai, file KYC_update.APK"
    val s = NotificationSignals.from("com.whatsapp", listOf(null, secret), "msg", false, emptyList())!!
    assertTrue(s.hasText)
    assertFalse(s.isCallNotification)
    assertTrue(s.apkAttachment)
    val line = s.logLine()
    assertFalse(line, line.contains("482913"))
    assertFalse(line, line.contains("KYC"))
    assertEquals("T6 notification · pkg=com.whatsapp · has_text=yes · is_call_notification=no · attachment_apk=yes", line)
  }

  @Test fun callAndAttachmentDetection() {
    val call = NotificationSignals.from("com.whatsapp", listOf("Incoming voice call"), "call", false, emptyList())!!
    assertTrue(call.isCallNotification)
    assertFalse(call.apkAttachment)
    val styled = NotificationSignals.from("com.whatsapp", emptyList(), null, true, emptyList())!!
    assertTrue(styled.isCallNotification)
    assertFalse(styled.hasText)
    val doc = NotificationSignals.from("com.whatsapp", listOf("📄 Document"), "msg", false, listOf("invoice.apk"))!!
    assertTrue(doc.apkAttachment)
    val pdf = NotificationSignals.from("com.whatsapp", listOf("📄 bill.pdf"), "msg", false, listOf("bill.pdf"))!!
    assertFalse(pdf.apkAttachment)
  }

  @Test fun redirectionLineHasNoNumber() {
    assertEquals("T4 redirection seen · saved_contact=yes · placed unmodified", RedirectionLog.line(true))
    assertEquals("T4 redirection seen · saved_contact=unknown · placed unmodified", RedirectionLog.line(null))
    assertFalse(Masker.hasLongDigitRun(RedirectionLog.line(false)))
  }

  @Test fun debugEventsAreCappedNewestFirst() {
    val d = DebugEvents(max = 3, clock = { 0L })
    repeat(5) { d.add("line $it") }
    val snap = d.snapshot()
    assertEquals(3, snap.size)
    assertTrue(snap[0].endsWith("line 4"))
    assertTrue(snap[2].endsWith("line 2"))
  }
}
