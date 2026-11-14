package app.sahaj.shield.core

/**
 * In-memory call state. Never stores a phone number, only "saved contact or not" and times.
 * Fed by the CallScreeningService (saved / unsaved for incoming calls) and by the
 * TelephonyCallback / PhoneStateListener (active / ended).
 */
class CallStateTracker(private val clock: () -> Long = System::currentTimeMillis) {
  enum class State { IDLE, RINGING, OFFHOOK }

  data class Snapshot(
    val callActive: Boolean,
    val onCallWithUnsaved: Boolean,
    val callStartedAtMs: Long?,
    /** CallerType of the current call (computed in memory from the number at screening; never the number). */
    val callerType: String? = null,
    /** True once the call is connected (OFFHOOK). [callStartedAtMs] is then the time it connected. */
    val answered: Boolean = false,
  )

  /** One finished call. No number: only saved/unsaved, caller type, direction and times. */
  data class CallSummary(
    val unsaved: Boolean,
    val callerType: String?,
    /** true = incoming, false = she dialled it, null = unknown (no screening / redirection result). */
    val incoming: Boolean?,
    val answered: Boolean,
    val startedAtMs: Long,
    val endedAtMs: Long,
    val wasP1: Boolean,
  ) {
    /** Talk time (0 for a call that was never connected). */
    val durationMs: Long get() = if (answered) (endedAtMs - startedAtMs).coerceAtLeast(0) else 0L
  }

  fun interface Listener {
    /** [wasP1] = a P1 verdict (OTP SMS during an unsaved call) happened during this call. */
    fun onCallEnded(wasP1: Boolean)
  }

  private val lock = Any()
  private var state = State.IDLE
  private var lastScreenedUnsaved: Boolean? = null
  private var lastScreenedType: String? = null
  private var lastScreenedIncoming: Boolean? = null
  private var lastScreenedAtMs = 0L
  private var unsaved = false
  private var callerType: String? = null
  private var incoming: Boolean? = null
  private var answered = false
  private var startedAtMs: Long? = null
  private var p1 = false
  private var last: CallSummary? = null
  private val listeners = java.util.concurrent.CopyOnWriteArrayList<Listener>()
  private val changeListeners = java.util.concurrent.CopyOnWriteArrayList<(Snapshot) -> Unit>()
  private val endListeners = java.util.concurrent.CopyOnWriteArrayList<(CallSummary) -> Unit>()

  fun addListener(l: Listener) { listeners.add(l) }
  fun removeListener(l: Listener) { listeners.remove(l) }

  /** Phase 2 (P9): called after every call-state change with the new snapshot. */
  fun addChangeListener(l: (Snapshot) -> Unit) { changeListeners.add(l) }

  /** Phase 3 (P6, 1600 note, after-call answers): called once per finished call. */
  fun addEndListener(l: (CallSummary) -> Unit) { endListeners.add(l) }

  /** The last finished call (memory only), for the after-call screen. */
  fun lastCall(): CallSummary? = synchronized(lock) { last }

  /**
   * From the CallRedirectionService (P8/P9), just before an outgoing call starts. Uses the same
   * "next call is saved / unsaved" slot as incoming screening, so P9 also covers calls she dials.
   */
  fun onOutgoingDialled(isSavedContact: Boolean, callerType: String? = null) = note(isSavedContact, callerType, incoming = false)

  /** From CallScreeningService, before the phone rings. [callerType] is computed from the number in memory. */
  fun onIncomingScreened(isSavedContact: Boolean, callerType: String? = null) = note(isSavedContact, callerType, incoming = true)

  private fun note(isSavedContact: Boolean, type: String?, incoming: Boolean) {
    val duringCall = synchronized(lock) {
      lastScreenedUnsaved = !isSavedContact
      lastScreenedType = type
      lastScreenedIncoming = incoming
      lastScreenedAtMs = clock()
      if (state != State.IDLE) {
        unsaved = unsaved || !isSavedContact // call waiting
        if (!isSavedContact && type != null) callerType = type
      }
      state != State.IDLE
    }
    if (duringCall) { val snap = snapshot(); changeListeners.forEach { runCatching { it(snap) } } }
  }

  fun onCallState(newState: State) {
    var ended = false
    var wasP1 = false
    var summary: CallSummary? = null
    synchronized(lock) {
      val now = clock()
      when (newState) {
        State.RINGING, State.OFFHOOK -> {
          if (state == State.IDLE) {
            startedAtMs = now
            // Only trust a screening result from this call (screening happens just before ringing).
            val fresh = now - lastScreenedAtMs < SCREEN_MATCH_WINDOW_MS
            unsaved = lastScreenedUnsaved == true && fresh
            callerType = if (fresh) lastScreenedType else null
            incoming = if (fresh) lastScreenedIncoming else null
            answered = newState == State.OFFHOOK
            p1 = false
          }
          if (newState == State.OFFHOOK && state == State.RINGING) { startedAtMs = now; answered = true }
        }
        State.IDLE -> if (state != State.IDLE) {
          ended = true
          wasP1 = p1
          summary = CallSummary(unsaved, callerType, incoming, answered, startedAtMs ?: now, now, p1)
          last = summary
          unsaved = false
          callerType = null
          incoming = null
          answered = false
          startedAtMs = null
          p1 = false
          lastScreenedUnsaved = null
          lastScreenedType = null
          lastScreenedIncoming = null
        }
      }
      state = newState
    }
    if (ended) listeners.forEach { it.onCallEnded(wasP1) }
    summary?.let { s -> endListeners.forEach { runCatching { it(s) } } }
    val snap = snapshot()
    changeListeners.forEach { runCatching { it(snap) } }
  }

  fun markP1() = synchronized(lock) { if (state != State.IDLE) p1 = true }

  fun snapshot(): Snapshot = synchronized(lock) {
    val active = state != State.IDLE
    Snapshot(active, active && unsaved, if (active) startedAtMs else null, if (active) callerType else null, active && answered)
  }

  companion object {
    const val SCREEN_MATCH_WINDOW_MS = 60_000L
  }
}
