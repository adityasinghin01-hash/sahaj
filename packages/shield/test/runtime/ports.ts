/** Fake outside-world ports for joined-runtime tests (K-B8). No network: providers are fakes. */
import { vi } from "vitest";
import { createRouter, type Provider } from "@sahaj/adapters";
import { createShieldRuntime } from "../../src/runtime";
import type { ShieldRuntimeDb, ShieldRuntimeTestPorts } from "../../src/runtime/types";

export const GATEWAY_SECRET = "runtime-gateway-secret-0123456789abcdef";

export function aiReply(data: Record<string, unknown>): Provider {
  return vi.fn(async () => ({ kind: "text" as const, text: JSON.stringify(data) }));
}

export function makeRuntime(db: ShieldRuntimeDb, opts: {
  provider?: Provider; now?: () => Date; env?: Partial<ShieldRuntimeTestPorts["env"]>; allow?: boolean;
} = {}) {
  const pending: Promise<unknown>[] = [];
  const provider = opts.provider ?? aiReply({ is_scam: false, scam_type: "unknown", pressure_signals: [], asks_for: [],
    confidence: 0.2, hindi_reason: "Theek lagta hai." });
  const ports: ShieldRuntimeTestPorts = {
    db, router: createRouter({ claude: provider, muse: provider, gemini: provider }),
    whatsapp: { sendShieldAlert: vi.fn(async () => undefined), sendFamilyCheckCard: vi.fn(async () => undefined) },
    push: { childCard: vi.fn(async () => undefined) },
    calls: { getParentLine: vi.fn(async () => "aasha-line"), callParent: vi.fn(async () => ({ status: "answered" as const })),
      startResponderCall: vi.fn(async () => undefined), startCallback: vi.fn(async () => undefined) },
    scheduler: { after: vi.fn(async () => undefined), claim: vi.fn(async () => true) },
    atlas: { bridgeChild: vi.fn(async () => undefined), startCircleChain: vi.fn(async () => undefined) },
    gate: { check: vi.fn(async () => ({ allowed: opts.allow ?? true })) },
    sign: vi.fn(async () => undefined),
    waitUntil(promise) { pending.push(promise); },
    env: { SHIELD_DEVICE_PAIRING_SECRET: "k-b8-runtime-pairing-secret-long-enough", SMS_GATEWAY_SECRET: GATEWAY_SECRET,
      DEMO_TIMER_SCALE: "60", ...opts.env },
    clock: { now: opts.now ?? (() => new Date("2026-11-14T06:00:00.000Z")) },
    cache: { get: vi.fn(async () => null), set: vi.fn(async () => undefined) },
    log: { error: vi.fn() },
  };
  const runtime = createShieldRuntime(ports);
  const flush = async () => { while (pending.length) await Promise.allSettled(pending.splice(0)); };
  return { runtime, ports, provider, flush };
}
