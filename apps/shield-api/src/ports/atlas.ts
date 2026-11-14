import type { Sql } from "postgres";
import type { ShieldRuntimePorts } from "@sahaj/shield";
import { writeOutbox } from "./outbox";

export function createAtlasPort(sql: Sql): ShieldRuntimePorts["atlas"] {
  return {
    async bridgeChild(input) {
      await writeOutbox(sql, {
        channel: "atlas",
        kind: "bridge_child",
        familyId: input.familyId,
        parentId: input.parentId,
        payload: {
          reason: input.reason,
        },
      });
    },
    async startCircleChain(input) {
      const verdictId = "verdictId" in input ? input.verdictId : undefined;
      const streakId = "streakId" in input ? input.streakId : undefined;
      const dedupeKey = verdictId
        ? `atlas:circle_chain:${verdictId}`
        : streakId
          ? `atlas:circle_chain:streak:${streakId}`
          : null;
      await writeOutbox(sql, {
        channel: "atlas",
        kind: "start_circle_chain",
        familyId: input.familyId,
        parentId: input.parentId,
        dedupeKey,
        payload: verdictId
          ? { verdict_id: verdictId }
          : {
              reason: "reason" in input ? input.reason : "unknown",
              ...(streakId ? { streak_id: streakId } : {}),
            },
      });
    },
  };
}

