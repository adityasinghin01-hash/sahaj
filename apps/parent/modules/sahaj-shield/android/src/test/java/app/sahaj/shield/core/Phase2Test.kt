package app.sahaj.shield.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

/** Manual clock + scheduler: nothing runs until the test advances time. */
private class FakeTime(var now: Long = 1_763_100_000_000L) : Scheduler {
  private class Job(var at: Long, val period: Long?, val task: () -> Unit) { var cancelled = false }
  private val jobs = mutableListOf<Job>()

  val active: Int get() = jobs.count { !it.cancelled }

  override fun schedule(delayMs: Long, task: () -> Unit): Cancellable {
    val j = Job(now + delayMs, null, task); jobs += j
    return Cancellable { j.cancelled = true }
  }

  override fun every(periodMs: Long, task: () -> Unit): Cancellable {
    val j = Job(now, periodMs, task); jobs += j
    return Cancellable { j.cancelled = true }
  }

  fun advance(ms: Long) {
    val end = now + ms
    while (true) {
      val next = jobs.filter { !it.cancelled && it.at <= end }.minByOrNull { it.at } ?: break
      now = maxOf(now, next.at)
      if (next.period == null) next.cancelled = true else next.at += next.period
      next.task()
    }
    now = end
    jobs.removeAll { it.cancelled }
  }
}

private class FakeAlerts : Phase2Alerts {
  val warnings = mutableListOf<Pair<Warning, Boolean>>()
  var pause: Pair<() -> Unit, () -> Unit>? = null
  var pauses = 0
  override fun showCallPause(onCallAnyway: () -> Unit, onDontCall: () -> Unit) { pauses++; pause = onCallAnyway to onDontCall }
  override fun showWarning(warning: Warning, callActive: Boolean) { warnings += warning to callActive }
}

private data class Sent(val kind: String, val rule: String, val ctx: Map<String, Any>)

class Phase2Test {
  @get:Rule val tmp = TemporaryFolder()

  private val time = FakeTime()
  private val alerts = FakeAlerts()
  private val sent = mutableListOf<Sent>()
  private var call = CallStateTracker.Snapshot(false, false, null)
  private val foreground = mutableListOf<String>()
  private var foregroundQueries = 0

  private fun shield(switches: FeatureSwitches = FeatureSwitches(), numbers: FlaggedNumberStore = FlaggedNumberStore()) = Phase2Shield(
    switches = switches,
    numbers = numbers,
    alerts = alerts,
    events = { k, r, c -> sent += Sent(k, r, c) },
    scheduler = time,
    foreground = { _ -> foregroundQueries++; foreground.toList().also { foreground.clear() } },
    currentCall = { call },
    flaggedApps = FileFlaggedAppStore(),
    selfPackage = "app.sahaj.parent",
    clock = { time.now },
  )

  private fun allOn() = FeatureSwitches().also { s -> Feature.entries.forEach { s.set(it, true) } }

  private val red = LocalVerdict(LocalLevel.RED, listOf("r"), listOf("pattern.P5"), "", "mobile_10", emptyList())
  private val scamSms = SmsInput("+91 98765 43210", "Bijli kat jayegi. Turant 70123-45678 par call karein ya +91 (912) 345 6789", 0)

  // ---------------- P8 ----------------

  @Test fun p8_dialledNumberFromFlaggedSmsIsPaused_otherNumbersPlaceUnmodified() {
    val p = shield(allOn())
    p.onFlaggedSms(scamSms.copy(receivedAtMs = time.now), red)
    assertEquals(3, p.numbers.size(time.now)) // sender + two numbers in the body

    var replaced = 0
    // Match regardless of format: +91, spaces, 0 prefix.
    for (dialled in listOf("07012345678", "+917012345678", "9876543210", "9123456789")) {
      assertEquals(dialled, OutgoingCallGuard.Decision.PAUSED, p.outgoing.onOutgoingCall(dialled, { replaced++ }))
    }
    assertEquals(4, alerts.pauses)
    // No match → today's behaviour.
    assertEquals(OutgoingCallGuard.Decision.PLACE_UNMODIFIED, p.outgoing.onOutgoingCall("9000011111", { replaced++ }))
    assertEquals(OutgoingCallGuard.Decision.PLACE_UNMODIFIED, p.outgoing.onOutgoingCall("*121#", { replaced++ }))
    assertEquals(4, alerts.pauses)
    assertEquals(0, replaced)
    assertTrue(sent.isEmpty())
  }

  @Test fun p8_callAnywayReplacesOnceAndIsNotPausedAgain_thenPausesNextTime() {
    val p = shield(allOn())
    p.onFlaggedSms(scamSms.copy(receivedAtMs = time.now), red)
    var replaced = 0
    assertEquals(OutgoingCallGuard.Decision.PAUSED, p.outgoing.onOutgoingCall("7012345678", { replaced++ }))
    alerts.pause!!.first() // [Phir bhi call karo]
    assertEquals(1, replaced)
    // The re-placed call comes back through the redirection service: let it through, unmodified.
    assertEquals(OutgoingCallGuard.Decision.PLACE_UNMODIFIED, p.outgoing.onOutgoingCall("+91 70123 45678", { replaced++ }))
    assertEquals(1, alerts.pauses)
    // Allow-once is used up: a later call to the same number is paused again.
    assertEquals(OutgoingCallGuard.Decision.PAUSED, p.outgoing.onOutgoingCall("7012345678", { replaced++ }))
    assertTrue(sent.isEmpty()) // "call anyway" sends nothing
  }

  @Test fun p8_allowOnceExpires() {
    val p = shield(allOn())
    p.onFlaggedSms(scamSms.copy(receivedAtMs = time.now), red)
    p.outgoing.onOutgoingCall("7012345678", {})
    alerts.pause!!.first()
    time.advance(FlaggedNumberStore.ALLOW_ONCE_MS + 1)
    assertEquals(OutgoingCallGuard.Decision.PAUSED, p.outgoing.onOutgoingCall("7012345678", {}))
  }

  @Test fun p8_dontCallEnqueuesMaskedCallOutEvent() {
    val p = shield(allOn())
    p.onFlaggedSms(scamSms.copy(receivedAtMs = time.now), red)
    var replaced = 0
    p.outgoing.onOutgoingCall("7012345678", { replaced++ })
    alerts.pause!!.second() // [Mat karo]
    assertEquals(0, replaced)
    assertEquals(1, sent.size)
    assertEquals("call_out", sent[0].kind)
    assertEquals("pattern.P8", sent[0].rule)
    val json = EventFactory.fromSignal(sent[0].kind, sent[0].rule, sent[0].ctx, EventIdentity("f", "p", "d"), "7d0b8d52-3a43-4d6e-9d0a-111122223333", time.now).toJson()
    assertTrue(json.contains("\"kind\":\"call_out\""))
    assertTrue(json.contains("\"local_level\":\"red\""))
    assertFalse(json.contains("masked_text"))
    assertNoNumbers(json)
  }

  @Test fun p8_numbersExpireAfter24h_andStoreFileHoldsOnlyHashes() {
    val f = File(tmp.newFolder(), "p8.txt")
    val store = FlaggedNumberStore(f)
    val p = shield(allOn(), store)
    p.onFlaggedSms(scamSms.copy(receivedAtMs = time.now), red)
    val text = f.readText()
    assertFalse(text.contains("7012345678") || text.contains("9876543210") || text.contains("9123456789"))
    assertEquals(PhoneNumbers.hash10("7012345678"), PhoneNumbers.hashOf("+91 70123-45678"))
    assertTrue(text.contains(PhoneNumbers.hash10("7012345678")))
    // Survives a restart.
    assertTrue(FlaggedNumberStore(f).containsNumber("7012345678", time.now))
    time.advance(FlaggedNumberStore.TTL_MS + 1)
    assertEquals(OutgoingCallGuard.Decision.PLACE_UNMODIFIED, p.outgoing.onOutgoingCall("7012345678", {}))
  }

  @Test fun p8_greenSmsIsNotRemembered() {
    val p = shield(allOn())
    p.onFlaggedSms(scamSms, red.copy(level = LocalLevel.GREEN))
    assertEquals(0, p.numbers.size(time.now))
  }

  @Test fun p8_realEnginePipelineFeedsTheStore() {
    val path = System.getProperty("sahaj.rulesJson") ?: error("sahaj.rulesJson not set")
    val engine = RulesEngineRegistry.load(File(path).readText()).engine
    val p = shield(allOn())
    val pipe = ShieldPipeline(
      engine = { engine }, calls = CallStateTracker { 0L }, queue = FileEventQueue(tmp.newFolder()),
      alerts = object : AlertSink { override fun showRedScreen(verdict: LocalVerdict, callActive: Boolean) {} },
      identity = { null }, kickSender = {}, onFlagged = { i, v -> p.onFlaggedSms(i, v) },
    )
    val sms = SmsInput("9876501234", "Dear customer your SBI account KYC is blocked today. Update now at http://sbi-kyc-update.xyz/login or call 9123456780", time.now)
    assertEquals(ShieldPipeline.Outcome.NOT_PAIRED, pipe.onSms(sms, false)) // RED
    assertEquals(OutgoingCallGuard.Decision.PAUSED, p.outgoing.onOutgoingCall("9123456780", {}))
    // A GREEN SMS with a number is not remembered.
    pipe.onSms(SmsInput("9876501111", "Beta khana kha liya? Papa ka naya number 9988776655 hai", time.now), true)
    assertEquals(OutgoingCallGuard.Decision.PLACE_UNMODIFIED, p.outgoing.onOutgoingCall("9988776655", {}))
  }

  // ---------------- P9 ----------------

  @Test fun p9_pollsOnlyDuringUnsavedCall_firesOnBankApp_stopsWhenCallEnds() {
    val p = shield(allOn())
    // Saved-contact call: no polling.
    call = CallStateTracker.Snapshot(true, false, time.now)
    p.onCallState(call)
    assertFalse(p.bankApps.isPolling)
    assertEquals(0, time.active)
    foreground += "com.phonepe.app"
    time.advance(10_000)
    assertTrue(alerts.warnings.isEmpty())
    foreground.clear()

    // Unsaved call: polls every 2 s.
    call = CallStateTracker.Snapshot(true, true, time.now)
    p.onCallState(call)
    assertTrue(p.bankApps.isPolling)
    val q0 = foregroundQueries
    time.advance(6_000)
    assertEquals(4, foregroundQueries - q0) // t=0,2,4,6
    foreground += listOf("com.whatsapp", "com.android.dialer")
    time.advance(2_000)
    assertTrue(alerts.warnings.isEmpty())
    foreground += "net.one97.paytm"
    time.advance(2_000) // red within one poll (≤ 2 s)
    assertEquals(listOf(Warning.P9_BANK_APP to true), alerts.warnings)
    assertEquals(1, sent.size)
    assertEquals("app_open", sent[0].kind)
    assertEquals("net.one97.paytm", sent[0].ctx["package"])
    // Only once per call.
    foreground += "com.phonepe.app"
    time.advance(2_000)
    assertEquals(1, alerts.warnings.size)

    // Call ends → polling stops.
    call = CallStateTracker.Snapshot(false, false, null)
    p.onCallState(call)
    assertFalse(p.bankApps.isPolling)
    assertEquals(0, time.active)
    val q1 = foregroundQueries
    foreground += "com.phonepe.app"
    time.advance(20_000)
    assertEquals(q1, foregroundQueries)
    assertEquals(1, alerts.warnings.size)
  }

  @Test fun p9_followsCallStateTracker() {
    val p = shield(allOn())
    val tracker = CallStateTracker { time.now }
    tracker.addChangeListener { p.onCallState(it) }
    tracker.onIncomingScreened(isSavedContact = false)
    tracker.onCallState(CallStateTracker.State.RINGING)
    assertTrue(p.bankApps.isPolling) // ringing counts as call active (same as P1)
    tracker.onCallState(CallStateTracker.State.OFFHOOK)
    assertTrue(p.bankApps.isPolling)
    tracker.onCallState(CallStateTracker.State.IDLE)
    assertFalse(p.bankApps.isPolling)
    // Outgoing call she dialled to an unsaved number also counts.
    tracker.onOutgoingDialled(isSavedContact = false)
    tracker.onCallState(CallStateTracker.State.OFFHOOK)
    assertTrue(p.bankApps.isPolling)
    tracker.onCallState(CallStateTracker.State.IDLE)
    assertFalse(p.bankApps.isPolling)
  }

  @Test fun p9_switchOffDuringCallStopsPolling_onDuringCallStarts() {
    val sw = allOn()
    val p = shield(sw)
    call = CallStateTracker.Snapshot(true, true, time.now)
    p.onCallState(call)
    assertTrue(p.bankApps.isPolling)
    sw.set(Feature.P9_BANK_APP, false)
    assertFalse(p.bankApps.isPolling)
    sw.set(Feature.P9_BANK_APP, true)
    assertTrue(p.bankApps.isPolling) // reads the current call via currentCall()
  }

  // ---------------- P2 ----------------

  @Test fun p2_unsavedWhatsAppCallFiresAfter10Min() {
    val p = shield(allOn())
    assertTrue(p.whatsAppCalls.onCallNotification("k1", titleIsSavedContact = false))
    // Re-posts of the same notification do not restart the timer.
    time.advance(5 * 60_000)
    assertFalse(p.whatsAppCalls.onCallNotification("k1", false))
    time.advance(5 * 60_000 - 1)
    assertTrue(alerts.warnings.isEmpty())
    time.advance(1)
    assertEquals(listOf(Warning.P2_VIDEO_CALL to false), alerts.warnings)
    assertEquals("notification", sent.single().kind)
    assertEquals("pattern.P2", sent.single().rule)
    assertEquals(600, sent.single().ctx["call_seconds"])
    // Same call keeps posting updates: no second alarm.
    assertFalse(p.whatsAppCalls.onCallNotification("k1", false))
    time.advance(60 * 60_000)
    assertEquals(1, alerts.warnings.size)
  }

  @Test fun p2_demoScaleDividesThreshold() {
    val sw = allOn()
    sw.setDemoScale(20)
    val p = shield(sw)
    assertEquals(30_000L, p.whatsAppCalls.thresholdMs())
    p.whatsAppCalls.onCallNotification("k1", null) // unknown → treated as unsaved
    time.advance(29_999)
    assertTrue(alerts.warnings.isEmpty())
    time.advance(1)
    assertEquals(1, alerts.warnings.size)
    assertEquals(30, sent.single().ctx["call_seconds"])
    assertEquals(20, sent.single().ctx["demo_scale"])
  }

  @Test fun p2_savedContactOrShortCallDoesNothing() {
    val sw = allOn(); sw.setDemoScale(20)
    val p = shield(sw)
    assertFalse(p.whatsAppCalls.onCallNotification("saved", titleIsSavedContact = true))
    assertTrue(p.whatsAppCalls.onCallNotification("short", false))
    time.advance(10_000)
    p.whatsAppCalls.onNotificationRemoved("short") // call ended after 10 s
    time.advance(60_000)
    assertTrue(alerts.warnings.isEmpty())
    assertTrue(sent.isEmpty())
    assertEquals(0, p.whatsAppCalls.trackedCount)
  }

  // ---------------- P3 .apk ----------------

  @Test fun p3_apkAttachmentDetected() {
    val p = shield(allOn())
    val apkDoc = NotificationSignals.from("com.whatsapp", listOf("📄 Wedding_Card.APK"), null, false, emptyList())!!
    val apkUri = NotificationSignals.from("com.whatsapp.w4b", listOf("Photo"), null, false, listOf("PM-Kisan.apk"))!!
    val pdf = NotificationSignals.from("com.whatsapp", listOf("📄 bill.pdf"), null, false, emptyList())!!
    val word = NotificationSignals.from("com.whatsapp", listOf("apk ka link bhejo"), null, false, emptyList())!!
    assertTrue(p.apk.onSignals("a", apkDoc))
    assertTrue(p.apk.onSignals("b", apkUri))
    assertFalse(p.apk.onSignals("c", pdf))
    assertFalse(p.apk.onSignals("d", word))
    assertEquals(listOf(Warning.P3_APK to false, Warning.P3_APK to false), alerts.warnings)
    assertEquals(2, sent.size)
    sent.forEach { assertEquals("notification", it.kind); assertEquals("pattern.P3", it.rule); assertEquals(true, it.ctx["attachment_apk"]) }
    // Only signals: no text, no title in the event.
    sent.forEach { s -> assertFalse(s.ctx.values.any { it.toString().contains("Wedding", ignoreCase = true) || it.toString().contains("Kisan") }) }
    // Same notification re-posted within 10 min: no second alarm.
    assertFalse(p.apk.onSignals("a", apkDoc))
    // Other packages never produce signals.
    assertNull(NotificationSignals.from("org.telegram.messenger", listOf("x.apk"), null, false, emptyList()))
  }

  // ---------------- installed apps (P4 / P3) ----------------

  @Test fun installed_remoteControlAppsMatchAndAlertOnce() {
    val p = shield(allOn())
    val old = time.now - 90L * 86_400_000L
    val apps = listOf(
      InstalledApp("com.anydesk.anydeskandroid", "com.android.vending", old, false),
      InstalledApp("com.teamviewer.quicksupport.market", "com.android.vending", old, false),
      InstalledApp("com.carriez.flutter_hbb", null, old, false),
      InstalledApp("com.sand.airdroid", "com.android.vending", old, false),
      InstalledApp("com.whatsapp", "com.android.vending", old, false),
      InstalledApp("com.anydesk.notreally", "com.android.vending", old, false),
    )
    val flags = p.installed.scan(apps)
    assertEquals(
      listOf("com.anydesk.anydeskandroid", "com.teamviewer.quicksupport.market", "com.carriez.flutter_hbb", "com.sand.airdroid"),
      flags.map { it.packageName },
    )
    assertTrue(flags.all { it.ruleId == "pattern.P4" && it.reason == InstalledAppWatch.REASON_REMOTE })
    assertEquals(listOf(Warning.INSTALLED_APP to false), alerts.warnings) // one red screen per scan
    assertEquals(4, sent.size)
    assertTrue(sent.all { it.kind == "install" })
    // Next scan (6 h later): already flagged, nothing new.
    time.advance(6 * 3_600_000L)
    assertTrue(p.installed.scan(apps).isEmpty())
    assertEquals(1, alerts.warnings.size)
  }

  @Test fun installed_sideloadedInLast24hIsFlagged() {
    val p = shield(allOn())
    val apps = listOf(
      InstalledApp("com.fake.kyc", "com.google.android.packageinstaller", time.now - 2 * 3_600_000L, false),
      InstalledApp("com.fake.unknownsource", null, time.now - 3_600_000L, false),
      InstalledApp("com.old.sideload", "com.google.android.packageinstaller", time.now - 3 * 86_400_000L, false),
      InstalledApp("com.new.fromplay", "com.android.vending", time.now - 3_600_000L, false),
      InstalledApp("com.oem.updated", null, time.now - 3_600_000L, true),
      InstalledApp("app.sahaj.parent", null, time.now - 60_000L, false),
    )
    val flags = p.installed.scan(apps)
    assertEquals(listOf("com.fake.kyc", "com.fake.unknownsource"), flags.map { it.packageName })
    assertTrue(flags.all { it.ruleId == "pattern.P3" })
    assertEquals(2, sent[0].ctx["installed_hours_ago"])
    assertEquals("com.google.android.packageinstaller", sent[0].ctx["installer"])
    assertEquals("unknown", sent[1].ctx["installer"])
  }

  @Test fun remoteControlListMatchesConfigPluginQueries() {
    val path = System.getProperty("sahaj.pluginJs") ?: error("sahaj.pluginJs not set")
    val js = File(path).readText()
    val block = js.substringAfter("const REMOTE_CONTROL_PACKAGES = [").substringBefore("];")
    val inPlugin = Regex("'([a-zA-Z0-9_.]+)'").findAll(block).map { it.groupValues[1] }.toSet()
    assertEquals(AppLists.REMOTE_CONTROL, inPlugin)
  }

  // ---------------- switches ----------------

  @Test fun everyFeatureDoesNothingWhenItsSwitchIsOff() {
    val sw = FeatureSwitches() // all off (the default)
    Feature.entries.forEach { assertFalse(it.id, sw.isOn(it)) }
    val p = shield(sw)

    // P8: flagged SMS is not even remembered; dialling places unmodified.
    p.onFlaggedSms(scamSms, red)
    assertEquals(0, p.numbers.size(time.now))
    assertEquals(OutgoingCallGuard.Decision.PLACE_UNMODIFIED, p.outgoing.onOutgoingCall("7012345678", {}))
    // P8 with numbers already stored, switch off: still unmodified.
    p.numbers.recordFromSms(scamSms.sender, scamSms.body, time.now)
    assertEquals(OutgoingCallGuard.Decision.PLACE_UNMODIFIED, p.outgoing.onOutgoingCall("7012345678", {}))

    // P9: no polling during an unsaved call.
    call = CallStateTracker.Snapshot(true, true, time.now)
    p.onCallState(call)
    assertFalse(p.bankApps.isPolling)
    foreground += "com.phonepe.app"
    time.advance(30_000)
    assertEquals(0, foregroundQueries)

    // P2: no timer.
    assertFalse(p.whatsAppCalls.onCallNotification("k", false))
    time.advance(60 * 60_000)

    // P3: .apk ignored.
    assertFalse(p.apk.onSignals("k", NotificationSignals.from("com.whatsapp", listOf("x.apk"), null, false, emptyList())!!))

    // Installed apps: nothing.
    assertTrue(p.installed.scan(listOf(InstalledApp("com.anydesk.anydeskandroid", null, time.now, false))).isEmpty())

    // Simulate buttons also respect the switch.
    Feature.entries.forEach { assertEquals(it.id, "off", p.simulate(it)) }

    assertEquals(0, alerts.pauses)
    assertTrue(alerts.warnings.isEmpty())
    assertTrue(sent.isEmpty())
    assertEquals(0, time.active)
  }

  @Test fun turningOneSwitchOnLeavesTheOthersOff() {
    val sw = FeatureSwitches()
    sw.set(Feature.P3_APK, true)
    val p = shield(sw)
    assertTrue(p.apk.onSignals("k", NotificationSignals.from("com.whatsapp", listOf("x.apk"), null, false, emptyList())!!))
    assertFalse(p.whatsAppCalls.onCallNotification("c", false))
    assertTrue(p.installed.scan(listOf(InstalledApp("com.anydesk.anydeskandroid", null, time.now, false))).isEmpty())
    assertEquals(1, sent.size)
  }

  @Test fun p8_switchOffClearsKeptNumbers() {
    val sw = allOn()
    val p = shield(sw)
    p.onFlaggedSms(scamSms.copy(receivedAtMs = time.now), red)
    assertEquals(3, p.numbers.size(time.now))
    sw.set(Feature.P8_PAUSE_CALL, false)
    assertEquals(0, p.numbers.size(time.now))
  }

  @Test fun switchesPersistAndDefaultOff() {
    val f = File(tmp.newFolder(), "features.properties")
    val a = FeatureSwitches(f)
    assertEquals(false, a.snapshot()["p8_pause_call"])
    assertEquals(1, a.demoScale)
    a.set(Feature.P8_PAUSE_CALL, true)
    a.set(Feature.P2_VIDEO_CALL, true)
    a.setDemoScale(20)
    val b = FeatureSwitches(f)
    assertTrue(b.isOn(Feature.P8_PAUSE_CALL))
    assertTrue(b.isOn(Feature.P2_VIDEO_CALL))
    assertFalse(b.isOn(Feature.P9_BANK_APP))
    assertEquals(20, b.demoScale)
    b.setDemoScale(0)
    assertEquals(1, b.demoScale) // clamped
    assertNull(Feature.byId("nope"))
    assertEquals(Feature.P3_APK, Feature.byId("p3_apk"))
  }

  // ---------------- simulate buttons ----------------

  @Test fun simulateRunsTheSameCodePath() {
    val sw = allOn(); sw.setDemoScale(20)
    val p = shield(sw)
    assertEquals("paused", p.simulate(Feature.P8_PAUSE_CALL))
    assertEquals(1, alerts.pauses)
    alerts.pause!!.second()
    assertEquals("call_out", sent.last().kind)
    assertEquals(true, sent.last().ctx["simulated"])

    assertEquals("fired", p.simulate(Feature.P9_BANK_APP))
    assertEquals("app_open", sent.last().kind)
    assertFalse(p.bankApps.isPolling) // the fake call ended

    assertEquals("timer_started_30s", p.simulate(Feature.P2_VIDEO_CALL))
    time.advance(30_000)
    assertEquals("pattern.P2", sent.last().rule)

    assertEquals("fired", p.simulate(Feature.P3_APK))
    assertEquals("pattern.P3", sent.last().rule)

    assertEquals("flags_2", p.simulate(Feature.INSTALLED_APPS))
    assertEquals(listOf("install", "install"), sent.takeLast(2).map { it.kind })
    // Simulated flags are not remembered, so the button works again.
    assertEquals("flags_2", p.simulate(Feature.INSTALLED_APPS))

    val id = EventIdentity("f", "p", "d")
    sent.forEach { s -> assertNoNumbers(EventFactory.fromSignal(s.kind, s.rule, s.ctx, id, "7d0b8d52-3a43-4d6e-9d0a-111122223333", time.now).toJson()) }
  }

  @Test fun signalEventMasksStrayDigitsAndRejectsOtherKinds() {
    val e = EventFactory.fromSignal("install", "pattern.P3", mapOf("package" to "com.scam9876543210", "n" to 3), EventIdentity("f", "p", null), "7d0b8d52-3a43-4d6e-9d0a-111122223333", 0)
    assertEquals("com.scam[num]", e.context["package"])
    assertEquals(3, e.context["n"])
    assertTrue(runCatching { EventFactory.fromSignal("sms", "x", emptyMap(), EventIdentity("f", "p", null), "7d0b8d52-3a43-4d6e-9d0a-111122223333", 0) }.isFailure)
  }

  @Test fun phoneNumberExtraction() {
    assertEquals(listOf("7012345678", "9123456789"), PhoneNumbers.extract("call 70123-45678 or +91 (912) 345 6789, OTP 482913, Rs 5,000"))
    assertNull(PhoneNumbers.hashOf("121"))
    assertNull(PhoneNumbers.hashOf("*99#"))
    assertEquals(PhoneNumbers.hashOf("09123456789"), PhoneNumbers.hashOf("+919123456789"))
  }

  private fun assertNoNumbers(json: String) {
    // first_install_ms is a timestamp the card asks for (install events); it is not a phone number.
    val stripped = json
      .replace(Regex("\"idempotency_key\":\"[^\"]*\""), "")
      .replace(Regex("\"occurred_at\":\"[^\"]*\""), "")
      .replace(Regex("\"first_install_ms\":[0-9]+"), "")
    assertFalse(json, Masker.hasLongDigitRun(stripped))
    assertFalse(json, stripped.contains(Phase2Shield.SIM_NUMBER))
  }
}
