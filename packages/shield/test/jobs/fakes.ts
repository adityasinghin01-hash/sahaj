import { vi } from "vitest";
import type { FamilyCheckRecord } from "../../src/tools";
import type { ShieldJobDeps } from "../../src/jobs";
import { makeDeps, type FakeOptions } from "../tools/fakes";

export { ctx } from "../tools/fakes";

export interface Queued {
  ms: number;
  job: string;
  payload: Record<string, unknown>;
}

/** Tool fakes + an in-memory scheduler, job ledger and the no-answer DB write. */
export async function makeJobDeps(opts: FakeOptions & { childName?: string | null; env?: Record<string, string> } = {}) {
  const base = await makeDeps(opts);
  const checks: Record<string, FamilyCheckRecord> = base.checks;
  const queued: Queued[] = [];
  const claimed = new Set<string>();

  const scheduler = {
    after: vi.fn(async (ms: number, job: string, payload: Record<string, unknown>) => {
      queued.push({ ms, job, payload });
    }),
  };
  const jobs = {
    claim: vi.fn(async (key: string) => {
      if (claimed.has(key)) return false;
      claimed.add(key);
      return true;
    }),
  };
  const markFamilyCheckNoAnswer = vi.fn(async (id: string) => {
    const rec = checks[id];
    if (!rec || rec.state !== "asked") return false;
    rec.state = "no_answer";
    return true;
  });

  const deps = Object.assign(base.deps, {
    scheduler,
    jobs,
    env: opts.env ?? {},
    childName: vi.fn(async () => (opts.childName === undefined ? "Riya" : opts.childName)),
  });
  Object.assign(deps.db, { markFamilyCheckNoAnswer });

  return {
    deps: deps as typeof deps & ShieldJobDeps & { db: typeof deps.db & { markFamilyCheckNoAnswer: typeof markFamilyCheckNoAnswer } },
    checks,
    queued,
    claimed,
  };
}
