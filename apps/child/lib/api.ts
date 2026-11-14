import * as C from '@sahaj/shared';
import type { z } from 'zod';
import type { Session } from './session';
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}
export function createApi(session: Session) {
  async function request<T>(
    path: string,
    schema: z.ZodType<T>,
    input?: unknown,
    signal?: AbortSignal
  ): Promise<T> {
    const response = await fetch(`${session.url}/api/app/${path}`, {
      method: input === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: `Bearer ${session.token}`,
        ...(input === undefined
          ? {}
          : {
              'Content-Type': 'application/json',
              'Idempotency-Key': `app-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
            }),
      },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
      signal: signal ?? AbortSignal.timeout(12000),
    });
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new ApiError(response.status, 'Server response was unreadable.');
    }
    if (!response.ok) {
      const error = C.AppError.safeParse(json);
      throw new ApiError(
        response.status,
        error.success ? (error.data.message ?? error.data.error) : 'Request failed.'
      );
    }
    return schema.parse(json);
  }
  return {
    summary: (signal?: AbortSignal) =>
      request('shield/summary', C.AppSummaryResponse, undefined, signal),
    alerts: (since?: string, signal?: AbortSignal) =>
      request(
        `shield/alerts${since ? `?since=${encodeURIComponent(since)}` : ''}`,
        C.AppAlertsResponse,
        undefined,
        signal
      ),
    alert: (id: string, signal?: AbortSignal) =>
      request(
        `shield/alerts/${encodeURIComponent(id)}`,
        C.AppAlertDetailResponse,
        undefined,
        signal
      ),
    feedback: (id: string, input: C.AppFeedback) =>
      request(
        `shield/alerts/${encodeURIComponent(id)}/feedback`,
        C.AppFeedbackResponse,
        C.AppFeedbackRequest.parse(input)
      ),
    pair: () => request('shield/pair-code', C.AppPairResponse, {}),
    busy: (input: C.AppBusyReply) =>
      request('shield/busy-reply', C.AppBusyReplyResponse, C.AppBusyReplyRequest.parse(input)),
    timeline: (signal?: AbortSignal) =>
      request('timeline', C.AppTimelineResponse, undefined, signal),
    verify: (signal?: AbortSignal) =>
      request('timeline/verify', C.AppVerifyResponse, undefined, signal),
    evidence: (id: string, signal?: AbortSignal) =>
      request(
        `shield/evidence/${encodeURIComponent(id)}`,
        C.AppEvidenceResponse,
        undefined,
        signal
      ),
    harness: (signal?: AbortSignal) =>
      request('shield/harness', C.AppHarnessResponse, undefined, signal),
    drills: (input: C.AppDrills) =>
      request('shield/experience-drills', C.AppDrillsResponse, C.AppDrillsRequest.parse(input)),
    push: (input: C.AppPushToken) =>
      request('push-token', C.AppPushTokenResponse, C.AppPushTokenRequest.parse(input)),
  };
}
export type AppApi = ReturnType<typeof createApi>;
