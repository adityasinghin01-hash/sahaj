package app.sahaj.shield.core

import java.io.File

/**
 * Phase 3 call signals (Core 3 Step 3.3). Pure logic, like Phase2.kt.
 * Nothing here ever sees a phone number: only saved/unsaved, CallerType, direction and durations.
 */

/** Small, quiet notes after a call (no alarm). Implemented by Notifications on the phone. */
fun interface CallNotes {
  /** Incoming 1600-series caller: "Ye registered bank number tha". */
  fun registeredBankCall()
}

/**
 * P6: lengths of her last [max] answered calls with unsaved numbers, ON THE PHONE ONLY.
 * The file holds one number of milliseconds per line, nothing else. [file] = null keeps memory only.
 */
class CallLengthHistory(private val file: File? = null, private val max: Int = MAX_CALLS) {
  private val lock = Any()
  private val lengths = ArrayDeque<Long>()

  init {
    file?.takeIf { it.exists() }?.let { f ->
      runCatching { f.readLines().mapNotNull { it.trim().toLongOrNull() }.filter { it >= 0 }.takeLast(max).forEach { lengths.addLast(it) } }
    }
  }

  fun add(durationMs: Long) = synchronized(lock) {
    if (durationMs < 0) return@synchronized
    lengths.addLast(durationMs)
    while (lengths.size > max) lengths.removeFirst()
    save()
  }

  val size: Int get() = synchronized(lock) { lengths.size }

  /** Median of the stored lengths; null when there is no history yet. */
  fun median(): Long? = synchronized(lock) { median(lengths.toList()) }

  private fun save() {
    val f = file ?: return
    f.parentFile?.mkdirs()
    val tmp = File(f.parentFile, f.name + ".tmp")
    tmp.writeText(lengths.joinToString("") { "$it\n" })
    if (!tmp.renameTo(f)) { f.delete(); tmp.renameTo(f) }
  }

  companion object {
    const val MAX_CALLS = 20

    fun median(values: List<Long>): Long? {
      if (values.isEmpty()) return null
      val s = values.sorted()
      val mid = s.size / 2
      return if (s.size % 2 == 1) s[mid] else (s[mid - 1] + s[mid]) / 2
    }
  }
}

/**
 * P6 (Step 3.3): an answered call with an unsaved number that runs longer than
 * max(3 × her median unsaved-call length, 20 min) → one `call_state` event per call with
 * `context.duration_ms` and `context.long_vs_normal: true` (local level yellow; server rule P6 gives
 * Riya a quiet card). No red screen on the phone.
 * Also: an incoming 1600-series call → a quiet "registered bank number" note after it ends.
 */
class LongCallWatch(
  private val switches: FeatureSwitches,
  private val events: SignalEventSink,
  private val scheduler: Scheduler,
  private val history: CallLengthHistory,
  private val notes: CallNotes,
  private val clock: () -> Long,
) {
  private val lock = Any()
  private var timer: Cancellable? = null
  private var callStartMs: Long? = null
  private var callerType: String? = null
  private var thresholdForCall = 0L
  private var firedForStart: Long? = null

  /** Threshold for the next call (demo scale divides it, like P2). */
  fun thresholdMs(): Long = decide(history.median(), switches.demoScale)

  val isTiming: Boolean get() = synchronized(lock) { timer != null }

  /** Called on every call-state change. */
  fun onCallState(s: CallStateTracker.Snapshot) = synchronized(lock) {
    val watch = switches.isOn(Feature.P6_LONG_CALL) && s.callActive && s.onCallWithUnsaved && s.answered && s.callStartedAtMs != null
    if (!watch) {
      if (!s.callActive) stopLocked()
      return@synchronized
    }
    val start = s.callStartedAtMs!!
    if (callStartMs == start && timer != null) return@synchronized
    stopLocked()
    callStartMs = start
    callerType = s.callerType
    thresholdForCall = thresholdMs()
    val delay = (start + thresholdForCall - clock()).coerceAtLeast(0)
    timer = scheduler.schedule(delay) { fireDuring(start) }
  }

  fun onCallEnded(c: CallStateTracker.CallSummary) {
    var fireNow = false
    synchronized(lock) {
      val threshold = if (callStartMs == c.startedAtMs && thresholdForCall > 0) thresholdForCall else thresholdMs()
      stopLocked()
      if (switches.isOn(Feature.P6_LONG_CALL) && c.unsaved && c.answered) {
        // The timer can be missed (process restarted mid-call): decide again with the final length.
        if (firedForStart != c.startedAtMs && c.durationMs > threshold) {
          firedForStart = c.startedAtMs
          fireNow = true
        }
        history.add(c.durationMs)
      }
    }
    if (fireNow) send(c.durationMs, c.callerType, simulated = false)
    if (c.incoming == true && c.callerType == SERIES_1600) runCatching { notes.registeredBankCall() }
  }

  private fun fireDuring(start: Long) {
    val type: String?
    synchronized(lock) {
      if (callStartMs != start || firedForStart == start) return
      if (!switches.isOn(Feature.P6_LONG_CALL)) return
      firedForStart = start
      timer = null
      type = callerType
    }
    send(clock() - start, type, simulated = false)
  }

  private fun send(durationMs: Long, type: String?, simulated: Boolean) {
    val ctx = signalContext(simulated, "duration_ms" to durationMs, "long_vs_normal" to true, "demo_scale" to switches.demoScale)
    events.enqueue("call_state", RULE_ID, ctx, LocalLevel.YELLOW, type ?: "unknown")
  }

  private fun stopLocked() {
    timer?.cancel()
    timer = null
    callStartMs = null
    callerType = null
    thresholdForCall = 0L
  }

  /** Simulate button: sends the same event the timer sends, without touching her history. */
  fun simulate(): String {
    if (!switches.isOn(Feature.P6_LONG_CALL)) return "off"
    send(thresholdMs() + 1_000, "mobile_10", simulated = true)
    return "fired_${thresholdMs() / 1000}s"
  }

  companion object {
    const val RULE_ID = "pattern.P6"
    const val SERIES_1600 = "series_1600"
    const val FLOOR_MS = 20L * 60 * 1000
    const val MULTIPLIER = 3L

    /** max(3 × median, 20 min) ÷ demoScale. No history yet → 20 min. */
    fun decide(medianMs: Long?, demoScale: Int = 1): Long =
      maxOf(MULTIPLIER * (medianMs ?: 0L), FLOOR_MS) / demoScale.coerceAtLeast(1)

    /** Pure long-call decision for tests and the end-of-call check. */
    fun isLong(durationMs: Long, medianMs: Long?, demoScale: Int = 1): Boolean = durationMs > decide(medianMs, demoScale)
  }
}

/**
 * After-call answers (Step 3.3). Maa taps one big button on the after-call screen:
 * - "Haan, OTP bataya" → `voice_report` with `context.otp_shared: true` (red).
 * - "Bank se bola tha" → `voice_report` with `context.claimed_bank: true` and the caller type of the
 *   last call (server rule P7: bank claim + not 1600 = yellow).
 * - "Nahi" → nothing leaves the phone.
 */
class AfterCallReporter(
  private val events: SignalEventSink,
  private val lastCall: () -> CallStateTracker.CallSummary?,
) {
  enum class Answer(val id: String) {
    OTP_SHARED("otp_shared"), CLAIMED_BANK("claimed_bank"), NO("no");
    companion object { fun byId(id: String) = entries.firstOrNull { it.id == id } }
  }

  /** CallerType of the last call ("unknown" when we have none). */
  fun lastCallerType(): String {
    val c = lastCall() ?: return "unknown"
    if (!c.unsaved) return "saved_contact"
    return c.callerType?.takeIf { it in ShieldConfig.CALLER_TYPES } ?: "unknown"
  }

  /** Returns "sent" when an event was handed to the sink, "nothing_sent" for "no". */
  fun report(answer: Answer): String {
    val type = lastCallerType()
    return when (answer) {
      Answer.OTP_SHARED -> {
        events.enqueue("voice_report", "pattern.P1", signalContext(false, "otp_shared" to true, "source" to "after_call", "caller_type" to type), LocalLevel.RED, type)
        "sent"
      }
      Answer.CLAIMED_BANK -> {
        val level = if (type == LongCallWatch.SERIES_1600) LocalLevel.GREEN else LocalLevel.YELLOW
        events.enqueue("voice_report", "pattern.P7", signalContext(false, "claimed_bank" to true, "source" to "after_call", "caller_type" to type), level, type)
        "sent"
      }
      Answer.NO -> "nothing_sent"
    }
  }
}
