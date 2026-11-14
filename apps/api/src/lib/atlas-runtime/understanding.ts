import type { GateAction } from "@sahaj/gate";

/** Provenance-bearing result of an injected model/provider. Without `evidence` the result is ignored. */
export interface StructuredUnderstanding {
  action: GateAction | "unknown";
  certainty: "ready" | "uncertain";
  evidence: "model" | "provider";
}
export interface UnderstandingInput {
  eventType: string;
  /** Message text for the injected port only. Never logged, checkpointed, or returned. */
  text: string | null;
  /** Consented call content (Sarvam transcript and final variables). Same handling as `text`. */
  content?: { transcript?: unknown; variables?: unknown } | null;
}
export interface StructuredUnderstandingPort { understand(input: UnderstandingInput): Promise<StructuredUnderstanding> }

/**
 * Exact, case-insensitive commands the product defines itself. Everything else needs the injected port
 * or goes to review. Nothing here guesses intent from free text.
 */
const EXACT_COMMANDS: ReadonlyMap<string, GateAction> = new Map([
  ["check in", "check_in"], ["check-in", "check_in"], ["checkin", "check_in"], ["family report", "family_report"],
]);

export function exactCommand(text: string | null): GateAction | null {
  if (typeof text !== "string" || text.length > 64) return null;
  return EXACT_COMMANDS.get(text.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase()) ?? null;
}

/** WhatsApp ingestion stores `{ account, event }`; only a text message body is used. */
export function extractText(eventType: string, payload: unknown): string | null {
  if (!eventType.startsWith("whatsapp.") || typeof payload !== "object" || payload === null) return null;
  const event = (payload as { event?: unknown }).event;
  if (typeof event !== "object" || event === null) return null;
  const body = (event as { text?: { body?: unknown } }).text?.body;
  return typeof body === "string" && body.length <= 4096 ? body : null;
}

export type ContentExtraction =
  | { kind: "content"; text: string | null; content: UnderstandingInput["content"] }
  /** The event carries no usable content (missing consent, status only, or no payload). It must go to durable review. */
  | { kind: "review"; reason: "consent_missing" | "no_content" };

/**
 * Pull understanding input from an already decrypted, identity-bound payload.
 * Sarvam content is present only when ingestion proved call_transcript consent; `review_required` marks its absence.
 * TeleCMI missed calls carry no content, so they can never be understood without an explicit nudge workflow.
 */
export function extractContent(eventType: string, payload: unknown): ContentExtraction {
  if (typeof payload !== "object" || payload === null) return { kind: "review", reason: "no_content" };
  if (eventType.startsWith("whatsapp.")) {
    const text = extractText(eventType, payload);
    return text === null ? { kind: "review", reason: "no_content" } : { kind: "content", text, content: null };
  }
  if (eventType === "sarvam.outbound" || eventType === "sarvam.inbound") {
    const p = payload as { review_required?: unknown; interaction_transcript?: unknown; final_agent_variables?: unknown };
    if (p.review_required === "consent_missing") return { kind: "review", reason: "consent_missing" };
    const hasTranscript = Array.isArray(p.interaction_transcript) && p.interaction_transcript.length > 0;
    const hasVariables = typeof p.final_agent_variables === "object" && p.final_agent_variables !== null;
    if (!hasTranscript && !hasVariables) return { kind: "review", reason: "no_content" };
    return { kind: "content", text: null, content: { transcript: p.interaction_transcript, variables: p.final_agent_variables } };
  }
  return { kind: "review", reason: "no_content" };
}

const ALLOWED: ReadonlySet<string> = new Set(["check_in", "urgent_responder", "voice_message", "medicine_refill",
  "missed_call_nudge", "send_alert", "family_report", "record_audio", "share_data", "payment", "collect_otp", "medical_diagnosis"]);

export async function projectUnderstanding(
  input: UnderstandingInput, port?: StructuredUnderstandingPort,
): Promise<{ action: GateAction | "unknown"; certainty: "ready" | "uncertain" }> {
  // Exact commands apply only to a typed message; never to a call transcript.
  const exact = input.content ? null : exactCommand(input.text);
  if (exact) return { action: exact, certainty: "ready" };
  if (!port) return { action: "unknown", certainty: "uncertain" };
  try {
    const r = await port.understand(input);
    if (!r || (r.evidence !== "model" && r.evidence !== "provider") || !ALLOWED.has(r.action)) return { action: "unknown", certainty: "uncertain" };
    return { action: r.action, certainty: r.certainty === "ready" ? "ready" : "uncertain" };
  } catch { return { action: "unknown", certainty: "uncertain" }; }
}
