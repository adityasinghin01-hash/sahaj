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

const ALLOWED: ReadonlySet<string> = new Set(["check_in", "urgent_responder", "voice_message", "medicine_refill",
  "missed_call_nudge", "send_alert", "family_report", "record_audio", "share_data", "payment", "collect_otp", "medical_diagnosis"]);

export async function projectUnderstanding(
  input: UnderstandingInput, port?: StructuredUnderstandingPort,
): Promise<{ action: GateAction | "unknown"; certainty: "ready" | "uncertain" }> {
  const exact = exactCommand(input.text);
  if (exact) return { action: exact, certainty: "ready" };
  if (!port) return { action: "unknown", certainty: "uncertain" };
  try {
    const r = await port.understand(input);
    if (!r || (r.evidence !== "model" && r.evidence !== "provider") || !ALLOWED.has(r.action)) return { action: "unknown", certainty: "uncertain" };
    return { action: r.action, certainty: r.certainty === "ready" ? "ready" : "uncertain" };
  } catch { return { action: "unknown", certainty: "uncertain" }; }
}
