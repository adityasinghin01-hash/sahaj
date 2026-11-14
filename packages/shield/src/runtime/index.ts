import { ShieldEvent, Verdict, type ShieldAction } from "@sahaj/shared";
import { buildShieldGraph, handleScheduledJob as handleBrainJob, RETRY_PARENT_JOB, NO_REACTION_JOB } from "../brain/index.js";
import { checkAction, respond } from "../brain/respond.js";
import type { ShieldBrainDeps, StoredVerdict } from "../brain/types.js";
import { createPairingCode, handleShieldEvent, handleShieldPair, type ShieldServerDeps } from "../server";
import { scheduledShieldTools, handleShieldToolJob, isShieldJobName, FamilyCheckJobPayload, type ShieldJobDeps, type ScheduledToolDeps } from "../jobs";
import { isShieldToolName, type ShieldToolName, type ShieldTool, type ToolCtx, type ShieldDeps } from "../tools";
import { createShieldRuntimePg } from "./pg";
import { evaluateRules, scoreVoiceText } from "./rules";
import type { ShieldRuntimePorts, ShieldRuntimeTestPorts, ShieldRuntimeDb } from "./types";

export * from "./types";
export { createShieldRuntimePg } from "./pg";

export interface BoundShieldTools {
  run<K extends ShieldToolName>(name: K, ctx: ToolCtx,
    input: Parameters<(typeof scheduledShieldTools)[K]["run"]>[2]): ReturnType<(typeof scheduledShieldTools)[K]["run"]>;
}

export function createShieldRuntime(ports: ShieldRuntimePorts | ShieldRuntimeTestPorts) {
  const db = ports.sql ? createShieldRuntimePg(ports.sql) : (ports as ShieldRuntimeTestPorts).db;
  // Register the handled copy, while preserving the original rejection for its caller.
  const track = <T>(promise: Promise<T>): Promise<T> => {
    ports.waitUntil(promise.catch(() => { ports.log?.error("shield.runtime.background_failed"); }));
    return promise;
  };
  const sign: ShieldBrainDeps["sign"] = entry => track(ports.sign(entry));
  const scheduler = { after: (delay: number, name: string, payload: Record<string, unknown>) =>
    track(ports.scheduler.after(delay, name, payload)) };
  const getParentLine = async (ctx: ToolCtx) => {
    try { return await ports.calls.getParentLine(ctx); }
    catch { ports.log?.error("shield.runtime.parent_line_failed"); return null; }
  };

  function brainDeps(storage: ShieldRuntimeDb): ShieldBrainDeps {
    return {
      db: {
        ...storage.brain,
        async getParent(input) {
          const parent = await storage.brain.getParent(input);
          if (!parent) return null;
          const lineId = await getParentLine(input);
          return { ...parent, ...(lineId ? { line_id: lineId } : {}) };
        },
        async getVerdict(id) {
          const record = await storage.brain.getVerdict(id);
          if (!record) return null;
          const lineId = await getParentLine({ familyId: record.event.family_id, parentId: record.event.parent_id });
          return { ...record, parent: { ...record.parent, ...(lineId ? { line_id: lineId } : {}) } };
        },
      },
      rules: { evaluate: evaluateRules }, twoLock: request => ports.router.twoLock(request),
      notify: { childCard: input => ports.push.childCard(input) }, whatsapp: ports.whatsapp,
      calls: ports.calls, scheduler, jobs: { claim: key => track(ports.scheduler.claim(key)) },
      atlas: ports.atlas, gate: ports.gate, sign,
      cache: ports.cache, env: ports.env, now: () => ports.clock.now().getTime(),
    };
  }

  async function runBrainForEvent(eventId: string) {
    return db.withEventLock(eventId, async storage => {
      const event = await storage.getEvent(eventId);
      if (!event) throw new Error("Shield event not found");
      const existing = await storage.getVerdictForEvent(eventId);
      if (existing) return { verdict: existing.verdict, verdictId: existing.id };
      const state = await buildShieldGraph(brainDeps(storage)).invoke({ event });
      return state.decision;
    });
  }

  const serverDeps: ShieldServerDeps = {
    db: db.server, env: ports.env, clock: ports.clock, waitUntil: ports.waitUntil.bind(ports), log: ports.log,
    // The real event handler registers this promise with waitUntil before returning 200.
    atlas: { async enqueueShieldEvent({ eventId }) { await runBrainForEvent(eventId); } },
  };

  function toolDeps(ctx: ToolCtx): ShieldJobDeps & ScheduledToolDeps {
    const deps = brainDeps(db);
    const eventKey = crypto.randomUUID();
    // Tools own their fixed speech and bridge flows. This adapter persists their
    // structured decisions, then uses the brain's gated child-alert response branch.
    const alertChild: ShieldDeps["atlas"]["alertChild"] = async input => {
      if (input.familyId !== ctx.familyId || input.parentId !== ctx.parentId) throw new Error("Shield tool family mismatch");
      const verdict = Verdict.parse(input.verdict);
      const event = ShieldEvent.parse({ idempotency_key: eventKey, family_id: ctx.familyId,
        parent_id: ctx.parentId, channel: "keypad_voice", kind: "voice_report",
        occurred_at: ports.clock.now().toISOString(), matched_rules: verdict.checks_fired });
      const parent = await db.brain.getParent(ctx);
      if (!parent) throw new Error("Shield tool parent not found");
      await db.insertVoiceEvent(event);
      const record = { event, parent, verdict };
      const actions: ShieldAction[] = [];
      for (const action of verdict.actions) if (await checkAction(deps, record, action)) actions.push(action);
      const gated = { ...verdict, actions };
      const { id } = await db.brain.insertVerdict({ ...record, verdict: gated });
      await sign({ familyId: ctx.familyId, parentId: ctx.parentId, eventKey: event.idempotency_key,
        verdictId: id, step: "tool.verdict", status: "ok", details: { level: gated.level } });
      // No duplicate parent call or circle chain: those effects remain owned by the tools.
      const alertRecord: StoredVerdict = { ...record, id, verdict: { ...gated,
        actions: gated.actions.filter(action => action === "alert_child" || action === "offer_1930") } };
      await respond(alertRecord, deps);
    };
    const allowedEffect = async (action: ShieldAction, work: () => Promise<unknown>) => {
      const allowed = (await ports.gate.check({ familyId: ctx.familyId, action })).allowed;
      await sign({ familyId: ctx.familyId, parentId: ctx.parentId, eventKey,
        step: "gate.action", action, status: allowed ? "ok" : "denied" });
      if (!allowed) throw new Error("Shield action denied");
      await work();
    };
    return {
      llm: { understand: request => track(ports.router.understand(request)) },
      rules: { scoreText: scoreVoiceText }, clock: ports.clock, env: ports.env,
      db: {
        createFamilyCheck: input => track(db.tools.createFamilyCheck(input)),
        getFamilyCheck: id => track(db.tools.getFamilyCheck(id)),
        findPersonByName: (family, name) => track(db.tools.findPersonByName(family, name)),
        getCodeWordHash: family => track(db.tools.getCodeWordHash(family)),
        markFamilyCheckNoAnswer: (id, at) => track(db.tools.markFamilyCheckNoAnswer(id, at)),
      },
      whatsapp: { sendFamilyCheckCard: input => track(ports.whatsapp.sendFamilyCheckCard(input)) },
      calls: {
        startResponderCall: input => track(allowedEffect("speak_clip", () => ports.calls.startResponderCall(input))),
        startCallback: input => track(allowedEffect("speak_clip", () => ports.calls.startCallback(input))),
      },
      atlas: {
        alertChild: input => track(alertChild(input)),
        bridgeChild: input => track(allowedEffect("bridge_child", () => ports.atlas.bridgeChild(input))),
        startCircleChain: input => track(allowedEffect("circle_chain", () => ports.atlas.startCircleChain(input))),
      },
      sign: entry => track(ports.sign(entry)), scheduler,
      jobs: { claim: key => track(ports.scheduler.claim(key)) },
    };
  }

  const run = (async (name: ShieldToolName, ctx: ToolCtx, input: unknown) => {
    if (!isShieldToolName(name)) throw new Error("Unknown Shield tool");
    if (!await db.brain.getParent(ctx)) throw new Error("Shield tool parent not found");
    const tool: ShieldTool = scheduledShieldTools[name];
    return track(tool.run(toolDeps(ctx), ctx, input));
  }) as BoundShieldTools["run"];

  return {
    handleShieldPair: (request: Request) => handleShieldPair(request, serverDeps),
    handleShieldEvent: (request: Request) => handleShieldEvent(request, serverDeps),
    createPairingCode: (input: { familyId: string; userId: string }) => createPairingCode(serverDeps, input),
    shieldTools: { run } satisfies BoundShieldTools,
    async handleScheduledJob(name: string, payload: unknown) {
      if (name === RETRY_PARENT_JOB || name === NO_REACTION_JOB) return handleBrainJob(name, payload, brainDeps(db));
      if (isShieldJobName(name)) {
        // The existing job parser returns invalid_payload rather than throwing.
        const parsed = FamilyCheckJobPayload.safeParse(payload);
        if (!parsed.success) return { job: name, outcome: "invalid_payload" as const };
        const ctx = { familyId: parsed.data.family_id, parentId: parsed.data.parent_id };
        if (!await db.brain.getParent(ctx)) return { job: name, outcome: "not_found" as const };
        return handleShieldToolJob(name, payload, toolDeps(ctx));
      }
      throw new Error("Unknown Shield scheduled job");
    },
    runBrainForEvent,
  };
}
