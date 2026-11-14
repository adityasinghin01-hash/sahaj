import { AdapterError, requireAuthorization, type ProviderRequest, type ProviderResult } from "./contracts";
import type { TwilioConfig } from "./twilio";
import { send } from "./http";

const ACCOUNT_SID = /^AC[a-f0-9]{32}$/i;
const RECORDING_SID = /^RE[a-f0-9]{32}$/i;
/** Matches the private `sahaj-recordings` bucket limit (50 MiB). */
export const MAX_TWILIO_RECORDING_BYTES = 50 * 1024 * 1024;
const WAV_TYPES = /^audio\/(x-wav|wav|wave|vnd\.wave)$/i;

/**
 * Read one recording as WAV from the Twilio REST API. Authorization action: "twilio.recording.read".
 * The URL is built here from validated SIDs only; no caller or webhook supplied URL is ever fetched.
 * Redirects are refused by the shared HTTP helper (see packages/adapters/README.md, open assumptions).
 * The caller must have re-verified consent for the exact call before invoking this, and must not log the bytes.
 */
export async function fetchTwilioRecording(
  deps: TwilioConfig,
  request: ProviderRequest<{ recordingSid: string }>,
  opts: { maxBytes?: number } = {},
): Promise<ProviderResult<{ audio: Uint8Array; contentType: "audio/wav" }>> {
  requireAuthorization(request, "twilio.recording.read");
  if (!ACCOUNT_SID.test(deps.accountSid) || !deps.authToken) throw new AdapterError("invalid_payload", "twilio");
  const sid = request.payload.recordingSid;
  if (typeof sid !== "string" || !RECORDING_SID.test(sid)) throw new AdapterError("invalid_payload", "twilio");
  const maxBytes = opts.maxBytes ?? MAX_TWILIO_RECORDING_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_TWILIO_RECORDING_BYTES) throw new AdapterError("invalid_payload", "twilio");
  const auth = Buffer.from(`${deps.accountSid}:${deps.authToken}`).toString("base64");
  const res = await send(`https://api.twilio.com/2010-04-01/Accounts/${deps.accountSid}/Recordings/${sid}.wav`,
    { method: "GET", headers: { Authorization: `Basic ${auth}`, Accept: "audio/x-wav, audio/wav" } },
    { provider: "twilio", transport: deps.transport, timeoutMs: deps.timeoutMs ?? 30_000, maxBytes, readOnly: true });
  if (!WAV_TYPES.test(res.contentType.split(";")[0]!.trim()) || res.body.length === 0) throw new AdapterError("provider_rejected", "twilio", res.status);
  return { provider: "twilio", idempotencyKey: request.idempotencyKey, data: { audio: res.body, contentType: "audio/wav" } };
}
