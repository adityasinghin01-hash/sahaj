import { assertE164, assertSafeUrl, type FetchTransport } from "@sahaj/adapters";
import type { Phase2Entrypoints, ProviderRuntimeConfig, RecordingSarvamConfig, RecordingTwilioConfig, SarvamProviderConfig, TwilioProviderConfig, WhatsAppProviderConfig } from "./bridge";

/**
 * Environment NAMES read by `providerConfigFromEnv` (template: apps/api/.env.example). The route passes `process.env`;
 * values are never logged, returned or stored. Problems are reported as `NAME:missing|invalid` only.
 */
export const PROVIDER_ENV = {
  dispatchEnabled: "PROVIDER_DISPATCH_ENABLED",
  sarvamEnabled: "SARVAM_OUTBOUND_ENABLED",
  twilioEnabled: "TWILIO_OUTBOUND_ENABLED",
  whatsappEnabled: "WHATSAPP_OUTBOUND_ENABLED",
  webhookHosts: "PROVIDER_WEBHOOK_HOSTS",
  identitySecret: "IDENTITY_HASH_SECRET",
  contactKey: "CONTACT_ENCRYPTION_KEY",
  webhookKey: "WEBHOOK_ENCRYPTION_KEY",
  consentVersion: "CALL_CONSENT_VERSION",
  sarvamApiKey: "SARVAM_API_KEY",
  sarvamOrgId: "SARVAM_ORG_ID",
  sarvamWorkspaceId: "SARVAM_WORKSPACE_ID",
  sarvamAppId: "SARVAM_APP_ID",
  sarvamAppVersion: "SARVAM_APP_VERSION",
  sarvamConnectionId: "SARVAM_CONNECTION_ID",
  sarvamAgentNumber: "SARVAM_AGENT_NUMBER",
  sarvamWebhookUrl: "SARVAM_OUTBOUND_WEBHOOK_URL",
  twilioAccountSid: "TWILIO_ACCOUNT_SID",
  twilioAuthToken: "TWILIO_AUTH_TOKEN",
  twilioFromNumber: "TWILIO_FROM_NUMBER",
  twilioStatusCallbackUrl: "TWILIO_STATUS_CALLBACK_URL",
  whatsappAccessToken: "WHATSAPP_ACCESS_TOKEN",
  whatsappPhoneNumberId: "WHATSAPP_PHONE_NUMBER_ID",
  whatsappGraphVersion: "WHATSAPP_GRAPH_VERSION",
  recordingEnabled: "RECORDING_RETRIEVAL_ENABLED",
  twilioRecordingEnabled: "TWILIO_RECORDING_RETRIEVAL",
  sarvamRecordingEnabled: "SARVAM_RECORDING_RETRIEVAL",
  purgeEnabled: "RECORDING_PURGE_ENABLED",
  purgeLimit: "RECORDING_PURGE_LIMIT",
} as const;

const SAFE_ID = /^[A-Za-z0-9_.-]{1,128}$/;        // Sarvam ids (adapter SAFE_ID)
const ACCOUNT_SID = /^AC[a-f0-9]{32}$/i;           // Twilio adapter
const NUMERIC_ID = /^\d{1,32}$/;                   // WhatsApp adapter
const GRAPH_VERSION = /^v\d{1,2}\.\d$/;            // WhatsApp adapter; explicit, never defaulted
const HEX64 = /^[0-9a-fA-F]{64}$/;

type Env = Record<string, string | undefined>;

/** Validated provider configuration. A provider is configured only when enabled AND every field is present and valid. */
export function providerConfigFromEnv(env: Env, transport: FetchTransport | undefined = globalThis.fetch as FetchTransport | undefined): ProviderRuntimeConfig {
  const problems: string[] = [];
  const v = (name: string) => (typeof env[name] === "string" && env[name]!.length > 0 ? env[name] : undefined);
  const flag = (name: string) => env[name] === "true";
  /** Read a required value; record `NAME:missing` / `NAME:invalid`. */
  const need = (name: string, ok: (s: string) => boolean = () => true): string | undefined => {
    const s = v(name);
    if (s === undefined) { problems.push(`${name}:missing`); return undefined; }
    let valid = false; try { valid = ok(s); } catch { valid = false; }
    if (!valid) { problems.push(`${name}:invalid`); return undefined; }
    return s;
  };
  const e164 = (s: string) => assertE164(s) === s;

  const anyOutbound = flag(PROVIDER_ENV.sarvamEnabled) || flag(PROVIDER_ENV.twilioEnabled) || flag(PROVIDER_ENV.whatsappEnabled);
  let hosts: string[] = [];
  if (anyOutbound && (flag(PROVIDER_ENV.sarvamEnabled) || flag(PROVIDER_ENV.twilioEnabled))) {
    const raw = need(PROVIDER_ENV.webhookHosts, s => s.split(",").map(h => h.trim()).every(h => /^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(h)));
    hosts = raw ? raw.split(",").map(h => h.trim().toLowerCase()) : [];
  }
  const safeUrl = (s: string) => hosts.length > 0 && assertSafeUrl(s, hosts).toString().length > 0;

  let sarvam: SarvamProviderConfig | undefined;
  if (flag(PROVIDER_ENV.sarvamEnabled)) {
    const f = {
      apiKey: need(PROVIDER_ENV.sarvamApiKey), orgId: need(PROVIDER_ENV.sarvamOrgId, s => SAFE_ID.test(s)),
      workspaceId: need(PROVIDER_ENV.sarvamWorkspaceId, s => SAFE_ID.test(s)), appId: need(PROVIDER_ENV.sarvamAppId, s => SAFE_ID.test(s)),
      appVersion: need(PROVIDER_ENV.sarvamAppVersion, s => /^\d{1,9}$/.test(s)), connectionId: need(PROVIDER_ENV.sarvamConnectionId, s => SAFE_ID.test(s)),
      agentPhoneNumber: need(PROVIDER_ENV.sarvamAgentNumber, e164), webhookUrl: need(PROVIDER_ENV.sarvamWebhookUrl, safeUrl),
    };
    if (Object.values(f).every(x => x !== undefined)) sarvam = { ...(f as Record<keyof typeof f, string>), appVersion: Number(f.appVersion) };
  }
  let twilio: TwilioProviderConfig | undefined;
  if (flag(PROVIDER_ENV.twilioEnabled)) {
    const f = {
      accountSid: need(PROVIDER_ENV.twilioAccountSid, s => ACCOUNT_SID.test(s)), authToken: need(PROVIDER_ENV.twilioAuthToken),
      fromNumber: need(PROVIDER_ENV.twilioFromNumber, e164), statusCallbackUrl: need(PROVIDER_ENV.twilioStatusCallbackUrl, safeUrl),
    };
    // No TwiML URL is read from the environment: a URL cannot attest disclosure. Responder calls need an injected owned
    // renderer (bridge.ts TwilioResponderRenderer); without one Twilio stays out of the claimable capabilities.
    if (Object.values(f).every(x => x !== undefined)) twilio = { ...(f as Record<keyof typeof f, string>), allowedWebhookHosts: hosts };
  }
  let whatsapp: WhatsAppProviderConfig | undefined;
  if (flag(PROVIDER_ENV.whatsappEnabled)) {
    const f = {
      accessToken: need(PROVIDER_ENV.whatsappAccessToken), phoneNumberId: need(PROVIDER_ENV.whatsappPhoneNumberId, s => NUMERIC_ID.test(s)),
      graphVersion: need(PROVIDER_ENV.whatsappGraphVersion, s => GRAPH_VERSION.test(s)),
    };
    if (Object.values(f).every(x => x !== undefined)) whatsapp = f as WhatsAppProviderConfig;
  }

  const dispatchEnabled = flag(PROVIDER_ENV.dispatchEnabled);
  const identitySecret = dispatchEnabled ? need(PROVIDER_ENV.identitySecret, s => s.length >= 32) : v(PROVIDER_ENV.identitySecret);
  const contactEncryptionKey = dispatchEnabled ? need(PROVIDER_ENV.contactKey, s => HEX64.test(s)) : undefined;

  // Recording retrieval: master flag plus one flag per provider. Each provider's settings are independent, so a Sarvam-only
  // setup needs no Twilio credentials (and vice versa). Shared: WEBHOOK_ENCRYPTION_KEY and CALL_CONSENT_VERSION.
  let recordingTwilio: RecordingTwilioConfig | undefined, recordingSarvam: RecordingSarvamConfig | undefined;
  if (flag(PROVIDER_ENV.recordingEnabled) && (flag(PROVIDER_ENV.twilioRecordingEnabled) || flag(PROVIDER_ENV.sarvamRecordingEnabled))) {
    const encryptionKey = need(PROVIDER_ENV.webhookKey, s => HEX64.test(s));
    const consentVersion = need(PROVIDER_ENV.consentVersion, s => /^[A-Za-z0-9_.:-]{1,64}$/.test(s));
    if (flag(PROVIDER_ENV.twilioRecordingEnabled)) {
      const accountSid = need(PROVIDER_ENV.twilioAccountSid, s => ACCOUNT_SID.test(s)), authToken = need(PROVIDER_ENV.twilioAuthToken);
      if (encryptionKey && consentVersion && accountSid && authToken) recordingTwilio = { encryptionKey, consentVersion, accountSid, authToken };
    }
    if (flag(PROVIDER_ENV.sarvamRecordingEnabled)) {
      const s = { apiKey: need(PROVIDER_ENV.sarvamApiKey), orgId: need(PROVIDER_ENV.sarvamOrgId, x => SAFE_ID.test(x)),
        workspaceId: need(PROVIDER_ENV.sarvamWorkspaceId, x => SAFE_ID.test(x)), appId: need(PROVIDER_ENV.sarvamAppId, x => SAFE_ID.test(x)) };
      if (encryptionKey && consentVersion && Object.values(s).every(x => x !== undefined)) {
        recordingSarvam = { encryptionKey, consentVersion, sarvam: s as RecordingSarvamConfig["sarvam"] };
      }
    }
  }
  const purgeLimitRaw = v(PROVIDER_ENV.purgeLimit);
  const purgeLimit = purgeLimitRaw === undefined ? 25 : /^\d{1,3}$/.test(purgeLimitRaw) && Number(purgeLimitRaw) >= 1 && Number(purgeLimitRaw) <= 100 ? Number(purgeLimitRaw) : undefined;
  if (purgeLimit === undefined) problems.push(`${PROVIDER_ENV.purgeLimit}:invalid`);

  const providers = { ...(sarvam ? { sarvam } : {}), ...(twilio ? { twilio } : {}), ...(whatsapp ? { whatsapp } : {}) };
  return {
    dispatchEnabled, transport, identitySecret, contactEncryptionKey, recordingTwilio, recordingSarvam,
    providers: Object.keys(providers).length ? providers : undefined,
    purgeEnabled: flag(PROVIDER_ENV.purgeEnabled) && purgeLimit !== undefined, purgeLimit: purgeLimit ?? 25,
    problems: [...new Set(problems)],
  };
}

export { phase2Entrypoints } from "./phase2-modules";
export type { Phase2Entrypoints };
