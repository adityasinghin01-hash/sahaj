import { createHash, timingSafeEqual } from "node:crypto";
import { AdapterError, dispatchOnce, requireAuthorization, type DispatchLedger, type FetchTransport, type ProviderRequest, type ProviderResult } from "./contracts";
import { assertE164, assertSafeUrl, digits, isRecord, parseJson, send, str } from "./http";
import { verifyWhatsAppSignature } from "./security";

const GRAPH = "https://graph.facebook.com";
const NUMERIC_ID = /^\d{1,32}$/;
const MEDIA_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** Fail closed to this exact host; deployments must explicitly configure additional verified hosts. */
export const DEFAULT_MEDIA_HOSTS = ["lookaside.fbsbx.com"] as const;
const AUDIO_TYPES = new Set(["audio/ogg", "audio/mpeg", "audio/mp4", "audio/aac", "audio/amr"]);
const MAX_MEDIA_BYTES = 16 * 1024 * 1024;

export interface WhatsAppConfig {
  transport: FetchTransport;
  accessToken: string;
  phoneNumberId: string;
  /** Graph API version such as "v23.0". Required: confirm the current supported version in Meta docs. */
  graphVersion: string;
  timeoutMs?: number;
}
export interface WhatsAppSendDeps extends WhatsAppConfig { ledger: DispatchLedger }

function checkConfig(c: WhatsAppConfig): void {
  if (!c.accessToken || !NUMERIC_ID.test(c.phoneNumberId) || !/^v\d{1,2}\.\d$/.test(c.graphVersion)) throw new AdapterError("invalid_payload", "whatsapp");
}
const cleanTo = (to: string) => assertE164(to).slice(1);

async function post(deps: WhatsAppSendDeps, request: ProviderRequest<unknown>, action: string, message: Record<string, unknown>): Promise<ProviderResult<{ messageId: string }>> {
  return dispatchOnce(deps.ledger, request, "whatsapp", action, async () => {
    const res = await send(`${GRAPH}/${deps.graphVersion}/${deps.phoneNumberId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${deps.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", ...message }),
    }, { provider: "whatsapp", transport: deps.transport, timeoutMs: deps.timeoutMs, readOnly: false });
    let id: string | undefined;
    try {
      const messages = parseJson(res.body, "whatsapp").messages;
      if (Array.isArray(messages) && isRecord(messages[0])) id = str(messages[0].id, 256);
    } catch { /* handled below */ }
    if (!id) throw new AdapterError("delivery_unknown", "whatsapp");
    return { data: { messageId: id }, providerRef: id };
  });
}

/** Authorization action: "whatsapp.send_text". */
export async function sendWhatsAppText(deps: WhatsAppSendDeps, request: ProviderRequest<{ to: string; body: string }>): Promise<ProviderResult<{ messageId: string }>> {
  requireAuthorization(request, "whatsapp.send_text"); checkConfig(deps);
  const { to, body } = request.payload;
  if (typeof body !== "string" || body.length < 1 || body.length > 4096) throw new AdapterError("invalid_payload", "whatsapp");
  return post(deps, request, "whatsapp.send_text", { to: cleanTo(to), type: "text", text: { preview_url: false, body } });
}

export interface ReplyButton { id: string; title: string }
/** Reply buttons: 1 to 3, title <= 20 chars, id <= 256 (use signWhatsAppButton output). Authorization action: "whatsapp.send_buttons". */
export async function sendWhatsAppButtons(deps: WhatsAppSendDeps, request: ProviderRequest<{ to: string; body: string; buttons: ReplyButton[] }>): Promise<ProviderResult<{ messageId: string }>> {
  requireAuthorization(request, "whatsapp.send_buttons"); checkConfig(deps);
  const { to, body, buttons } = request.payload;
  if (typeof body !== "string" || body.length < 1 || body.length > 1024 || !Array.isArray(buttons) || buttons.length < 1 || buttons.length > 3 ||
      new Set(buttons.map((b) => b?.id)).size !== buttons.length ||
      buttons.some((b) => !b || typeof b.id !== "string" || b.id.length < 1 || b.id.length > 256 || typeof b.title !== "string" || b.title.length < 1 || b.title.length > 20)) {
    throw new AdapterError("invalid_payload", "whatsapp");
  }
  return post(deps, request, "whatsapp.send_buttons", {
    to: cleanTo(to), type: "interactive",
    interactive: { type: "button", body: { text: body }, action: { buttons: buttons.map((b) => ({ type: "reply", reply: { id: b.id, title: b.title } })) } },
  });
}

/** Audio by uploaded media id or by an https link on an allowlisted host. Authorization action: "whatsapp.send_audio". */
export async function sendWhatsAppAudio(deps: WhatsAppSendDeps, request: ProviderRequest<{ to: string; mediaId?: string; link?: string }>, allowedLinkHosts: readonly string[] = []): Promise<ProviderResult<{ messageId: string }>> {
  requireAuthorization(request, "whatsapp.send_audio"); checkConfig(deps);
  const { to, mediaId, link } = request.payload;
  if ((mediaId === undefined) === (link === undefined)) throw new AdapterError("invalid_payload", "whatsapp");
  let audio: Record<string, string>;
  if (mediaId !== undefined) {
    if (!MEDIA_ID.test(mediaId)) throw new AdapterError("invalid_payload", "whatsapp");
    audio = { id: mediaId };
  } else {
    audio = { link: assertSafeUrl(link!, allowedLinkHosts, "whatsapp").toString() };
  }
  return post(deps, request, "whatsapp.send_audio", { to: cleanTo(to), type: "audio", audio });
}

/**
 * Download inbound media in two steps (id -> short-lived URL -> bytes). The URL is validated
 * against the host allowlist, redirects are refused, size is capped and sha256 is checked when provided.
 * Authorization action: "whatsapp.media.read".
 */
export async function fetchWhatsAppMedia(
  deps: WhatsAppConfig,
  request: ProviderRequest<{ mediaId: string }>,
  opts: { maxBytes?: number; allowedHosts?: readonly string[] } = {},
): Promise<ProviderResult<{ data: Uint8Array; mimeType: string }>> {
  requireAuthorization(request, "whatsapp.media.read"); checkConfig(deps);
  const { mediaId } = request.payload;
  if (!MEDIA_ID.test(mediaId)) throw new AdapterError("invalid_payload", "whatsapp");
  const max = opts.maxBytes ?? MAX_MEDIA_BYTES;
  const auth = { Authorization: `Bearer ${deps.accessToken}` };
  const meta = await send(`${GRAPH}/${deps.graphVersion}/${mediaId}`, { method: "GET", headers: auth },
    { provider: "whatsapp", transport: deps.transport, timeoutMs: deps.timeoutMs, readOnly: true });
  const info = parseJson(meta.body, "whatsapp");
  const mime = typeof info.mime_type === "string" ? info.mime_type.split(";")[0]!.trim().toLowerCase() : "";
  if (typeof info.url !== "string" || !AUDIO_TYPES.has(mime)) throw new AdapterError("provider_rejected", "whatsapp");
  if (typeof info.file_size === "number" && info.file_size > max) throw new AdapterError("payload_too_large", "whatsapp");
  const url = assertSafeUrl(info.url, opts.allowedHosts ?? DEFAULT_MEDIA_HOSTS, "whatsapp");
  const file = await send(url.toString(), { method: "GET", headers: auth },
    { provider: "whatsapp", transport: deps.transport, timeoutMs: deps.timeoutMs ?? 30_000, maxBytes: max, readOnly: true });
  if (typeof info.sha256 === "string" && /^[a-f0-9]{64}$/i.test(info.sha256)) {
    const actual = createHash("sha256").update(file.body).digest();
    const expected = Buffer.from(info.sha256, "hex");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new AdapterError("provider_rejected", "whatsapp");
  }
  return { provider: "whatsapp", idempotencyKey: request.idempotencyKey, data: { data: file.body, mimeType: mime } };
}

/** GET subscription handshake. Returns the challenge to echo. */
export function verifyWhatsAppChallenge(query: URLSearchParams, verifyToken: string): string {
  const challenge = query.get("hub.challenge");
  const given = Buffer.from(query.get("hub.verify_token") ?? ""), want = Buffer.from(verifyToken);
  if (!verifyToken || query.get("hub.mode") !== "subscribe" || !challenge || !/^\d{1,20}$/.test(challenge) || given.length !== want.length || !timingSafeEqual(given, want)) {
    throw new AdapterError("invalid_signature", "whatsapp");
  }
  return challenge;
}

export type WhatsAppInbound =
  | { kind: "text"; messageId: string; personId: string; from: string; text: string }
  | { kind: "button"; messageId: string; personId: string; from: string; buttonId: string }
  | { kind: "audio"; messageId: string; personId: string; from: string; mediaId: string; mimeType: string };
export interface WhatsAppStatus { messageId: string; status: "sent" | "delivered" | "read" | "failed"; recipientDigits: string }
export interface WhatsAppParsed { messages: WhatsAppInbound[]; statuses: WhatsAppStatus[]; rejectedMessages: number }

/**
 * Verify the raw-byte HMAC first, then parse. Only messages for the configured phone number id and from
 * registered senders are returned; others are counted in rejectedMessages. Invalid signature or a payload
 * for another business number throws.
 */
export async function parseWhatsAppWebhook(
  rawBody: Uint8Array | string,
  signature: string | null,
  cfg: { appSecret: string; phoneNumberId: string },
  resolveSender: (fromDigits: string) => Promise<{ personId: string } | null> | { personId: string } | null,
): Promise<WhatsAppParsed> {
  if (!verifyWhatsAppSignature(rawBody, signature, cfg.appSecret)) throw new AdapterError("invalid_signature", "whatsapp");
  if ((typeof rawBody === "string" ? Buffer.byteLength(rawBody) : rawBody.byteLength) > 1_000_000) throw new AdapterError("payload_too_large", "whatsapp");
  let root: unknown;
  try { root = JSON.parse(typeof rawBody === "string" ? rawBody : new TextDecoder("utf-8", { fatal: true }).decode(rawBody)); } catch { throw new AdapterError("invalid_payload", "whatsapp"); }
  if (!isRecord(root) || root.object !== "whatsapp_business_account" || !Array.isArray(root.entry)) throw new AdapterError("invalid_payload", "whatsapp");
  const out: WhatsAppParsed = { messages: [], statuses: [], rejectedMessages: 0 };
  for (const entry of root.entry) {
    if (!isRecord(entry) || !Array.isArray(entry.changes)) throw new AdapterError("invalid_payload", "whatsapp");
    for (const change of entry.changes) {
      if (!isRecord(change) || change.field !== "messages" || !isRecord(change.value)) continue;
      const value = change.value;
      if (!isRecord(value.metadata) || value.metadata.phone_number_id !== cfg.phoneNumberId) throw new AdapterError("unknown_identity", "whatsapp");
      for (const s of Array.isArray(value.statuses) ? value.statuses : []) {
        if (!isRecord(s)) throw new AdapterError("invalid_payload", "whatsapp");
        const id = str(s.id, 256);
        if (!id || (s.status !== "sent" && s.status !== "delivered" && s.status !== "read" && s.status !== "failed")) throw new AdapterError("invalid_payload", "whatsapp");
        out.statuses.push({ messageId: id, status: s.status, recipientDigits: digits(s.recipient_id) });
      }
      for (const m of Array.isArray(value.messages) ? value.messages : []) {
        if (!isRecord(m)) throw new AdapterError("invalid_payload", "whatsapp");
        const id = str(m.id, 256), from = digits(m.from);
        if (!id || !from) throw new AdapterError("invalid_payload", "whatsapp");
        const who = await resolveSender(from);
        if (!who?.personId) { out.rejectedMessages++; continue; }
        const base = { messageId: id, personId: who.personId, from };
        if (m.type === "text" && isRecord(m.text) && typeof m.text.body === "string") out.messages.push({ kind: "text", ...base, text: m.text.body.slice(0, 4096) });
        else if (m.type === "interactive" && isRecord(m.interactive) && m.interactive.type === "button_reply" && isRecord(m.interactive.button_reply) && str(m.interactive.button_reply.id, 256))
          out.messages.push({ kind: "button", ...base, buttonId: m.interactive.button_reply.id as string });
        else if (m.type === "audio" && isRecord(m.audio) && typeof m.audio.id === "string" && MEDIA_ID.test(m.audio.id))
          out.messages.push({ kind: "audio", ...base, mediaId: m.audio.id, mimeType: typeof m.audio.mime_type === "string" ? m.audio.mime_type.slice(0, 100) : "" });
        else out.rejectedMessages++; // unsupported type: ignore, do not guess
      }
    }
  }
  return out;
}

