import { NextResponse } from "next/server";
import { safeTokenEquals } from "../secrets";
import { readWebhookBody } from "../webhook-security";
import {
  configuredDigits, handleSarvam, handleTeleCmi, handleTwilioGather, handleTwilioRecording, handleTwilioStatus, toResult,
  type GatewayResult, type TwilioConfig,
} from "./gateway";
import { gatherStore, providerStore } from "./store";
import { serviceDatabase } from "../database";
import { sarvamAgentAliases, sarvamContactAccount } from "../core1/sarvam-calls";
import { createSupabaseSarvamHeardPort, recordSarvamVoiceHeard } from "../core1/sarvam-heard";

export const LIMITS = { sarvam: 524288, telecmi: 16384, twilio: 65536 } as const;

const send = ({ status, body }: GatewayResult) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
const notFound = () => NextResponse.json({ error: "not_found" }, { status: 404 });
const notConfigured = (code = "provider_account_not_configured") => send({ status: 503, body: { error: code } });

type Params = { params: Promise<{ secret: string }> };

/** Wrong or unconfigured URL secret returns 404 before the body is read. */
export async function sarvamPostCall(request: Request, { params }: Params) {
  const { secret } = await params;
  if (!safeTokenEquals(secret, process.env.SARVAM_HOOK_SECRET)) return notFound();
  const { SARVAM_DEPLOYMENT_ID: deploymentId } = process.env;
  // Contact account: SARVAM_APP_ID, else SARVAM_AGENT_ID_CHECKIN (the account the lab registers contacts under).
  const appId = sarvamContactAccount(process.env);
  const agentDigits = configuredDigits(process.env.SARVAM_AGENT_NUMBER ?? process.env.SARVAM_AGENT_PHONE_NUMBER);
  if (!appId || !agentDigits) return notConfigured();
  try {
    const raw = await readWebhookBody(request, LIMITS.sarvam);
    const result = await handleSarvam(raw, { appId, agentDigits, deploymentId: deploymentId || undefined, consentVersion: process.env.CALL_CONSENT_VERSION || undefined, recordingRetrieval: process.env.SARVAM_RECORDING_RETRIEVAL === "true", outboundAgentIds: sarvamAgentAliases(process.env) }, providerStore);
    if (result.status === 200) await projectVoiceHeard(raw);
    return send(result);
  } catch (error) { return send(toResult(error)); }
}

/** After a verified outbound post-call event: a keypad voice-note call that connected >= 10 s marks that note heard. */
async function projectVoiceHeard(raw: Buffer): Promise<void> {
  try {
    const body = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
    if (typeof body.attempt_id !== "string") return;
    await recordSarvamVoiceHeard(createSupabaseSarvamHeardPort(serviceDatabase()), {
      attemptId: body.attempt_id,
      status: typeof body.status === "string" ? body.status : null,
      durationSeconds: typeof body.duration === "number" ? body.duration : null,
    });
  } catch {
    // The event itself is stored; a failed projection leaves the note "not heard", never a false "heard".
    console.error("[sarvam-post-call] voice heard projection failed");
  }
}

export async function missedCall(request: Request, { params }: Params) {
  const { secret } = await params;
  if (!safeTokenEquals(secret, process.env.MISSEDCALL_HOOK_SECRET)) return notFound();
  const appId = Number(process.env.TELECMI_APP_ID);
  const virtualDigits = configuredDigits(process.env.TELECMI_VIRTUAL_NUMBER);
  if (!Number.isSafeInteger(appId) || appId <= 0 || !virtualDigits) return notConfigured();
  try {
    const raw = await readWebhookBody(request, LIMITS.telecmi);
    return send(await handleTeleCmi(raw, { appId, virtualDigits }, providerStore));
  } catch (error) { return send(toResult(error)); }
}

function twilioConfig(): TwilioConfig | null {
  const { TWILIO_ACCOUNT_SID: accountSid, TWILIO_AUTH_TOKEN: authToken } = process.env;
  if (!accountSid || !authToken) return null;
  return { accountSid, authToken, statusUrl: process.env.TWILIO_STATUS_CALLBACK_URL, recordingUrl: process.env.TWILIO_RECORDING_CALLBACK_URL, gatherUrl: process.env.TWILIO_GATHER_CALLBACK_URL, consentVersion: process.env.CALL_CONSENT_VERSION || undefined };
}

export async function twilioStatus(request: Request) {
  const cfg = twilioConfig();
  if (!cfg) return notConfigured("not_configured");
  try {
    const raw = await readWebhookBody(request, LIMITS.twilio);
    return send(await handleTwilioStatus(raw, request.headers.get("content-type"), request.headers.get("x-twilio-signature"), cfg, providerStore));
  } catch (error) { return send(toResult(error)); }
}

export async function twilioRecording(request: Request) {
  const cfg = twilioConfig();
  if (!cfg) return notConfigured("not_configured");
  try {
    const raw = await readWebhookBody(request, LIMITS.twilio);
    return send(await handleTwilioRecording(raw, request.headers.get("content-type"), request.headers.get("x-twilio-signature"), cfg, providerStore));
  } catch (error) { return send(toResult(error)); }
}

/** Twilio Gather action callback for urgent responder calls. TwiML on success, JSON error otherwise. */
export async function twilioGather(request: Request) {
  const cfg = twilioConfig();
  if (!cfg) return notConfigured("not_configured");
  try {
    const raw = await readWebhookBody(request, LIMITS.twilio);
    const result = await handleTwilioGather(raw, request.headers.get("content-type"), request.headers.get("x-twilio-signature"), cfg, providerStore, gatherStore);
    if (result.twiml) return new Response(result.twiml, { status: result.status, headers: { "Content-Type": "text/xml; charset=utf-8", "Cache-Control": "no-store" } });
    return send(result);
  } catch (error) { return send(toResult(error)); }
}