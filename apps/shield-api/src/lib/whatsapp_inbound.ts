import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Sql } from "postgres";
import { contactSenderHash } from "@/ports/contacts";
import { canonicalJson, computeChainHash } from "@/ports/sign";

export type WhatsappAnswer = "confirmed" | "denied";
export interface WhatsappAnswerInput {
  messageKey: string;
  /** Foundation HMAC identity index (kept under this DTO field for compatibility). */
  phoneHash: string;
  answer: WhatsappAnswer;
  at: Date;
}
export interface WhatsappInboundStore {
  recordAnswer(input: WhatsappAnswerInput): Promise<void>;
}
interface WhatsappInboundApp {
  env: Readonly<Record<string, string | undefined>>;
  whatsappInboundStore?: WhatsappInboundStore;
  whatsappInboundWaitUntil?: (promise: Promise<unknown>) => void;
}
const MAX_BODY = 256 * 1024;
const sha256 = (value: string) => createHash("sha256").update(value).digest();
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

export function normalizeWhatsappReply(value: unknown): WhatsappAnswer | null {
  if (typeof value !== "string") return null;
  const text = value.trim().toLowerCase();
  if (["confirmed", "haan", "ha", "yes", "1"].includes(text)) return "confirmed";
  if (["denied", "nahi", "na", "no", "2"].includes(text)) return "denied";
  return null;
}
function reply(message: Record<string, unknown>): WhatsappAnswer | null {
  if (message.type === "text") return normalizeWhatsappReply(object(message.text).body);
  if (message.type === "button") {
    const button = object(message.button);
    return normalizeWhatsappReply(button.payload) ?? normalizeWhatsappReply(button.text);
  }
  if (message.type === "interactive") {
    const interactive = object(message.interactive);
    const button = object(interactive.button_reply ?? interactive.list_reply);
    return normalizeWhatsappReply(button.id) ?? normalizeWhatsappReply(button.title);
  }
  return null;
}

/** No answer writer is exposed by ShieldRuntime/ShieldToolsDb; use their same states/columns.
 * dev_cache's link-only cache port has no atomic claim. This transaction claims a hashed ID,
 * answers the newest pending check, and signs using the existing timeline chain algorithm.
 */
export function createPgWhatsappInboundStore(sql: Sql, env: Readonly<Record<string, string | undefined>> = process.env): WhatsappInboundStore {
  return {
    async recordAnswer({ messageKey, phoneHash, answer, at }) {
      await sql.begin(async (tx) => {
        await tx`set local statement_timeout = '2s'`;
        const claimed = await tx`
          insert into public.dev_cache (key, value, expires_at, updated_at)
          values (${messageKey}, '{"seen":true}'::jsonb, ${at}::timestamptz + interval '24 hours', ${at}::timestamptz)
          on conflict (key) do update set value=excluded.value, expires_at=excluded.expires_at, updated_at=excluded.updated_at
          where dev_cache.expires_at <= ${at}::timestamptz
          returning key`;
        if (!claimed.length) return;
        // The webhook reduces its sender to the foundation HMAC index before background work.
        const people = await tx<{ id: string; family_id: string }[]>`
          select person_id as id, family_id from public.provider_identities
          where source='whatsapp' and account_id=${env.WHATSAPP_PHONE_NUMBER_ID ?? ""}
            and binding_kind='contact' and enabled and revoked_at is null
            and external_id_hash=${phoneHash} limit 2`;
        // Ambiguous routing numbers must not choose a family arbitrarily.
        if (people.length !== 1) return;
        const person = people[0]!;
        await tx`select pg_advisory_xact_lock(hashtextextended(${`whatsapp:person:${person.id}`}, 0))`;
        const [check] = await tx<{ id: string; parent_id: string }[]>`
          select id, parent_id from public.family_checks
          where family_id=${person.family_id} and asked_person_id=${person.id} and state='asked'
            and created_at >= ${at}::timestamptz - interval '30 minutes' and created_at <= ${at}::timestamptz
          order by created_at desc, id desc limit 1 for update`;
        if (!check) return;
        await tx`update public.family_checks set state=${answer}, answered_at=${at}::timestamptz
          where id=${check.id} and state='asked'`;
        const entry = {
          familyId: person.family_id, parentId: check.parent_id,
          eventKey: messageKey, step: "shield.family_check.answered", status: "ok" as const,
          details: { check_id: check.id, person_id: person.id, answer, channel: "whatsapp" },
        };
        // Same chain lock, canonical serialization and hash as createTimelineSigner;
        // kept inside this transaction so failed signing rolls back the answer and replay marker.
        await tx`select pg_advisory_xact_lock(hashtextextended('shield.dev_timeline', 0))`;
        const [latest] = await tx<{ hash: string }[]>`select hash from public.dev_timeline order by seq desc limit 1`;
        const prevHash = latest?.hash ?? "0".repeat(64);
        const hash = computeChainHash(prevHash, entry);
        await tx`insert into public.dev_timeline
          (family_id, parent_id, event_key, kind, step, status, entry, prev_hash, hash)
          values (${entry.familyId}, ${entry.parentId}, ${messageKey}, 'brain', ${entry.step}, 'ok',
            ${tx.json(JSON.parse(canonicalJson(entry)))}, ${prevHash}, ${hash})`;
      });
    },
  };
}

export function createWhatsappWebhookHandlers(
  getApp: () => WhatsappInboundApp,
  getEnv: () => Readonly<Record<string, string | undefined>> = () => getApp().env,
) {
  return {
    async GET(req: Request): Promise<Response> {
      const url = new URL(req.url);
      const token = getEnv().WHATSAPP_VERIFY_TOKEN;
      const supplied = url.searchParams.get("hub.verify_token");
      if (!token || !supplied || url.searchParams.get("hub.mode") !== "subscribe" ||
          !timingSafeEqual(sha256(token), sha256(supplied))) {
        console.info(JSON.stringify({ evt: "shield.whatsapp_webhook.verify", ok: false }));
        return new Response("Forbidden", { status: 403 });
      }
      console.info(JSON.stringify({ evt: "shield.whatsapp_webhook.verify", ok: true }));
      return new Response(url.searchParams.get("hub.challenge") ?? "", { headers: { "content-type": "text/plain; charset=utf-8" } });
    },
    async POST(req: Request): Promise<Response> {
      const secret = getEnv().WHATSAPP_APP_SECRET;
      if (!secret || secret.length < 32) return Response.json({ error: "not_configured" }, { status: 500 });
      const signature = req.headers.get("x-hub-signature-256") ?? "";
      if (!/^sha256=[a-f0-9]{64}$/i.test(signature)) return Response.json({ error: "unauthorized" }, { status: 401 });
      const reader = req.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        if (Number(req.headers.get("content-length")) > MAX_BODY) return Response.json({ error: "body_too_large" }, { status: 413 });
        if (reader) {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.byteLength;
            if (size > MAX_BODY) {
              void reader.cancel().catch(() => undefined);
              return Response.json({ error: "body_too_large" }, { status: 413 });
            }
            chunks.push(chunk.value);
          }
        }
      } catch { return Response.json({ error: "invalid_body" }, { status: 400 }); }
      finally { reader?.releaseLock(); }
      const raw = Buffer.concat(chunks);
      const expected = createHmac("sha256", secret).update(raw).digest();
      if (!timingSafeEqual(expected, Buffer.from(signature.slice(7), "hex"))) {
        console.info(JSON.stringify({ evt: "shield.whatsapp_webhook.post", signature: "bad" }));
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      let payload: unknown;
      try { payload = JSON.parse(raw.toString("utf8")); }
      catch { return Response.json({ ok: true }); }
      // Reduce to enums and hashes before handing anything to background work.
      const answers: WhatsappAnswerInput[] = [];
      let messageCount = 0, statusCount = 0;
      for (const entry of array(object(payload).entry)) {
        for (const change of array(object(entry).changes)) {
          statusCount += array(object(object(change).value).statuses).length;
          for (const item of array(object(object(change).value).messages)) {
            messageCount += 1;
            const message = object(item);
            const answer = reply(message);
            if (!answer || typeof message.id !== "string" || !message.id ||
                typeof message.from !== "string" || !/^[1-9][0-9]{9,14}$/.test(message.from)) continue;
            const account = object(object(change).value).metadata;
            if (object(account).phone_number_id !== getEnv().WHATSAPP_PHONE_NUMBER_ID) continue;
            const phoneHash = contactSenderHash(getEnv(), "whatsapp", message.from);
            if (phoneHash) answers.push({ phoneHash, answer, at: new Date(), messageKey: `whatsapp:inbound:${sha256(message.id).toString("hex")}` });
          }
        }
      }
      // Ops visibility for webhook delivery checks: counts and enums only.
      console.info(JSON.stringify({ evt: "shield.whatsapp_webhook.post", signature: "ok", messages: messageCount,
        statuses: statusCount, family_check_answers: answers.length }));
      if (answers.length) {
        try {
          const app = getApp();
          const store = app.whatsappInboundStore;
          if (!store) throw new Error("inbound_store_missing");
          const work = (async () => {
            for (const answer of answers) {
              try { await store.recordAnswer(answer); }
              catch { console.error("shield.whatsapp_inbound.store_failed"); }
            }
          })();
          if (app.whatsappInboundWaitUntil) app.whatsappInboundWaitUntil(work);
          else await work;
        } catch { console.error("shield.whatsapp_inbound.unavailable"); }
      }
      return Response.json({ ok: true });
    },
  };
}
