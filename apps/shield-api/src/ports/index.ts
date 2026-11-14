import { after } from "next/server";
import type { Sql } from "postgres";
import { createDefaultRouter } from "@sahaj/adapters";
import type { ShieldRuntimePorts } from "@sahaj/shield";
import { createAtlasPort } from "./atlas";
import { createCachePort } from "./cache";
import { createCallsPort } from "./calls";
import { createGatePort } from "./gate";
import { createPushPort } from "./push";
import { createSchedulerPort } from "./scheduler";
import { createTimelineSigner } from "./sign";
import { createWhatsappPort, isWhatsappConfigured } from "./whatsapp";

export interface PortsStatus {
  sql: "real";
  router: "real" | "unconfigured";
  whatsapp: "real" | "outbox";
  push: "outbox";
  calls: "outbox";
  atlas: "outbox";
  scheduler: "real";
  gate: "real";
  sign: "dev_timeline_sha256";
  cache: "real";
}

export function getPortsStatus(env: Readonly<Record<string, string | undefined>>): PortsStatus {
  const routerConfigured = Boolean(
    env.ANTHROPIC_API_KEY?.trim() || env.MUSE_API_KEY?.trim() || env.GEMINI_API_KEY?.trim(),
  );
  return {
    sql: "real",
    router: routerConfigured ? "real" : "unconfigured",
    whatsapp: isWhatsappConfigured(env) ? "real" : "outbox",
    push: "outbox",
    calls: "outbox",
    atlas: "outbox",
    scheduler: "real",
    gate: "real",
    sign: "dev_timeline_sha256",
    cache: "real",
  };
}

export function nextWaitUntil(promise: Promise<unknown>): void {
  const handled = promise.catch(() => undefined);
  try {
    after(() => handled);
  } catch {
    // Outside a Next.js request context (e.g. unit tests), keep the promise handled.
    void handled;
  }
}

export function createShieldPorts(opts: {
  shieldSql: Sql;
  auxSql: Sql;
  env: Readonly<Record<string, string | undefined>>;
  clock?: { now(): Date };
  waitUntil?: (promise: Promise<unknown>) => void;
  fetchFn?: typeof fetch;
}): ShieldRuntimePorts {
  const clock = opts.clock ?? { now: () => new Date() };
  const sign = createTimelineSigner(opts.auxSql);
  const router = createDefaultRouter({ env: opts.env });

  return {
    sql: opts.shieldSql,
    router: {
      understand: router.understand,
      twoLock: router.twoLock,
    },
    whatsapp: createWhatsappPort(opts.auxSql, opts.env, opts.fetchFn),
    // Key-free link checks; OPENPHISH_FEED=0 / RDAP_LOOKUP=0 switch them off (lab e2e does).
    linkIntelFetch: opts.fetchFn ?? fetch,
    push: createPushPort(opts.auxSql),
    calls: createCallsPort(opts.auxSql, opts.env),
    scheduler: createSchedulerPort(opts.auxSql, clock),
    atlas: createAtlasPort(opts.auxSql),
    gate: createGatePort(sign),
    sign,
    waitUntil: opts.waitUntil ?? nextWaitUntil,
    env: {
      SHIELD_DEVICE_PAIRING_SECRET: opts.env.SHIELD_DEVICE_PAIRING_SECRET ?? "",
      SAFE_BROWSING_KEY: opts.env.SAFE_BROWSING_KEY,
      DEMO_TIMER_SCALE: opts.env.DEMO_TIMER_SCALE,
      SMS_GATEWAY_SECRET: opts.env.SMS_GATEWAY_SECRET,
    },
    clock,
    cache: createCachePort(opts.auxSql, clock),
    log: {
      error(message, meta) {
        console.error(message, meta ? JSON.stringify(meta) : "");
      },
    },
    // C-06 additions: configured delivery and the existing runtime evidence port.
    ...createAppDeliveryPorts(opts),
  };
}

import { createAppTimelinePort } from "../lib/app_timeline";
export function createAppDeliveryPorts(opts: { auxSql: Sql; env: Readonly<Record<string,string|undefined>>; fetchFn?: typeof fetch }): Partial<Pick<ShieldRuntimePorts, "push" | "calls" | "timeline">> {
  return {
    push: createPushPort(opts.auxSql, opts.env, opts.fetchFn),
    calls: createCallsPort(opts.auxSql, opts.env, opts.fetchFn),
    timeline: createAppTimelinePort(opts.auxSql),
  };
}
