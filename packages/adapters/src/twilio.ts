import { AdapterError, dispatchOnce, requireAuthorization, type DispatchLedger, type FetchTransport, type ProviderRequest, type ProviderResult } from "./contracts";
import { assertE164, assertSafeUrl, parseJson, send, str } from "./http";
import { AI_DISCLOSURE, requireRecordingConsent, type RecordingConsent } from "./audio";
import { verifyTwilioFormSignature } from "./security";

const ACCOUNT_SID = /^AC[a-f0-9]{32}$/i;
const CALL_SID = /^CA[a-f0-9]{32}$/i;
const HINDI = "hi-IN";

export interface TwilioConfig { transport: FetchTransport; accountSid: string; authToken: string; timeoutMs?: number }
export interface TwilioCallDeps extends TwilioConfig {
  ledger: DispatchLedger; fromNumber: string; statusCallbackUrl: string;
  /** Server configured hosts serving consent-enforcing TwiML and callbacks. Never caller supplied. */
  allowedWebhookHosts: readonly string[];
}

/** Start a call that fetches TwiML from `twimlUrl`. Authorization action: "twilio.create_call". Status callbacks reconcile delivery-unknown outcomes. */
export async function createTwilioCall(deps: TwilioCallDeps, request: ProviderRequest<{ to: string; twimlUrl: string }>): Promise<ProviderResult<{ callSid: string }>> {
  const action = "twilio.create_call";
  requireAuthorization(request, action);
  if (!ACCOUNT_SID.test(deps.accountSid) || !deps.authToken) throw new AdapterError("invalid_payload", "twilio");
  const to = assertE164(request.payload.to), from = assertE164(deps.fromNumber);
  assertSafeUrl(request.payload.twimlUrl, deps.allowedWebhookHosts, "twilio");
  assertSafeUrl(deps.statusCallbackUrl, deps.allowedWebhookHosts, "twilio");
  const form = new URLSearchParams({ To: to, From: from, Url: request.payload.twimlUrl, StatusCallback: deps.statusCallbackUrl, StatusCallbackMethod: "POST" });
  for (const ev of ["initiated", "ringing", "answered", "completed"]) form.append("StatusCallbackEvent", ev);
  const auth = Buffer.from(`${deps.accountSid}:${deps.authToken}`).toString("base64");
  return dispatchOnce(deps.ledger, request, "twilio", action, async () => {
    const res = await send(`https://api.twilio.com/2010-04-01/Accounts/${deps.accountSid}/Calls.json`, {
      method: "POST",
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    }, { provider: "twilio", transport: deps.transport, timeoutMs: deps.timeoutMs, readOnly: false });
    let sid: string | undefined;
    try { sid = str(parseJson(res.body, "twilio").sid, 64); } catch { /* handled below */ }
    if (!sid || !CALL_SID.test(sid)) throw new AdapterError("delivery_unknown", "twilio");
    return { data: { callSid: sid }, providerRef: sid };
  });
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

export interface RelayOptions {
  /** HTTPS URL of the real recorded family voice. Must be on an allowlisted host. */
  recordingUrl: string;
  allowedRecordingHosts: readonly string[];
  consent: RecordingConsent;
  personId: string;
  recordingId: string;
  /** Where Twilio posts the DTMF/speech reply. Must be https. */
  actionUrl: string;
  /** Hindi question asked after the recording, for example "सुनने के लिए 1 दबाएँ या हाँ बोलें". */
  promptHindi: string;
}
/**
 * TwiML that identifies the AI, plays a REAL family recording (consent required), then asks a Hindi
 * question answerable by speech or a keypad digit. No recording of the listener is made here.
 */
export function buildRecordedVoiceRelayTwiml(o: RelayOptions): string {
  requireRecordingConsent(o.consent, o.personId, o.recordingId);
  const url = assertSafeUrl(o.recordingUrl, o.allowedRecordingHosts, "twilio");
  if (!o.actionUrl.startsWith("https://") || !o.promptHindi || o.promptHindi.length > 300) throw new AdapterError("invalid_payload", "twilio");
  return `<?xml version="1.0" encoding="UTF-8"?><Response>` +
    `<Say language="${HINDI}">${xml(AI_DISCLOSURE.Hindi)} ${xml("अब आपके परिवार की रिकॉर्ड की गई आवाज़ सुनाई जा रही है।")}</Say>` +
    `<Play>${xml(url.toString())}</Play>` +
    `<Gather input="dtmf speech" language="${HINDI}" numDigits="1" timeout="6" speechTimeout="auto" action="${xml(o.actionUrl)}" method="POST">` +
    `<Say language="${HINDI}">${xml(o.promptHindi)}</Say></Gather>` +
    `<Say language="${HINDI}">${xml("कोई उत्तर नहीं मिला। धन्यवाद।")}</Say><Hangup/></Response>`;
}

/** Ask for recording consent first. Nothing is recorded until buildReplyRecordingTwiml sees the consent digit. */
export function buildRecordingConsentTwiml(actionUrl: string): string {
  if (!actionUrl.startsWith("https://")) throw new AdapterError("unsafe_url", "twilio");
  const ask = `${AI_DISCLOSURE.Hindi} क्या आप अपना जवाब रिकॉर्ड करने की अनुमति देते हैं? हाँ के लिए 1 दबाएँ, नहीं के लिए 2।`;
  return `<?xml version="1.0" encoding="UTF-8"?><Response>` +
    `<Gather input="dtmf speech" language="${HINDI}" numDigits="1" timeout="6" speechTimeout="auto" action="${xml(actionUrl)}" method="POST">` +
    `<Say language="${HINDI}">${xml(ask)}</Say></Gather>` +
    `<Say language="${HINDI}">${xml("कोई उत्तर नहीं मिला। हम रिकॉर्ड नहीं करेंगे। धन्यवाद।")}</Say><Hangup/></Response>`;
}
/** Records only after explicit consent (digit "1" or spoken "हाँ"/"yes"). Anything else ends the call without recording. */
export function buildReplyRecordingTwiml(consentReply: GatherReply, recordingStatusUrl: string): string {
  if (!recordingStatusUrl.startsWith("https://")) throw new AdapterError("unsafe_url", "twilio");
  if (consentReply.choice !== "yes") {
    return `<?xml version="1.0" encoding="UTF-8"?><Response><Say language="${HINDI}">${xml("ठीक है, हम रिकॉर्ड नहीं करेंगे। धन्यवाद।")}</Say><Hangup/></Response>`;
  }
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Say language="${HINDI}">${xml("बीप के बाद अपना संदेश बोलें।")}</Say>` +
    `<Record maxLength="60" playBeep="true" timeout="5" recordingStatusCallback="${xml(recordingStatusUrl)}" recordingStatusCallbackMethod="POST"/></Response>`;
}

export interface GatherReply { choice: "yes" | "no" | "unknown"; via: "dtmf" | "speech" | "none"; confidence: number | null }
const YES = new Set(["1", "हाँ", "हां", "हा", "जी", "yes", "ha", "haan", "ok", "okay"]);
const NO = new Set(["2", "नहीं", "नही", "ना", "no", "nahi", "nahin"]);
/** Interpret a verified Twilio Gather callback. Low-confidence speech is "unknown", never a guess. */
export function parseGatherReply(params: URLSearchParams, minSpeechConfidence = 0.6): GatherReply {
  const digit = params.get("Digits");
  if (digit) return { choice: digit === "1" ? "yes" : digit === "2" ? "no" : "unknown", via: "dtmf", confidence: null };
  const speech = params.get("SpeechResult")?.trim().toLowerCase().replace(/[।.!?,]/g, "");
  const conf = Number(params.get("Confidence"));
  if (speech && speech.length <= 200) {
    if (!Number.isFinite(conf) || conf < minSpeechConfidence) return { choice: "unknown", via: "speech", confidence: Number.isFinite(conf) ? conf : null };
    return { choice: YES.has(speech) ? "yes" : NO.has(speech) ? "no" : "unknown", via: "speech", confidence: conf };
  }
  return { choice: "unknown", via: "none", confidence: null };
}

export type TwilioCallStatus = "queued" | "initiated" | "ringing" | "in-progress" | "completed" | "busy" | "failed" | "no-answer" | "canceled";
const CALL_STATUSES = new Set<string>(["queued", "initiated", "ringing", "in-progress", "completed", "busy", "failed", "no-answer", "canceled"]);
/** Verify the signature against the configured public URL, then match the account. Returns the call status for reconciliation. */
export function parseTwilioStatusCallback(publicUrl: string, params: URLSearchParams, signature: string | null, cfg: { authToken: string; accountSid: string }): { callSid: string; status: TwilioCallStatus } {
  if (!verifyTwilioFormSignature(publicUrl, params, signature, cfg.authToken)) throw new AdapterError("invalid_signature", "twilio");
  const sid = params.get("CallSid"), status = params.get("CallStatus");
  if (params.get("AccountSid") !== cfg.accountSid) throw new AdapterError("unknown_identity", "twilio");
  if (!sid || !CALL_SID.test(sid) || !status || !CALL_STATUSES.has(status)) throw new AdapterError("invalid_payload", "twilio");
  return { callSid: sid, status: status as TwilioCallStatus };
}

