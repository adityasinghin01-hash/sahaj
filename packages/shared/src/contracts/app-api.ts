import { z } from "zod";
import { AlertLevel, ScamType, VerdictReason } from "../shield";

export const AppScopeRequest = z.object({
  family_id: z.string().uuid().optional(),
});
export const AppEmptyRequest = z.object({}).strict();
export const AppIdRequest = z.object({ id: z.string().uuid() });
export const AppEvidenceRequest = z.object({ incidentId: z.string().uuid() });
export const AppError = z.object({
  error: z.string(),
  message: z.string().optional(),
});
export const AppHarnessResponse = z.object({
  available: z.boolean(),
  mode: z.string().nullable(),
  summary: z.record(z.string(), z.number()),
  ai: z.record(z.string(), z.unknown()).nullable(),
});
export const AppAlert = z.object({
  id: z.string().uuid(),
  parent_id: z.string().uuid(),
  created_at: z.string(),
  level: AlertLevel,
  scam_type: ScamType,
  reasons: z.array(VerdictReason),
  checks_fired: z.array(z.string()),
  masked_snippet: z.string(),
  channel: z.string(),
  child_feedback: z.enum(["safe", "fraud"]).nullable(),
});
export const AppAlertsRequest = AppScopeRequest.extend({
  since: z.string().max(300).optional(),
});
export const AppAlertsResponse = z.object({
  alerts: z.array(AppAlert),
  next_cursor: z.string().nullable(),
});
export const AppTimelineRow = z.object({
  id: z.string().uuid(),
  seq: z.string(),
  created_at: z.string(),
  step: z.string(),
  status: z.string().nullable(),
  entry: z.record(z.string(), z.unknown()),
  prev_hash: z.string(),
  hash: z.string(),
});
export const AppTimelineResponse = z.object({ rows: z.array(AppTimelineRow) });
export const AppVerifyResponse = z.object({
  valid: z.boolean(),
  checked: z.number().int().nonnegative(),
  broken_at: z.string().nullable(),
});
export const AppAlertDetailResponse = AppAlert.extend({
  told_hi: z.string(),
  told_en: z.string(),
  timeline: z.array(AppTimelineRow),
});
export const AppSummaryResponse = z.object({
  family_id: z.string().uuid(),
  checks_this_week: z.number(),
  frauds_stopped: z.number(),
  devices: z.array(
    z.object({
      id: z.string().uuid(),
      parent_id: z.string().uuid(),
      label: z.string().nullable(),
      protections: z.record(z.string(), z.boolean()),
      last_heartbeat_at: z.string().nullable(),
    }),
  ),
  parents: z.array(
    z.object({
      id: z.string().uuid(),
      name: z.string(),
      scam_sense: z.object({
        score_out_of_5: z.number(),
        trend: z.enum(["up", "down", "flat"]),
        drills_this_month: z.number(),
      }),
    }),
  ),
  harness: AppHarnessResponse,
});
export const AppFeedbackRequest = z
  .object({ answer: z.enum(["safe", "fraud"]) })
  .strict();
export const AppFeedbackResponse = z.object({
  ok: z.literal(true),
  verdict_id: z.string().uuid(),
  feedback: z.enum(["safe", "fraud"]),
  repeated: z.boolean(),
});
export const AppPairResponse = z.object({
  ok: z.literal(true),
  code: z.string().regex(/^\d{6}$/),
  expires_at: z.string(),
  family_id: z.string().uuid(),
});
export const AppBusyReplyRequest = z
  .object({ streak_id: z.string().uuid() })
  .strict();
export const AppBusyReplyResponse = z.object({
  ok: z.literal(true),
  streak_id: z.string().uuid(),
  replied: z.boolean(),
});
export const AppEvidenceResponse = z.object({
  summary_en: z.string(),
  summary_hi: z.string(),
  copy_for_1930: z.string(),
  cybercrime_url: z.literal("https://cybercrime.gov.in"),
  chain_hash: z.string(),
  created_at: z.string(),
  verification: AppVerifyResponse.nullable(),
});
export const AppDrillsRequest = z
  .object({ parent_id: z.string().uuid(), enabled: z.boolean() })
  .strict();
export const AppDrillsResponse = z.object({
  ok: z.literal(true),
  enabled: z.boolean(),
  parent_id: z.string().uuid(),
});
export const AppPushTokenRequest = z
  .object({
    expo_token: z
      .string()
      .regex(/^(ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]+\]$/)
      .max(250),
  })
  .strict();
export const AppPushTokenResponse = z.object({ ok: z.literal(true) });

export type AppAlert = z.infer<typeof AppAlert>;
export type AppSummary = z.infer<typeof AppSummaryResponse>;
export type AppAlertDetail = z.infer<typeof AppAlertDetailResponse>;
export type AppTimeline = z.infer<typeof AppTimelineResponse>;
export type AppVerification = z.infer<typeof AppVerifyResponse>;
export type AppEvidence = z.infer<typeof AppEvidenceResponse>;
export type AppHarness = z.infer<typeof AppHarnessResponse>;
export type AppFeedback = z.infer<typeof AppFeedbackRequest>;
export type AppPair = z.infer<typeof AppPairResponse>;
export type AppBusyReply = z.infer<typeof AppBusyReplyRequest>;
export type AppDrills = z.infer<typeof AppDrillsRequest>;
export type AppPushToken = z.infer<typeof AppPushTokenRequest>;

/** Request/response pairs are the single app/server vocabulary, including bodyless requests. */
export const AppApiContract = {
  summary: { request: AppScopeRequest, response: AppSummaryResponse },
  alerts: { request: AppAlertsRequest, response: AppAlertsResponse },
  alert: { request: AppIdRequest, response: AppAlertDetailResponse },
  feedback: { request: AppFeedbackRequest, response: AppFeedbackResponse },
  pair: { request: AppEmptyRequest, response: AppPairResponse },
  busy: { request: AppBusyReplyRequest, response: AppBusyReplyResponse },
  timeline: { request: AppScopeRequest, response: AppTimelineResponse },
  verify: { request: AppScopeRequest, response: AppVerifyResponse },
  evidence: { request: AppEvidenceRequest, response: AppEvidenceResponse },
  harness: { request: AppScopeRequest, response: AppHarnessResponse },
  drills: { request: AppDrillsRequest, response: AppDrillsResponse },
  push: { request: AppPushTokenRequest, response: AppPushTokenResponse },
} as const;
export type AppRequests = {
  [K in keyof typeof AppApiContract]: z.infer<
    (typeof AppApiContract)[K]["request"]
  >;
};
export type AppResponses = {
  [K in keyof typeof AppApiContract]: z.infer<
    (typeof AppApiContract)[K]["response"]
  >;
};
