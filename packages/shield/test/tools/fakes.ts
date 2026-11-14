import { vi } from "vitest";
import type { ScamJudgement } from "@sahaj/shared";
import type { FamilyCheckRecord, ShieldDeps, ToolCtx } from "../../src/tools";
import { sha256Hex } from "../../src/tools/check_code_word";

export const ctx: ToolCtx = { familyId: "fam_1", parentId: "maa_1" };

export const hang = <T>(): Promise<T> => new Promise<T>(() => undefined);

export type RulesResult = ReturnType<ShieldDeps["rules"]["scoreText"]>;

export interface FakeOptions {
  rules?: RulesResult;
  judgement?: ScamJudgement | null;
  people?: Record<string, { id: string; name: string }>;
  checks?: Record<string, FamilyCheckRecord>;
  codeWord?: string | null;
}

export const GREEN: RulesResult = { level: "green", scam_type: "unknown", hits: [] };

export const SCAM_JUDGEMENT: ScamJudgement = {
  is_scam: true,
  scam_type: "kyc_block",
  pressure_signals: ["urgency"],
  asks_for: ["otp"],
  confidence: 0.9,
  hindi_reason: "OTP maang raha hai",
};

export async function makeDeps(opts: FakeOptions = {}) {
  const people = opts.people ?? { rahul: { id: "p_rahul", name: "Rahul" } };
  const checks: Record<string, FamilyCheckRecord> = { ...(opts.checks ?? {}) };
  const codeHash = opts.codeWord === undefined ? await sha256Hex("neem ka ped") : opts.codeWord === null ? null : await sha256Hex(opts.codeWord);
  const judgement = opts.judgement === undefined ? null : opts.judgement;

  const llmCalls: { task: string; system: string; input: string }[] = [];

  const deps = {
    llm: {
      understand: vi.fn(async (req: { task: string; system: string; input: string }) => {
        llmCalls.push({ task: req.task, system: req.system, input: req.input });
        return judgement
          ? ({ ok: true, data: judgement, model: "fake-model" } as const)
          : ({ ok: false, reason: "no_judgement" } as const);
      }),
    },
    rules: { scoreText: vi.fn((_masked: string): RulesResult => opts.rules ?? GREEN) },
    whatsapp: { sendFamilyCheckCard: vi.fn(async () => undefined) },
    calls: {
      startResponderCall: vi.fn(async () => undefined),
      startCallback: vi.fn(async () => undefined),
    },
    atlas: {
      bridgeChild: vi.fn(async () => undefined),
      startCircleChain: vi.fn(async () => undefined),
      alertChild: vi.fn(async () => undefined),
    },
    db: {
      createFamilyCheck: vi.fn(async (input: { familyId: string; toPersonId: string; claimedName: string }) => {
        const id = `chk_${Object.keys(checks).length + 1}`;
        checks[id] = { state: "asked", familyId: input.familyId, toPersonId: input.toPersonId, claimedName: input.claimedName };
        return { id };
      }),
      getFamilyCheck: vi.fn(async (id: string) => checks[id] ?? null),
      findPersonByName: vi.fn(async (_familyId: string, name: string) => people[name.trim().toLowerCase()] ?? null),
      getCodeWordHash: vi.fn(async () => codeHash),
    },
    sign: vi.fn(async () => undefined),
    clock: { now: () => new Date("2026-11-14T10:00:00Z") },
  };

  return { deps: deps as unknown as ShieldDeps & typeof deps, llmCalls, checks };
}

/** Every string that reached the fake AI. */
export function textsSeenByAi(llmCalls: { task: string; system: string; input: string }[]): string[] {
  return llmCalls.flatMap((c) => [c.task, c.system, c.input]);
}
