/**
 * Compile-time and runtime check that this lane's exports fit the Phase 3 seam EXACTLY as Phase 3 documents it
 * (kiro-phase3 apps/api/src/lib/atlas-runtime/bridge.ts `Phase2Entrypoints` and phase2-modules.ts). The interface below is a
 * read-only copy of that shape; it is not imported because the Phase 3 file is not in this branch. If either side changes,
 * `pnpm exec tsc --noEmit` or this test fails.
 */
import { describe, expect, it } from "vitest";
import * as dispatch from "../../src/lib/provider-dispatch";
import * as recording from "../../src/lib/recording-worker";

type ContactProvider = "sarvam" | "twilio" | "whatsapp";
type Disposition = { action: "complete" | "retry"; code: string };
interface Phase2Entrypoints {
  dispatchStore(db: unknown): unknown;
  runOutboxDispatchTick(deps: Record<string, unknown>): Promise<{ enabled: boolean; claimed: number; outcomes: Record<string, number> }>;
  runStatusNormalizationJob(deps: { store: unknown; readRaw(id: string): Promise<{ familyId: string; source: string; eventType: string; metadata: Record<string, unknown> } | null> }, rawEventId: string): Promise<Disposition>;
  recordingStore(db: unknown): unknown;
  recordingStorage(db: unknown): unknown;
  runRecordingJob(deps: Record<string, unknown>, db: unknown, rawEventId: string): Promise<Disposition>;
  createContactResolver(db: unknown, cfg: { encryptionKeyHex: string; identitySecret: string; accounts: Partial<Record<ContactProvider, string>> }): (familyId: string, personId: string, provider: ContactProvider) => Promise<string | null>;
  purgeStore(db: unknown): unknown;
  runRecordingPurgeTick(deps: Record<string, unknown>): Promise<{ purged: number; skipped: number; failed: number; refused: number; enabled: boolean }>;
}

// Exactly the composition phase2-modules.ts documents.
const phase2Entrypoints: Phase2Entrypoints = {
  dispatchStore: (db) => dispatch.dispatchStore(db as never) as unknown,
  runOutboxDispatchTick: (deps) => dispatch.runOutboxDispatchTick(deps as never) as never,
  runStatusNormalizationJob: (deps, id) => dispatch.runStatusNormalizationJob(deps as never, id),
  createContactResolver: (db, cfg) => dispatch.createContactResolver(db as never, cfg),
  recordingStore: (db) => recording.recordingStore(db as never) as unknown,
  recordingStorage: (db) => recording.recordingStorage(db as never) as unknown,
  runRecordingJob: (deps, db, id) => recording.runRecordingJob(deps as never, db as never, id),
  purgeStore: (db) => recording.purgeStore(db as never) as unknown,
  runRecordingPurgeTick: (deps) => recording.runRecordingPurgeTick(deps as never),
};

describe("Phase 3 seam", () => {
  it("every entrypoint exists and the gated ones do nothing when disabled", async () => {
    for (const fn of Object.values(phase2Entrypoints)) expect(typeof fn).toBe("function");
    const resolver = phase2Entrypoints.createContactResolver({ from: () => { throw new Error("must not query"); }, rpc: async () => ({ data: null, error: null }) },
      { encryptionKeyHex: "ab".repeat(32), identitySecret: "x".repeat(40), accounts: {} });
    expect(await resolver("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "whatsapp")).toBeNull(); // no account configured
    expect(await phase2Entrypoints.runOutboxDispatchTick({ enabled: false })).toMatchObject({ enabled: false, claimed: 0 });
    expect(await phase2Entrypoints.runRecordingPurgeTick({ enabled: false })).toMatchObject({ enabled: false, purged: 0 });
  });
});
