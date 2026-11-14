import { describe, expect, it } from "vitest";
import { fetchTwilioRecording } from "../src/twilio-recording";
import { auth, code, hang, PERSON, req, scripted } from "./helpers";

const SID = "AC" + "a".repeat(32), REC = "RE" + "c".repeat(32), TOKEN = "synthetic-twilio-token";
const wav = (body: BodyInit | null = new Uint8Array([82, 73, 70, 70]), type = "audio/x-wav", status = 200) =>
  new Response(body, { status, headers: { "content-type": type } });
const request = (over = {}) => req("twilio.recording.read", { recordingSid: REC }, over);
const cfg = (transport: Parameters<typeof fetchTwilioRecording>[0]["transport"]) => ({ transport, accountSid: SID, authToken: TOKEN, timeoutMs: 30 });

describe("fetchTwilioRecording", () => {
  it("builds the URL only from validated SIDs and sends basic auth", async () => {
    const t = scripted(wav());
    const res = await fetchTwilioRecording(cfg(t.transport), request());
    expect(res.data.audio.length).toBe(4);
    expect(t.calls[0]!.url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${SID}/Recordings/${REC}.wav`);
    expect((t.calls[0]!.init.headers as Record<string, string>).Authorization).toMatch(/^Basic /);
  });
  it("rejects SIDs that could redirect the request", async () => {
    for (const recordingSid of ["RE../../x", `${REC}/../../Calls`, "https://evil.test/a", "RE" + "c".repeat(31), ""]) {
      const t = scripted();
      expect(await code(fetchTwilioRecording(cfg(t.transport), request({ payload: { recordingSid } })))).toBe("invalid_payload");
      expect(t.calls).toHaveLength(0);
    }
  });
  it("denies without matching authorization, with no network call", async () => {
    const t = scripted();
    expect(await code(fetchTwilioRecording(cfg(t.transport), request({ authorization: auth("twilio.create_call") })))).toBe("authorization_denied");
    expect(await code(fetchTwilioRecording(cfg(t.transport), request({ authorization: auth("twilio.recording.read", { consent: false }) })))).toBe("authorization_denied");
    expect(await code(fetchTwilioRecording(cfg(t.transport), request({ personId: "someone-else", authorization: auth("twilio.recording.read", { personId: PERSON }) })))).toBe("authorization_denied");
    expect(t.calls).toHaveLength(0);
  });
  it("refuses wrong content type, empty body, redirects and oversized bodies", async () => {
    expect(await code(fetchTwilioRecording(cfg(scripted(wav(new Uint8Array([1]), "text/html")).transport), request()))).toBe("provider_rejected");
    expect(await code(fetchTwilioRecording(cfg(scripted(wav(new Uint8Array())).transport), request()))).toBe("provider_rejected");
    expect(await code(fetchTwilioRecording(cfg(scripted(new Response(null, { status: 302, headers: { location: "https://evil.test/a.wav" } })).transport), request()))).toBe("provider_rejected");
    expect(await code(fetchTwilioRecording(cfg(scripted(wav(new Uint8Array(100))).transport), request(), { maxBytes: 10 }))).toBe("payload_too_large");
  });
  it("timeouts and server errors are retryable reads, not delivery_unknown", async () => {
    expect(await code(fetchTwilioRecording(cfg(scripted(hang()).transport), request()))).toBe("provider_unavailable");
    expect(await code(fetchTwilioRecording(cfg(scripted(wav(null, "text/plain", 503)).transport), request()))).toBe("provider_unavailable");
  });
  it("caps maxBytes above the bucket limit", async () => {
    expect(await code(fetchTwilioRecording(cfg(scripted().transport), request(), { maxBytes: 51 * 1024 * 1024 }))).toBe("invalid_payload");
  });
});
