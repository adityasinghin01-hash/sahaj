import * as React from 'react';
import { z } from 'zod';
import { ApiError } from './api';
import { useSession, type Session } from './session';

export const FreeWindowItemSchema = z.object({
  id: z.string(),
  person_id: z.string(),
  person_display_name: z.string(),
  person_role: z.enum(['parent', 'child', 'circle', 'vendor']),
  timezone: z.string(),
  start_time: z.string(),
  end_time: z.string(),
  start_minute: z.number(),
  end_minute: z.number(),
  kind: z.enum(['recurring', 'ad_hoc']),
  days_of_week: z.array(z.number()).nullable(),
  expires_at: z.string().nullable(),
  source: z.enum(['app', 'sarvam_checkin', 'free_now']),
  label: z.string(),
  active_now: z.boolean(),
  created_at: z.string(),
});
export type FreeWindowItem = z.infer<typeof FreeWindowItemSchema>;

export const LastMatcherNudgeSchema = z.object({
  id: z.string(),
  matched_at: z.string(),
  local_date: z.string(),
});
export type LastMatcherNudge = z.infer<typeof LastMatcherNudgeSchema>;

export const FreeTimesResponseSchema = z.object({
  family_id: z.string(),
  person_id: z.string(),
  timezone: z.string(),
  windows: z.array(FreeWindowItemSchema),
  family_windows: z.array(FreeWindowItemSchema),
  both_free_now: z.boolean(),
  maa_free_now: z.boolean(),
  riya_free_now: z.boolean(),
  maa_quiet_now: z.boolean(),
  talked_today: z.boolean(),
  nudged_today: z.boolean(),
  nudge_message: z.string(),
  last_nudge: LastMatcherNudgeSchema.nullable(),
});
export type FreeTimesResponse = z.infer<typeof FreeTimesResponseSchema>;

export const CreateFreeWindowResponseSchema = z.object({
  ok: z.literal(true),
  window: FreeWindowItemSchema,
});
export type CreateFreeWindowResponse = z.infer<typeof CreateFreeWindowResponseSchema>;

export const DeleteFreeWindowResponseSchema = z.object({
  ok: z.literal(true),
  deleted_id: z.string(),
});
export type DeleteFreeWindowResponse = z.infer<typeof DeleteFreeWindowResponseSchema>;

const ErrorEnvelopeSchema = z.object({
  error: z.string(),
  message: z.string().optional(),
});

export const MATCHER_STRINGS = {
  en: {
    title: 'Free-time matcher',
    sub: 'Sahaj nudges you once a day when both you and Maa are free and haven’t talked yet.',
    bothFreeBanner: 'Abhi aap dono free hain — aap Maa ko call kar sakti hain.',
    bothFreeHint: 'Both you and Maa are free right now · notify only, never auto-bridged.',
    freeNowBtn: 'Free now for 30 min',
    freeNowActive: 'You are marked free now (30 min)',
    yourWindowsSection: 'Your daily free windows',
    maaWindowsSection: 'Maa’s free windows (from check-in)',
    noYourWindows: 'No free windows set yet. Tap a preset or add your hours below.',
    noMaaWindows: 'Maa hasn’t shared a free window on her check-in call yet.',
    addWindowTitle: 'Add a window',
    startLabel: 'Start (HH:MM, 24h)',
    endLabel: 'End (HH:MM, 24h)',
    addBtn: 'Save free window',
    removeBtn: 'Remove',
    callMaaBtn: 'Call Maa now',
    quietHoursNote: 'Maa is in quiet hours right now — Sahaj will not nudge during quiet hours.',
    talkedTodayNote: 'You and Maa already connected today — no extra nudge needed.',
    nudgedTodayNote: 'Today’s both-free nudge has already been sent.',
  },
  hi: {
    title: 'दोनों फ्री समय (मैचर)',
    sub: 'जब आप और माँ दोनों फ्री हों और आज बात न हुई हो, सहज दिन में एक बार आपको याद दिलाएगा।',
    bothFreeBanner: 'Abhi aap dono free hain — aap Maa ko call kar sakti hain.',
    bothFreeHint: 'अभी आप और माँ दोनों फ्री हैं · केवल सूचना, अपने-आप कॉल नहीं जोड़ी जाती।',
    freeNowBtn: 'अभी 30 मिनट के लिए फ्री हूँ',
    freeNowActive: 'आप अभी 30 मिनट के लिए फ्री चिह्नित हैं',
    yourWindowsSection: 'आपके फ्री समय',
    maaWindowsSection: 'माँ का फ्री समय (चेक-इन कॉल से)',
    noYourWindows: 'अभी कोई समय तय नहीं है। नीचे से चुनें या अपना समय जोड़ें।',
    noMaaWindows: 'माँ ने अभी चेक-इन कॉल पर फ्री समय नहीं बताया है।',
    addWindowTitle: 'नया समय जोड़ें',
    startLabel: 'शुरू (HH:MM, 24h)',
    endLabel: 'समाप्त (HH:MM, 24h)',
    addBtn: 'फ्री समय सेव करें',
    removeBtn: 'हटाएँ',
    callMaaBtn: 'माँ को कॉल करें',
    quietHoursNote: 'अभी माँ के आराम का समय (Quiet hours) है — कोई सूचना नहीं भेजी जाएगी।',
    talkedTodayNote: 'आज आपकी और माँ की बात हो चुकी है।',
    nudgedTodayNote: 'आज की दोनों-फ्री सूचना भेजी जा चुकी है।',
  },
} as const;

export const PRESET_FREE_WINDOWS = [
  { label: 'Morning 09:00–11:00', startTime: '09:00', endTime: '11:00' },
  { label: 'Lunch 13:00–14:30', startTime: '13:00', endTime: '14:30' },
  { label: 'Evening 18:00–20:00', startTime: '18:00', endTime: '20:00' },
  { label: 'Night 20:30–22:00', startTime: '20:30', endTime: '22:00' },
] as const;

export function createCore1MatcherApi(session: Session, familyId?: string) {
  const effectiveFamilyId = familyId ?? session.familyId;

  async function request<T>(
    path: string,
    schema: z.ZodType<T>,
    options?: {
      method?: 'GET' | 'POST' | 'DELETE';
      body?: Record<string, unknown>;
      signal?: AbortSignal;
    },
  ): Promise<T> {
    const method = options?.method ?? 'GET';
    const qs =
      method === 'GET' && effectiveFamilyId
        ? `${path.includes('?') ? '&' : '?'}familyId=${encodeURIComponent(effectiveFamilyId)}`
        : '';
    const url = `${session.url}/api/core1/${path}${qs}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${session.token}`,
    };
    if (effectiveFamilyId) {
      headers['x-sahaj-family-id'] = effectiveFamilyId;
    }

    let bodyStr: string | undefined;
    if (method === 'POST') {
      headers['Content-Type'] = 'application/json';
      const payload = effectiveFamilyId
        ? { familyId: effectiveFamilyId, ...(options?.body ?? {}) }
        : (options?.body ?? {});
      bodyStr = JSON.stringify(payload);
    }

    const res = await fetch(url, {
      method,
      headers,
      ...(bodyStr !== undefined ? { body: bodyStr } : {}),
      signal: options?.signal ?? AbortSignal.timeout(12000),
    });

    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new ApiError(res.status, 'Server response was unreadable.');
    }

    if (!res.ok) {
      const parsedErr = ErrorEnvelopeSchema.safeParse(json);
      throw new ApiError(
        res.status,
        parsedErr.success ? (parsedErr.data.message ?? parsedErr.data.error) : 'Request failed.',
      );
    }

    return schema.parse(json);
  }

  return {
    getFreeTimes: (signal?: AbortSignal) =>
      request('free-times', FreeTimesResponseSchema, { method: 'GET', signal }),

    addFreeWindow: (input: {
      startTime: string;
      endTime: string;
      timezone?: string;
      daysOfWeek?: number[];
      label?: string;
    }) =>
      request('free-times', CreateFreeWindowResponseSchema, {
        method: 'POST',
        body: {
          start_time: input.startTime,
          end_time: input.endTime,
          ...(input.timezone ? { timezone: input.timezone } : {}),
          ...(input.daysOfWeek ? { days_of_week: input.daysOfWeek } : {}),
          ...(input.label ? { label: input.label } : {}),
        },
      }),

    freeNow: (durationMinutes = 30, timezone?: string) =>
      request('free-times', CreateFreeWindowResponseSchema, {
        method: 'POST',
        body: {
          mode: 'free_now',
          duration_minutes: durationMinutes,
          ...(timezone ? { timezone } : {}),
        },
      }),

    deleteFreeWindow: (windowId: string) =>
      request(`free-times/${encodeURIComponent(windowId)}`, DeleteFreeWindowResponseSchema, {
        method: 'DELETE',
      }),
  };
}

export type Core1MatcherApi = ReturnType<typeof createCore1MatcherApi>;

export function useCore1MatcherApi(familyId?: string): Core1MatcherApi | null {
  const { session } = useSession();
  return React.useMemo(
    () => (session ? createCore1MatcherApi(session, familyId) : null),
    [session, familyId],
  );
}
