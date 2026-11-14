import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { fetchWhatsAppMedia, parseWhatsAppWebhook, sendWhatsAppAudio, sendWhatsAppButtons, sendWhatsAppText, verifyWhatsAppChallenge, type WhatsAppSendDeps } from "../src/whatsapp";
import { KEY, MemoryLedger, PHONE, code, hang, json, req, scripted } from "./helpers";

const cfg = (transport: WhatsAppSendDeps["transport"], ledger = new MemoryLedger()): WhatsAppSendDeps => ({ transport, ledger, accessToken: "synthetic-token", phoneNumberId: "100000000000001", graphVersion: "v23.0", timeoutMs: 30 });
const ok = () => json({ messages: [{ id: "wamid.1" }] });

describe("send", () => {
  it("sends text with bearer auth to the configured phone number id", async () => {
    const t = scripted(ok()); const deps = cfg(t.transport);
    const r = await sendWhatsAppText(deps, req("whatsapp.send_text", { to: PHONE, body: "Namaste" }));
    expect(r.data.messageId).toBe("wamid.1");
    expect(t.calls[0]!.url).toBe("https://graph.facebook.com/v23.0/100000000000001/messages");
    expect(JSON.parse(t.calls[0]!.init.body as string)).toMatchObject({ messaging_product: "whatsapp", to: PHONE.slice(1), type: "text" });
    expect((t.calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer synthetic-token");
    expect((deps.ledger as MemoryLedger).state.get(KEY)).toBe("dispatched:wamid.1");
  });
  it("validates button count, title length, id length and duplicates", async () => {
    const t = scripted(ok());
    const b = (n: number, title = "OK", id = "x") => Array.from({ length: n }, (_, i) => ({ id: id + i, title }));
    const send = (buttons: unknown, body = "q") => sendWhatsAppButtons(cfg(t.transport), req("whatsapp.send_buttons", { to: PHONE, body, buttons: buttons as never }));
    expect(await code(send([]))).toBe("invalid_payload");
    expect(await code(send(b(4)))).toBe("invalid_payload");
    expect(await code(send(b(1, "x".repeat(21))))).toBe("invalid_payload");
    expect(await code(send(b(1, "OK", "i".repeat(257))))).toBe("invalid_payload");
    expect(await code(send([{ id: "a", title: "A" }, { id: "a", title: "B" }]))).toBe("invalid_payload");
    expect(await code(send(b(1), ""))).toBe("invalid_payload");
    expect(t.calls).toHaveLength(0);
    await send(b(3));
    expect(JSON.parse(t.calls[0]!.init.body as string).interactive.action.buttons).toHaveLength(3);
  });
  it("audio needs exactly one of id/link and the link host must be allowlisted https", async () => {
    const t = scripted(ok(), ok());
    const a = (p: object, hosts: string[] = []) => sendWhatsAppAudio(cfg(t.transport), req("whatsapp.send_audio", { to: PHONE, ...p }), hosts);
    expect(await code(a({}))).toBe("invalid_payload");
    expect(await code(a({ mediaId: "m1", link: "https://cdn.example.test/a.ogg" }))).toBe("invalid_payload");
    for (const link of ["http://cdn.example.test/a.ogg", "https://127.0.0.1/a.ogg", "https://localhost/a.ogg", "https://evil.test/a.ogg", "https://u:p@cdn.example.test/a.ogg", "https://cdn.example.test:8443/a.ogg", "https://169.254.169.254/x"]) {
      expect(await code(a({ link }, ["cdn.example.test"]))).toBe("unsafe_url");
    }
    await a({ mediaId: "m1" });
    await a({ link: "https://cdn.example.test/a.ogg" }, ["cdn.example.test"]);
    expect(t.calls).toHaveLength(2);
  });
  it("requires authorization, timeouts are delivery_unknown and never retried", async () => {
    const t = scripted(hang());
    const bad = req("whatsapp.send_text", { to: PHONE, body: "x" }, { personId: "someone-else" });
    expect(await code(sendWhatsAppText(cfg(t.transport), bad))).toBe("authorization_denied");
    const ledger = new MemoryLedger();
    expect(await code(sendWhatsAppText(cfg(t.transport, ledger), req("whatsapp.send_text", { to: PHONE, body: "x" })))).toBe("delivery_unknown");
    expect(ledger.state.get(KEY)).toBe("unknown");
    expect(await code(sendWhatsAppText(cfg(t.transport, ledger), req("whatsapp.send_text", { to: PHONE, body: "x" })))).toBe("duplicate_dispatch");
    expect(t.calls).toHaveLength(1);
  });
  it("provider 400 is a clean failure; 2xx without message id is delivery_unknown", async () => {
    const l1 = new MemoryLedger(), l2 = new MemoryLedger();
    expect(await code(sendWhatsAppText(cfg(scripted(json({ error: { message: PHONE } }, 400)).transport, l1), req("whatsapp.send_text", { to: PHONE, body: "x" })))).toBe("provider_rejected");
    expect(await code(sendWhatsAppText(cfg(scripted(json({})).transport, l2), req("whatsapp.send_text", { to: PHONE, body: "x" })))).toBe("delivery_unknown");
    expect([l1.state.get(KEY), l2.state.get(KEY)]).toEqual(["failed", "unknown"]);
  });
});

describe("fetchWhatsAppMedia", () => {
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const sha = createHash("sha256").update(bytes).digest("hex");
  const meta = (over: object = {}) => json({ url: "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1", mime_type: "audio/ogg; codecs=opus", sha256: sha, file_size: 4, id: "m1", ...over });
  const fileRes = (b = bytes) => new Response(b, { status: 200 });
  const r = (id = "m1") => req("whatsapp.media.read", { mediaId: id });
  it("downloads in two steps with auth on both and verifies sha256", async () => {
    const t = scripted(meta(), fileRes());
    const out = await fetchWhatsAppMedia(cfg(t.transport), r());
    expect(out.data.mimeType).toBe("audio/ogg");
    expect([...out.data.data]).toEqual([1, 2, 3, 4]);
    expect(t.calls.map((c) => c.url)[0]).toBe("https://graph.facebook.com/v23.0/m1");
    expect((t.calls[1]!.init as RequestInit).redirect).toBe("manual");
  });
  it("rejects unsafe media URLs, non-audio, hash mismatch and oversize", async () => {
    expect(await code(fetchWhatsAppMedia(cfg(scripted(meta({ url: "https://evil.test/x" })).transport), r()))).toBe("unsafe_url");
    expect(await code(fetchWhatsAppMedia(cfg(scripted(meta({ url: "http://lookaside.fbsbx.com/x" })).transport), r()))).toBe("unsafe_url");
    expect(await code(fetchWhatsAppMedia(cfg(scripted(meta({ mime_type: "application/pdf" })).transport), r()))).toBe("provider_rejected");
    expect(await code(fetchWhatsAppMedia(cfg(scripted(meta(), fileRes(new Uint8Array([9, 9, 9, 9]))).transport), r()))).toBe("provider_rejected");
    expect(await code(fetchWhatsAppMedia(cfg(scripted(meta({ file_size: 99999999 })).transport), r()))).toBe("payload_too_large");
    expect(await code(fetchWhatsAppMedia(cfg(scripted(meta({ sha256: undefined, file_size: undefined }), fileRes(new Uint8Array(50))).transport), r(), { maxBytes: 10 }))).toBe("payload_too_large");
  });
  it("rejects redirects and bad ids; timeouts are provider_unavailable", async () => {
    expect(await code(fetchWhatsAppMedia(cfg(scripted(meta(), new Response("", { status: 302, headers: { location: "http://169.254.169.254/" } })).transport), r()))).toBe("provider_rejected");
    expect(await code(fetchWhatsAppMedia(cfg(scripted().transport), r("../x")))).toBe("invalid_payload");
    expect(await code(fetchWhatsAppMedia(cfg(scripted(hang()).transport), r()))).toBe("provider_unavailable");
  });
});

describe("webhook parsing", () => {
  const appSecret = "app-secret";
  const sign = (raw: string) => `sha256=${createHmac("sha256", appSecret).update(raw).digest("hex")}`;
  const pn = "100000000000001";
  const body = (messages: unknown[], over: Record<string, unknown> = {}, statuses: unknown[] = []) => JSON.stringify({
    object: "whatsapp_business_account",
    entry: [{ id: "1", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { display_phone_number: "x", phone_number_id: pn, ...over }, messages, statuses } }] }],
  });
  const known = (d: string) => (d === PHONE.slice(1) ? { personId: "p1" } : null);
  const parse = (raw: string, sig: string | null = sign(raw)) => parseWhatsAppWebhook(raw, sig, { appSecret, phoneNumberId: pn }, known);
  const text = { id: "wamid.in1", from: PHONE.slice(1), type: "text", text: { body: "ha" } };

  it("parses text, button reply and audio from a registered sender", async () => {
    const raw = body([text, { id: "w2", from: PHONE.slice(1), type: "interactive", interactive: { type: "button_reply", button_reply: { id: "tok", title: "OK" } } }, { id: "w3", from: PHONE.slice(1), type: "audio", audio: { id: "media1", mime_type: "audio/ogg; codecs=opus" } }]);
    const out = await parse(raw);
    expect(out.messages.map((m) => m.kind)).toEqual(["text", "button", "audio"]);
    expect(out.messages[0]).toMatchObject({ personId: "p1" });
  });
  it("rejects invalid signature before parsing, and tampered bodies", async () => {
    const raw = body([text]);
    expect(await code(parse(raw, null))).toBe("invalid_signature");
    expect(await code(parse(raw, sign(raw + " ")))).toBe("invalid_signature");
    expect(await code(parse("{not json", sign("{not json")))).toBe("invalid_payload");
  });
  it("fails closed for another phone number id and drops unknown senders", async () => {
    expect(await code(parse(body([text], { phone_number_id: "999" })))).toBe("unknown_identity");
    const out = await parse(body([{ ...text, from: "919000000077" }]));
    expect(out.messages).toHaveLength(0);
    expect(out.rejectedMessages).toBe(1);
  });
  it("returns delivery status events for reconciliation and rejects malformed ones", async () => {
    const out = await parse(body([], {}, [{ id: "wamid.out1", status: "delivered", recipient_id: PHONE.slice(1) }]));
    expect(out.statuses).toEqual([{ messageId: "wamid.out1", status: "delivered", recipientDigits: PHONE.slice(1) }]);
    expect(await code(parse(body([], {}, [{ id: "x", status: "weird" }])))).toBe("invalid_payload");
    expect(await code(parse(JSON.stringify({ object: "page", entry: [] })))).toBe("invalid_payload");
    expect(await code(parse(body([null])))).toBe("invalid_payload");
  });
  it("ignores unsupported message types instead of guessing", async () => {
    const out = await parse(body([{ id: "w9", from: PHONE.slice(1), type: "location", location: {} }]));
    expect(out.messages).toHaveLength(0); expect(out.rejectedMessages).toBe(1);
  });
  it("verification handshake", () => {
    const q = (o: Record<string, string>) => new URLSearchParams(o);
    expect(verifyWhatsAppChallenge(q({ "hub.mode": "subscribe", "hub.challenge": "1158201444", "hub.verify_token": "tok" }), "tok")).toBe("1158201444");
    expect(() => verifyWhatsAppChallenge(q({ "hub.mode": "subscribe", "hub.challenge": "1", "hub.verify_token": "bad" }), "tok")).toThrow();
    expect(() => verifyWhatsAppChallenge(q({ "hub.mode": "subscribe", "hub.challenge": "<script>", "hub.verify_token": "tok" }), "tok")).toThrow();
    expect(() => verifyWhatsAppChallenge(q({ "hub.mode": "subscribe", "hub.challenge": "1", "hub.verify_token": "" }), "")).toThrow();
  });
});
