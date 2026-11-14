import { createHash } from "node:crypto";
import type { Sql } from "postgres";
import { mask, maskDigits, type ShieldRuntimePorts } from "@sahaj/shield";
import { createContactsPort } from "./contacts";
import { writeOutbox } from "./outbox";
import { claimProvider, finishProvider } from "../lib/app_provider";
import { drillOpening, maskedSarvamText, sarvamBridgeLabel } from "../lib/sarvam_variables";

// Verified 2026-11-14: https://docs.sarvam.ai/voice-agents/api/instant-outbound/create.md
const DRILL_UUID_RE = /^exp\.[a-z_]+\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True only when every Sarvam outbound setting for this purpose is present and outbound is switched on. */
export function isSarvamOutboundConfigured(
  env: Readonly<Record<string, string | undefined>>,
  purpose: "CHECKIN" | "RESPONDER" | "CALLBACK" | "EXPERIENCE",
): boolean {
  return Boolean(
    env.SARVAM_API_KEY &&
      env.SARVAM_ORG_ID &&
      env.SARVAM_WORKSPACE_ID &&
      env[`SARVAM_AGENT_ID_${purpose}`] &&
      env.SARVAM_CONNECTION_ID &&
      env.SARVAM_AGENT_PHONE_NUMBER &&
      env.SARVAM_WEBHOOK_URL &&
      env.SARVAM_OUTBOUND_ENABLED === "1",
  );
}

export type SarvamCallsPort = ShieldRuntimePorts["calls"] & {
  placeCheckinRetry(input: { familyId: string; parentId: string; streakId: string; jobId: string }): Promise<{ placed: boolean }>;
};

export function createCallsPort(
  sql: Sql,
  env: Readonly<Record<string, string | undefined>>,
  fetchFn: typeof fetch = fetch,
): SarvamCallsPort {
  const contacts = createContactsPort(sql, env);
  async function outbound(
    purpose: "CHECKIN" | "RESPONDER" | "CALLBACK" | "EXPERIENCE",
    input: {
      familyId: string;
      personId: string;
      parentId?: string;
      key: string;
      line?: string;
      /** Extra webhook metadata, e.g. busy-watch `in_checkin_window` / `streak_id`. Never phone numbers. */
      metadata?: Record<string, string | boolean>;
      /** Extra agent variables the prompt reads (@incident_id, @drill_id, @opening …). Masked before sending. */
      variables?: Record<string, string>;
    },
  ): Promise<boolean> {
    const agent = env[`SARVAM_AGENT_ID_${purpose}`];
    const configured = isSarvamOutboundConfigured(env, purpose);
    if (!configured) {
      await writeOutbox(sql, {
        channel: "calls",
        kind:
          purpose === "CHECKIN"
            ? "call_parent"
            : purpose === "RESPONDER"
              ? "start_responder_call"
              : "start_callback",
        familyId: input.familyId,
        parentId: input.parentId,
        dedupeKey: input.key,
        payload: { simulated: true, purpose: purpose.toLowerCase() },
      });
      return false;
    }
    const phone = await contacts.resolve({ familyId: input.familyId, personId: input.personId, source: "sarvam" });
    if (!phone) {
      await writeOutbox(sql, {
        channel: "calls",
        kind: "sarvam_unavailable",
        familyId: input.familyId,
        parentId: input.parentId,
        dedupeKey: input.key,
        payload: { reason: "no_valid_destination" },
      });
      return false;
    }
    const receipt = await claimProvider(sql, {
      channel: "calls",
      kind: "sarvam_outbound",
      familyId: input.familyId,
      parentId: input.parentId,
      key: input.key,
    });
    if (!receipt) return false;
    try {
      const response = await fetchFn(
        `https://apps.sarvam.ai/api/outbounds/v1/orgs/${encodeURIComponent(env.SARVAM_ORG_ID!)}/workspaces/${encodeURIComponent(env.SARVAM_WORKSPACE_ID!)}/outbounds`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-API-Key": env.SARVAM_API_KEY!,
          },
          signal: AbortSignal.timeout(5000),
          body: JSON.stringify({
            app_config: {
              app_id: agent,
              // Each agent has its own committed versions: SARVAM_AGENT_VERSION_<PURPOSE> wins over the shared one.
              app_version: Number(env[`SARVAM_AGENT_VERSION_${purpose}`] ?? env.SARVAM_AGENT_VERSION ?? "1"),
              connection_config: {
                connection_id: env.SARVAM_CONNECTION_ID,
                agent_phone_number: env.SARVAM_AGENT_PHONE_NUMBER,
              },
              // Only masked speech reaches the agent; phone routing stays in telephony metadata.
              agent_variables: {
                purpose: purpose.toLowerCase(),
                introduction: "Main Sahaj ki AI sahayak hoon.",
                // Tool calls need the family/person context (ids only, never phone numbers).
                family_id: input.familyId,
                parent_id: input.parentId ?? input.personId,
                person_id: input.personId,
                ...Object.fromEntries(Object.entries(input.variables ?? {})
                  .map(([name, value]) => [name, (UUID_RE.test(value) || (name === "drill_id" && DRILL_UUID_RE.test(value))) ? value : maskDigits(mask(value))])),
                // The callback prompt reads @callback_line; older prompts read @line.
                ...(input.line ? { line: maskDigits(mask(input.line)), callback_line: maskDigits(mask(input.line)) } : {}),
              },
              app_overrides: {
                initial_bot_message:
                  "Main Sahaj ki AI sahayak hoon. Main kabhi OTP, PIN, paise ya bank details nahi maangti.",
              },
            },
            user_config: { user_phone_number: phone },
            webhook_config: {
              url: env.SARVAM_WEBHOOK_URL,
              metadata: {
                family_id: input.familyId,
                person_id: input.personId,
                receipt_id: receipt,
                purpose: purpose.toLowerCase(),
                ...(input.metadata ?? {}),
              },
            },
          }),
        },
      );
      const data = (await response.json()) as { attempt_id?: string };
      const accepted = response.ok && typeof data.attempt_id === "string";
      await finishProvider(
        sql,
        receipt,
        accepted ? "accepted" : "failed",
        accepted ? data.attempt_id : undefined,
      );
      return accepted;
    } catch {
      await finishProvider(sql, receipt, "unknown");
      return false;
    }
  }
  return {
    /** Busy-line watch (step 2.4): real check-in retry, looped back via the call-status webhook. */
    async placeCheckinRetry(input: { familyId: string; parentId: string; streakId: string; jobId: string }) {
      if (!isSarvamOutboundConfigured(env, "CHECKIN")) return { placed: false };
      const placed = await outbound("CHECKIN", {
        familyId: input.familyId,
        personId: input.parentId,
        parentId: input.parentId,
        key: `calls:busy_retry:${input.streakId}:${input.jobId}`,
        metadata: { in_checkin_window: true, streak_id: input.streakId },
      });
      return { placed };
    },
    async getParentLine() {
      return env.AASHA_DIDI_LINE_ID?.trim() || "dev-outbox-line";
    },
    async callParent(input) {
      await outbound("CHECKIN", {
        familyId: input.familyId,
        personId: input.parentId,
        parentId: input.parentId,
        key: `calls:call_parent:${input.verdictId}:${input.attempt}`,
      });
      // Instant outbound only returns an attempt id. Never claim that Maa answered.
      // Current runtime has no "queued" state; the webhook owner must reconcile actual outcomes.
      return { status: "no_answer" };
    },
    async startResponderCall(input) {
      const drill = input.purpose === "experience_drill" && input.script ? input.script : null;
      // Recover Maa from the saved check, never from the responder destination. Bind all three ids.
      const rows = drill ? [] : await sql<{ parent_id: string; responder_name: string; subject_name: string }[]>`
        select c.parent_id, r.display_name as responder_name, p.display_name as subject_name
        from public.family_checks c
        join public.people p on p.id=c.parent_id and p.family_id=c.family_id and p.role='parent'
        join public.people r on r.id=c.asked_person_id and r.family_id=c.family_id
        where c.id=${input.checkId} and c.family_id=${input.familyId} and c.asked_person_id=${input.toPersonId}
        limit 1`;
      const check = rows[0];
      if (!drill && !check) return;
      await outbound(drill && env.SARVAM_AGENT_ID_EXPERIENCE ? "EXPERIENCE" : "RESPONDER", {
        familyId: input.familyId,
        personId: input.toPersonId,
        parentId: drill ? input.toPersonId : check!.parent_id,
        key: `calls:responder:${input.checkId}`,
        variables: drill
          ? { drill_id: input.checkId, opening: drillOpening(drill.opening_hi), ask: drill.ask_hi, nudge: drill.nudge_hi }
          : { incident_id: input.checkId, check_id: input.checkId,
            responder_name: maskedSarvamText(check!.responder_name, 80), subject_name: maskedSarvamText(check!.subject_name, 80),
            incident_summary: "Aapke naam se aaye call ki pushti ke liye parivaar ko madad chahiye.",
            // No address is stored by this workflow; never infer permission from an active check.
            address_line: "", is_danger: "no", bridge_to: sarvamBridgeLabel(env) },
      });
    },
    async startCallback(input) {
      await outbound("CALLBACK", {
        familyId: input.familyId,
        personId: input.parentId,
        parentId: input.parentId,
        line: input.line,
        variables: {
          callback_reason: input.callbackReason ?? "family_check_answer",
          ...(input.checkId ? { check_id: input.checkId } : {}),
          ...(Number.isInteger(input.missedCount) && input.missedCount! > 0 && input.missedCount! < 1000
            ? { missed_count: String(input.missedCount) } : {}),
        },
        key: `calls:callback:${input.checkId ?? input.parentId}:${createHash("sha256").update(input.line).digest("hex")}`,
      });
    },
  };
}
