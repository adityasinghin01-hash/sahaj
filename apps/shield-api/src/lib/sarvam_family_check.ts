import type { Sql } from "postgres";
import { canonicalJson, computeChainHash } from "@/ports/sign";
import { normalizeWhatsappReply, type WhatsappAnswer } from "./whatsapp_inbound";

/**
 * Family-check answer that comes back from the Sarvam RESPONDER call (no WhatsApp).
 *
 * family_check rings the family member through `calls.startResponderCall` (key `calls:responder:<check_id>`). When that
 * call ends, Sarvam posts to the secret-path webhook `/api/sarvam/webhook/<SARVAM_WEBHOOK_SECRET>` with the
 * webhook_config metadata WE set (family_id, person_id, receipt_id, purpose=responder) and the call's final agent
 * variables (check_id + the spoken answer). The answer is recorded only when all of these match stored rows:
 *   - a responder call row for exactly this check (`dev_outbox.dedupe_key = calls:responder:<check_id>`, same family)
 *     whose id is the `receipt_id` we sent,
 *   - the check is in this family, was asked of this person, is still `asked` and is under 30 minutes old.
 * Same states/columns and timeline chain as the WhatsApp answer store (whatsapp_inbound.ts).
 */
export interface ResponderAnswerInput {
  familyId: string;
  personId: string;
  receiptId: string;
  checkId: string;
  answer: WhatsappAnswer;
  at: Date;
}
export type ResponderAnswerResult = "recorded" | "no_responder_call" | "no_open_check";

export interface SarvamFamilyCheckStore {
  recordResponderAnswer(input: ResponderAnswerInput): Promise<ResponderAnswerResult>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Reads check_id + answer from the post-call body. Sarvam sends the call's variables as final_agent_variables. */
export function parseResponderAnswer(body: Record<string, unknown>): { checkId: string; answer: WhatsappAnswer; receiptId: string; personId: string } | null {
  const nested = record(body.data);
  const meta = record(body.metadata ?? nested.metadata);
  const finals = record(body.final_agent_variables ?? nested.final_agent_variables);
  const vars = record(body.agent_variables ?? nested.agent_variables);
  const checkId = [finals.check_id, vars.check_id, meta.check_id, finals.incident_id].find((v) => typeof v === "string" && UUID_RE.test(v));
  const receiptId = [meta.receipt_id, vars.receipt_id].find((v) => typeof v === "string" && UUID_RE.test(v));
  // The person we rang: webhook metadata person_id (calls.ts), never parent_id (agent variables default it to the callee).
  const personId = [meta.person_id, vars.person_id].find((v) => typeof v === "string" && UUID_RE.test(v));
  const answer = normalizeWhatsappReply(finals.family_check_answer ?? vars.family_check_answer ?? body.family_check_answer);
  if (typeof checkId !== "string" || typeof receiptId !== "string" || typeof personId !== "string" || !answer) return null;
  return { checkId, answer, receiptId, personId };
}

export function createPgSarvamFamilyCheckStore(sql: Sql): SarvamFamilyCheckStore {
  return {
    async recordResponderAnswer({ familyId, personId, receiptId, checkId, answer, at }) {
      return sql.begin(async (tx) => {
        await tx`set local statement_timeout = '2s'`;
        const [call] = await tx<{ id: string }[]>`
          select id from public.dev_outbox
          where id=${receiptId} and dedupe_key=${`calls:responder:${checkId}`} and family_id=${familyId} and channel='calls'
          limit 1`;
        if (!call) return "no_responder_call" as const;
        await tx`select pg_advisory_xact_lock(hashtextextended(${`family_check:${checkId}`}, 0))`;
        const [check] = await tx<{ id: string; parent_id: string }[]>`
          update public.family_checks set state=${answer}, answered_at=${at}::timestamptz
          where id=${checkId} and family_id=${familyId} and asked_person_id=${personId} and state='asked'
            and created_at >= ${at}::timestamptz - interval '30 minutes'
          returning id, parent_id`;
        if (!check) return "no_open_check" as const;
        const eventKey = `sarvam:responder:${checkId}`;
        const entry = {
          familyId, parentId: check.parent_id, eventKey, step: "shield.family_check.answered", status: "ok" as const,
          details: { check_id: checkId, person_id: personId, answer, channel: "sarvam_responder_call" },
        };
        // Same chain lock, canonical serialization and hash as createTimelineSigner (see whatsapp_inbound.ts).
        await tx`select pg_advisory_xact_lock(hashtextextended('shield.dev_timeline', 0))`;
        const [latest] = await tx<{ hash: string }[]>`select hash from public.dev_timeline order by seq desc limit 1`;
        const prevHash = latest?.hash ?? "0".repeat(64);
        const hash = computeChainHash(prevHash, entry);
        await tx`insert into public.dev_timeline
          (family_id, parent_id, event_key, kind, step, status, entry, prev_hash, hash)
          values (${familyId}, ${check.parent_id}, ${eventKey}, 'brain', ${entry.step}, 'ok',
            ${tx.json(JSON.parse(canonicalJson(entry)))}, ${prevHash}, ${hash})`;
        return "recorded" as const;
      }) as Promise<ResponderAnswerResult>;
    },
  };
}
