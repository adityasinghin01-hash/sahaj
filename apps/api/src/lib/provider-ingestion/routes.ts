import { NextResponse } from "next/server";
import { safeTokenEquals } from "../secrets";
import { readWebhookBody } from "../webhook-security";
import {
  configuredDigits, handleSarvam, handleTeleCmi, handleTwilioRecording, handleTwilioStatus, toResult,
  type GatewayResult, type TwilioConfig,
} from "./gateway";
import { providerStore } from "./store";

export const LIMITS = { sarvam: 524288, telecmi: 16384, twilio: 65536 } as const;

const send = ({ status, body }: GatewayResult) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
const notFound = () => NextResponse.json({ error: "not_found" }, { status: 404 });
const notConfigured = (code = "provider_account_not_configured") => send({ status: 503, body: { error: code } });

type Params = { params: Promise<{ secret: string }> };

/** Wrong or unconfigured URL secret returns 404 before the body is read. */
export async function sarvamPostCall(request: Request, { params }: Params) {
  const { secret } = await params;
  if (!safeTokenEquals(secret, process.env.SARVAM_HOOK_SECRET)) return notFound();
  const { SARVAM_APP_ID: appId, SARVAM_DEPLOYMENT_ID: deploymentId } = process.env;
  const agentDigits = configuredDigits(process.env.SARVAM_AGENT_NUMBER);
  if (!appId || !agentDigits) return notConfigured();
  try {
    const raw = await readWebhookBody(request, LIMITS.sarvam);
    return send(await handleSarvam(raw, { appId, agentDigits, deploymentId: deploymentId || undefined, consentVersion: process.env.CALL_CONSENT_VERSION || undefined }, providerStore));
  } catch (error) { return send(toResult(error)); }
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
  return { accountSid, authToken, statusUrl: process.env.TWILIO_STATUS_CALLBACK_URL, recordingUrl: process.env.TWILIO_RECORDING_CALLBACK_URL, consentVersion: process.env.CALL_CONSENT_VERSION || undefined };
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
