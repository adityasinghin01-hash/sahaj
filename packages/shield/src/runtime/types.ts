import type { Sql } from "postgres";
import type { understand, twoLock } from "@sahaj/adapters";
import type { ShieldBrainDeps, StoredVerdict, TimelineRow, ChildCard } from "../brain/types.js";
import type { ShieldServerDb } from "../server/types";
import type { ShieldDeps, ToolCtx } from "../tools/types";
import type { ShieldJobDeps, JobLedger } from "../jobs";
import type { ShieldEvent } from "@sahaj/shared";

/** Extra persistence needed to join the graph to the existing server/tools DB. */
export interface ShieldRuntimeDb {
  server: ShieldServerDb;
  tools: ShieldJobDeps["db"];
  brain: ShieldBrainDeps["db"];
  getEvent(eventId: string): Promise<ShieldEvent | null>;
  insertVoiceEvent(event: ShieldEvent): Promise<{ id: string }>;
  getVerdictForEvent(eventId: string): Promise<StoredVerdict | null>;
  /** Serialize across workers; work receives storage using the locked connection. */
  withEventLock<T>(eventId: string, work: (db: ShieldRuntimeDb) => Promise<T>): Promise<T>;
}

export type ShieldTimelineEntry = TimelineRow | Parameters<ShieldDeps["sign"]>[0];
export type ShieldCircleInput = Parameters<ShieldBrainDeps["atlas"]["startCircleChain"]>[0]
  | Parameters<ShieldDeps["atlas"]["startCircleChain"]>[0];

export interface ShieldRuntimePorts {
  sql: Sql;
  router: { understand: typeof understand; twoLock: typeof twoLock };
  whatsapp: ShieldDeps["whatsapp"] & ShieldBrainDeps["whatsapp"];
  /** Persist the child-app card and request push delivery. Receives no inbox text. */
  push: { childCard(input: ChildCard): Promise<unknown> };
  calls: ShieldDeps["calls"] & ShieldBrainDeps["calls"] & {
    getParentLine(input: ToolCtx): Promise<string | null>;
  };
  scheduler: {
    after(delayMs: number, name: string, payload: Record<string, unknown>): Promise<void>;
    /** Durable, atomic run-once ledger for the existing tool jobs. */
    claim: JobLedger["claim"];
  };
  atlas: {
    startCircleChain(input: ShieldCircleInput): Promise<unknown>;
    bridgeChild: ShieldDeps["atlas"]["bridgeChild"];
  };
  gate: ShieldBrainDeps["gate"];
  sign(entry: ShieldTimelineEntry): Promise<void>;
  waitUntil(promise: Promise<unknown>): void;
  env: { SHIELD_DEVICE_PAIRING_SECRET: string; SAFE_BROWSING_KEY?: string; DEMO_TIMER_SCALE?: string };
  clock: { now(): Date };
  cache: ShieldBrainDeps["cache"];
  log?: { error(message: string, meta?: Record<string, unknown>): void };
}

/** Offline tests replace storage only; all application modules still run unchanged. */
export type ShieldRuntimeTestPorts = Omit<ShieldRuntimePorts, "sql"> & { db: ShieldRuntimeDb; sql?: never };
