import { z } from "zod";
import type { ShieldAction, ShieldEvent, Verdict } from "@sahaj/shared";
import type { ShieldDeps, StoredVerdict, TimelineRow } from "./types.js";

export const RETRY_PARENT_JOB = "retryCallParent";
export const NO_REACTION_JOB = "shield.no_reaction_check";
export function ladderActions(event: ShieldEvent, verdict: Verdict): ShieldAction[] {
  if (verdict.level === "green") return [];
  const actions: ShieldAction[] = ["alert_child"];
  if (verdict.level === "red") {
    actions.push(event.channel === "device" ? "show_red_screen" : "speak_clip", "circle_chain");
  }
  if (event.context.money_already_left === true) actions.push("offer_1930");
  return actions;
}
export function scaledDelay(deps: ShieldDeps): number {
  const scale = Number((deps.env ?? process.env).DEMO_TIMER_SCALE ?? "1");
  return 120000 / (Number.isFinite(scale) && scale > 0 ? scale : 1);
}
export async function audit(deps: ShieldDeps, record: Omit<StoredVerdict, "id"> & { id?: string }, row: Pick<TimelineRow, "step" | "status" | "action" | "details">) {
  await deps.sign({ familyId: record.event.family_id, parentId: record.event.parent_id,
    eventKey: record.event.idempotency_key, ...(record.id ? { verdictId: record.id } : {}), ...row });
}
export async function checkAction(deps: ShieldDeps, record: Omit<StoredVerdict, "id"> & { id?: string }, action: ShieldAction): Promise<boolean> {
  let allowed = false;
  try { allowed = (await deps.gate.check({ familyId: record.event.family_id, action })).allowed === true; }
  catch { /* A failed gate is a denial, never implicit approval. */ }
  await audit(deps, record, { step: "gate.action", action, status: allowed ? "ok" : "denied" });
  return allowed;
}
// Catch only the provider operation. An audit/signing failure must remain visible to the host.
async function effect(deps: ShieldDeps, record: StoredVerdict, step: string, operation: () => Promise<unknown>, action?: ShieldAction): Promise<boolean> {
  let status: TimelineRow["status"] = "ok";
  try { await operation(); } catch { status = "failed"; }
  await audit(deps, record, { step, status, ...(action ? { action } : {}) });
  return status === "ok";
}
async function schedule(deps: ShieldDeps, record: StoredVerdict, name: string, payload: Record<string, unknown>) {
  await effect(deps, record, `schedule.${name}`, () => deps.scheduler.after(scaledDelay(deps), name, payload));
}
async function callParent(record: StoredVerdict, deps: ShieldDeps, attempt: number) {
  const lineId = record.parent.line_id;
  if (!lineId) {
    await audit(deps, record, { step: "call_parent", status: "skipped", action: "speak_clip", details: { reason: "missing_line", attempt } }); return;
  }
  let status = "failed";
  try {
    status = (await deps.calls.callParent({ familyId: record.event.family_id, parentId: record.event.parent_id,
      lineId, verdictId: record.id, attempt })).status;
  } catch { /* Treat a provider failure as retryable; never expose its raw error. */ }
  await audit(deps, record, { step: "call_parent", status: status === "failed" ? "failed" : "ok", action: "speak_clip", details: { result: status, attempt } });
  if (["busy", "no_answer", "failed"].includes(status) && attempt < 3) {
    await schedule(deps, record, RETRY_PARENT_JOB, { verdictId: record.id, attempt: attempt + 1 });
  }
}
export async function respond(record: StoredVerdict, deps: ShieldDeps) {
  const { verdict, event } = record;
  const allowed = (action: ShieldAction) => verdict.actions.includes(action);
  if (verdict.level === "green") return;
  // Independent response branches run together: a slow call cannot delay Riya's push/WhatsApp.
  const branches: Promise<unknown>[] = [];
  if (allowed("alert_child")) {
    const card = { verdictId: record.id, familyId: event.family_id, parentId: event.parent_id,
      verdict, quiet: verdict.level === "yellow", push: true as const, offer1930: allowed("offer_1930") };
    branches.push(effect(deps, record, "child_card_push", () => deps.notify.childCard(card), "alert_child"));
    if (verdict.level === "red") {
      branches.push(effect(deps, record, "whatsapp_alert", () => deps.whatsapp.sendShieldAlert({ ...card, callToAction: "📞 Call Maa now" }), "alert_child"));
    }
  }
  if (verdict.level === "red") {
    if (allowed("show_red_screen") && event.channel === "device") {
      // The device already showed the screen. This is confirmation only.
      branches.push(audit(deps, record, { step: "confirm_red_screen", status: "ok", action: "show_red_screen" }));
    }
    if (allowed("speak_clip") && event.channel !== "device") branches.push(callParent(record, deps, 1));
    if (allowed("circle_chain")) branches.push(schedule(deps, record, NO_REACTION_JOB, { verdictId: record.id }));
  }
  const outcomes = await Promise.allSettled(branches);
  // Wait for sibling branches to finish before surfacing a signing failure.
  const failed = outcomes.find(result => result.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
}
const reactionPayload = z.object({ verdictId: z.string().min(1) }).strict();
const retryPayload = z.object({ verdictId: z.string().min(1), attempt: z.number().int().min(2).max(3) }).strict();
export async function handleScheduledJob(name: string, payload: unknown, deps: ShieldDeps): Promise<void> {
  if (name !== RETRY_PARENT_JOB && name !== NO_REACTION_JOB) throw new Error("Unknown Shield scheduled job");
  const input = name === RETRY_PARENT_JOB ? retryPayload.parse(payload) : reactionPayload.parse(payload);
  const record = await deps.db.getVerdict(input.verdictId);
  if (!record) throw new Error("Shield scheduled verdict not found");
  if (record.parent.id !== record.event.parent_id || record.parent.family_id !== record.event.family_id || record.id !== input.verdictId) throw new Error("Shield scheduled family mismatch");
  try {
    const action = name === RETRY_PARENT_JOB ? "speak_clip" : "circle_chain";
    if (record.verdict.level !== "red" || !record.verdict.actions.includes(action) ||
        (name === RETRY_PARENT_JOB && record.event.channel === "device")) {
      await audit(deps, record, { step: name, status: "skipped" }); return;
    }
    if (!await checkAction(deps, record, action)) {
      await audit(deps, record, { step: name, status: "denied", action }); return;
    }
    if (name === RETRY_PARENT_JOB) {
      await callParent(record, deps, retryPayload.parse(input).attempt);
    } else {
      const reacted = await deps.db.hasChildReaction({ verdictId: record.id });
      await audit(deps, record, { step: "child_reaction_check", status: "ok", details: { reacted } });
      if (!reacted) await effect(deps, record, "circle_chain", () => deps.atlas.startCircleChain({
        verdictId: record.id, familyId: record.event.family_id, parentId: record.event.parent_id,
      }), "circle_chain");
    }
    await audit(deps, record, { step: name, status: "ok" });
  } catch (error) {
    await audit(deps, record, { step: name, status: "failed" });
    throw error;
  }
}
