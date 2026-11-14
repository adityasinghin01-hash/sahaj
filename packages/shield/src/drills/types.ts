import type { ZodType } from "zod";
import type { ScamType } from "@sahaj/shared";

/** Supplied by the host/shared story catalogue. No bundled production stories. */
export interface DrillStory {
  id: string;
  scam_type: ScamType;
  story_hi: string;
  good_answers: string[];
  risky_answers: string[];
  teach_line_hi: string;
}
export interface DrillRecord {
  family_id: string;
  parent_id: string;
  drill_id: string;
  type: "helper" | "experience";
  asked_at: string;
  answer_masked: string | null;
  score: 0 | 1 | 2 | null;
  teach_line_played: boolean;
}
export interface DrillContext { familyId: string; parentId: string }
export interface DrillStore {
  /** Cross-worker transaction lock. All callback operations use its connection. */
  withParentLock<T>(ctx: DrillContext, work: (store: DrillStore) => Promise<T>): Promise<T>;
  getParent(ctx: DrillContext): Promise<boolean>;
  /** Latest ten HELPER drills (experience drills have their own weekly limit). */
  recent(ctx: DrillContext): Promise<DrillRecord[]>;
  insert(record: DrillRecord): Promise<void>;
  getAsked(input: DrillContext & { drillId: string }): Promise<DrillRecord | null>;
  /**
   * Conditional first answer only; caller serializes against issuance and other answers.
   * teachLinePlayed: the tool handed off the teaching line (score < 2). Omitted = true (C-04 callers).
   */
  saveAnswer(input: DrillContext & { drillId: string; answerMasked: string; score: 0 | 1 | 2; teachLinePlayed?: boolean }): Promise<void>;
  between(input: DrillContext & { since: string; until: string }): Promise<DrillRecord[]>;
}
export interface DrillDeps {
  stories: readonly DrillStory[];
  db: DrillStore;
  router: {
    understand<T>(req: { task: string; system: string; input: string; schema: ZodType<T>; effort: "low"; timeoutMs?: number }):
      Promise<{ ok: true; data: T; model: string } | { ok: false; reason: string }>;
  };
  clock: { now(): Date };
}
