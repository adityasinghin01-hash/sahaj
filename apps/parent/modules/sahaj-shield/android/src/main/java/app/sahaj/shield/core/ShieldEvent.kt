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

object IsoTime {
  /** UTC ISO-8601 with milliseconds, accepted by z.string().datetime(). */
  // SimpleDateFormat instead of java.time so it works below API 26 without desugaring.
  fun format(epochMs: Long): String {
    val f = java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", java.util.Locale.US)
    f.timeZone = java.util.TimeZone.getTimeZone("UTC")
    return f.format(java.util.Date(epochMs))
  }
}
