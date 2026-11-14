package app.sahaj.shield.core

/**
 * Kotlin mirror of ShieldEvent in packages/shared/src/shield.ts (v1).
 * Only masked data goes in here. [toJson] gives the exact bytes that are signed and sent.
 */
data class ShieldEvent(
  val idempotencyKey: String,
  val familyId: String,
  val parentId: String,
  val deviceId: String?,
  val channel: String,
  val kind: String,
  val occurredAt: String,
  val maskedText: String?,
  val senderType: String?,
  val linkDomains: List<String>,
  val matchedRules: List<String>,
  val localLevel: String?,
  /** Strings, numbers or booleans only, never phone numbers. */
  val context: Map<String, Any>,
  /** CallerType (shield.ts), Phase 3 call events only. Never the number. */
  val callerType: String? = null,
) {
  fun toJson(): String {
    val w = Json.ObjectWriter()
    w.put("idempotency_key", idempotencyKey)
    w.put("family_id", familyId)
    w.put("parent_id", parentId)
    if (deviceId != null) w.put("device_id", deviceId)
    w.put("channel", channel)
    w.put("kind", kind)
    w.put("occurred_at", occurredAt)
    if (maskedText != null) w.put("masked_text", maskedText)
    if (senderType != null) w.put("sender_type", senderType)
    if (callerType != null) w.put("caller_type", callerType)
    w.putStrings("link_domains", linkDomains)
    w.putStrings("matched_rules", matchedRules)
    if (localLevel != null) w.put("local_level", localLevel)
    w.putFlat("context", context)
    return w.finish()
  }

  companion object {
    /** SenderType enum in shield.ts. Anything else from the engine becomes "unknown". */
    val SENDER_TYPES = setOf("business_header", "mobile_10", "international", "short_code", "saved_contact", "unknown")
  }
}

/** Identity fields that come from pairing, not from the SMS. */
data class EventIdentity(
  val familyId: String,
  val parentId: String,
  val deviceId: String?,
)

object EventFactory {
  /**
   * Builds the outgoing event from a YELLOW/RED verdict. Every free-text field is re-masked
   * here, whatever the rules engine returned. The raw sender and body are never used.
   */
  fun fromSmsVerdict(
    verdict: LocalVerdict,
    ctx: PhoneContext,
    identity: EventIdentity,
    idempotencyKey: String,
    occurredAtMs: Long,
  ): ShieldEvent {
    val context = linkedMapOf<String, Any>(
      "on_call_with_unsaved" to ctx.onCallWithUnsaved,
      "call_active" to ctx.callActive,
    )
    if (ctx.onCallWithUnsaved && ctx.callStartedAtMs != null) {
      context["call_started_at"] = IsoTime.format(ctx.callStartedAtMs)
    }
    return ShieldEvent(
      idempotencyKey = idempotencyKey,
      familyId = identity.familyId,
      parentId = identity.parentId,
      deviceId = identity.deviceId,
      channel = "device",
      kind = "sms",
      occurredAt = IsoTime.format(occurredAtMs),
      maskedText = Masker.mask(verdict.maskedText),
      senderType = verdict.senderType.takeIf { it in ShieldEvent.SENDER_TYPES } ?: "unknown",
      linkDomains = verdict.linkDomains.map { Masker.mask(it).take(253) }.distinct().take(20),
      matchedRules = verdict.matchedRules.map { Masker.mask(it).take(64) }.distinct().take(50),
      localLevel = verdict.level.wire,
      context = context,
    )
  }
}

/**
 * Phase 2/3 signal events (call_out, call_state, app_open, notification, install, voice_report). No masked_text and no sender:
 * only the rule id, the level and a flat context of yes/no facts, package names and durations.
 * Every string value is masked again, so a stray 4+ digit run can never leave the phone.
 */
fun EventFactory.fromSignal(
  kind: String,
  ruleId: String,
  context: Map<String, Any>,
  identity: EventIdentity,
  idempotencyKey: String,
  occurredAtMs: Long,
  level: LocalLevel = LocalLevel.RED,
  callerType: String? = null,
): ShieldEvent {
  require(kind in SIGNAL_KINDS) { "unsupported signal kind" }
  val safe = linkedMapOf<String, Any>()
  for ((k, v) in context) {
    safe[Masker.mask(k).take(64)] = when (v) {
      is Boolean, is Int, is Long -> v
      is Number -> v.toDouble()
      else -> Masker.mask(v.toString()).take(200)
    }
  }
  return ShieldEvent(
    idempotencyKey = idempotencyKey,
    familyId = identity.familyId,
    parentId = identity.parentId,
    deviceId = identity.deviceId,
    channel = "device",
    kind = kind,
    occurredAt = IsoTime.format(occurredAtMs),
    maskedText = null,
    senderType = null,
    linkDomains = emptyList(),
    matchedRules = listOf(Masker.mask(ruleId).take(64)),
    localLevel = level.wire,
    context = safe,
    callerType = callerType?.takeIf { it in ShieldConfig.CALLER_TYPES },
  )
}

/** ShieldEventKind values (packages/shared/src/shield.ts) that Phase 2/3 signals send. */
val SIGNAL_KINDS = setOf("call_out", "call_state", "app_open", "notification", "install", "voice_report")

object IsoTime {
  /** UTC ISO-8601 with milliseconds, accepted by z.string().datetime(). */
  // SimpleDateFormat instead of java.time so it works below API 26 without desugaring.
  fun format(epochMs: Long): String {
    val f = java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", java.util.Locale.US)
    f.timeZone = java.util.TimeZone.getTimeZone("UTC")
    return f.format(java.util.Date(epochMs))
  }
}
