import { describe, expect, it } from "vitest";
import { PROVIDER_ENV, providerConfigFromEnv } from "../../src/lib/atlas-runtime/providers";

const transport = (async () => new Response()) as never;
const SECRET_MARKERS = ["sk-synthetic", "tok-synthetic", "wa-token-synthetic", "cd".repeat(32)];
const sarvam = {
  SARVAM_OUTBOUND_ENABLED: "true", PROVIDER_WEBHOOK_HOSTS: "api.sahaj.example", SARVAM_API_KEY: "sk-synthetic", SARVAM_ORG_ID: "org-1",
  SARVAM_WORKSPACE_ID: "ws-1", SARVAM_APP_ID: "app-1", SARVAM_APP_VERSION: "3", SARVAM_CONNECTION_ID: "conn-1",
  SARVAM_AGENT_NUMBER: "+918000000000", SARVAM_OUTBOUND_WEBHOOK_URL: "https://api.sahaj.example/api/sarvam/post-call/s",
};
const twilio = {
  TWILIO_OUTBOUND_ENABLED: "true", PROVIDER_WEBHOOK_HOSTS: "api.sahaj.example", TWILIO_ACCOUNT_SID: "AC" + "a".repeat(32), TWILIO_AUTH_TOKEN: "tok-synthetic",
  TWILIO_FROM_NUMBER: "+918000000001", TWILIO_STATUS_CALLBACK_URL: "https://api.sahaj.example/api/twilio/status",
  TWILIO_RESPONDER_TWIML_URL: "https://api.sahaj.example/api/twilio/voice/responder",
};
const whatsapp = { WHATSAPP_OUTBOUND_ENABLED: "true", WHATSAPP_ACCESS_TOKEN: "wa-token-synthetic", WHATSAPP_PHONE_NUMBER_ID: "1234567890", WHATSAPP_GRAPH_VERSION: "v23.0" };
const dispatch = { PROVIDER_DISPATCH_ENABLED: "true", IDENTITY_HASH_SECRET: "synthetic-identity-secret-0123456789abcdef", CONTACT_ENCRYPTION_KEY: "cd".repeat(32) };
const noSecrets = (x: unknown) => { const s = JSON.stringify(x); for (const m of SECRET_MARKERS) expect(s).not.toContain(m); };

describe("providerConfigFromEnv", () => {
  it("configures nothing without explicit enable flags, even with every value present", () => {
    const c = providerConfigFromEnv({ ...sarvam, ...twilio, ...whatsapp, SARVAM_OUTBOUND_ENABLED: "1", TWILIO_OUTBOUND_ENABLED: "yes", WHATSAPP_OUTBOUND_ENABLED: "TRUE",
      PROVIDER_DISPATCH_ENABLED: "false" }, transport);
    expect(c.providers).toBeUndefined(); expect(c.dispatchEnabled).toBe(false); expect(c.contactEncryptionKey).toBeUndefined();
    expect(c.purgeEnabled).toBe(false); expect(c.problems).toEqual([]);
  });
  it("builds exactly the adapter fields for each enabled, complete provider", () => {
    const c = providerConfigFromEnv({ ...sarvam, ...twilio, ...whatsapp, ...dispatch }, transport);
    expect(c.providers?.sarvam).toEqual({ apiKey: "sk-synthetic", orgId: "org-1", workspaceId: "ws-1", appId: "app-1", appVersion: 3, connectionId: "conn-1",
      agentPhoneNumber: "+918000000000", webhookUrl: sarvam.SARVAM_OUTBOUND_WEBHOOK_URL });
    expect(c.providers?.twilio).toEqual({ accountSid: twilio.TWILIO_ACCOUNT_SID, authToken: "tok-synthetic", fromNumber: "+918000000001",
      statusCallbackUrl: twilio.TWILIO_STATUS_CALLBACK_URL, allowedWebhookHosts: ["api.sahaj.example"] });
    expect(c.twilioTwimlUrl).toBe(twilio.TWILIO_RESPONDER_TWIML_URL);
    expect(c.providers?.whatsapp).toEqual({ accessToken: "wa-token-synthetic", phoneNumberId: "1234567890", graphVersion: "v23.0" });
    expect(c.dispatchEnabled).toBe(true); expect(c.contactEncryptionKey).toBe("cd".repeat(32)); expect(c.problems).toEqual([]);
  });
  it("leaves a provider unconfigured and reports NAMES only when any field is missing or invalid", () => {
    const cases: Array<[Record<string, string>, string]> = [
      [{ ...whatsapp, WHATSAPP_GRAPH_VERSION: "" }, "WHATSAPP_GRAPH_VERSION:missing"],          // never defaulted
      [{ ...whatsapp, WHATSAPP_GRAPH_VERSION: "latest" }, "WHATSAPP_GRAPH_VERSION:invalid"],
      [{ ...whatsapp, WHATSAPP_PHONE_NUMBER_ID: "+91abc" }, "WHATSAPP_PHONE_NUMBER_ID:invalid"],
      [{ ...sarvam, SARVAM_APP_VERSION: "2.1" }, "SARVAM_APP_VERSION:invalid"],
      [{ ...sarvam, SARVAM_AGENT_NUMBER: "08000000000" }, "SARVAM_AGENT_NUMBER:invalid"],
      [{ ...sarvam, SARVAM_OUTBOUND_WEBHOOK_URL: "http://api.sahaj.example/x" }, "SARVAM_OUTBOUND_WEBHOOK_URL:invalid"],
      [{ ...sarvam, SARVAM_OUTBOUND_WEBHOOK_URL: "https://evil.example/x" }, "SARVAM_OUTBOUND_WEBHOOK_URL:invalid"],   // host not allowlisted
      [{ ...sarvam, SARVAM_OUTBOUND_WEBHOOK_URL: "https://u:p@api.sahaj.example/x" }, "SARVAM_OUTBOUND_WEBHOOK_URL:invalid"],
      [{ ...sarvam, PROVIDER_WEBHOOK_HOSTS: "" }, "PROVIDER_WEBHOOK_HOSTS:missing"],
      [{ ...twilio, TWILIO_ACCOUNT_SID: "AC123" }, "TWILIO_ACCOUNT_SID:invalid"],
      [{ ...twilio, TWILIO_STATUS_CALLBACK_URL: "https://api.sahaj.example:8443/s" }, "TWILIO_STATUS_CALLBACK_URL:invalid"],
      [{ ...twilio, TWILIO_RESPONDER_TWIML_URL: "" }, "TWILIO_RESPONDER_TWIML_URL:missing"],
      [{ ...twilio, PROVIDER_WEBHOOK_HOSTS: "localhost" }, "PROVIDER_WEBHOOK_HOSTS:invalid"],
    ];
    for (const [env, problem] of cases) {
      const c = providerConfigFromEnv(env, transport);
      expect(c.providers).toBeUndefined();
      expect(c.problems).toContain(problem);
      noSecrets(c.problems);
    }
  });
  it("dispatch requires a valid contact key and identity secret, reported by name", () => {
    const c = providerConfigFromEnv({ ...whatsapp, PROVIDER_DISPATCH_ENABLED: "true", IDENTITY_HASH_SECRET: "short", CONTACT_ENCRYPTION_KEY: "zz" }, transport);
    expect(c.identitySecret).toBeUndefined(); expect(c.contactEncryptionKey).toBeUndefined();
    expect(c.problems).toEqual(expect.arrayContaining(["IDENTITY_HASH_SECRET:invalid", "CONTACT_ENCRYPTION_KEY:invalid"]));
  });
  it("recording and purge flags are explicit; purge limit is validated", () => {
    expect(providerConfigFromEnv({ RECORDING_PURGE_ENABLED: "true" }, transport)).toMatchObject({ purgeEnabled: true, purgeLimit: 25 });
    const bad = providerConfigFromEnv({ RECORDING_PURGE_ENABLED: "true", RECORDING_PURGE_LIMIT: "5000" }, transport);
    expect(bad.purgeEnabled).toBe(false); expect(bad.problems).toContain("RECORDING_PURGE_LIMIT:invalid");
    const rec = providerConfigFromEnv({ RECORDING_RETRIEVAL_ENABLED: "true", WEBHOOK_ENCRYPTION_KEY: "ab".repeat(32), TWILIO_ACCOUNT_SID: twilio.TWILIO_ACCOUNT_SID,
      TWILIO_AUTH_TOKEN: "tok-synthetic", CALL_CONSENT_VERSION: "v1" }, transport);
    expect(rec.recording).toMatchObject({ accountSid: twilio.TWILIO_ACCOUNT_SID, consentVersion: "v1" }); expect(rec.recording?.sarvam).toBeUndefined();
    expect(providerConfigFromEnv({ RECORDING_RETRIEVAL_ENABLED: "true" }, transport).recording).toBeUndefined();
  });
  it("every documented name exists in apps/api/.env.example (names only, empty values)", async () => {
    const { readFileSync } = await import("node:fs");
    const template = readFileSync(new URL("../../.env.example", import.meta.url), "utf8");
    for (const name of Object.values(PROVIDER_ENV)) expect(template).toMatch(new RegExp(`^${name}=[^\\n]*$`, "m"));
    for (const line of template.split(/\r?\n/)) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
      if (m && !/_ENABLED$|^MAINTENANCE_KILL$|^PRUNE_ENABLED$|^SARVAM_RECORDING_RETRIEVAL$|^RECORDING_PURGE_LIMIT$/.test(m[1])) expect(m[2]).toBe("");
    }
  });
});
