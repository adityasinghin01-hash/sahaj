import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildRecordedVoiceRelayTwiml, buildRecordingConsentTwiml, buildReplyRecordingTwiml, createTwilioCall, parseGatherReply, parseTwilioStatusCallback, type TwilioCallDeps } from "../src/twilio";
import { parseTeleCmiMissedWebhook, pullTeleCmiMissedCalls } from "../src/telecmi";
import { AI_DISCLOSURE, MockAudioConverter, MockSpeechToText, MockTextToSpeech, planAudioChunks, transcribeInChunks, withAiDisclosure, type AudioBlob } from "../src/audio";
import { KEY, MemoryLedger, PERSON, PHONE, code, hang, json, req, scripted } from "./helpers";

const SID = "AC" + "a".repeat(32), CALL = "CA" + "b".repeat(32), TOKEN = "synthetic-twilio-token";
const twilioDeps = (transport: TwilioCallDeps["transport"], ledger = new MemoryLedger()): TwilioCallDeps => ({ transport, ledger, accountSid: SID, authToken: TOKEN, fromNumber: "+918000000000", statusCallbackUrl: "https://api.example.test/api/twilio/status", allowedWebhookHosts: ["api.example.test"], timeoutMs: 30 });

describe("Twilio create call", () => {
  const r = () => req("twilio.create_call", { to: PHONE, twimlUrl: "https://api.example.test/api/twilio/voice/relay" });
  it("refuses attacker TwiML before claiming or contacting the provider", async () => {
    const t = scripted(); const deps = twilioDeps(t.transport);
    for (const url of ["https://evil.test/record-without-consent", "https://api.example.test@evil.test/", "https://127.0.0.1/", "https://api.example.test:444/"]) {
      const request = r(); request.payload.twimlUrl = url;
      expect(await code(createTwilioCall(deps, request))).toBe("unsafe_url");
    }
    expect(t.calls).toHaveLength(0);
    expect((deps.ledger as MemoryLedger).claims.size).toBe(0);
  });
  it("posts a form with basic auth and records the call sid", async () => {
    const t = scripted(json({ sid: CALL })); const deps = twilioDeps(t.transport);
    expect((await createTwilioCall(deps, r())).data.callSid).toBe(CALL);
    expect(t.calls[0]!.url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${SID}/Calls.json`);
    const form = new URLSearchParams(t.calls[0]!.init.body as string);
    expect(form.get("To")).toBe(PHONE); expect(form.getAll("StatusCallbackEvent")).toContain("completed");
    expect((deps.ledger as MemoryLedger).state.get(KEY)).toBe(`dispatched:${CALL}`);
  });
  it("timeout is delivery_unknown, no retry; 400 is clean failure; unauthorized makes no call", async () => {
    const ledger = new MemoryLedger(); const t = scripted(hang());
    expect(await code(createTwilioCall(twilioDeps(t.transport, ledger), r()))).toBe("delivery_unknown");
    expect(await code(createTwilioCall(twilioDeps(t.transport, ledger), r()))).toBe("duplicate_dispatch");
    const l2 = new MemoryLedger();
    expect(await code(createTwilioCall(twilioDeps(scripted(json({ code: 21211 }, 400)).transport, l2), r()))).toBe("provider_rejected");
    expect(l2.state.get(KEY)).toBe("failed");
    const bad = r(); bad.authorization = { ...bad.authorization, consent: false };
    const t3 = scripted();
    expect(await code(createTwilioCall(twilioDeps(t3.transport), bad))).toBe("authorization_denied");
    expect(t3.calls).toHaveLength(0);
  });
});

describe("Twilio TwiML relay", () => {
  const consent = { granted: true, personId: PERSON, recordingId: "rec-1" };
  const opts = { recordingUrl: "https://media.example.test/rec-1.mp3", allowedRecordingHosts: ["media.example.test"], consent, personId: PERSON, recordingId: "rec-1", actionUrl: "https://api.example.test/api/twilio/gather", promptHindi: "सुनने के लिए 1 दबाएँ" };
  it("identifies the AI, plays the real recording, gathers Hindi speech and DTMF", () => {
    const x = buildRecordedVoiceRelayTwiml(opts);
    expect(x).toContain(AI_DISCLOSURE.Hindi);
    expect(x.indexOf("<Say")).toBeLessThan(x.indexOf("<Play>"));
    expect(x).toContain('<Play>https://media.example.test/rec-1.mp3</Play>');
    expect(x).toContain('input="dtmf speech"'); expect(x).toContain('language="hi-IN"');
    expect(x).not.toContain("<Record");
  });
  it("refuses without consent, for another person/recording, or for unsafe URLs", () => {
    for (const bad of [{ consent: { ...consent, granted: false } }, { consent: undefined as never }, { consent: { ...consent, recordingId: "other" } }, { personId: "p2" }]) {
      expect(() => buildRecordedVoiceRelayTwiml({ ...opts, ...bad })).toThrow(/authorization_denied/);
    }
    for (const recordingUrl of ["http://media.example.test/a.mp3", "https://evil.test/a.mp3", "https://10.0.0.1/a.mp3"]) expect(() => buildRecordedVoiceRelayTwiml({ ...opts, recordingUrl })).toThrow(/unsafe_url/);
  });
  it("escapes XML in URLs", () => {
    const x = buildRecordedVoiceRelayTwiml({ ...opts, recordingUrl: "https://media.example.test/a.mp3?x=1&y=<2>" });
    expect(x).toContain("&amp;y=%3C2%3E");
  });
  it("only records the caller's reply after explicit yes", () => {
    expect(buildRecordingConsentTwiml("https://api.example.test/c")).not.toContain("<Record");
    expect(buildReplyRecordingTwiml({ choice: "yes", via: "dtmf", confidence: null }, "https://api.example.test/r")).toContain("<Record");
    for (const choice of ["no", "unknown"] as const) expect(buildReplyRecordingTwiml({ choice, via: "speech", confidence: 0.2 }, "https://api.example.test/r")).not.toContain("<Record");
  });
  it("parses DTMF and speech, and treats low confidence or unclear speech as unknown", () => {
    const p = (o: Record<string, string>) => parseGatherReply(new URLSearchParams(o));
    expect(p({ Digits: "1" })).toMatchObject({ choice: "yes", via: "dtmf" });
    expect(p({ Digits: "2" }).choice).toBe("no");
    expect(p({ Digits: "7" }).choice).toBe("unknown");
    expect(p({ SpeechResult: "हाँ।", Confidence: "0.9" }).choice).toBe("yes");
    expect(p({ SpeechResult: "नहीं", Confidence: "0.9" }).choice).toBe("no");
    expect(p({ SpeechResult: "हाँ", Confidence: "0.2" }).choice).toBe("unknown");
    expect(p({ SpeechResult: "हाँ" }).choice).toBe("unknown");
    expect(p({}).choice).toBe("unknown");
  });
  it("status callbacks need signature, matching account and a known status", () => {
    const url = "https://api.example.test/api/twilio/status";
    const params = new URLSearchParams({ AccountSid: SID, CallSid: CALL, CallStatus: "completed" });
    const sign = (p: URLSearchParams) => { let v = url; for (const k of [...p.keys()].sort()) v += k + p.get(k); return createHmac("sha1", TOKEN).update(v).digest("base64"); };
    expect(parseTwilioStatusCallback(url, params, sign(params), { authToken: TOKEN, accountSid: SID })).toEqual({ callSid: CALL, status: "completed" });
    expect(() => parseTwilioStatusCallback(url, params, "bad", { authToken: TOKEN, accountSid: SID })).toThrow(/invalid_signature/);
    const other = new URLSearchParams({ AccountSid: "AC" + "c".repeat(32), CallSid: CALL, CallStatus: "completed" });
    expect(() => parseTwilioStatusCallback(url, other, sign(other), { authToken: TOKEN, accountSid: SID })).toThrow(/unknown_identity/);
    const odd = new URLSearchParams({ AccountSid: SID, CallSid: CALL, CallStatus: "teleported" });
    expect(() => parseTwilioStatusCallback(url, odd, sign(odd), { authToken: TOKEN, accountSid: SID })).toThrow(/invalid_payload/);
  });
});

describe("TeleCMI", () => {
  const account = { appId: 2222223, virtualNumber: "440000000000" };
  const known = (d: string) => (d === "440000000001" ? { personId: "p1" } : null);
  // Shape from TeleCMI "Incoming Missed CDR" webhook docs, synthetic values.
  const hook = (over: Record<string, unknown> = {}) => ({ virtual_number: 440000000000, custom: '{"crm":"true"}', appid: 2222223, type: "cdr", direction: "inbound", cmiuuid: "4d1f9521-50e5-447d-bf5f-c3292995a727", status: "missed", from: 440000000001, time: 1634721099442, waitedsec: 127, hangup_reason: "recv_bye", voicemail: true, ...over });
  it("webhook variant: accepts a matching registered caller", async () => {
    expect(await parseTeleCmiMissedWebhook(hook(), account, known)).toMatchObject({ variant: "webhook_cdr", personId: "p1", callId: "4d1f9521-50e5-447d-bf5f-c3292995a727" });
  });
  it("webhook variant: wrong account, number or unknown caller fails closed", async () => {
    expect(await code(parseTeleCmiMissedWebhook(hook({ appid: 1 }), account, known))).toBe("unknown_identity");
    expect(await code(parseTeleCmiMissedWebhook(hook({ virtual_number: 440000000009 }), account, known))).toBe("unknown_identity");
    expect(await code(parseTeleCmiMissedWebhook(hook({ from: 440000000077 }), account, known))).toBe("unknown_identity");
  });
  it("webhook variant: answered, outbound and malformed CDRs are rejected", async () => {
    for (const bad of [null, {}, hook({ status: "answered" }), hook({ direction: "outbound" }), hook({ type: "other" }), hook({ cmiuuid: "x" }), hook({ time: "now" }), hook({ time: 5 }), hook({ from: "" })]) {
      expect(await code(parseTeleCmiMissedWebhook(bad, account, known))).toBe("invalid_payload");
    }
  });
  const pullBody = (cdr: unknown[], extra: object = {}) => json({ count: cdr.length, cdr, code: 200, ...extra });
  const row = (over: Record<string, unknown> = {}) => ({ cmiuid: "8b5f88dd-0396-4f9d-907f-7807275d2def", duration: 4, billedsec: 4, rate: 1, name: "unknown", from: 440000000001, to: 440000000000, time: 1654507446464, ...over });
  const q = { startDate: 1654500000000, endDate: 1654510000000 };
  const deps = (transport: Parameters<typeof pullTeleCmiMissedCalls>[0]["transport"]) => ({ transport, account, secret: "synthetic-secret", timeoutMs: 30 });
  it("pull variant: distinct shape (cmiuid/to, no appid), only our DID, unknown callers have null person", async () => {
    const t = scripted(pullBody([row(), row({ cmiuid: "11111111-0396-4f9d-907f-7807275d2def", from: 440000000077 }), row({ cmiuid: "22222222-0396-4f9d-907f-7807275d2def", to: 440000000099 })]));
    const out = await pullTeleCmiMissedCalls(deps(t.transport), { ...q, limit: 20 }, known);
    expect(out.calls).toHaveLength(2);
    expect(out.calls[0]).toMatchObject({ variant: "pull_cdr", personId: "p1" });
    expect(out.calls[1]!.personId).toBeNull();
    expect(t.calls[0]!.url).toBe("https://rest.telecmi.com/v2/missed");
    expect(JSON.parse(t.calls[0]!.init.body as string)).toMatchObject({ appid: 2222223, limit: 20 });
  });
  it("pull variant: rejects bad ranges, auth failure, bad rows, timeouts", async () => {
    const t = scripted();
    expect(await code(pullTeleCmiMissedCalls(deps(t.transport), { ...q, limit: 21 }, known))).toBe("invalid_payload");
    expect(await code(pullTeleCmiMissedCalls(deps(t.transport), { startDate: 2e12, endDate: 1e12 }, known))).toBe("invalid_payload");
    expect(await code(pullTeleCmiMissedCalls(deps(scripted(json({ msg: "auth" }, 404)).transport), q, known))).toBe("provider_rejected");
    expect(await code(pullTeleCmiMissedCalls(deps(scripted(pullBody([], { code: 400 })).transport), q, known))).toBe("provider_rejected");
    expect(await code(pullTeleCmiMissedCalls(deps(scripted(pullBody([{ cmiuid: "bad" }])).transport), q, known))).toBe("invalid_payload");
    expect(await code(pullTeleCmiMissedCalls(deps(scripted(hang()).transport), q, known))).toBe("provider_unavailable");
    expect(t.calls).toHaveLength(0);
  });
  it("errors do not include the secret", async () => {
    try { await pullTeleCmiMissedCalls(deps(scripted(json({}, 404)).transport), q, known); } catch (e) { expect(String(e) + JSON.stringify(e)).not.toContain("synthetic-secret"); }
  });
});

describe("audio", () => {
  it("chunk plan never exceeds 28s and covers the whole duration", () => {
    for (const d of [0.5, 28, 28.01, 56, 100, 3600]) {
      const plan = planAudioChunks(d);
      expect(plan.every((c) => c.endSeconds - c.startSeconds <= 28 + 1e-9)).toBe(true);
      expect(plan[0]!.startSeconds).toBe(0); expect(plan.at(-1)!.endSeconds).toBe(d);
      plan.slice(1).forEach((c, i) => expect(c.startSeconds).toBe(plan[i]!.endSeconds));
    }
    for (const bad of [0, -1, NaN, Infinity, 3601]) expect(() => planAudioChunks(bad)).toThrow();
    expect(() => planAudioChunks(60, 30)).toThrow();
  });
  it("AI disclosure always prefixes synthetic speech", () => {
    expect(withAiDisclosure("दवाई लें").startsWith(AI_DISCLOSURE.Hindi)).toBe(true);
    expect(withAiDisclosure("take medicine", "English").startsWith(AI_DISCLOSURE.English)).toBe(true);
  });
  it("mocks work without network and long audio is transcribed in <=28s pieces", async () => {
    const audio: AudioBlob = { format: "wav", data: new Uint8Array(1), durationSeconds: 70 };
    const stt = new MockSpeechToText(["a", "b", "c"]);
    const sizes: number[] = [];
    const text = await transcribeInChunks(audio, async (a, c) => { sizes.push(c.endSeconds - c.startSeconds); return { ...a, durationSeconds: c.endSeconds - c.startSeconds }; }, stt, "hi-IN");
    expect(text).toBe("a b c"); expect(Math.max(...sizes)).toBeLessThanOrEqual(28);
    const conv = new MockAudioConverter();
    expect((await conv.convert(audio, "mulaw_8k")).format).toBe("mulaw_8k");
    const tts = new MockTextToSpeech(); await tts.synthesize("x", "hi-IN"); expect(tts.spoken).toEqual(["x"]);
  });
  it("a slicer that returns an over-long piece is rejected", async () => {
    const audio: AudioBlob = { format: "wav", data: new Uint8Array(1), durationSeconds: 30 };
    await expect(transcribeInChunks(audio, async (a) => ({ ...a, durationSeconds: 30 }), new MockSpeechToText(), "hi-IN")).rejects.toThrow(/invalid_payload/);
  });
});
