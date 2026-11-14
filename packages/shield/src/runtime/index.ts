import { ShieldEvent, Verdict, type ShieldAction } from "@sahaj/shared";
import { buildShieldGraph, handleScheduledJob as handleBrainJob, RETRY_PARENT_JOB, NO_REACTION_JOB } from "../brain/index.js";
import { audit, checkAction, respond } from "../brain/respond.js";
import type { ShieldBrainDeps, StoredVerdict } from "../brain/types.js";
import { createPairingCode, handleShieldEvent, handleShieldPair, type ShieldServerDeps } from "../server";
import { scheduledShieldTools, handleShieldToolJob, isShieldJobName, FamilyCheckJobPayload, type ShieldJobDeps, type ScheduledToolDeps } from "../jobs";
import { type ShieldTool, type ToolCtx, type ShieldDeps } from "../tools";
import { drillAnswer, pickDrill, scamSense, DRILL_FALLBACK_LINE, HELPER_DRILL_STORIES, type DrillDeps,
  experienceTurn, startExperienceDrill, isQuietHours, experienceScriptFor, ExperienceJobPayload,
  EXPERIENCE_DRILL_JOB, EXPERIENCE_DRILL_PURPOSE, EXPERIENCE_STOP_LINE, type ExperienceDeps, type ExperienceStore } from "../drills";
import { buildEvidencePack, verifyEvidencePack, type EvidenceDeps, type EvidenceRequest } from "../evidence";
import { callScreen, screenCall, CALL_GATE_FORWARD_LINE, type CallGateDeps, type ScreenCallInput } from "../callgate";
import { numberFingerprint } from "../warnings/fingerprint";
import { createShieldRuntimePg } from "./pg";
import { handleSmsGateway, type SmsGatewayDeps } from "../gateway";
import { evaluateRules, scoreVoiceText } from "./rules";
import type { ShieldRuntimePorts, ShieldRuntimeTestPorts, ShieldRuntimeDb } from "./types";

export * from "./types";
export { createShieldRuntimePg } from "./pg";

/** Unified runtime registration, including the drill, experience-drill and call-gateway tools. */
export const shieldTools = { ...scheduledShieldTools, drill_answer: drillAnswer, experience_turn: experienceTurn,
  call_screen: callScreen } as const;
export type ShieldToolName = keyof typeof shieldTools;
export function isShieldToolName(name: string): name is ShieldToolName {
  return Object.prototype.hasOwnProperty.call(shieldTools, name);
}
/** Outcome of the shield.drill.experience job. */
export interface ExperienceJobResult {
  job: typeof EXPERIENCE_DRILL_JOB;
  outcome: "started" | "invalid_payload" | "not_found" | "no_consent" | "disabled" | "already_answered"
    | "quiet_hours" | "duplicate" | "denied";
}
export interface BoundShieldTools {
  run<K extends ShieldToolName>(name: K, ctx: ToolCtx,
    input: Parameters<(typeof shieldTools)[K]["run"]>[2]): ReturnType<(typeof shieldTools)[K]["run"]>;
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
      const deps = brainDeps(storage);
      const state = await buildShieldGraph(deps).invoke({ event });
      // KEYPAD ladder for forwarded SMS: the brain calls Maa for red; yellow also gets Aasha
      // Didi's call (one attempt, gated and signed) next to Riya's quiet card.
      if (event.channel === "gateway_sms" && state.decision.verdict.level === "yellow" && state.decision.verdictId) {
        await keypadYellowCall(deps, { id: state.decision.verdictId, event, parent: state.parent, verdict: state.decision.verdict });
      }
      return state.decision;
    });
  }

  async function keypadYellowCall(deps: ShieldBrainDeps, record: StoredVerdict) {
    if (!await checkAction(deps, record, "speak_clip")) return;
    const lineId = record.parent.line_id;
    if (!lineId) {
      await audit(deps, record, { step: "call_parent", status: "skipped", action: "speak_clip", details: { reason: "missing_line", attempt: 1, level: "yellow" } });
      return;
    }
    let status = "failed";
    try {
      status = (await ports.calls.callParent({ familyId: record.event.family_id, parentId: record.event.parent_id,
        lineId, verdictId: record.id, attempt: 1 })).status;
    } catch { /* Provider failure is signed; never expose its raw error. */ }
    await audit(deps, record, { step: "call_parent", status: status === "failed" ? "failed" : "ok", action: "speak_clip",
      details: { result: status, attempt: 1, level: "yellow" } });
  }

  const serverDeps: ShieldServerDeps = {
    db: db.server, env: ports.env, clock: ports.clock, waitUntil: ports.waitUntil.bind(ports), log: ports.log,
    // The real event handler registers this promise with waitUntil before returning 200.
    atlas: { async enqueueShieldEvent({ eventId }) { await runBrainForEvent(eventId); } },
  };

  const missingGateway = async (): Promise<never> => { throw new Error("Shield gateway storage is not configured"); };
  const gatewayDeps: SmsGatewayDeps = {
    db: db.gateway ?? { findParentByPhoneHash: missingGateway, insertGatewayEvent: missingGateway },
    // Same path as a phone event: the handler gives this promise to waitUntil before returning 200.
    brain: { runForEvent: eventId => runBrainForEvent(eventId) },
    waitUntil: ports.waitUntil.bind(ports), env: ports.env, log: ports.log,
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

  function drillDeps(): DrillDeps {
    if (!db.drills) throw new Error("Shield drill storage not configured");
    const storage = db.drills;
    // The shared ten-story catalogue is the default; a host may inject its own.
    return { db: { ...storage, withParentLock: (ctx, work) => track(storage.withParentLock(ctx, work)) },
      stories: ports.drillStories ?? HELPER_DRILL_STORIES, clock: ports.clock,
      router: { understand: request => track(ports.router.understand(request)) } };
  }

  function experienceStore(): ExperienceStore {
    if (!db.experience) throw new Error("Shield experience drill storage not configured");
    const storage = db.experience;
    return { ...storage, withParentLock: (ctx, work) => track(storage.withParentLock(ctx, work)) };
  }
  function experienceDeps(): ExperienceDeps {
    return { db: experienceStore(), clock: ports.clock, scheduler };
  }
  const signDrill = (ctx: ToolCtx, type: string, line: string, data: Record<string, string | number | boolean> = {}) =>
    track(ports.sign({ familyId: ctx.familyId, type, line, data: { parent_id: ctx.parentId, ...data } }));

  async function runExperienceJob(payload: unknown): Promise<ExperienceJobResult> {
    const job = EXPERIENCE_DRILL_JOB;
    const parsed = ExperienceJobPayload.safeParse(payload);
    if (!parsed.success) return { job, outcome: "invalid_payload" };
    const ctx = { familyId: parsed.data.family_id, parentId: parsed.data.parent_id };
    const drillId = parsed.data.drill_id;
    const store = experienceStore();
    // Every lock is checked again at call time: Maa or Riya may have switched it off since.
    const blocked = await store.withParentLock(ctx, async tx => {
      if (!await tx.getParent(ctx)) return "not_found" as const;
      const drill = await tx.getExperience({ ...ctx, drillId });
      if (!drill) return "not_found" as const;
      if (drill.score !== null) return "already_answered" as const;
      if (!await tx.hasConsent(ctx)) return "no_consent" as const;
      if (!await tx.isEnabled(ctx)) return "disabled" as const;
      if (isQuietHours(ports.clock.now())) return "quiet_hours" as const;
      return null;
    });
    const script = experienceScriptFor(drillId);
    if (blocked || !script) {
      await signDrill(ctx, "shield.drill.experience.skipped", "Experience drill call not placed.", { reason: blocked ?? "no_script" });
      return { job, outcome: blocked ?? "not_found" };
    }
    if (!await ports.scheduler.claim(`${job}:${drillId}`)) return { job, outcome: "duplicate" };
    const allowed = (await ports.gate.check({ familyId: ctx.familyId, action: "speak_clip" })).allowed === true;
    await sign({ familyId: ctx.familyId, parentId: ctx.parentId, eventKey: drillId, step: "gate.action",
      action: "speak_clip", status: allowed ? "ok" : "denied" });
    if (!allowed) return { job, outcome: "denied" };
    await ports.calls.startResponderCall({ familyId: ctx.familyId, toPersonId: ctx.parentId, checkId: drillId,
      purpose: EXPERIENCE_DRILL_PURPOSE, script: { id: script.id, opening_hi: script.opening_hi, ask_hi: script.ask_hi, nudge_hi: script.nudge_hi } });
    await signDrill(ctx, "shield.drill.experience.started", "Experience drill call placed with a generic script.", { script_id: script.id });
    return { job, outcome: "started" };
  }

  function callGateDeps(ctx: ToolCtx): CallGateDeps {
    const tools = toolDeps(ctx);
    const missing = async (): Promise<never> => { throw new Error("Shield call gateway storage not configured"); };
    return { env: ports.env, db: db.callgate ?? { getParent: missing, isFamilyNumber: missing },
      rules: { scoreText: scoreVoiceText }, router: { understand: request => track(ports.router.understand(request)) },
      alertChild: input => tools.atlas.alertChild(input), sign: entry => track(ports.sign(entry)) };
  }

  function evidenceDeps(): EvidenceDeps {
    if (!db.evidence || !ports.timeline) throw new Error("Shield evidence ports not configured");
    return { db: db.evidence, timeline: ports.timeline, clock: ports.clock,
      ...(ports.evidenceSensitive ? { sensitive: ports.evidenceSensitive } : {}) };
  }

  const run = (async (name: ShieldToolName, ctx: ToolCtx, input: unknown) => {
    if (!isShieldToolName(name)) throw new Error("Unknown Shield tool");
    if (name === "drill_answer") {
      // The drill tool includes membership and storage work inside its deadline.
      try { return track(drillAnswer.run(drillDeps(), ctx, input as Parameters<typeof drillAnswer.run>[2])); }
      catch { return { score: 0, teach_line_hi: DRILL_FALLBACK_LINE, teach: true }; }
    }
    if (name === "experience_turn") {
      try { return track(experienceTurn.run(experienceDeps(), ctx, input as Parameters<typeof experienceTurn.run>[2])); }
      catch { return { stop: true, line: EXPERIENCE_STOP_LINE }; }
    }
    if (name === "call_screen") {
      try { return track(callScreen.run(callGateDeps(ctx), ctx, input as Parameters<typeof callScreen.run>[2])); }
      catch { return ports.env.CALL_GATEWAY_ENABLED === "1" ? { enabled: true, action: "forward", reason: "unsure", line: CALL_GATE_FORWARD_LINE } : { enabled: false }; }
    }
    if (!await db.brain.getParent(ctx)) throw new Error("Shield tool parent not found");
    const tool: ShieldTool = scheduledShieldTools[name as keyof typeof scheduledShieldTools];
    return track(tool.run(toolDeps(ctx), ctx, input));
  }) as BoundShieldTools["run"];

  return {
    handleShieldPair: (request: Request) => handleShieldPair(request, serverDeps),
    handleShieldEvent: (request: Request) => handleShieldEvent(request, serverDeps),
    handleSmsGateway: (request: Request) => handleSmsGateway(request, gatewayDeps),
    createPairingCode: (input: { familyId: string; userId: string }) => createPairingCode(serverDeps, input),
    shieldTools: { run } satisfies BoundShieldTools,
    pickDrill: (input: ToolCtx & { now: Date }) => pickDrill(drillDeps(), input),
    scamSense: (input: ToolCtx & { month: string }) => scamSense(drillDeps(), input),
    buildEvidencePack: (input: EvidenceRequest) => buildEvidencePack(evidenceDeps(), input),
    /** Recompute a stored receipt's contents hash and chain checkpoint. */
    verifyEvidencePack: (input: { familyId: string; packId: string }) => verifyEvidencePack(evidenceDeps(), input),

    /** Keypad onboarding: register the number Maa forwards SMS from. Only its fingerprint is stored. */
    async registerGatewayParent(input: { familyId: string; parentId: string; phone: string }) {
      const registry = db.gateway;
      if (!registry?.registerParent) throw new Error("Shield gateway storage is not configured");
      const phoneHash = await numberFingerprint(input.phone);
      if (!phoneHash) throw new Error("Invalid gateway phone number");
      if (!await registry.registerParent({ phoneHash, familyId: input.familyId, parentId: input.parentId })) {
        throw new Error("Shield gateway parent not found");
      }
      await signDrill(input, "shield.gateway.registered", "Keypad parent registered for SMS forwarding.");
      return { ok: true as const };
    },
    async unregisterGatewayParent(input: { familyId: string; parentId: string }) {
      const registry = db.gateway;
      if (!registry?.unregisterParent) throw new Error("Shield gateway storage is not configured");
      const removed = await registry.unregisterParent(input);
      await signDrill(input, "shield.gateway.unregistered", "Keypad parent removed from SMS forwarding.", { removed });
      return { ok: true as const, removed };
    },

    /** Maa's recorded yes for experience drills (clipRef = storage reference of the recording). */
    async recordDrillConsent(input: { familyId: string; parentId: string; clipRef: string }) {
      const clipRef = String(input.clipRef ?? "").trim();
      if (!clipRef || clipRef.length > 300) throw new Error("Invalid consent clip reference");
      const row = await experienceStore().recordConsent({ ...input, clipRef, givenAt: ports.clock.now() });
      if (!row) throw new Error("Drill parent not found");
      await signDrill(input, "shield.drill.consent", "Maa recorded consent for experience drills.");
      return { ok: true as const, consent_id: row.id };
    },
    async revokeDrillConsent(input: { familyId: string; parentId: string }) {
      const revoked = await experienceStore().revokeConsent({ ...input, at: ports.clock.now() });
      await signDrill(input, "shield.drill.consent_revoked", "Experience drill consent revoked.", { revoked });
      return { ok: true as const, revoked };
    },
    /** The child's per-parent switch. byUserId must be a child member of the family. */
    async setExperienceDrills(input: { familyId: string; parentId: string; enabled: boolean; byUserId: string }) {
      if (typeof input.enabled !== "boolean") throw new Error("Invalid experience drill switch");
      if (!await experienceStore().setEnabled({ ...input, at: ports.clock.now() })) throw new Error("Experience drills child access required");
      await signDrill(input, "shield.drill.experience_switch", `Experience drills switched ${input.enabled ? "on" : "off"} by the child.`, { enabled: input.enabled });
      return { ok: true as const, enabled: input.enabled };
    },
    /** Refuses unless consent AND switch AND none in the last 7 days AND outside quiet hours. */
    async startExperienceDrill(input: { familyId: string; parentId: string }) {
      const result = await startExperienceDrill(experienceDeps(), input);
      await signDrill(input, result.ok ? "shield.drill.experience.scheduled" : "shield.drill.experience.refused",
        result.ok ? "Experience drill scheduled." : "Experience drill refused.", result.ok ? { script_id: result.script_id } : { reason: result.reason });
      return result;
    },
    /** Next praise line for the daily check-in (Sarvam variable @drill_praise), or null. */
    async takeCheckinPraise(input: { familyId: string; parentId: string }) {
      const line = await experienceStore().takeCheckinLine({ ...input, at: ports.clock.now() });
      return line ? { drill_praise: line } : null;
    },

    /** Step 3.6 call gateway. { enabled: false } unless env CALL_GATEWAY_ENABLED === "1". */
    screenCall: (input: { familyId: string; parentId: string } & ScreenCallInput) => {
      const { familyId, parentId, ...call } = input;
      return track(screenCall(callGateDeps({ familyId, parentId }), { familyId, parentId }, call));
    },
    async handleScheduledJob(name: string, payload: unknown) {
      if (name === EXPERIENCE_DRILL_JOB) return runExperienceJob(payload);
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
