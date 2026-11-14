import { shield, shieldAvailable } from "./shield";

export type MaaHeardMessageKind =
  | "core2_reassurance"
  | "core1_voice_post"
  | "gentle_news_voice";

export interface ReportMaaPlaybackFinishedInput {
  messageKind: MaaHeardMessageKind;
  deliveryId: string;
  reassuranceId?: string | null;
  voicePostId?: string | null;
  clipDurationS: number;
  playedDurationS: number;
  playbackFinished: boolean;
  finishedAtIso?: string;
}

export interface ReportMaaPlaybackFinishedResult {
  ok: boolean;
  receipt_id?: string;
  heard_at?: string;
  badge_label?: string;
  already_recorded?: boolean;
  error?: string;
}

function getBaseUrl(): string {
  const fromShield = shieldAvailable ? shield.getServerAddress() : null;
  const raw =
    (fromShield && fromShield.trim()) ||
    process.env.EXPO_PUBLIC_API_URL ||
    process.env.EXPO_PUBLIC_SHIELD_SERVER_URL ||
    "";
  return raw.replace(/\/+$/, "");
}

/**
 * Standalone helper for Maa's smartphone app (`apps/parent`) to send a
 * device-signed playback-completion acknowledgement to `POST /api/core2/heard/device`.
 *
 * IMPORTANT:
 * - Never call this on a timer or when playback starts; call it ONLY inside the
 *   audio player's natural completion callback (`status.didJustFinish === true`)
 *   when `playedDurationS >= clipDurationS`.
 * - Lead wiring in `apps/parent/src/app/voice.tsx`:
 *   Import `reportMaaPlaybackFinished` from `../lib/maa-heard` and invoke it inside
 *   `onPlaybackStatusUpdate` right when `status.didJustFinish` fires with the clip's
 *   duration in seconds.
 */
export async function reportMaaPlaybackFinished(
  input: ReportMaaPlaybackFinishedInput,
): Promise<ReportMaaPlaybackFinishedResult> {
  if (!input.playbackFinished || input.playedDurationS < input.clipDurationS) {
    return {
      ok: false,
      error: "heard_proof_requires_full_playback",
    };
  }

  const base = getBaseUrl();
  if (!base || !shieldAvailable) {
    return { ok: false, error: "device_signing_unavailable" };
  }

  const status = shield.getStatus();
  if (!status || !status.paired) {
    return { ok: false, error: "device_not_paired" };
  }

  const body = JSON.stringify({
    message_kind: input.messageKind,
    delivery_id: input.deliveryId,
    ...(input.reassuranceId ? { reassurance_id: input.reassuranceId } : {}),
    ...(input.voicePostId ? { voice_post_id: input.voicePostId } : {}),
    clip_duration_s: Math.max(1, Math.round(input.clipDurationS)),
    played_duration_s: Math.max(1, Math.round(input.playedDurationS)),
    playback_finished: true,
    finished_at: input.finishedAtIso ?? new Date().toISOString(),
  });

  const signed = shield.signRequest(body);
  if (!signed || !signed["x-shield-sig"] || !signed["x-shield-ts"]) {
    return { ok: false, error: "signing_failed" };
  }

  try {
    const res = await fetch(`${base}/api/core2/heard/device`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...signed,
      },
      body,
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      return {
        ok: false,
        error: typeof data.error === "string" ? data.error : `http_${res.status}`,
      };
    }
    return {
      ok: true,
      receipt_id: typeof data.receipt_id === "string" ? data.receipt_id : undefined,
      heard_at: typeof data.heard_at === "string" ? data.heard_at : undefined,
      badge_label: typeof data.badge_label === "string" ? data.badge_label : undefined,
      already_recorded: Boolean(data.already_recorded),
    };
  } catch {
    return { ok: false, error: "network_error" };
  }
}
