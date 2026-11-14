import { vi } from "vitest";
import { ShieldEvent, type Verdict, type ScamJudgement } from "@sahaj/shared";
import type { ShieldBrainDeps, StoredVerdict, TwoLockResult } from "../../src/brain/types.js";

export const event = (overrides: Partial<ShieldEvent> = {}): ShieldEvent => ShieldEvent.parse({
  idempotency_key: "event-key-one", family_id: "family-a", parent_id: "maa",
  channel: "device", kind: "sms", occurred_at: "2026-11-14T09:00:00.000Z",
  masked_text: "Your bank KYC will expire. Share [OTP] urgently.", ...overrides,
});
export const reason = (id: string) => ({ rule_id: id, hi: "सावधान रहें।", en: "Be careful." });
export const verdict = (level: Verdict["level"] = "green"): Verdict => ({
  level, scam_type: "kyc_block", reasons: level === "green" ? [] : [reason("kyc"), reason("urgency"), reason("otp")],
  checks_fired: level === "green" ? [] : ["kyc", "urgency", "otp"], ai_used: false,
  models_agreed: [], confidence: 0.95, actions: [],
});
export const judgement = (is_scam = true): ScamJudgement => ({
  is_scam, scam_type: "kyc_block", pressure_signals: ["urgency"], asks_for: ["otp"],
  confidence: 0.9, hindi_reason: "ओटीपी साझा करने का दबाव है।",
});
export const locks = (a: boolean | null = true, b: boolean | null = true): TwoLockResult => {
  const result = (model: "claude" | "muse", v: boolean | null) => v === null
    ? { ok: false as const, reason: "all_failed" as const, attempts: [] }
    : { ok: true as const, model, data: judgement(v), attempts: [] };
  return { claude: result("claude", a), muse: result("muse", b) };
};
export function fixtures(level: Verdict["level"] = "green", needs_ai = false) {
  const stored = new Map<string, StoredVerdict>();
  const cache = new Map();
  const deps = {
    db: {
      getParent: vi.fn<ShieldBrainDeps["db"]["getParent"]>(async () => ({ id: "maa", family_id: "family-a", line_id: "line-maa" })),
      getRecentEvents: vi.fn<ShieldBrainDeps["db"]["getRecentEvents"]>(async () => []),
      insertVerdict: vi.fn(async (row: Omit<StoredVerdict, "id">) => {
        stored.set("verdict-a", { ...row, id: "verdict-a" }); return { id: "verdict-a" };
      }),
      getVerdict: vi.fn(async (id: string) => stored.get(id) ?? null),
      hasChildReaction: vi.fn(async () => false),
    },
    rules: { evaluate: vi.fn(async () => ({ verdict: verdict(level), needs_ai, links: [] as { url: string; domain: string }[] })) },
    cache: { get: vi.fn<ShieldBrainDeps["cache"]["get"]>(async (k: string) => cache.get(k)), set: vi.fn<ShieldBrainDeps["cache"]["set"]>(async (k: string, v: unknown) => { cache.set(k, v); }) },
    gate: { check: vi.fn<ShieldBrainDeps["gate"]["check"]>(async () => ({ allowed: true })) },
    notify: { childCard: vi.fn<ShieldBrainDeps["notify"]["childCard"]>(async () => {}) },
    whatsapp: { sendShieldAlert: vi.fn<ShieldBrainDeps["whatsapp"]["sendShieldAlert"]>(async () => {}) },
    calls: { callParent: vi.fn<ShieldBrainDeps["calls"]["callParent"]>(async () => ({ status: "busy" as "busy" | "answered" | "no_answer" | "failed" })) },
    scheduler: { after: vi.fn<ShieldBrainDeps["scheduler"]["after"]>(async () => {}) },
    atlas: { startCircleChain: vi.fn<ShieldBrainDeps["atlas"]["startCircleChain"]>(async () => {}) },
    sign: vi.fn<ShieldBrainDeps["sign"]>(async () => {}), twoLock: vi.fn<NonNullable<ShieldBrainDeps["twoLock"]>>(async () => locks()),
    env: {}, now: () => Date.parse("2026-11-14T09:05:00.000Z"),
    safeBrowsingFetch: vi.fn<typeof fetch>(async () => new Response("{}")),
    sandbox: { unshorten: vi.fn(async (url: string) => url) },
  } satisfies ShieldBrainDeps;
  return { deps, stored };
}
