import { z } from "zod";
import type { AlertLevel } from "@sahaj/shared";
import { maskDigits } from "./mask";
import { GENERIC_FAMILY, LINES, SAFE_FALLBACK_LINE, type StopScriptId } from "./lines";
import { alertChild, background, defineTool, makeVerdict, safeSign } from "./runtime";
import type { ShieldDeps, ToolCtx } from "./types";

/* ------------------------------------------------------------------ family_check */

export const FamilyCheckInput = z.object({
  claimed_name: z.string().trim().min(1).max(80),
  asked_for: z.string().trim().min(1).max(300),
});

export type FamilyCheckOutput =
  | { check_id: string; status: "checking"; line_id: StopScriptId; line_hi: string }
  | { check_id: null; status: "unknown_person"; line_id: StopScriptId; line_hi: string };

export const familyCheck = defineTool({
  name: "family_check",
  description:
    "Caller claims to be family and asks for something: send that family member a WhatsApp check card and answer at once.",
  input: FamilyCheckInput,
  fallback: (): FamilyCheckOutput => ({
    check_id: null,
    status: "unknown_person",
    line_id: 1,
    line_hi: SAFE_FALLBACK_LINE,
  }),
  async handler(deps, ctx, input): Promise<FamilyCheckOutput> {
    const claimedName = maskDigits(input.claimed_name);
    const askedWhat = maskDigits(input.asked_for);
    const person = await deps.db.findPersonByName(ctx.familyId, claimedName);

    if (!person) {
      await safeSign(deps, {
        familyId: ctx.familyId,
        type: "shield.voice.family_check",
        line: `Caller claimed to be "${claimedName}", who is not in the family list.`,
        data: { status: "unknown_person", claimed_name: claimedName, asked_what: askedWhat },
      });
      await alertChild(
        deps,
        ctx,
        makeVerdict({
          level: "yellow",
          scam_type: "family_in_trouble",
          rule_id: "voice.family_check.unknown_person",
          hi: `Kisi ne "${claimedName}" banke Maa se baat ki, jo family list mein nahi hai.`,
          en: `Someone claiming to be "${claimedName}" (not in the family list) asked Maa for: ${askedWhat}.`,
          actions: ["speak_clip", "alert_child"],
        }),
      );
      return { check_id: null, status: "unknown_person", line_id: 8, line_hi: LINES.familyCheckUnknown };
    }

    const check = await deps.db.createFamilyCheck({
      familyId: ctx.familyId,
      parentId: ctx.parentId,
      toPersonId: person.id,
      claimedName: person.name,
      askedWhat,
      state: "asked",
      createdAt: deps.clock.now(),
    });

    let cardSent = true;
    try {
      await deps.whatsapp.sendFamilyCheckCard({
        familyId: ctx.familyId,
        toPersonId: person.id,
        claimedName: person.name,
        askedWhat,
        checkId: check.id,
      });
    } catch {
      cardSent = false;
      // The card did not go out, so do not wait 60 s for a tap: ring the family member now.
      background(deps, ctx, "family_check_escalate", async () => {
        await escalateFamilyCheck(deps, check.id);
      });
    }

    await safeSign(deps, {
      familyId: ctx.familyId,
      type: "shield.voice.family_check",
      line: cardSent
        ? `Asked ${person.name} on WhatsApp to confirm they are calling Maa.`
        : `WhatsApp check card to ${person.name} failed; calling them instead.`,
      data: { status: "checking", check_id: check.id, person_id: person.id, asked_what: askedWhat, card_sent: cardSent },
    });

    return { check_id: check.id, status: "checking", line_id: 8, line_hi: LINES.familyCheckAsking(person.name) };
  },
});

/* ------------------------------------------------------------------ family_check_result */

export const FamilyCheckResultInput = z.object({ check_id: z.string().trim().min(1).max(200) });

export interface FamilyCheckResultOutput {
  status: "confirmed" | "denied" | "pending" | "no_answer" | "not_found";
  level: AlertLevel;
  line_id: StopScriptId | null;
  line_hi: string;
}

export const familyCheckResult = defineTool({
  name: "family_check_result",
  description:
    "Read the family check answer. On pending the agent waits ~20 s and asks again; after a 2nd pending it promises a callback.",
  input: FamilyCheckResultInput,
  fallback: (): FamilyCheckResultOutput => ({
    status: "pending",
    level: "yellow",
    line_id: 1,
    line_hi: SAFE_FALLBACK_LINE,
  }),
  async handler(deps, ctx, input): Promise<FamilyCheckResultOutput> {
    const rec = await deps.db.getFamilyCheck(input.check_id);
    // A check from another family is treated as missing, so a guessed id cannot leak anything.
    const mine = rec !== null && (rec.familyId === undefined || rec.familyId === ctx.familyId);
    const name = (mine && rec.claimedName) || GENERIC_FAMILY;

    let out: FamilyCheckResultOutput;
    if (!mine) {
      out = { status: "not_found", level: "yellow", line_id: null, line_hi: LINES.familyNotFound };
    } else if (rec.state === "confirmed") {
      out = { status: "confirmed", level: "green", line_id: null, line_hi: LINES.familyConfirmed(name) };
    } else if (rec.state === "denied") {
      out = { status: "denied", level: "red", line_id: null, line_hi: LINES.familyDenied(name) };
    } else if (rec.state === "no_answer") {
      out = { status: "no_answer", level: "yellow", line_id: null, line_hi: LINES.familyNoAnswer };
    } else {
      out = { status: "pending", level: "yellow", line_id: null, line_hi: LINES.familyPending };
    }

    await safeSign(deps, {
      familyId: ctx.familyId,
      type: "shield.voice.family_check_result",
      line: `Family check ${out.status}${mine ? ` (${name})` : ""}.`,
      data: { check_id: input.check_id, status: out.status, level: out.level },
    });

    if (out.status === "denied") {
      await alertChild(
        deps,
        ctx,
        makeVerdict({
          level: "red",
          scam_type: "family_in_trouble",
          rule_id: "voice.family_check.denied",
          hi: `${name} ne bataya ki Maa ko call karne wale woh nahi the.`,
          en: `${name} denied being the caller who asked Maa for something.`,
          actions: ["speak_clip", "alert_child"],
        }),
      );
    }
    return out;
  },
});

/* ------------------------------------------------------------------ helpers for Atlas / the agent route */

/**
 * Called by the Atlas 60 s timer when nobody tapped the WhatsApp card: rings the family member.
 * No-op once the check has been answered.
 */
export async function escalateFamilyCheck(
  deps: ShieldDeps,
  checkId: string,
): Promise<{ escalated: boolean; reason?: "not_found" | "already_answered" | "missing_record_fields" | "call_failed" }> {
  const rec = await deps.db.getFamilyCheck(checkId);
  if (!rec) return { escalated: false, reason: "not_found" };
  if (rec.state !== "asked") return { escalated: false, reason: "already_answered" };
  if (!rec.familyId || !rec.toPersonId) return { escalated: false, reason: "missing_record_fields" };

  const familyId = rec.familyId;
  try {
    await deps.calls.startResponderCall({ familyId, toPersonId: rec.toPersonId, checkId });
  } catch {
    await safeSign(deps, {
      familyId,
      type: "shield.voice.side_effect_failed",
      line: "Responder call for the family check failed.",
      data: { step: "start_responder_call", check_id: checkId },
    });
    return { escalated: false, reason: "call_failed" };
  }
  await safeSign(deps, {
    familyId,
    type: "shield.voice.family_check_escalated",
    line: `No tap on the WhatsApp card; calling ${rec.claimedName ?? "the family member"}.`,
    data: { check_id: checkId, person_id: rec.toPersonId },
  });
  return { escalated: true };
}

/** After the 2nd pending result the agent tells Maa it will call back; this places that callback. */
export async function scheduleCallback(
  deps: ShieldDeps,
  ctx: ToolCtx,
  line: string = LINES.callbackDefault,
): Promise<{ ok: boolean }> {
  try {
    await deps.calls.startCallback({ familyId: ctx.familyId, parentId: ctx.parentId, line });
  } catch {
    await safeSign(deps, {
      familyId: ctx.familyId,
      type: "shield.voice.side_effect_failed",
      line: "Scheduling the callback to Maa failed.",
      data: { step: "start_callback" },
    });
    return { ok: false };
  }
  await safeSign(deps, {
    familyId: ctx.familyId,
    type: "shield.voice.callback_scheduled",
    line: "Aasha Didi will call Maa back once the family check is answered.",
  });
  return { ok: true };
}
