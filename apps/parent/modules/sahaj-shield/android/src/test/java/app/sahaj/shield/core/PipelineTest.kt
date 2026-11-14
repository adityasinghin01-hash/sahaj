package app.sahaj.shield.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.IOException

/** Tiny stand-in for the real rules engine (written on another card). Returns a fixed level. */
private class StubEngine(private val level: LocalLevel, private val rules: List<String> = listOf("P1")) : RulesEngine {
  var lastCtx: PhoneContext? = null
  override fun check(input: SmsInput, ctx: PhoneContext): LocalVerdict {
    lastCtx = ctx
    // Deliberately returns the RAW body as "maskedText" to prove the module re-masks it.
    return LocalVerdict(level, listOf("OTP ${input.body}"), rules, input.body, "mobile_10", listOf("evil1234.example.com"))
  }
}

private class RecordingAlerts : AlertSink {
  val shown = mutableListOf<Pair<LocalVerdict, Boolean>>()
  override fun showRedScreen(verdict: LocalVerdict, callActive: Boolean) { shown += verdict to callActive }
}

class PipelineTest {
  @get:Rule val tmp = TemporaryFolder()

  private val identity = EventIdentity("fam-1", "par-1", "dev-1")
  private val sms = SmsInput("+919876543210", "Your OTP is 482913. Call 9876543210 now", 1_763_113_399_038L)

  private fun pipeline(engine: RulesEngine, queue: FileEventQueue, alerts: AlertSink, calls: CallStateTracker = CallStateTracker { 0L }, kicks: IntArray = IntArray(1)) =
    ShieldPipeline(
      engine = { engine },
      calls = calls,
      queue = queue,
      alerts = alerts,
      identity = { identity },
      kickSender = { kicks[0]++ },
      newKey = { "7d0b8d52-3a43-4d6e-9d0a-111122223333" },
      clock = { 1_000L },
    )

  @Test fun greenNeverEnqueues() {
    val q = FileEventQueue(tmp.newFolder())
    val alerts = RecordingAlerts()
    val kicks = IntArray(1)
    val out = pipeline(StubEngine(LocalLevel.GREEN), q, alerts, kicks = kicks).onSms(sms, null)
    assertEquals(ShieldPipeline.Outcome.GREEN_DROPPED, out)
    assertEquals(0, q.size())
    assertTrue(alerts.shown.isEmpty())
    assertEquals(0, kicks[0])
  }

  @Test fun yellowEnqueuesWithoutRedScreen() {
    val q = FileEventQueue(tmp.newFolder())
    val alerts = RecordingAlerts()
    assertEquals(ShieldPipeline.Outcome.QUEUED, pipeline(StubEngine(LocalLevel.YELLOW), q, alerts).onSms(sms, false))
    assertEquals(1, q.size())
    assertTrue(alerts.shown.isEmpty())
  }

  @Test fun redEnqueuesAndRequestsOverlay() {
    val q = FileEventQueue(tmp.newFolder())
    val alerts = RecordingAlerts()
    val kicks = IntArray(1)
    val out = pipeline(StubEngine(LocalLevel.RED), q, alerts, kicks = kicks).onSms(sms, false)
    assertEquals(ShieldPipeline.Outcome.QUEUED, out)
    assertEquals(1, q.size())
    assertEquals(1, alerts.shown.size)
    assertEquals(LocalLevel.RED, alerts.shown[0].first.level)
    assertFalse(alerts.shown[0].second) // no call active → clip plays at once
    assertEquals(1, kicks[0])
    assertTrue(q.all()[0].body.contains("\"local_level\":\"red\""))
  }

  @Test fun redDuringUnsavedCallPassesCallContextAndHoldsClip() {
    var now = 10_000L
    val calls = CallStateTracker { now }
    var endedP1: Boolean? = null
    calls.addListener { endedP1 = it }
    calls.onIncomingScreened(isSavedContact = false)
    calls.onCallState(CallStateTracker.State.RINGING)
    calls.onCallState(CallStateTracker.State.OFFHOOK)
    val engine = StubEngine(LocalLevel.RED, listOf("P1"))
    val alerts = RecordingAlerts()
    val q = FileEventQueue(tmp.newFolder())
    pipeline(engine, q, alerts, calls).onSms(sms, null)

    assertTrue(engine.lastCtx!!.onCallWithUnsaved)
    assertTrue(alerts.shown[0].second) // overlay now, clip waits for call end
    val body = q.all()[0].body
    assertTrue(body.contains("\"on_call_with_unsaved\":true"))
    assertTrue(body.contains("\"call_started_at\":\"1970-01-01T00:00:10.000Z\""))
    now = 20_000L
    calls.onCallState(CallStateTracker.State.IDLE)
    assertEquals(true, endedP1) // → after-call question
  }

  @Test fun maskedEventNeverContainsFourDigitRun() {
    val q = FileEventQueue(tmp.newFolder())
    pipeline(StubEngine(LocalLevel.RED), q, RecordingAlerts()).onSms(sms, false)
    val body = q.all()[0].body
    assertTrue(body.contains("\"masked_text\":"))
    assertFalse(body.contains("482913"))
    assertFalse(body.contains("9876543210"))
    // Strip the fields that are timestamps / ids by design, then nothing may have 4+ digits in a row.
    val stripped = body
      .replace(Regex(""""(idempotency_key|occurred_at|call_started_at|family_id|parent_id|device_id)":"[^"]*""""), "")
    assertFalse(stripped, Masker.hasLongDigitRun(stripped))

    // Event built straight from a verdict whose fields are all raw.
    val raw = LocalVerdict(LocalLevel.RED, emptyList(), listOf("R-12345"), "OTP 1 2 3 4 5 6, a/c 00112233", "weird", listOf("1234.in"))
    val e = EventFactory.fromSmsVerdict(raw, PhoneContext(), identity, "k-00000000", 0L)
    assertFalse(Masker.hasLongDigitRun(e.maskedText!!))
    assertTrue(e.matchedRules.none { Masker.hasLongDigitRun(it) })
    assertTrue(e.linkDomains.none { Masker.hasLongDigitRun(it) })
    assertEquals("unknown", e.senderType)
  }

  @Test fun unpairedRedStillAlertsButQueuesNothing() {
    val q = FileEventQueue(tmp.newFolder())
    val alerts = RecordingAlerts()
    val p = ShieldPipeline({ StubEngine(LocalLevel.RED) }, CallStateTracker { 0L }, q, alerts, { null }, {})
    assertEquals(ShieldPipeline.Outcome.NOT_PAIRED, p.onSms(sms, null))
    assertEquals(1, alerts.shown.size)
    assertEquals(0, q.size())
  }
}

class QueueAndSenderTest {
  @get:Rule val tmp = TemporaryFolder()

  private val pairing = Pairing("https://api.example.test/", "dev-1", "secret-secret-secret", "", familyId = "f", parentId = "p")

  @Test fun queueSurvivesReopen() {
    val dir = tmp.newFolder()
    FileEventQueue(dir).enqueue("aaaaaaaa-1", "{\"x\":1}", 5)
    val again = FileEventQueue(dir).all()
    assertEquals(1, again.size)
    assertEquals("{\"x\":1}", again[0].body)
  }

  @Test fun retriesAfterFailureWithBackoffThenSends() {
    val q = FileEventQueue(tmp.newFolder())
    q.enqueue("aaaaaaaa-1", "{\"a\":1}", 0)
    var now = 1_000L
    val calls = mutableListOf<Triple<String, Map<String, String>, String>>()
    var mode = "down"
    val transport = Transport { url, headers, body ->
      calls += Triple(url, headers, body)
      when (mode) {
        "down" -> throw IOException("offline")
        "500" -> 500
        else -> 201
      }
    }
    val backoff = Backoff(baseMs = 30_000, maxMs = 600_000, maxAttempts = 10)
    val sender = EventSender(q, transport, { pairing }, { now }, backoff)

    // 1st try: network down → stays queued, next try in 30 s.
    var r = sender.drainDue()
    assertEquals(0, r.sent); assertEquals(1, r.retried)
    assertEquals(1, q.size())
    assertEquals(1, q.all()[0].attempts)
    assertEquals(now + 30_000, r.nextDueAtMs)

    // Not due yet → no request.
    now += 10_000
    sender.drainDue()
    assertEquals(1, calls.size)

    // 2nd try: server 500 → retry again with doubled delay (60 s).
    now = 31_000
    mode = "500"
    r = sender.drainDue()
    assertEquals(1, r.retried)
    assertEquals(2, q.all()[0].attempts)
    assertEquals(now + 60_000, r.nextDueAtMs)

    // 3rd try: success → removed.
    now += 60_000
    mode = "ok"
    r = sender.drainDue()
    assertEquals(1, r.sent)
    assertEquals(0, q.size())
    assertNull(r.nextDueAtMs)

    // Every attempt was signed fresh and went to the right URL.
    assertEquals(3, calls.size)
    for ((url, headers, body) in calls) {
      assertEquals("https://api.example.test/api/shield/event", url)
      assertEquals("dev-1", headers["x-shield-device"])
      val ts = headers["x-shield-ts"]!!.toLong()
      assertEquals(Signer.sign("secret-secret-secret", ts, body), headers["x-shield-sig"])
    }
  }

  @Test fun duplicateIsDoneAndBadRequestIsDropped() {
    val q = FileEventQueue(tmp.newFolder())
    q.enqueue("aaaaaaaa-1", "{}", 0)
    q.enqueue("bbbbbbbb-2", "{}", 1)
    val codes = ArrayDeque(listOf(409, 422))
    val r = EventSender(q, { _, _, _ -> codes.removeFirst() }, { pairing }, { 10L }).drainDue()
    assertEquals(1, r.sent); assertEquals(1, r.dropped); assertEquals(0, q.size())
  }

  @Test fun givesUpAfterMaxAttempts() {
    val q = FileEventQueue(tmp.newFolder())
    q.enqueue("aaaaaaaa-1", "{}", 0)
    var now = 0L
    val sender = EventSender(q, { _, _, _ -> 503 }, { pairing }, { now }, Backoff(1, 1, maxAttempts = 3))
    repeat(3) { now += 10; sender.drainDue() }
    assertEquals(0, q.size())
  }

  @Test fun notPairedKeepsQueue() {
    val q = FileEventQueue(tmp.newFolder())
    q.enqueue("aaaaaaaa-1", "{}", 0)
    val r = EventSender(q, { _, _, _ -> error("must not send") }, { null }, { 10L }).drainDue()
    assertEquals(0, r.sent); assertEquals(1, q.size())
  }

  @Test fun backoffDoublesAndCaps() {
    val b = Backoff(baseMs = 30_000, maxMs = 6 * 3600_000L)
    assertEquals(30_000L, b.delayFor(1))
    assertEquals(60_000L, b.delayFor(2))
    assertEquals(120_000L, b.delayFor(3))
    assertEquals(6 * 3600_000L, b.delayFor(40))
  }
}
