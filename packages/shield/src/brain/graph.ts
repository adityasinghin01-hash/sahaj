import { Annotation, StateGraph, START, END } from "@langchain/langgraph";
import { ShieldEvent, Verdict, type ShieldAction } from "@sahaj/shared";
import type { ShieldBrainDeps, Parent, RulesResult, LinkResult, TwoLockResult, StoredVerdict } from "./types.js";
import { checkLinks } from "./links.js";
import { judge, mergeVerdict } from "./judgement.js";
import { checkAction, ladderActions, respond } from "./respond.js";

const State = Annotation.Root({
  event: Annotation<ShieldEvent>(),
  parent: Annotation<Parent>(),
  recentEvents: Annotation<ShieldEvent[]>(),
  ruleResult: Annotation<RulesResult>(),
  linkResults: Annotation<LinkResult[]>(),
  aiResult: Annotation<TwoLockResult | undefined>(),
  decision: Annotation<{ verdict: Verdict; verdictId?: string }>(),
});
type GraphState = typeof State.State;
type Update = Partial<GraphState>;

/** Invoke with { event }; read result.decision.{verdict,verdictId}. Atlas owns persistence/retries. */
export function buildShieldGraph(deps: ShieldBrainDeps) {
  const node = (step: string, work: (state: GraphState) => Promise<Update>) => async (state: GraphState): Promise<Update> => {
    let update: Update;
    try { update = await work(state); }
    catch (error) {
      await deps.sign({ familyId: state.event?.family_id, parentId: state.event?.parent_id,
        eventKey: state.event?.idempotency_key, verdictId: state.decision?.verdictId,
        step, status: "failed" });
      throw error;
    }
    const event = update.event ?? state.event;
    const current = { ...state, ...update };
    const details: Record<string, string | number | boolean> = {};
    if (step === "load") details.recent_events = current.recentEvents.length;
    if (step === "rules") { details.level = current.ruleResult.verdict.level; details.needs_ai = current.ruleResult.needs_ai; }
    if (step === "links") {
      details.domains = current.linkResults.length;
      details.threats = current.linkResults.filter(result => result.threat).length;
      details.unverified = current.linkResults.filter(result => result.status !== "checked").length;
    }
    if (step === "ai") {
      details.attempted = !!current.aiResult;
      if (current.aiResult) details.successful_models = [current.aiResult.claude, current.aiResult.muse].filter(result => result.ok).length;
    }
    if (current.decision && ["verdict", "gate", "respond", "sign"].includes(step)) {
      details.level = current.decision.verdict.level;
      details.reasons = current.decision.verdict.reasons.length;
      details.actions = current.decision.verdict.actions.length;
      details.models_agreed = current.decision.verdict.models_agreed.join(",");
    }
    await deps.sign({ familyId: event.family_id, parentId: event.parent_id,
      eventKey: event.idempotency_key, verdictId: update.decision?.verdictId ?? state.decision?.verdictId,
      step, status: "ok", details });
    return update;
  };
  return new StateGraph(State)
    .addNode("load", node("load", async state => {
      const event = ShieldEvent.parse(state.event);
      const untilMs = (deps.now ?? Date.now)();
      const sinceMs = untilMs - 30 * 60 * 1000;
      const [parent, events] = await Promise.all([
        deps.db.getParent({ familyId: event.family_id, parentId: event.parent_id }),
        deps.db.getRecentEvents({ familyId: event.family_id, parentId: event.parent_id,
          since: new Date(sinceMs).toISOString(), until: new Date(untilMs).toISOString() }),
      ]);
      if (!parent || parent.id !== event.parent_id || parent.family_id !== event.family_id) throw new Error("Shield parent/family mismatch");
      // Do not let a broad DB adapter leak another family's history into the rules.
      const recentEvents = events.map(item => ShieldEvent.parse(item)).filter(item =>
        item.family_id === event.family_id && item.parent_id === event.parent_id &&
        Date.parse(item.occurred_at) >= sinceMs && Date.parse(item.occurred_at) <= untilMs);
      return { event, parent, recentEvents };
    }))
    .addNode("rules", node("rules", async state => {
      const rules = await deps.rules.evaluate(state.event, state.recentEvents);
      return { ruleResult: { ...rules, verdict: Verdict.parse(rules.verdict) } };
    }))
    .addNode("links", node("links", async state => ({ linkResults: await checkLinks(state.ruleResult.links, deps) })))
    .addNode("ai", node("ai", async state => {
      if (!state.ruleResult.needs_ai || state.ruleResult.verdict.level === "red" || state.linkResults.some(link => link.threat)) return { aiResult: undefined };
      return { aiResult: await judge(state.event, deps) };
    }))
    .addNode("verdict", node("verdict", async state => {
      const verdict = mergeVerdict(state.ruleResult.verdict, state.linkResults, state.aiResult);
      verdict.actions = ladderActions(state.event, verdict);
      return { decision: { verdict: Verdict.parse(verdict) } };
    }))
    .addNode("gate", node("gate", async state => {
      const record = { event: state.event, parent: state.parent, verdict: state.decision.verdict };
      const actions: ShieldAction[] = [];
      for (const action of record.verdict.actions) if (await checkAction(deps, record, action)) actions.push(action);
      const verdict = { ...record.verdict, actions };
      const inserted = await deps.db.insertVerdict({ ...record, verdict });
      if (!inserted.id) throw new Error("Shield verdict missing persisted id");
      return { decision: { verdict, verdictId: inserted.id } };
    }))
    .addNode("respond", node("respond", async state => {
      const record: StoredVerdict = { id: state.decision.verdictId!, event: state.event, parent: state.parent, verdict: state.decision.verdict };
      await respond(record, deps); return {};
    }))
    .addNode("sign", node("sign", async () => ({})))
    .addEdge(START, "load").addEdge("load", "rules").addEdge("rules", "links")
    .addEdge("links", "ai").addEdge("ai", "verdict").addEdge("verdict", "gate")
    .addEdge("gate", "respond").addEdge("respond", "sign").addEdge("sign", END)
    .compile(); // Deliberately no checkpointer; the registering Atlas graph supplies its own policy.
}
