import type { z, ZodType } from "zod";
import type { AlertLevel } from "@sahaj/shared";

export type FamilyCheckStateValue = "asked" | "confirmed" | "denied" | "no_answer";

export interface CreateFamilyCheckInput {
  familyId: string;
  parentId: string;
  toPersonId: string;
  claimedName: string;
  /** Masked: never contains a 4+ digit run. */
  askedWhat: string;
  state: "asked";
  createdAt: Date;
}

export interface FamilyCheckRecord {
  state: FamilyCheckStateValue;
  /** Optional extras. When present they let the tools speak the name and scope the check to the caller's family. */
  familyId?: string;
  toPersonId?: string;
  claimedName?: string;
}

export interface ShieldDeps {
  llm: {
    understand<T>(req: {
      task: string;
      system: string;
      input: string;
      schema: ZodType<T>;
      effort?: "low" | "medium";
    }): Promise<{ ok: true; data: T; model: string } | { ok: false; reason: string }>;
  };
  rules: {
    scoreText(maskedText: string): { level: AlertLevel; scam_type: string; hits: string[] };
  };
  whatsapp: {
    sendFamilyCheckCard(input: {
      familyId: string;
      toPersonId: string;
      claimedName: string;
      askedWhat: string;
      checkId: string;
    }): Promise<void>;
  };
  calls: {
    /**
     * Family-check responder call. With purpose "experience_drill" (Step 3.5) the call goes to the
     * parent (toPersonId = parentId, checkId = drill id) and speaks the given GENERIC script.
     */
    startResponderCall(input: {
      familyId: string; toPersonId: string; checkId: string;
      purpose?: "experience_drill";
      script?: { id: string; opening_hi: string; ask_hi: string; nudge_hi: string };
    }): Promise<void>;
    startCallback(input: { familyId: string; parentId: string; line: string }): Promise<void>;
  };
  atlas: {
    bridgeChild(input: { familyId: string; parentId: string; reason: string }): Promise<void>;
    startCircleChain(input: { familyId: string; parentId: string; reason: string }): Promise<void>;
    alertChild(input: { familyId: string; parentId: string; verdict: unknown }): Promise<void>;
  };
  db: {
    createFamilyCheck(input: CreateFamilyCheckInput): Promise<{ id: string }>;
    getFamilyCheck(id: string): Promise<FamilyCheckRecord | null>;
    findPersonByName(familyId: string, name: string): Promise<{ id: string; name: string } | null>;
    getCodeWordHash(familyId: string): Promise<string | null>;
  };
  sign(event: { familyId: string; type: string; line: string; data?: Record<string, unknown> }): Promise<void>;
  clock: { now(): Date };
}

export interface ToolCtx {
  familyId: string;
  parentId: string;
}

export interface ShieldTool<S extends ZodType = ZodType, O = unknown> {
  name: string;
  description: string;
  input: S;
  /** Validates input, never throws, and always resolves within TOOL_TIMEOUT_MS (safe fallback on timeout/error). */
  run(deps: ShieldDeps, ctx: ToolCtx, input: z.input<S>): Promise<O>;
}
