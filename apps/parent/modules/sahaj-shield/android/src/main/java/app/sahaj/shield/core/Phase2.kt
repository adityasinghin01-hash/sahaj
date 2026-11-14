package app.sahaj.shield.core

/**
 * Phase 2 (Core 3 Steps 2.1, 2.2, 2.3, 3.2). Pure logic; Android pieces come in through the
 * interfaces below. Every feature checks its [FeatureSwitches] entry first and does nothing when off.
 * Only signals leave the phone (rule id, yes/no facts, package names, durations): never a phone
 * number, never message or notification text.
 */

/** The fixed Hindi lines from the build file §2.1 (Roman for the screen, Devanagari for TTS). */
enum class Warning(val ruleId: String, val text: String, val speech: String) {
  /** Line 3 (P8 pause screen). */
  P8_PAUSE(
    "pattern.P8",
    "Ruk jaiye. Ye number ek fraud message se aaya tha. Phir bhi call karna hai toh hara button dabaiye.",
    "रुक जाइए। ये नंबर एक फ्रॉड मैसेज से आया था। फिर भी कॉल करना है तो हरा बटन दबाइए।",
  ),
  /** P9 (Step 2.2). */
  P9_BANK_APP(
    "pattern.P9",
    "Call par koi paise bhejne ko keh raha hai? Ruk jaiye.",
    "कॉल पर कोई पैसे भेजने को कह रहा है? रुक जाइए।",
  ),
  /** Line 4 (P2). "Riya" is replaced with the paired child's name on the phone. */
  P2_VIDEO_CALL(
    "pattern.P2",
    "Police kabhi video call par arrest nahi karti. Phone kaat dijiye. Riya aapko abhi call karegi.",
    "पुलिस कभी वीडियो कॉल पर अरेस्ट नहीं करती। फ़ोन काट दीजिए। Riya आपको अभी कॉल करेगी।",
  ),
  /** Line 5 (P3 .apk in WhatsApp). */
  P3_APK(
    "pattern.P3",
    "Ye file mat kholiye. Ye fraud ho sakti hai.",
    "ये फ़ाइल मत खोलिए। ये फ्रॉड हो सकती है।",
  ),
  /** Line 5 (installed-app scan: P4 remote control / P3 outside Play Store). */
  INSTALLED_APP(
    "pattern.P4",
    "Ye file mat kholiye. Ye fraud ho sakti hai.",
    "ये फ़ाइल मत खोलिए। ये फ्रॉड हो सकती है।",
  ),
}

/** Red screens for Phase 2. Implemented by AlertController on the phone. */
interface Phase2Alerts {
  /**
   * P8 pause screen (line 3) with [Phir bhi call karo] → [onCallAnyway] and [Mat karo] → [onDontCall].
   * At most one of the two is called.
   */
  fun showCallPause(onCallAnyway: () -> Unit, onDontCall: () -> Unit)

  /** Red screen with [warning]. [callActive] = a SIM call is on, so the spoken line waits until it ends. */
  fun showWarning(warning: Warning, callActive: Boolean)
}

/** Queues one masked signal event (kind ∈ ShieldEventKind). Does nothing if the phone is not paired. */
fun interface SignalEventSink {
  fun enqueue(kind: String, ruleId: String, context: Map<String, Any>)
}

fun interface Cancellable { fun cancel() }

interface Scheduler {
  fun schedule(delayMs: Long, task: () -> Unit): Cancellable
  fun every(periodMs: Long, task: () -> Unit): Cancellable
}

/** P9: packages that came to the foreground since [sinceMs] (UsageStatsManager on the phone). */
fun interface ForegroundSource {
  fun packagesSince(sinceMs: Long): List<String>
}

/**
 * Package lists. rules.json v1.0.0 has no package lists, so they live here for now
 * (listed in .cards/K-A5.report.md so they can move into rules.json).
 */
object AppLists {
  /** P9: banking / UPI apps. */
  val BANKING_UPI = setOf(
    "com.google.android.apps.nbu.paisa.user", // Google Pay
    "com.phonepe.app", // PhonePe
    "net.one97.paytm", // Paytm
    "in.org.npci.upiapp", // BHIM
    "com.sbi.lotusintouch", // YONO SBI
    "com.sbi.SBIFreedomPlus", // YONO Lite SBI
    "com.sbi.upi", // BHIM SBI Pay
    "com.snapwork.hdfc", // HDFC Bank
    "com.csam.icici.bank.imobile", // ICICI iMobile
    "com.axis.mobile", // Axis Mobile
    "com.msf.kbank.mobile", // Kotak
    "com.bankofbaroda.mconnect", // Bank of Baroda bob World
    "com.Version1", // PNB ONE
    "com.canarabank.mobility", // Canara ai1
    "com.mobikwik_new", // MobiKwik
    "com.freecharge.android", // Freecharge
    "com.dreamplug.androidapp", // CRED
  )

  /** P4: remote-control apps. Also written into <queries> by app.plugin.js so they are visible on Android 11+. */
  val REMOTE_CONTROL = setOf(
    "com.anydesk.anydeskandroid", // AnyDesk
    "com.teamviewer.quicksupport.market", // TeamViewer QuickSupport
    "com.teamviewer.host.market", // TeamViewer Host
    "com.teamviewer.teamviewer.market.mobile", // TeamViewer Remote Control
    "com.carriez.flutter_hbb", // RustDesk
    "com.sand.airdroid", // AirDroid
    "com.sand.airdroidbiz", // AirDroid Business
    "com.sand.airmirror", // AirMirror (AirDroid remote control)
  )

  /** P3: the only installer that counts as the Play Store. */
  val PLAY_STORE_INSTALLERS = setOf("com.android.vending")
}

/** P8 (Step 2.1): decides what ShieldCallRedirectionService does with one outgoing call. */
class OutgoingCallGuard(
  private val switches: FeatureSwitches,
  private val numbers: FlaggedNumberStore,
  private val alerts: Phase2Alerts,
  private val events: SignalEventSink,
  private val clock: () -> Long,
) {
  enum class Decision { PLACE_UNMODIFIED, PAUSED }

  /**
   * [number] is the dialled number (memory only). [replace] re-places the same call unmodified.
   * PAUSED → the service must call cancelCall(); the pause screen is already requested.
   */
  fun onOutgoingCall(number: String, replace: () -> Unit, simulated: Boolean = false): Decision {
    if (!switches.isOn(Feature.P8_PAUSE_CALL)) return Decision.PLACE_UNMODIFIED
    val now = clock()
    if (numbers.consumeAllowOnce(number, now)) return Decision.PLACE_UNMODIFIED
    if (!numbers.containsNumber(number, now)) return Decision.PLACE_UNMODIFIED
    alerts.showCallPause(
      onCallAnyway = {
        numbers.allowOnce(number, clock())
        replace()
      },
      onDontCall = {
        events.enqueue("call_out", Warning.P8_PAUSE.ruleId, signalContext(simulated, "paused" to true, "user_choice" to "did_not_call"))
      },
    )
    return Decision.PAUSED
  }
}

/** P9 (Step 2.2): polls the foreground app every 2 s while a call with an unsaved number is active. */
class BankAppWatch(
  private val switches: FeatureSwitches,
  private val alerts: Phase2Alerts,
  private val events: SignalEventSink,
  private val scheduler: Scheduler,
  private val foreground: ForegroundSource,
  private val currentCall: () -> CallStateTracker.Snapshot,
  private val clock: () -> Long,
  private val packages: Set<String> = AppLists.BANKING_UPI,
) {
  private val lock = Any()
  private var poll: Cancellable? = null
  private var sinceMs = 0L
  private var firedThisCall = false

  val isPolling: Boolean get() = synchronized(lock) { poll != null }

  /** Called on every call-state change and when the switch changes. */
  fun onCallState(s: CallStateTracker.Snapshot) = synchronized(lock) {
    val shouldPoll = switches.isOn(Feature.P9_BANK_APP) && s.callActive && s.onCallWithUnsaved
    if (shouldPoll && poll == null) {
      sinceMs = s.callStartedAtMs?.coerceAtMost(clock()) ?: clock()
      firedThisCall = false
      poll = scheduler.every(POLL_MS) { tick() }
    } else if (!shouldPoll && poll != null) {
      stopLocked()
    }
  }

  fun refresh() = onCallState(currentCall())

  /** One poll. Public for the simulate button and tests. */
  fun tick(override: List<String>? = null) {
    val start: Long
    synchronized(lock) {
      if (poll == null && override == null) return
      if (!switches.isOn(Feature.P9_BANK_APP)) { stopLocked(); return }
      if (firedThisCall) return
      start = sinceMs
    }
    val now = clock()
    val pkgs = override ?: runCatching { foreground.packagesSince(start) }.getOrDefault(emptyList())
    val hit: String = pkgs.firstOrNull { it in packages } ?: run { synchronized(lock) { sinceMs = now }; return }
    synchronized(lock) {
      sinceMs = now
      if (firedThisCall) return
      firedThisCall = true
    }
    alerts.showWarning(Warning.P9_BANK_APP, callActive = true)
    events.enqueue("app_open", Warning.P9_BANK_APP.ruleId, signalContext(override != null, "package" to hit, "on_call_with_unsaved" to true))
  }

  /** Simulate button: an unsaved call starts, a UPI app opens, the call ends — same code path. */
  fun simulate(): String {
    if (!switches.isOn(Feature.P9_BANK_APP)) return "off"
    try {
      onCallState(CallStateTracker.Snapshot(callActive = true, onCallWithUnsaved = true, callStartedAtMs = clock()))
      tick(override = listOf("com.phonepe.app"))
    } finally {
      onCallState(CallStateTracker.Snapshot(callActive = false, onCallWithUnsaved = false, callStartedAtMs = null))
      refresh() // back to the real call state
    }
    return "fired"
  }

  private fun stopLocked() {
    poll?.cancel()
    poll = null
  }

  companion object {
    const val POLL_MS = 2_000L
  }
}

/**
 * P2 (Step 2.3): an ongoing WhatsApp call notification whose title is not a saved contact,
 * still there after 10 min (divided by demoScale) → red + line 4.
 */
class WhatsAppCallWatch(
  private val switches: FeatureSwitches,
  private val alerts: Phase2Alerts,
  private val events: SignalEventSink,
  private val scheduler: Scheduler,
  private val clock: () -> Long,
) {
  private class Tracked(val startedAtMs: Long, val timer: Cancellable, val simulated: Boolean)

  private val lock = Any()
  private val tracked = HashMap<String, Tracked>()
  private val fired = HashSet<String>()

  fun thresholdMs(): Long = BASE_THRESHOLD_MS / switches.demoScale.coerceAtLeast(1)

  val trackedCount: Int get() = synchronized(lock) { tracked.size }

  /**
   * [key]: StatusBarNotification.key. [titleIsSavedContact]: null = unknown (treated as unsaved).
   * Called every time WhatsApp posts/updates the call notification; only the first sighting starts the timer.
   */
  fun onCallNotification(key: String, titleIsSavedContact: Boolean?, simulated: Boolean = false): Boolean = synchronized(lock) {
    if (!switches.isOn(Feature.P2_VIDEO_CALL)) return false
    if (titleIsSavedContact == true || key in tracked || key in fired) return false
    val delay = thresholdMs()
    val t = scheduler.schedule(delay) { fire(key) }
    tracked[key] = Tracked(clock(), t, simulated)
    true
  }

  /** The call notification went away: the call ended (or was hidden). */
  fun onNotificationRemoved(key: String) = synchronized(lock) {
    tracked.remove(key)?.timer?.cancel()
    fired.remove(key)
    Unit
  }

  fun stopAll() = synchronized(lock) {
    tracked.values.forEach { it.timer.cancel() }
    tracked.clear()
  }

  private fun fire(key: String) {
    val t: Tracked
    synchronized(lock) {
      t = tracked.remove(key) ?: return
      if (!switches.isOn(Feature.P2_VIDEO_CALL)) return
      if (!t.simulated) fired.add(key)
    }
    val seconds = ((clock() - t.startedAtMs) / 1000).toInt()
    alerts.showWarning(Warning.P2_VIDEO_CALL, callActive = false)
    events.enqueue(
      "notification", Warning.P2_VIDEO_CALL.ruleId,
      signalContext(t.simulated, "source" to "whatsapp", "whatsapp_call_unsaved" to true, "call_seconds" to seconds, "demo_scale" to switches.demoScale),
    )
  }

  companion object {
    const val BASE_THRESHOLD_MS = 10L * 60 * 1000
  }
}

/** P3 (Step 2.3): a WhatsApp notification whose attachment / document name ends in .apk → red + line 5. */
class ApkWatch(
  private val switches: FeatureSwitches,
  private val alerts: Phase2Alerts,
  private val events: SignalEventSink,
  private val clock: () -> Long,
) {
  private val lock = Any()
  /** notification key → last time we warned, so WhatsApp re-posting the same chat does not repeat the alarm. */
  private val lastFired = HashMap<String, Long>()

  fun onSignals(key: String, signals: NotificationSignals, simulated: Boolean = false): Boolean {
    if (!switches.isOn(Feature.P3_APK) || !signals.apkAttachment) return false
    val now = clock()
    synchronized(lock) {
      val last = lastFired[key]
      if (last != null && now - last < REPEAT_MS) return false
      lastFired.entries.removeAll { now - it.value >= REPEAT_MS }
      lastFired[key] = now
    }
    alerts.showWarning(Warning.P3_APK, callActive = false)
    events.enqueue("notification", Warning.P3_APK.ruleId, signalContext(simulated, "source" to "whatsapp", "attachment_apk" to true))
    return true
  }

  companion object {
    const val REPEAT_MS = 10L * 60 * 1000
  }
}

/** One installed package, as read from PackageManager. */
data class InstalledApp(
  val packageName: String,
  /** Install source (getInstallSourceInfo / getInstallerPackageName); null = unknown, e.g. adb. */
  val installer: String?,
  val firstInstallMs: Long,
  val isSystem: Boolean,
)

data class AppFlag(val packageName: String, val reason: String, val ruleId: String, val installer: String?)

/** Remembers which (package, reason) pairs were already flagged so each one alerts once. */
interface FlaggedAppStore {
  fun contains(id: String): Boolean
  fun add(id: String)
}

class FileFlaggedAppStore(private val file: java.io.File? = null) : FlaggedAppStore {
  private val ids = HashSet<String>()
  init { file?.takeIf { it.exists() }?.let { f -> runCatching { ids.addAll(f.readLines().filter { it.isNotBlank() }) } } }
  @Synchronized override fun contains(id: String) = id in ids
  @Synchronized override fun add(id: String) {
    if (!ids.add(id)) return
    val f = file ?: return
    f.parentFile?.mkdirs()
    f.writeText(ids.sorted().joinToString("\n", postfix = "\n"))
  }
}

/** Step 3.2: installed-app scan (on app start + every 6 h). */
class InstalledAppWatch(
  private val switches: FeatureSwitches,
  private val alerts: Phase2Alerts,
  private val events: SignalEventSink,
  private val flagged: FlaggedAppStore,
  private val selfPackage: String,
  private val clock: () -> Long,
) {
  /** Pure check, no side effects. */
  fun evaluate(apps: List<InstalledApp>): List<AppFlag> {
    val now = clock()
    val out = mutableListOf<AppFlag>()
    for (a in apps) {
      if (a.packageName == selfPackage) continue
      if (a.packageName in AppLists.REMOTE_CONTROL) {
        out += AppFlag(a.packageName, REASON_REMOTE, "pattern.P4", a.installer)
        continue
      }
      val recent = now - a.firstInstallMs in 0..RECENT_MS
      if (!a.isSystem && recent && a.installer !in AppLists.PLAY_STORE_INSTALLERS) {
        out += AppFlag(a.packageName, REASON_OUTSIDE_PLAY, "pattern.P3", a.installer)
      }
    }
    return out
  }

  /** Alerts once for any NEW flag (one red screen, one event per flag). Returns the new flags. */
  fun scan(apps: List<InstalledApp>, simulated: Boolean = false): List<AppFlag> {
    if (!switches.isOn(Feature.INSTALLED_APPS)) return emptyList()
    val fresh = evaluate(apps).filter { simulated || !flagged.contains(it.id()) }
    if (fresh.isEmpty()) return fresh
    if (!simulated) fresh.forEach { flagged.add(it.id()) }
    alerts.showWarning(Warning.INSTALLED_APP, callActive = false)
    for (f in fresh) {
      val app = apps.first { it.packageName == f.packageName }
      val hours = ((clock() - app.firstInstallMs) / 3_600_000L).coerceAtLeast(0).toInt()
      events.enqueue(
        "install", f.ruleId,
        signalContext(simulated, "package" to f.packageName, "reason" to f.reason, "installer" to (f.installer ?: "unknown"), "installed_hours_ago" to hours),
      )
    }
    return fresh
  }

  private fun AppFlag.id() = "$packageName|$reason"

  companion object {
    const val RECENT_MS = 24L * 60 * 60 * 1000
    const val REASON_REMOTE = "remote_control"
    const val REASON_OUTSIDE_PLAY = "outside_play_store"
  }
}

/** Ties the Phase 2 pieces together. One per process (ShieldRuntime) or per test. */
class Phase2Shield(
  val switches: FeatureSwitches,
  val numbers: FlaggedNumberStore,
  alerts: Phase2Alerts,
  events: SignalEventSink,
  scheduler: Scheduler,
  foreground: ForegroundSource,
  currentCall: () -> CallStateTracker.Snapshot,
  flaggedApps: FlaggedAppStore,
  selfPackage: String,
  private val clock: () -> Long = System::currentTimeMillis,
) {
  val outgoing = OutgoingCallGuard(switches, numbers, alerts, events, clock)
  val bankApps = BankAppWatch(switches, alerts, events, scheduler, foreground, currentCall, clock)
  val whatsAppCalls = WhatsAppCallWatch(switches, alerts, events, scheduler, clock)
  val apk = ApkWatch(switches, alerts, events, clock)
  val installed = InstalledAppWatch(switches, alerts, events, flaggedApps, selfPackage, clock)

  init {
    switches.addListener { f, on ->
      when (f) {
        Feature.P8_PAUSE_CALL -> if (!on) numbers.clear()
        Feature.P9_BANK_APP -> bankApps.refresh()
        Feature.P2_VIDEO_CALL -> if (!on) whatsAppCalls.stopAll()
        else -> Unit
      }
    }
  }

  /** From ShieldPipeline for every YELLOW/RED SMS. Nothing is kept when P8 is off. */
  fun onFlaggedSms(input: SmsInput, verdict: LocalVerdict) {
    if (verdict.level == LocalLevel.GREEN || !switches.isOn(Feature.P8_PAUSE_CALL)) return
    numbers.recordFromSms(input.sender, input.body, input.receivedAtMs)
  }

  fun onCallState(s: CallStateTracker.Snapshot) = bankApps.onCallState(s)

  /**
   * Test-screen "simulate" button: feeds fake signals through the same code path as the real
   * service. Returns a short status string ("off" when the switch is off).
   */
  fun simulate(feature: Feature, log: (String) -> Unit = {}): String {
    if (!switches.isOn(feature)) return "off"
    return when (feature) {
      Feature.P8_PAUSE_CALL -> {
        onFlaggedSms(
          SmsInput(SIM_NUMBER, "Aapka bijli connection aaj kata jayega. Turant $SIM_NUMBER par call karein.", clock()),
          LocalVerdict(LocalLevel.RED, emptyList(), listOf("simulated"), "", "mobile_10", emptyList()),
        )
        val d = outgoing.onOutgoingCall(SIM_NUMBER, replace = { log("P8 simulate: would re-place the call unmodified") }, simulated = true)
        if (d == OutgoingCallGuard.Decision.PAUSED) "paused" else "placed_unmodified"
      }
      Feature.P9_BANK_APP -> bankApps.simulate()
      Feature.P2_VIDEO_CALL -> {
        val key = "simulated:p2:${clock()}"
        if (whatsAppCalls.onCallNotification(key, titleIsSavedContact = false, simulated = true)) {
          "timer_started_${whatsAppCalls.thresholdMs() / 1000}s"
        } else "not_started"
      }
      Feature.P3_APK -> {
        val s = NotificationSignals.from("com.whatsapp", listOf("📄 shaadi_card.apk"), null, false, emptyList())!!
        if (apk.onSignals("simulated:p3:${clock()}", s, simulated = true)) "fired" else "not_fired"
      }
      Feature.INSTALLED_APPS -> {
        val now = clock()
        val fake = listOf(
          InstalledApp("com.anydesk.anydeskandroid", "com.android.vending", now - 30L * 86_400_000L, false),
          InstalledApp("com.example.shaadicard", "com.google.android.packageinstaller", now - 3_600_000L, false),
        )
        "flags_${installed.scan(fake, simulated = true).size}"
      }
    }
  }

  companion object {
    /** Fake number used only by the P8 simulate button. Never dialled (simulate's replace() only logs). */
    const val SIM_NUMBER = "9000000000"
  }
}

/** Context map for a signal event. Strings are masked again by EventFactory. */
internal fun signalContext(simulated: Boolean, vararg pairs: Pair<String, Any>): Map<String, Any> {
  val m = linkedMapOf<String, Any>()
  pairs.forEach { m[it.first] = it.second }
  if (simulated) m["simulated"] = true
  return m
}
