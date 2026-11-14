import type { Sql } from "postgres";
import { buildShieldAlert, safeText, type ShieldRuntimePorts } from "@sahaj/shield";
import { writeOutbox } from "./outbox";

const DEFAULT_GRAPH_VERSION = "v27.0";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function normalizeWhatsappDigits(phone: string | null | undefined): string | null {
  if (!phone || /[xX]/.test(phone)) return null;
  const digits = phone.replace(/[^\d]/g, "");
  return digits.length >= 10 && digits.length <= 15 ? digits : null;
}

async function sendMetaTextMessage(opts: {
  fetchFn: typeof fetch;
  token: string;
  phoneNumberId: string;
  graphVersion: string;
  to: string;
  body: string;
}): Promise<void> {
  const url = `https://graph.facebook.com/${encodeURIComponent(opts.graphVersion)}/${encodeURIComponent(opts.phoneNumberId)}/messages`;
  const res = await opts.fetchFn(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: opts.to,
      type: "text",
      text: {
        preview_url: false,
        body: opts.body.slice(0, 4096),
      },
    }),
  });
  if (!res.ok) {
    throw new Error(`WhatsApp Cloud API failed with status ${res.status}`);
  }
}

export function isWhatsappConfigured(env: Readonly<Record<string, string | undefined>>): boolean {
  return Boolean(env.WHATSAPP_TOKEN?.trim() && env.WHATSAPP_PHONE_NUMBER_ID?.trim());
}

export function createWhatsappPort(
  sql: Sql,
  env: Readonly<Record<string, string | undefined>>,
  fetchFn: typeof fetch = fetch,
): ShieldRuntimePorts["whatsapp"] {
  const token = env.WHATSAPP_TOKEN?.trim();
  const phoneNumberId = env.WHATSAPP_PHONE_NUMBER_ID?.trim();
  const graphVersion = env.WHATSAPP_GRAPH_VERSION?.trim() || DEFAULT_GRAPH_VERSION;
  const configured = Boolean(token && phoneNumberId);

  async function lookupParentName(familyId: string, parentId: string): Promise<string> {
    if (!UUID_RE.test(familyId) || !UUID_RE.test(parentId)) return "Maa";
    const [row] = await sql<{ name: string }[]>`
      select name from public.people where id = ${parentId} and family_id = ${familyId} limit 1`;
    return row?.name || "Maa";
  }

  async function lookupChildPhone(familyId: string): Promise<{ personId: string; name: string; phone: string | null } | null> {
    if (!UUID_RE.test(familyId)) return null;
    const [row] = await sql<{ id: string; name: string; phone: string | null }[]>`
      select id, name, phone
      from public.people
      where family_id = ${familyId} and role = 'child'
      order by (phone is not null and phone not like '%X%') desc, created_at asc, id asc
      limit 1`;
    return row ? { personId: row.id, name: row.name, phone: row.phone } : null;
  }

  async function lookupPersonPhone(familyId: string, personId: string): Promise<string | null> {
    if (!UUID_RE.test(familyId) || !UUID_RE.test(personId)) return null;
    const [row] = await sql<{ phone: string | null }[]>`
      select phone from public.people where id = ${personId} and family_id = ${familyId} limit 1`;
    return row?.phone ?? null;
  }

  return {
    async sendShieldAlert(card) {
      const parentName = await lookupParentName(card.familyId, card.parentId);
      const channel =
        card.verdict.actions.includes("speak_clip") && !card.verdict.actions.includes("show_red_screen")
          ? "keypad_voice"
          : "device";
      const alert = buildShieldAlert(card.verdict, { parentName, channel, lang: "en" });
      const textBody =
        card.verdict.level === "red"
          ? `${alert.title}\n${alert.body}\n\n${card.callToAction}`
          : `${alert.title}\n${alert.body}`;

      if (configured && token && phoneNumberId) {
        const child = await lookupChildPhone(card.familyId);
        const to = normalizeWhatsappDigits(child?.phone);
        if (to) {
          await sendMetaTextMessage({
            fetchFn,
            token,
            phoneNumberId,
            graphVersion,
            to,
            body: textBody,
          });
          return { delivered: "whatsapp_cloud_api", verdictId: card.verdictId };
        }
      }

      await writeOutbox(sql, {
        channel: "whatsapp",
        kind: "send_shield_alert",
        familyId: card.familyId,
        parentId: card.parentId,
        dedupeKey: `whatsapp:shield_alert:${card.verdictId}`,
        payload: {
          verdict_id: card.verdictId,
          level: card.verdict.level,
          scam_type: card.verdict.scam_type,
          quiet: card.quiet,
          offer_1930: card.offer1930,
          call_to_action: card.callToAction,
          alert,
          text_body: textBody,
        },
      });
      return { delivered: "dev_outbox", verdictId: card.verdictId };
    },

    async sendFamilyCheckCard(input) {
      const safeName = safeText(input.claimedName) || "Family member";
      const safeAsked = safeText(input.askedWhat) || "money or urgent help";
      const textBody = [
        `Sahaj Family Check`,
        `Someone claiming to be ${safeName} is asking Maa for: ${safeAsked}.`,
        `Reply CONFIRMED if it is really you, or DENIED if it is not.`,
      ].join("\n");

      if (configured && token && phoneNumberId) {
        const rawPhone = await lookupPersonPhone(input.familyId, input.toPersonId);
        const to = normalizeWhatsappDigits(rawPhone);
        if (to) {
          await sendMetaTextMessage({
            fetchFn,
            token,
            phoneNumberId,
            graphVersion,
            to,
            body: textBody,
          });
          return;
        }
      }

      await writeOutbox(sql, {
        channel: "whatsapp",
        kind: "send_family_check_card",
        familyId: input.familyId,
        dedupeKey: `whatsapp:family_check:${input.checkId}`,
        payload: {
          check_id: input.checkId,
          to_person_id: input.toPersonId,
          claimed_name: safeName,
          asked_what: safeAsked,
          text_body: textBody,
        },
      });
    },
  };
}

