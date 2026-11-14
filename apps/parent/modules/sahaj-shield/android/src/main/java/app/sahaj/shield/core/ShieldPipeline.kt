package app.sahaj.shield.core

/** Shows the red screen (or the fallback notification) and plays the clip. */
interface AlertSink {
  /** [callActive] = the clip must wait until the call ends; the overlay shows at once. */
  fun showRedScreen(verdict: LocalVerdict, callActive: Boolean)
}

/** Decides what to do with each SMS. Pure logic; Android pieces come in through interfaces. */
class ShieldPipeline(
  private val engine: () -> RulesEngine,
  private val calls: CallStateTracker,
  private val queue: FileEventQueue,
  private val alerts: AlertSink,
  private val identity: () -> EventIdentity?,
  private val kickSender: () -> Unit,
  private val onVerdict: (LocalVerdict) -> Unit = {},
  private val newKey: () -> String = { java.util.UUID.randomUUID().toString() },
  private val clock: () -> Long = System::currentTimeMillis,
) {
  enum class Outcome { GREEN_DROPPED, QUEUED, NOT_PAIRED }

  fun onSms(input: SmsInput, senderIsSavedContact: Boolean?): Outcome {
    val call = calls.snapshot()
    val ctx = PhoneContext(
      callActive = call.callActive,
      onCallWithUnsaved = call.onCallWithUnsaved,
      callStartedAtMs = call.callStartedAtMs,
      senderIsSavedContact = senderIsSavedContact,
    )
    val verdict = engine().check(input, ctx)
    onVerdict(verdict.copy(maskedText = Masker.mask(verdict.maskedText)))

    // GREEN: stop here. Nothing is stored and nothing leaves the phone.
    if (verdict.level == LocalLevel.GREEN) return Outcome.GREEN_DROPPED

    if (verdict.level == LocalLevel.RED) {
      if (ctx.onCallWithUnsaved && "P1" in verdict.matchedRules) calls.markP1()
      alerts.showRedScreen(verdict, call.callActive)
    }

    // Not paired yet: the red screen above still protects the parent, but there is nowhere to send.
    val id = identity() ?: return Outcome.NOT_PAIRED
    val event = EventFactory.fromSmsVerdict(verdict, ctx, id, newKey(), input.receivedAtMs)
    queue.enqueue(event.idempotencyKey, event.toJson(), clock())
    kickSender()
    return Outcome.QUEUED
  }
}
