package app.sahaj.shield.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.io.IOException

/** Manual clock + one-shot scheduler for the P6 timer. */
private class ManualTime(var now: Long = 1_763_100_000_000L) : Scheduler {
  private class Job(val at: Long, val task: () -> Unit) { var cancelled = false }
  private val jobs = mutableListOf<Job>()
  val pending: Int get() = jobs.count { !it.cancelled }

  override fun schedule(delayMs: Long, task: () -> Unit): Cancellable {
    val j = Job(now + delayMs, task); jobs += j
    return Cancellable { j.cancelled = true }
  }

  override fun every(periodMs: Long, task: () -> Unit): Cancellable = Cancellable { }

  fun advance(ms: Long) {
    val end = now + ms
    while (true) {
      val next = jobs.filter { !it.cancelled && it.at <= end }.minByOrNull { it.at } ?: break
      now = maxOf(now, next.at)
      next.cancelled = true
      next.task()
    }
    now = end
    jobs.removeAll { it.cancelled }
  }
}

private data class Signal(val kind: String, val rule: String, val ctx: Map<String, Any>, val level: LocalLevel, val callerType: String?)

private class RecordingSink : SignalEventSink {
  val got = mutableListOf<Signal>()
  override fun enqueue(kind: String, ruleId: String, context: Map<String, Any>) { got += Signal(kind, ruleId, context, LocalLevel.RED, null) }
  override fun enqueue(kind: String, ruleId: String, context: Map<String, Any>, level: LocalLevel, callerType: String?) {
    got += Signal(kind, ruleId, context, level, callerType)
  }
}

private class FakeTransport(var status: Int = 200, var fail: Boolean = false) : Transport {
  data class Call(val url: String, val headers: Map<String, String>, val body: String)
  val calls = mutableListOf<Call>()
  override fun post(url: String, headers: Map<String, String>, body: String): Int {
    calls += Call(url, headers, body)
    if (fail) throw IOException("offline")
    return status
  }
}

/**
 * Test codec standing in for the Keystore cipher: reversible, and the stored form uses only the
 * letters g–v, so it can never contain a digit or the plaintext.
 */
private object ReverseHexCodec : BodyCodec {
  private const val ALPHA = "ghijklmnopqrstuv"
  override fun encode(plain: String) = plain.toByteArray(Charsets.UTF_8).joinToString("") { b ->
    val i = b.toInt() and 0xff
    "${ALPHA[i ushr 4]}${ALPHA[i and 0x0f]}"
  }
  override fun decode(stored: String): String {
    require(stored.all { it in ALPHA } && stored.length % 2 == 0)
    return String(ByteArray(stored.length / 2) { ((ALPHA.indexOf(stored[it * 2]) shl 4) or ALPHA.indexOf(stored[it * 2 + 1])).toByte() }, Charsets.UTF_8)
  }
}

class Phase3Test {
  @get:Rule val tmp = TemporaryFolder()

  private val time = ManualTime()
  private val sink = RecordingSink()
  private var bankNotes = 0
  private val min = 60_000L

  private fun switches(on: Boolean = true) = FeatureSwitches().also { if (on) it.set(Feature.P6_LONG_CALL, true) }

  private fun watch(sw: FeatureSwitches = switches(), history: CallLengthHistory = CallLengthHistory()) =
    LongCallWatch(sw, sink, time, history, { bankNotes++ }, { time.now })

  // ---------------- median / long-call decision ----------------

  @Test fun medianOfOddEvenAndEmpty() {
    assertNull(CallLengthHistory.median(emptyList()))
    assertEquals(5L, CallLengthHistory.median(listOf(9L, 1L, 5L)))
    assertEquals(4L, CallLengthHistory.median(listOf(9L, 2L, 6L, 1L))) // (2 + 6) / 2
    assertEquals(4L, CallLengthHistory.median(listOf(6L, 2L)))
  }

  @Test fun thresholdIsMaxOfThreeTimesMedianAndTwentyMinutes() {
    assertEquals(20 * min, LongCallWatch.decide(null))
    assertEquals(20 * min, LongCallWatch.decide(2 * min)) // 3 × 2 = 6 min < 20
    assertEquals(30 * min, LongCallWatch.decide(10 * min)) // 3 × 10 = 30 min
    assertEquals(60_000L, LongCallWatch.decide(null, demoScale = 20)) // demo: 20 min ÷ 20
    assertFalse(LongCallWatch.isLong(20 * min, null))
    assertTrue(LongCallWatch.isLong(20 * min + 1, null))
    assertFalse(LongCallWatch.isLong(25 * min, 10 * min))
    assertTrue(LongCallWatch.isLong(31 * min, 10 * min))
  }

  @Test fun historyKeepsLast20OnPhoneOnly_numbersOnly() {
    val f = File(tmp.newFolder(), "p6.txt")
    val h = CallLengthHistory(f)
    (1..25).forEach { h.add(it * 1000L) }
    assertEquals(20, h.size)
    assertEquals(15_500L, h.median()) // 6..25 s
    val lines = f.readLines()
    assertEquals(20, lines.size)
    assertTrue(lines.all { it.matches(Regex("^[0-9]+$")) })
    assertEquals(15_500L, CallLengthHistory(f).median()) // survives a restart
  }

  // ---------------- P6 through the real CallStateTracker ----------------

  private fun unsavedCall(tracker: CallStateTracker, type: String = "mobile_10") {
    tracker.onIncomingScreened(isSavedContact = false, callerType = type)
    tracker.onCallState(CallStateTracker.State.RINGING)
    time.advance(5_000)
    tracker.onCallState(CallStateTracker.State.OFFHOOK)
  }

  private fun wire(w: LongCallWatch): CallStateTracker {
    val t = CallStateTracker { time.now }
    t.addChangeListener { w.onCallState(it) }
    t.addEndListener { w.onCallEnded(it) }
    return t
  }

  @Test fun p6_longUnsavedCallSendsOneQuietCallStateEvent() {
    val h = CallLengthHistory()
    repeat(5) { h.add(4 * min) } // her normal: 4 min → threshold max(12, 20) = 20 min
    val w = watch(history = h)
    val tracker = wire(w)
    unsavedCall(tracker)
    assertTrue(w.isTiming)
    time.advance(20 * min - 1)
    assertTrue(sink.got.isEmpty())
    time.advance(1)
    val e = sink.got.single()
    assertEquals("call_state", e.kind)
    assertEquals("pattern.P6", e.rule)
    assertEquals(LocalLevel.YELLOW, e.level)
    assertEquals("mobile_10", e.callerType)
    assertEquals(true, e.ctx["long_vs_normal"])
    assertEquals(20 * min, e.ctx["duration_ms"])
    // Once per call: more time, re-sent states and the call end send nothing more.
    time.advance(30 * min)
    tracker.onCallState(CallStateTracker.State.OFFHOOK)
    tracker.onCallState(CallStateTracker.State.IDLE)
    assertEquals(1, sink.got.size)
    assertFalse(w.isTiming)
    assertEquals(6, h.size) // this call's length joined her history
  }

  @Test fun p6_usesHerMedian_normalLengthCallSendsNothing() {
    val h = CallLengthHistory()
    repeat(3) { h.add(10 * min) } // threshold 30 min
    val w = watch(history = h)
    val tracker = wire(w)
    unsavedCall(tracker)
    time.advance(25 * min)
    tracker.onCallState(CallStateTracker.State.IDLE)
    assertTrue(sink.got.isEmpty())
    assertEquals(4, h.size)
  }

  @Test fun p6_missedTimerIsCaughtAtCallEnd() {
    val w = watch()
    // The listener only sees the end (e.g. process restarted mid-call): the end-of-call check still fires once.
    w.onCallEnded(CallStateTracker.CallSummary(true, "international", true, true, time.now - 45 * min, time.now, false))
    assertEquals(1, sink.got.size)
    assertEquals(45 * min, sink.got[0].ctx["duration_ms"])
    assertEquals("international", sink.got[0].callerType)
  }

  @Test fun p6_savedContactUnansweredOrSwitchOffSendNothing() {
    val w = watch()
    val tracker = wire(w)
    tracker.onIncomingScreened(isSavedContact = true, callerType = "saved_contact")
    tracker.onCallState(CallStateTracker.State.OFFHOOK)
    time.advance(90 * min)
    tracker.onCallState(CallStateTracker.State.IDLE)
    // Rang for a long time, never answered.
    tracker.onIncomingScreened(false, "mobile_10")
    tracker.onCallState(CallStateTracker.State.RINGING)
    time.advance(90 * min)
    tracker.onCallState(CallStateTracker.State.IDLE)
    assertTrue(sink.got.isEmpty())

    val off = watch(sw = switches(on = false))
    val t2 = wire(off)
    unsavedCall(t2)
    time.advance(90 * min)
    t2.onCallState(CallStateTracker.State.IDLE)
    assertTrue(sink.got.isEmpty())
    assertEquals(0, time.pending)
    assertEquals("off", off.simulate())
  }

  @Test fun p6_eventJsonHasCallerTypeAndYellowAndNoNumbers() {
    val w = watch()
    w.onCallEnded(CallStateTracker.CallSummary(true, "mobile_10", true, true, time.now - 50 * min, time.now, false))
    val s = sink.got.single()
    val json = EventFactory.fromSignal(s.kind, s.rule, s.ctx, EventIdentity("f", "p", "d"), "7d0b8d52-3a43-4d6e-9d0a-111122223333", time.now, s.level, s.callerType).toJson()
    assertTrue(json, json.contains("\"kind\":\"call_state\""))
    assertTrue(json, json.contains("\"caller_type\":\"mobile_10\""))
    assertTrue(json, json.contains("\"local_level\":\"yellow\""))
    assertTrue(json, json.contains("\"long_vs_normal\":true"))
    assertTrue(json, json.contains("\"duration_ms\":3000000"))
    assertFalse(json.contains("9000000"))
  }

  // ---------------- 1600 note ----------------

  @Test fun incoming1600CallGetsQuietNote_onlyIncoming1600() {
    val w = watch(sw = switches(on = false)) // the note does not need the P6 switch
    val tracker = wire(w)
    tracker.onIncomingScreened(false, "series_1600")
    tracker.onCallState(CallStateTracker.State.RINGING)
    tracker.onCallState(CallStateTracker.State.OFFHOOK)
    tracker.onCallState(CallStateTracker.State.IDLE)
    assertEquals(1, bankNotes)
    tracker.onOutgoingDialled(false, "series_1600") // she dialled it: no note
    tracker.onCallState(CallStateTracker.State.OFFHOOK)
    tracker.onCallState(CallStateTracker.State.IDLE)
    tracker.onIncomingScreened(false, "mobile_10")
    tracker.onCallState(CallStateTracker.State.RINGING)
    tracker.onCallState(CallStateTracker.State.IDLE)
    assertEquals(1, bankNotes)
    assertTrue(sink.got.isEmpty()) // no alarm, no event
  }

  // ---------------- after-call answers ----------------

  @Test fun afterCall_bankClaimSendsVoiceReportWithCallerType() {
    var last: CallStateTracker.CallSummary? = CallStateTracker.CallSummary(true, "mobile_10", true, true, 0, 60_000, false)
    val r = AfterCallReporter(sink) { last }
    assertEquals("sent", r.report(AfterCallReporter.Answer.CLAIMED_BANK))
    val e = sink.got.single()
    assertEquals("voice_report", e.kind)
    assertEquals("pattern.P7", e.rule)
    assertEquals(true, e.ctx["claimed_bank"])
    assertEquals("mobile_10", e.ctx["caller_type"])
    assertEquals("mobile_10", e.callerType)
    assertEquals(LocalLevel.YELLOW, e.level)

    last = CallStateTracker.CallSummary(true, "series_1600", true, true, 0, 60_000, false)
    r.report(AfterCallReporter.Answer.CLAIMED_BANK)
    assertEquals(LocalLevel.GREEN, sink.got.last().level) // a real 1600 number: the claim fits
    assertEquals("series_1600", sink.got.last().callerType)

    last = null
    r.report(AfterCallReporter.Answer.CLAIMED_BANK)
    assertEquals("unknown", sink.got.last().callerType)
  }

  @Test fun afterCall_otpSharedSendsVoiceReport_noSendsNothing() {
    val r = AfterCallReporter(sink) { CallStateTracker.CallSummary(true, "international", true, true, 0, 1, true) }
    assertEquals("sent", r.report(AfterCallReporter.Answer.OTP_SHARED))
    val e = sink.got.single()
    assertEquals("voice_report", e.kind)
    assertEquals(true, e.ctx["otp_shared"])
    assertEquals(LocalLevel.RED, e.level)
    assertEquals("nothing_sent", r.report(AfterCallReporter.Answer.NO))
    assertEquals(1, sink.got.size)
    assertEquals(AfterCallReporter.Answer.CLAIMED_BANK, AfterCallReporter.Answer.byId("claimed_bank"))
    assertNull(AfterCallReporter.Answer.byId("maybe"))
  }

  @Test fun trackerKeepsLastCallWithoutNumber() {
    val tracker = CallStateTracker { time.now }
    tracker.onIncomingScreened(false, "series_140")
    tracker.onCallState(CallStateTracker.State.RINGING)
    time.advance(3_000)
    tracker.onCallState(CallStateTracker.State.OFFHOOK)
    time.advance(70_000)
    tracker.onCallState(CallStateTracker.State.IDLE)
    val c = tracker.lastCall()!!
    assertTrue(c.unsaved)
    assertEquals("series_140", c.callerType)
    assertEquals(true, c.incoming)
    assertEquals(70_000L, c.durationMs)
    assertFalse(c.toString().contains("9000000"))
  }

  // ---------------- install-source classification (P3) ----------------

  @Test fun installSourceClassification() {
    val w = InstalledAppWatch(
      FeatureSwitches().also { it.set(Feature.INSTALLED_APPS, true) },
      object : Phase2Alerts {
        override fun showCallPause(onCallAnyway: () -> Unit, onDontCall: () -> Unit) {}
        override fun showWarning(warning: Warning, callActive: Boolean) {}
      },
      sink, FileFlaggedAppStore(), "app.sahaj.parent", { time.now },
      remoteControl = setOf("com.example.remote"), playStoreInstallers = setOf("com.android.vending"), recentMs = 12 * 3_600_000L,
    )
    assertTrue(w.isPlayStore("com.android.vending"))
    assertFalse(w.isPlayStore(null)) // adb / unknown
    assertFalse(w.isPlayStore("com.google.android.packageinstaller")) // sideloaded .apk
    assertFalse(w.isPlayStore("com.whatsapp"))
    val apps = listOf(
      InstalledApp("com.side.recent", "com.google.android.packageinstaller", time.now - 11 * 3_600_000L, false),
      InstalledApp("com.side.old", "com.google.android.packageinstaller", time.now - 13 * 3_600_000L, false), // outside 12 h
      InstalledApp("com.play.recent", "com.android.vending", time.now - 3_600_000L, false),
      InstalledApp("com.system.recent", null, time.now - 3_600_000L, true),
    )
    assertEquals(listOf("com.side.recent"), w.evaluate(apps).map { it.packageName })
    w.scan(apps)
    val e = sink.got.single()
    assertEquals("install", e.kind)
    assertEquals("com.side.recent", e.ctx["package"])
    assertEquals("com.google.android.packageinstaller", e.ctx["installer"])
    assertEquals(time.now - 11 * 3_600_000L, e.ctx["first_install_ms"])
    // Already flagged → fires once.
    assertTrue(w.scan(apps).isEmpty())
    assertEquals(1, sink.got.size)
  }

  // ---------------- heartbeat ----------------

  private val pairing = Pairing("https://api.example.test", "dev-1", "s3cret-s3cret-s3cret", "+919000000001", "Riya", "fam-1", "maa-1")

  @Test fun heartbeatPayloadShape() {
    val p = Protections(sms = true, screening = true, redirection = false, usage = true, notifications = false, overlay = true)
    val json = HeartbeatPayload("dev-1", p, "14", "1.0.0", 0L).toJson()
    assertEquals(
      """{"device_id":"dev-1","protections":{"sms":true,"screening":true,"redirection":false,"usage":true,"notifications":false,"overlay":true},"android_version":"14","app_version":"1.0.0","sent_at":"1970-01-01T00:00:00.000Z"}""",
      json,
    )
  }

  @Test fun heartbeatIsSignedLikeEventsAndPostedToHeartbeatPath() {
    val q = FileEventQueue(tmp.newFolder())
    var kicks = 0
    val m = HeartbeatMonitor(q, { pairing }, { kicks++ }, null, { 5_000L })
    val p = Protections(true, true, true, true, true, true)
    assertTrue(m.onStatus(p, "14", "1.0.0", force = true))
    assertEquals(1, kicks)
    val t = FakeTransport(200)
    val sender = EventSender(q, t, { pairing }, { 7_000L }, path = EventSender.HEARTBEAT_PATH)
    assertEquals(1, sender.drainDue().sent)
    val c = t.calls.single()
    assertEquals("https://api.example.test/api/shield/heartbeat", c.url)
    assertEquals("dev-1", c.headers[Signer.HEADER_DEVICE])
    assertEquals("7000", c.headers[Signer.HEADER_TS])
    assertEquals(Signer.sign(pairing.deviceSecret, 7_000L, c.body), c.headers[Signer.HEADER_SIG])
    assertTrue(c.body.contains("\"device_id\":\"dev-1\""))
    assertFalse(c.body.contains(pairing.deviceSecret))
    assertEquals(0, q.size())
  }

  @Test fun heartbeatOnlyOnChangeUnlessForced_keepsNewestOnly_retriesLikeEvents() {
    val q = FileEventQueue(tmp.newFolder())
    val last = File(tmp.newFolder(), "hb_last.txt")
    val m = HeartbeatMonitor(q, { pairing }, {}, last, { 0L })
    val a = Protections(true, false, false, false, false, false)
    assertTrue(m.onStatus(a, "14", "1.0.0", force = true))
    assertFalse(m.onStatus(a, "14", "1.0.0", force = false)) // nothing changed
    val b = a.copy(screening = true)
    assertTrue(m.onStatus(b, "14", "1.0.0", force = false)) // permission change
    assertEquals(1, q.size()) // older unsent heartbeat replaced
    assertTrue(q.all().single().body.contains("\"screening\":true"))
    // Survives restart: same protections are not re-sent without force.
    assertFalse(HeartbeatMonitor(q, { pairing }, {}, last, { 0L }).onStatus(b, "14", "1.0.0", force = false))
    // Not paired → nothing.
    assertFalse(HeartbeatMonitor(FileEventQueue(tmp.newFolder()), { null }, {}).onStatus(a, "14", "1.0.0", force = true))
    // Offline → rescheduled with the event backoff.
    val r = EventSender(q, FakeTransport(fail = true), { pairing }, { 0L }, path = EventSender.HEARTBEAT_PATH).drainDue()
    assertEquals(1, r.retried)
    assertEquals(Backoff().delayFor(1), r.nextDueAtMs)
  }

  // ---------------- gateway ----------------

  private val secret = "g".repeat(40)

  private fun gatewaySetup(store: GatewayConfigStore = MemoryGatewayConfigStore(GatewayConfig(true, "https://api.example.test/", secret, "gw-test1"))): Triple<GatewayForwarder, FakeTransport, Pair<File, GatewayRecentLog>> {
    val dir = tmp.newFolder()
    val t = FakeTransport(200)
    val recent = GatewayRecentLog(File(tmp.newFolder(), "recent.txt"))
    var k = 0
    val f = GatewayForwarder(FileEventQueue(dir, codec = ReverseHexCodec), t, { store.load() }, recent, { time.now }, newKey = { "7d0b8d52-3a43-4d6e-9d0a-00000000000${k++}" })
    return Triple(f, t, dir to recent)
  }

  @Test fun gatewayPayloadShape() {
    assertEquals(
      """{"from":"+919000000002","body":"Bijli kat jayegi","received_at":"1970-01-01T00:00:01.000Z","gateway_id":"gw-test1"}""",
      GatewayPayload.json("+919000000002", "Bijli kat jayegi", 1_000L, "gw-test1"),
    )
  }

  @Test fun gatewayForwardsEverySmsWithSecretHeader_encryptedAtRest() {
    val (f, t, x) = gatewaySetup()
    val (dir, recent) = x
    assertTrue(f.enqueue("+919000000002", "Namaste beta, OTP 4829 hai", time.now))
    assertTrue(f.enqueue("+919000000003", "Doodh wala aaya", time.now))
    // On disk: never the number or the text.
    val stored = dir.listFiles()!!.joinToString("") { it.readText() }
    assertFalse(stored.contains("9000000002") || stored.contains("Namaste") || stored.contains("4829"))
    val r = f.drainDue()
    assertEquals(2, r.sent)
    assertEquals(2, t.calls.size)
    t.calls.forEach {
      assertEquals("https://api.example.test/api/sms/gateway", it.url)
      assertEquals(secret, it.headers[GatewayForwarder.HEADER_SECRET])
      assertTrue(it.body.contains("\"gateway_id\":\"gw-test1\""))
    }
    assertTrue(t.calls[0].body.contains("\"from\":\"+919000000002\""))
    assertEquals(listOf(GatewayRecentLog.SENT, GatewayRecentLog.SENT), recent.list().map { it.status })
    assertEquals(0, dir.listFiles { file -> file.name.endsWith(".evt") }!!.size)
  }

  @Test fun gatewayRetriesDropsAndKeepsOnlyTimeAndStatus() {
    val (f, t, x) = gatewaySetup()
    val (_, recent) = x
    f.enqueue("+919000000004", "Aapka parcel ruka hai", time.now)
    t.fail = true
    val r1 = f.drainDue()
    assertEquals(1, r1.retried)
    assertEquals(GatewayRecentLog.RETRYING, recent.list().single().status)
    t.fail = false; t.status = 400
    time.advance(Backoff().delayFor(1))
    assertEquals(1, f.drainDue().dropped)
    assertEquals(GatewayRecentLog.DROPPED, recent.list().single().status)
    // Too old (24 h) → dropped without sending.
    f.enqueue("+919000000005", "x", time.now)
    time.advance(GatewayForwarder.MAX_AGE_MS + 1)
    val before = t.calls.size
    assertEquals(1, f.drainDue().dropped)
    assertEquals(before, t.calls.size)
    // The recent log only ever has key, time, status.
    recent.list().forEach { e -> assertTrue(e.status in GatewayRecentLog.STATUSES) }
  }

  @Test fun gatewayRecentKeepsLast5_newestFirst_survivesRestart() {
    val file = File(tmp.newFolder(), "recent.txt")
    val log = GatewayRecentLog(file)
    (1..7).forEach { log.add("k$it", it * 1000L, GatewayRecentLog.QUEUED) }
    log.update("k7", GatewayRecentLog.SENT)
    assertEquals(listOf(7000L, 6000L, 5000L, 4000L, 3000L), log.list().map { it.atMs })
    assertEquals(GatewayRecentLog.SENT, GatewayRecentLog(file).list().first().status)
    assertTrue(file.readLines().all { it.split('\t').size == 3 })
  }

  @Test fun gatewayOffOrUnconfiguredStoresNothing() {
    val off = MemoryGatewayConfigStore(GatewayConfig(false, "https://api.example.test", secret, "gw-1"))
    val (f1, t1, _) = gatewaySetup(off)
    assertFalse(f1.isOn())
    assertFalse(f1.enqueue("+919000000006", "x", 0))
    assertNull(f1.drainDue().nextDueAtMs)
    assertTrue(t1.calls.isEmpty())
    val (f2, _, _) = gatewaySetup(MemoryGatewayConfigStore(null))
    assertFalse(f2.enqueue("+919000000006", "x", 0))
    val shortSecret = MemoryGatewayConfigStore(GatewayConfig(true, "https://api.example.test", "short", "gw-1"))
    assertFalse(gatewaySetup(shortSecret).first.isOn())
  }

  @Test fun gatewaySecretStorageInterface_andValidation() {
    val store: GatewayConfigStore = MemoryGatewayConfigStore()
    assertNull(store.load())
    val c = GatewayConfig(true, "https://api.example.test", secret, GatewayForwarder.newGatewayId())
    store.save(c)
    assertEquals(c, store.load())
    assertFalse(c.toString().contains(secret)) // never printed
    assertFalse(c.toString().contains("api.example.test"))
    store.clear()
    assertNull(store.load())

    assertNull(GatewayForwarder.validate("https://api.example.test", secret, allowHttp = false))
    assertEquals("https_required", GatewayForwarder.validate("http://api.example.test", secret, allowHttp = false))
    assertNull(GatewayForwarder.validate("http://10.0.2.2:3000", secret, allowHttp = true))
    assertEquals("bad_url", GatewayForwarder.validate("not a url", secret, allowHttp = false))
    assertEquals("secret_too_short", GatewayForwarder.validate("https://api.example.test", "x".repeat(31), allowHttp = false))
    assertEquals("secret_bad_chars", GatewayForwarder.validate("https://api.example.test", "a b".padEnd(40, 'c'), allowHttp = false))
    assertTrue(GatewayForwarder.isValidGatewayId(GatewayForwarder.newGatewayId()))
  }

  @Test fun queueDropsUnreadableEncryptedItems() {
    val dir = tmp.newFolder()
    val q = FileEventQueue(dir, codec = ReverseHexCodec)
    q.enqueue("7d0b8d52-3a43-4d6e-9d0a-111122223333", "hello", 0)
    assertEquals("hello", q.all().single().body)
    // Read back with a codec that cannot decrypt (e.g. Keystore key lost): the item is removed.
    val broken = object : BodyCodec {
      override fun encode(plain: String) = plain
      override fun decode(stored: String): String = throw IllegalStateException("no key")
    }
    assertTrue(FileEventQueue(dir, codec = broken).all().isEmpty())
    assertEquals(0, dir.listFiles { f -> f.name.endsWith(".evt") }!!.size)
  }
}
