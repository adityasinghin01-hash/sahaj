import type { Sql } from "postgres";
import type { ShieldRuntimePorts } from "@sahaj/shield";
import { writeOutbox } from "./outbox";

export function createCallsPort(
  sql: Sql,
  env: Readonly<Record<string, string | undefined>>,
): ShieldRuntimePorts["calls"] {
  const configuredLine = env.AASHA_DIDI_LINE_ID?.trim() || "dev-outbox-line";

  return {
    async getParentLine() {
      return configuredLine;
    },
    async callParent(input) {
      await writeOutbox(sql, {
        channel: "calls",
        kind: "call_parent",
        familyId: input.familyId,
        parentId: input.parentId,
        dedupeKey: `calls:call_parent:${input.verdictId}:${input.attempt}`,
        payload: {
          line_id: input.lineId,
          verdict_id: input.verdictId,
          attempt: input.attempt,
        },
      });
      return { status: "answered" };
    },
    async startResponderCall(input) {
      await writeOutbox(sql, {
        channel: "calls",
        kind: "start_responder_call",
        familyId: input.familyId,
        dedupeKey: `calls:responder:${input.checkId}`,
        payload: {
          to_person_id: input.toPersonId,
          check_id: input.checkId,
        },
      });
    },
    async startCallback(input) {
      await writeOutbox(sql, {
        channel: "calls",
        kind: "start_callback",
        familyId: input.familyId,
        parentId: input.parentId,
        payload: {
          line: input.line,
        },
      });
    },
  };
}

