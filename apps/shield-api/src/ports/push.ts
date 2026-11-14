import type { Sql } from "postgres";
import { buildShieldAlert, type ShieldRuntimePorts } from "@sahaj/shield";
import { writeOutbox } from "./outbox";

export function createPushPort(sql: Sql): ShieldRuntimePorts["push"] {
  return {
    async childCard(card) {
      const channel =
        card.verdict.actions.includes("speak_clip") && !card.verdict.actions.includes("show_red_screen")
          ? "keypad_voice"
          : "device";
      const alert = buildShieldAlert(card.verdict, { parentName: "Maa", channel, lang: "en" });
      await writeOutbox(sql, {
        channel: "push",
        kind: "child_card",
        familyId: card.familyId,
        parentId: card.parentId,
        dedupeKey: `push:child_card:${card.verdictId}`,
        payload: {
          verdict_id: card.verdictId,
          level: card.verdict.level,
          scam_type: card.verdict.scam_type,
          quiet: card.quiet,
          push: card.push,
          offer_1930: card.offer1930,
          alert,
        },
      });
    },
  };
}

