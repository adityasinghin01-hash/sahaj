import { afterEach, expect, it, vi } from "vitest";
import { ShieldEvent, Verdict } from "@sahaj/shared";
import { createRouter } from "@sahaj/adapters";
import { createShieldRuntime, isShieldToolName, shieldTools, type ShieldRuntimeTestPorts } from "../../src";
import { storage } from "../e2e/storage";
import { fixture, now, stories } from "./helpers";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

it("exports and binds drill_answer, weekly selection and scamSense in the joined runtime", async () => {
  const store = await storage(); cleanup.push(store.close);
  const drill = fixture(store.ctx); store.db.drills = drill.deps.db;
  const provider = vi.fn(async () => ({ kind: "text" as const, text: JSON.stringify({ score: 2, matched_good: ["Riya ko batana"], matched_risky: [], reason_en: "safe" }) }));
  const ports: ShieldRuntimeTestPorts = {
    db: store.db, router: createRouter({ claude: provider, muse: provider, gemini: provider }), drillStories: stories,
    whatsapp: { sendFamilyCheckCard: async () => {}, sendShieldAlert: async () => {} },
    push: { childCard: async () => {} },
    calls: { getParentLine: async () => null, callParent: async () => ({ status: "answered" }), startResponderCall: async () => {}, startCallback: async () => {} },
    scheduler: { after: async () => {}, claim: async () => true },
    atlas: { startCircleChain: async () => {}, bridgeChild: async () => {} },
    gate: { check: async () => ({ allowed: true }) }, sign: async () => {}, waitUntil: promise => { void promise; },
    env: { SHIELD_DEVICE_PAIRING_SECRET: "c04-runtime-test-pairing-secret-long" }, clock: { now: () => now },
    cache: { get: async () => null, set: async () => {} },
  };
  const runtime = createShieldRuntime(ports);
  expect(isShieldToolName("drill_answer")).toBe(true);
  expect(isShieldToolName("toString")).toBe(false);
  expect(shieldTools.drill_answer.name).toBe("drill_answer");
  expect(await runtime.pickDrill({ ...store.ctx, now })).toMatchObject({ drill_id: "power" });
  expect(await runtime.shieldTools.run("drill_answer", store.ctx, { drill_id: "power", said: "Riya ko batana code 123456" })).toMatchObject({ score: 2 });
  expect(provider).toHaveBeenCalledOnce();
  expect(drill.rows[0]!.answer_masked).not.toContain("123456");
  expect(await runtime.scamSense({ ...store.ctx, month: "2026-11" })).toMatchObject({ score_out_of_5: 5 });
  expect(await runtime.pickDrill({ ...store.ctx, now })).toBeNull();
  expect(() => runtime.buildEvidencePack({ familyId: store.ctx.familyId, verdictId: "missing", viewerUserId: "child" })).toThrow("Shield evidence ports not configured");
  const receipt = vi.fn(async () => {});
  store.db.evidence = {
    isChild: async input => input.familyId === store.ctx.familyId && input.viewerUserId === store.userId,
    getIncident: async () => ({ ...store.ctx, verdictId: "incident", createdAt: now.toISOString(), eventIds: ["event"],
      verdict: Verdict.parse({ level: "red", scam_type: "otp_theft", reasons: [], checks_fired: [], ai_used: false, confidence: 1, actions: [] }),
      events: [{ id: "event", event: ShieldEvent.parse({ family_id: store.ctx.familyId, parent_id: store.ctx.parentId,
        idempotency_key: "runtime-evidence", channel: "keypad_voice", kind: "voice_report", occurred_at: now.toISOString(), masked_text: "OTP <NUM>" }) }] }),
    savePack: receipt,
  };
  ports.timeline = { entriesFor: vi.fn(async () => []), chainHashFor: vi.fn(async () => "a".repeat(64)) };
  const pack = await runtime.buildEvidencePack({ familyId: store.ctx.familyId, verdictId: "incident", viewerUserId: store.userId });
  expect(pack.copy_for_1930).toContain("number: ask Maa / check her call log");
  expect(receipt).toHaveBeenCalledOnce();
  await expect(runtime.buildEvidencePack({ familyId: store.ctx.familyId, verdictId: "incident", viewerUserId: "outsider" })).rejects.toThrow("Evidence child access required");
  delete store.db.drills;
  expect(await runtime.shieldTools.run("drill_answer", store.ctx, { drill_id: "power", said: "Riya ko batana" })).toMatchObject({ score: 0 });
});
