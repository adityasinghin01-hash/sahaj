import type { Sql } from "postgres";
import type { DrillStore, DrillStory, ExperienceStore } from "../drills";
import type { EvidenceDeps, EvidenceSensitiveSource, EvidenceStore } from "../evidence";
import type { CallGateDeps } from "../callgate";
import type { understand, twoLock } from "@sahaj/adapters";
import type { ShieldBrainDeps, StoredVerdict, TimelineRow, ChildCard } from "../brain/types.js";
import type { ShieldServerDb } from "../server/types";
import type { ShieldDeps, ToolCtx } from "../tools/types";
import type { ShieldJobDeps, JobLedger } from "../jobs";
import type { ShieldEvent } from "@sahaj/shared";
import type { GatewayRegistryDb, SmsGatewayDb } from "../gateway/types";

/** Extra persistence needed to join the graph to the existing server/tools DB. */
export interface ShieldRuntimeDb {
  /** Optional only for legacy offline storage fixtures. Production supplies both. */
  drills?: DrillStore;
  evidence?: EvidenceStore;
  server: ShieldServerDb;
  tools: ShieldJobDeps["db"];
  brain: ShieldBrainDeps["db"];
  getEvent(eventId: string): Promise<ShieldEvent | null>;
  insertVoiceEvent(event: ShieldEvent): Promise<{ id: string }>;
  getVerdictForEvent(eventId: string): Promise<StoredVerdict | null>;
  /** Serialize across workers; work receives storage using the locked connection. */
  withEventLock<T>(eventId: string, work: (db: ShieldRuntimeDb) => Promise<T>): Promise<T>;
  /** SMS gateway storage (migration 20261114000500). Without it the gateway route answers 500. */
  gateway?: SmsGatewayDb & Partial<GatewayRegistryDb>;
  /** Experience drills (migration 20261114000800). Absent = those features fail closed. */
  experience?: ExperienceStore;
  /** Call gateway lookups (people.phone fingerprints). Absent = screenCall forwards everything. */
  callgate?: CallGateDeps["db"];
}

export type ShieldTimelineEntry = TimelineRow | Parameters<ShieldDeps["sign"]>[0];
export type ShieldCircleInput = Parameters<ShieldBrainDeps["atlas"]["startCircleChain"]>[0]
  | Parameters<ShieldDeps["atlas"]["startCircleChain"]>[0];

export interface ShieldRuntimePorts {
  sql: Sql;
  /** Inject the shared catalogue when it is available; no production sample stories. */
  drillStories?: readonly DrillStory[];
  /** Required when building an evidence pack; absent configuration fails closed. */
  timeline?: EvidenceDeps["timeline"];
  /** Child-only originals (full numbers, original message) for evidence packs. Optional. */
  evidenceSensitive?: EvidenceSensitiveSource;
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
  env: { SHIELD_DEVICE_PAIRING_SECRET: string; SAFE_BROWSING_KEY?: string; DEMO_TIMER_SCALE?: string;
    /** Shared secret of the SMS gateway phone (>= 32 characters). Needed only for handleSmsGateway. */
    SMS_GATEWAY_SECRET?: string;
    /** "1" turns the call gateway (Step 3.6) on. Anything else: screenCall returns { enabled: false }. */
    CALL_GATEWAY_ENABLED?: string };
  clock: { now(): Date };
  cache: ShieldBrainDeps["cache"];
  log?: { error(message: string, meta?: Record<string, unknown>): void };
}

/** Offline tests replace storage only; all application modules still run unchanged. */
export type ShieldRuntimeTestPorts = Omit<ShieldRuntimePorts, "sql"> & { db: ShieldRuntimeDb; sql?: never };
