import { z } from "zod";
import { Core2Error, newCore2Key } from "./core2";
import type { Session } from "./session";

export const MaaQuestionSchema = z.object({
  id: z.string(),
  question: z.string(),
  recorded_at: z.string(),
  source: z.enum(["sarvam_tool", "system"]),
});
export type MaaQuestion = z.infer<typeof MaaQuestionSchema>;

export const GentleNewsStateSchema = z.object({
  id: z.uuid(),
  family_id: z.uuid(),
  incident_id: z.uuid(),
  subject_person_id: z.uuid(),
  parent_person_id: z.uuid(),
  status: z.enum([
    "circle_offered",
    "companion_with_maa",
    "maa_call_queued",
    "maa_called",
    "closed",
  ]),
  calm_summary: z.string(),
  voice_post_id: z.uuid().nullable(),
  circle_person_id: z.uuid().nullable(),
  circle_display_name: z.string().nullable(),
  circle_offer_status: z.enum([
    "none",
    "offered",
    "accepted",
    "declined",
    "timed_out",
    "with_maa",
  ]),
  circle_offered_at: z.string().nullable(),
  circle_accepted_at: z.string().nullable(),
  circle_with_maa_at: z.string().nullable(),
  maa_call_due_at: z.string(),
  remaining_ms: z.number(),
  maa_call_queued_at: z.string().nullable(),
  maa_questions: z.array(MaaQuestionSchema),
  maa_notified_via_push: z.literal(false),
  created_at: z.string(),
  updated_at: z.string(),
});
export type GentleNewsState = z.infer<typeof GentleNewsStateSchema>;

export const HeardStatusSchema = z.object({
  delivery_id: z.uuid(),
  message_kind: z.enum(["core2_reassurance", "core1_voice_post", "gentle_news_voice"]),
  heard_verified: z.boolean(),
  heard_at: z.string().nullable(),
  channel: z.enum(["smartphone_app", "keypad_twilio"]).nullable(),
  evidence_type: z
    .enum([
      "device_signed_playback_end",
      "twilio_gather_after_playback",
      "twilio_status_duration_gte_clip",
    ])
    .nullable(),
  badge_label: z.string(),
});
export type HeardStatus = z.infer<typeof HeardStatusSchema>;

export const AfterReportDeliverySchema = z.object({
  delivery_id: z.uuid(),
  message_kind: z.enum(["core2_reassurance", "core1_voice_post", "gentle_news_voice"]),
  label: z.string(),
  sent_at: z.string(),
  delivery_status: z.string(),
  delivered: z.boolean(),
  heard: z.boolean(),
  heard_at: z.string().nullable(),
  heard_channel: z.enum(["smartphone_app", "keypad_twilio"]).nullable(),
  heard_evidence: z
    .enum([
      "device_signed_playback_end",
      "twilio_gather_after_playback",
      "twilio_status_duration_gte_clip",
    ])
    .nullable(),
  badge_label: z.string(),
});
export type AfterReportDelivery = z.infer<typeof AfterReportDeliverySchema>;

export const AfterReportSchema = z.object({
  schema_version: z.literal("sahaj.after_report.v1"),
  family_id: z.uuid(),
  incident_id: z.uuid(),
  closed_at: z.string(),
  redaction: z.object({
    phone_numbers_stripped: z.literal(true),
    location_trail_stripped: z.literal(true),
    ai_cloned_voice_used: z.literal(false),
  }),
  what_happened: z.object({
    severity: z.string(),
    final_state: z.string(),
    subject_person_id: z.uuid(),
    subject_name: z.string(),
    gentle_news_triggered: z.boolean(),
    calm_summary: z.string().nullable(),
    maa_questions: z.array(MaaQuestionSchema),
    timeline_chain_verified: z.boolean(),
    timeline_entries: z.array(
      z.object({
        id: z.string(),
        event_type: z.string(),
        human_line: z.string(),
        created_at: z.string(),
      }),
    ),
  }),
  who_accepted: z.object({
    owner_person_id: z.string().nullable(),
    owner_name: z.string().nullable(),
    assignments: z.array(
      z.object({
        assignment_id: z.string(),
        person_id: z.string(),
        display_name: z.string().nullable(),
        role: z.string().nullable(),
        status: z.string(),
        offered_at: z.string(),
        accepted_at: z.string().nullable(),
      }),
    ),
    gentle_news_companion: z
      .object({
        person_id: z.string().nullable(),
        display_name: z.string().nullable(),
        offer_status: z.string().nullable(),
        offered_at: z.string().nullable(),
        accepted_at: z.string().nullable(),
        with_maa_at: z.string().nullable(),
      })
      .nullable(),
  }),
  deliveries: z.array(AfterReportDeliverySchema),
  timings: z.object({
    incident_created_at: z.string(),
    first_offer_at: z.string().nullable(),
    accepted_at: z.string().nullable(),
    hurt_marked_at: z.string().nullable(),
    circle_with_maa_at: z.string().nullable(),
    maa_call_queued_at: z.string().nullable(),
    first_heard_at: z.string().nullable(),
    closed_at: z.string(),
    accept_latency_s: z.number().nullable(),
    resolution_duration_s: z.number().nullable(),
  }),
  zapier_z3: z.object({
    status: z.enum(["skipped", "sent", "failed"]),
    attempted_at: z.string().nullable(),
    http_status: z.number().nullable(),
  }),
});
export type AfterReport = z.infer<typeof AfterReportSchema>;

export const BADGE_UNCONFIRMED_HI = "Bheja gaya — sunna confirm nahi";

export function formatHeardBadgeLabel(
  heardAtIso: string | null | undefined,
  timezone = "Asia/Kolkata",
): string {
  if (!heardAtIso) return BADGE_UNCONFIRMED_HI;
  const parsed = new Date(heardAtIso);
  if (Number.isNaN(parsed.getTime())) return BADGE_UNCONFIRMED_HI;
  try {
    const hhmm = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(parsed);
    return `Maa ne suna ✓ ${hhmm}`;
  } catch {
    return `Maa ne suna ✓ ${parsed.toISOString().slice(11, 16)}`;
  }
}

async function requestJson<T>(
  session: Session,
  path: string,
  schema: z.ZodType<T>,
  init?: {
    method?: "GET" | "POST";
    body?: Record<string, unknown>;
    idempotencyKey?: string;
  },
): Promise<T> {
  const base = session.url.replace(/\/+$/, "");
  const headers: Record<string, string> = {
    accept: "application/json",
    authorization: `Bearer ${session.token}`,
  };
  if (session.familyId) {
    headers["x-sahaj-family-id"] = session.familyId;
  }
  if (init?.idempotencyKey) {
    headers["idempotency-key"] = init.idempotencyKey;
  }
  if (init?.body) {
    headers["content-type"] = "application/json";
  }

  const res = await fetch(`${base}${path}`, {
    method: init?.method ?? "GET",
    headers,
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    const code =
      typeof payload === "object" && payload !== null && "error" in payload
        ? String((payload as { error?: unknown }).error)
        : "request_failed";
    throw new Core2Error(res.status, code);
  }
  return schema.parse(payload);
}

export async function markIncidentHurtGentleNews(
  session: Session,
  input: {
    incidentId: string;
    calmSummary: string;
    voicePostId?: string | null;
    idempotencyKey?: string;
  },
): Promise<GentleNewsState> {
  return requestJson(session, "/api/core2/news", GentleNewsStateSchema, {
    method: "POST",
    idempotencyKey: input.idempotencyKey ?? newCore2Key(),
    body: {
      incident_id: input.incidentId,
      calm_summary: input.calmSummary,
      ...(input.voicePostId ? { voice_post_id: input.voicePostId } : {}),
    },
  });
}

export async function fetchGentleNewsState(
  session: Session,
  incidentId: string,
): Promise<GentleNewsState> {
  return requestJson(
    session,
    `/api/core2/news/${encodeURIComponent(incidentId)}`,
    GentleNewsStateSchema,
  );
}

export async function respondGentleNewsCircleOffer(
  session: Session,
  incidentId: string,
  action: "accept" | "decline" | "with_maa",
): Promise<GentleNewsState> {
  return requestJson(
    session,
    `/api/core2/news/${encodeURIComponent(incidentId)}/circle`,
    GentleNewsStateSchema,
    {
      method: "POST",
      body: { action },
    },
  );
}

export async function closeIncidentAndFetchAfterReport(
  session: Session,
  incidentId: string,
): Promise<AfterReport> {
  return requestJson(
    session,
    `/api/core2/news/${encodeURIComponent(incidentId)}/close`,
    AfterReportSchema,
    { method: "POST" },
  );
}

export async function fetchAfterReport(
  session: Session,
  incidentId: string,
): Promise<AfterReport> {
  return requestJson(
    session,
    `/api/core2/after-report/${encodeURIComponent(incidentId)}`,
    AfterReportSchema,
  );
}

export async function fetchHeardStatus(
  session: Session,
  deliveryId: string,
  messageKind: "core2_reassurance" | "core1_voice_post" | "gentle_news_voice" = "core2_reassurance",
): Promise<HeardStatus> {
  const qs = new URLSearchParams({
    delivery_id: deliveryId,
    message_kind: messageKind,
  }).toString();
  return requestJson(session, `/api/core2/heard?${qs}`, HeardStatusSchema);
}
