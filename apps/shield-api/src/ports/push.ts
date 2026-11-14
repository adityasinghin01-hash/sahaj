import { createHash } from "node:crypto";
import type { Sql } from "postgres";
import { buildShieldAlert, type ShieldRuntimePorts } from "@sahaj/shield";
import { writeOutbox } from "./outbox";
import { claimProvider, finishProvider } from "../lib/app_provider";

export function createPushPort(
  sql: Sql,
  env: Readonly<Record<string, string | undefined>> = process.env,
  fetchFn: typeof fetch = fetch,
): ShieldRuntimePorts["push"] {
  return {
    async childCard(card) {
      const channel =
        card.verdict.actions.includes("speak_clip") &&
        !card.verdict.actions.includes("show_red_screen")
          ? "keypad_voice"
          : "device";
      const alert = buildShieldAlert(card.verdict, {
        parentName: "Maa",
        channel,
        lang: "en",
      });
      const red = card.verdict.level === "red";
      // The shared formatter masks OTPs/phones and supplies an empty-reason fallback.
      // Push displays only its reason line; remove even short/Unicode numbers here.
      const reason = (alert.body.split("\n")[1] ?? "Suspicious call or message")
        .replace(/\p{Nd}+/gu, "•••");
      const key = `push:child_card:${card.verdictId}`;
      await writeOutbox(sql, {
        channel: "push",
        kind: "child_card",
        familyId: card.familyId,
        parentId: card.parentId,
        dedupeKey: key,
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
      if (env.EXPO_PUSH_ENABLED !== "1") return;
      const tokens = await sql<
        { expo_token: string }[]
      >`select distinct t.expo_token from public.app_push_tokens t
        join public.family_memberships m on m.family_id=t.family_id and m.user_id=t.user_id and m.role='child' and m.revoked_at is null
        where t.family_id=${card.familyId}`;
      for (const { expo_token: token } of tokens) {
        const receipt = await claimProvider(sql, {
          channel: "push",
          kind: "expo_child_card",
          familyId: card.familyId,
          parentId: card.parentId,
          key: `${key}:expo:${createHash("sha256").update(token).digest("hex")}`,
        });
        if (!receipt) continue;
        try {
          const response = await fetchFn(
            "https://exp.host/--/api/v2/push/send",
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Accept: "application/json",
                ...(env.EXPO_ACCESS_TOKEN
                  ? { Authorization: `Bearer ${env.EXPO_ACCESS_TOKEN}` }
                  : {}),
              },
              body: JSON.stringify({
                to: token,
                title: red ? "🔴 Maa ko scam call/message" : alert.title,
                body: reason,
                channelId: red ? "shield-red-v2" : "shield-quiet-v2",
                priority: red ? "high" : "normal",
                // Bundled on both platforms. iOS uses its default if the file is absent.
                // Android 8+ plays the channel sound; a red must override card.quiet.
                sound: red ? "shield_alarm.wav" : "default",
                data: { verdict_id: card.verdictId, route: "/alert", level: card.verdict.level },
              }),
              signal: AbortSignal.timeout(5000),
            },
          );
          const json = (await response.json()) as {
            data?: {
              status?: string;
              id?: string;
              details?: { error?: string };
            };
          };
          const accepted =
            response.ok &&
            json.data?.status === "ok" &&
            typeof json.data.id === "string";
          await finishProvider(
            sql,
            receipt,
            accepted ? "accepted" : "failed",
            accepted ? json.data!.id : undefined,
          );
          if (json.data?.details?.error === "DeviceNotRegistered")
            await sql`delete from public.app_push_tokens where expo_token=${token}`;
        } catch {
          await finishProvider(sql, receipt, "unknown");
        }
      }
    },
  };
}
