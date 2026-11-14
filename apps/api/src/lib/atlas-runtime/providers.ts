import type { FetchTransport } from "@sahaj/adapters/communication";
import type { Phase2Entrypoints, ProviderRuntimeConfig } from "./bridge";

/**
 * Environment names read by `providerConfigFromEnv`. The route passes `process.env`; values are never logged, returned or
 * stored. Names other than the two enable flags already exist in `apps/api/.env.example` or Phase 2's contract.
 */
export const PROVIDER_ENV = {
  dispatchEnabled: "PROVIDER_DISPATCH_ENABLED", // must be exactly "true"
  identitySecret: "IDENTITY_HASH_SECRET",
  encryptionKey: "WEBHOOK_ENCRYPTION_KEY",
  consentVersion: "CALL_CONSENT_VERSION",
  twilioAccountSid: "TWILIO_ACCOUNT_SID",
  twilioAuthToken: "TWILIO_AUTH_TOKEN",
  twilioStatusCallbackUrl: "TWILIO_STATUS_CALLBACK_URL",
  twilioFromNumber: "TWILIO_FROM_NUMBER",
  twilioTwimlUrl: "TWILIO_RESPONDER_TWIML_URL",
  recordingEnabled: "RECORDING_RETRIEVAL_ENABLED", // must be exactly "true"
} as const;

/**
 * Builds the injected provider configuration. Missing pieces stay undefined so the bridge reports them `unavailable`.
 * Deliberately NOT provided here, so dispatch stays unavailable in production until a reviewed implementation exists:
 *   - `resolveDestination`: no contact-encryption scheme for `provider_identities.contact_ciphertext` exists in either lane.
 *   - Sarvam outbound and WhatsApp send configuration (app version, connection id, agent number, Graph version) whose names
 *     belong to Phase 2's adapter contract.
 * The transport is global fetch only when some capability could use it; tests inject a scripted transport instead.
 */
export function providerConfigFromEnv(env: Record<string, string | undefined>, transport: FetchTransport | undefined = globalThis.fetch as FetchTransport | undefined): ProviderRuntimeConfig {
  const v = (name: string) => (env[name] && env[name]!.length ? env[name] : undefined);
  const twilio = v(PROVIDER_ENV.twilioAccountSid) && v(PROVIDER_ENV.twilioAuthToken) && v(PROVIDER_ENV.twilioFromNumber) && v(PROVIDER_ENV.twilioStatusCallbackUrl)
    ? { accountSid: v(PROVIDER_ENV.twilioAccountSid), authToken: v(PROVIDER_ENV.twilioAuthToken), fromNumber: v(PROVIDER_ENV.twilioFromNumber),
        statusCallbackUrl: v(PROVIDER_ENV.twilioStatusCallbackUrl), allowedWebhookHosts: hostOf(v(PROVIDER_ENV.twilioStatusCallbackUrl)) } : undefined;
  const recording = env[PROVIDER_ENV.recordingEnabled] === "true" && v(PROVIDER_ENV.encryptionKey) && v(PROVIDER_ENV.twilioAccountSid) && v(PROVIDER_ENV.twilioAuthToken) && v(PROVIDER_ENV.consentVersion)
    ? { encryptionKey: v(PROVIDER_ENV.encryptionKey)!, accountSid: v(PROVIDER_ENV.twilioAccountSid)!, authToken: v(PROVIDER_ENV.twilioAuthToken)!, consentVersion: v(PROVIDER_ENV.consentVersion)! } : undefined;
  return {
    dispatchEnabled: env[PROVIDER_ENV.dispatchEnabled] === "true",
    transport, identitySecret: v(PROVIDER_ENV.identitySecret),
    providers: twilio ? { twilio } : undefined,
    twilioTwimlUrl: v(PROVIDER_ENV.twilioTwimlUrl),
    recording,
  };
}
function hostOf(url: string | undefined): string[] {
  try { return url ? [new URL(url).host] : []; } catch { return []; }
}

export { phase2Entrypoints } from "./phase2-modules";
export type { Phase2Entrypoints };
