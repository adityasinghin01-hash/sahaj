import type { Sql } from "postgres";
import { z } from "zod";
import type { ShieldApp } from "./app";
import { getDbPools } from "./db";
import { isAllowedSarvamIp, verifyBearerToken } from "./auth";
import { contactSenderHash } from "@/ports/contacts";
import { maskedSarvamText, sarvamBridgeLabel } from "./sarvam_variables";

type Context = { familyId: string; parentId: string };
type ParentContext = { address_form: string | null; hearing_mode: boolean; consent_done: boolean;
  last_summary: string | null; open_requests: string | null; pending_voice: string | null };
export interface SarvamStartStore {
  lookupCaller(hash: string): Promise<Context | null>;
  getParent(familyId: string, parentId: string): Promise<ParentContext | null>;
}

export function createPgSarvamStartStore(sql: Sql, env: Readonly<Record<string, string | undefined>>): SarvamStartStore {
  return {
    async lookupCaller(hash) {
      const account = env.SARVAM_APP_ID ?? env.SARVAM_AGENT_ID_CHECKIN;
      if (!account || !/^[0-9a-f]{64}$/.test(hash)) return null;
      const rows = await sql<{ family_id: string; person_id: string }[]>`
        select i.family_id, i.person_id from public.provider_identities i
        join public.people p on p.id=i.person_id and p.family_id=i.family_id and p.role='parent'
        where i.source='sarvam' and i.account_id=${account} and i.external_id_hash=${hash}
          and i.binding_kind='contact' and i.enabled and i.revoked_at is null limit 2`;
      return rows.length === 1 ? { familyId: rows[0]!.family_id, parentId: rows[0]!.person_id } : null;
    },
    async getParent(familyId, parentId) {
      const rows = await sql<ParentContext[]>`
        select coalesce(nullif(p.address_form,''),p.display_name) as address_form,
          coalesce(length(trim(p.hearing_notes))>0,false) as hearing_mode,
          coalesce((select c.answer and c.version<>'' and c.created_at>now()-interval '365 days'
            from public.consents c where c.family_id=p.family_id and c.person_id=p.id
              and c.purpose='check_in' and c.created_at<=now()
            order by c.created_at desc,c.answer asc,c.id desc limit 1),false) as consent_done,
          (select s.short_summary from public.check_in_summaries s
            where s.family_id=p.family_id and s.person_id=p.id order by s.created_at desc,s.id desc limit 1) as last_summary,
          (select string_agg(r.kind, ', ') from (select kind from public.requests
            where family_id=p.family_id and person_id=p.id and status in ('pending','approved','running')
            order by created_at desc,id desc limit 5) r) as open_requests,
          (select case when count(*)>0 then 'Aapke liye awaaz ke sandesh hain.' else '' end
            from public.voice_posts v where v.family_id=p.family_id and v.recipient_id=p.id
              and v.state in ('queued','sent','delivered')) as pending_voice
        from public.people p where p.family_id=${familyId} and p.id=${parentId} and p.role='parent' limit 1`;
      return rows[0] ?? null;
    },
  };
}

export function createSarvamStartHandler(
  getApp: () => Pick<ShieldApp, "env" | "getWeeklyTip">,
  getStore?: () => SarvamStartStore,
) {
  return async function POST(req: Request): Promise<Response> {
    const app = getApp();
    if (!verifyBearerToken(req, app.env.SARVAM_TOOL_TOKEN) || !isAllowedSarvamIp(req, app.env)) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    let raw: unknown;
    try { const text = await req.text();
      if (text.length > 8192) return Response.json({ error: "too_large" }, { status: 413 });
      raw = JSON.parse(text);
    } catch { return Response.json({ error: "invalid_request" }, { status: 400 }); }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return Response.json({ error: "invalid_request" }, { status: 400 });
    const body = raw as Record<string, unknown>;
    // Explicit malformed/unknown callers must not fall back into the demo family's identity.
    const callerKeys = ["caller_number", "caller_phone_number", "from", "user_phone_number"];
    const supplied = callerKeys.filter(key => Object.hasOwn(body, key));
    let hash: string | null = null;
    if (supplied.length) {
      // Indian telephony often sends the caller as 0XXXXXXXXXX (seen live from the Lava keypad) or bare 10 digits;
      // contacts are bound as E.164 (91XXXXXXXXXX), so normalise before validating and hashing.
      const numbers = supplied.map(key => normaliseIndianCaller(body[key]));
      if (numbers.some(value => typeof value !== "string" || !/^\+?[1-9][0-9]{9,14}$/.test(value))) {
        return Response.json({ error: "invalid_request" }, { status: 400 });
      }
      const digits = (numbers as string[]).map(value => value.replace(/^\+/, ""));
      if (new Set(digits).size !== 1) return Response.json({ error: "invalid_request" }, { status: 400 });
      hash = contactSenderHash(app.env, "sarvam", digits[0]!);
      if (!hash) return Response.json({ error: "caller_not_found" }, { status: 404 });
    }
    try {
      const store = getStore ? getStore() : createPgSarvamStartStore(getDbPools(app.env.DATABASE_URL!).auxSql, app.env);
      const context = supplied.length ? await store.lookupCaller(hash!) : {
        familyId: app.env.DEFAULT_FAMILY_ID, parentId: app.env.DEFAULT_PARENT_ID,
      };
      if (!context) return Response.json({ error: "caller_not_found" }, { status: 404 });
      const parsed = z.object({ familyId: z.string().uuid(), parentId: z.string().uuid() }).safeParse(context);
      if (!parsed.success) return Response.json({ error: "missing_context" }, { status: 400 });
      const { familyId, parentId } = parsed.data;
      const parent = await store.getParent(familyId, parentId);
      if (!parent) return Response.json({ error: "parent_not_found" }, { status: 404 });
      const tip = await app.getWeeklyTip({ family_id: familyId });
      return Response.json({ family_id: familyId, parent_id: parentId,
        address_form: maskedSarvamText(parent.address_form || "ji", 80), greeting: "Namaste",
        hearing_mode: parent.hearing_mode === true, consent_done: parent.consent_done === true,
        last_summary: maskedSarvamText(parent.last_summary || ""), open_requests: maskedSarvamText(parent.open_requests || ""),
        pending_voice: maskedSarvamText(parent.pending_voice || ""),
        fraud_tip: maskedSarvamText(tip.ok ? tip.tip.fraud_tip_hi : ""), bridge_to: sarvamBridgeLabel(app.env),
      }, { headers: { "Cache-Control": "no-store" } });
    } catch { return Response.json({ error: "context_unavailable" }, { status: 503 }); }
  };
}

/** "0XXXXXXXXXX" / "XXXXXXXXXX" (Indian mobile/landline, spaces or dashes allowed) -> "91XXXXXXXXXX"; anything else unchanged. */
export function normaliseIndianCaller(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const compact = value.trim().replace(/[\s()-]/g, "");
  if (/^0[1-9][0-9]{9}$/.test(compact)) return `91${compact.slice(1)}`;
  if (/^[6-9][0-9]{9}$/.test(compact)) return `91${compact}`;
  return compact;
}
