import * as React from 'react';
import { z } from 'zod';
import { ApiError } from './api';
import { useSession, type Session } from './session';

export type Core1Lang = 'en' | 'hi';

let currentLang: Core1Lang = 'en';
const langListeners = new Set<() => void>();

export function setCore1Lang(lang: Core1Lang) {
  if (currentLang === lang) return;
  currentLang = lang;
  langListeners.forEach((fn) => fn());
}

export function getCore1Lang(): Core1Lang {
  return currentLang;
}

export function useCore1Lang(): [Core1Lang, (lang: Core1Lang) => void] {
  const lang = React.useSyncExternalStore(
    (fn) => {
      langListeners.add(fn);
      return () => {
        langListeners.delete(fn);
      };
    },
    () => currentLang,
    () => currentLang
  );
  return [lang, setCore1Lang];
}

export const CORE1_STRINGS = {
  en: {
    maasDayTitle: "Maa's day",
    maasDaySub: 'Check-ins, missed calls, and family report',
    todayCheckin: "Today's check-in",
    nextCheckin: 'Next check-in',
    recentCheckins: 'Recent check-ins',
    noCheckins: 'No check-in calls recorded yet.',
    noNextCheckin: 'No upcoming check-in scheduled.',
    familyReportBtn: 'Request family report (7 days)',
    familyReportSent: 'Family report requested',
    missedCallTitle: 'Maa gave a missed call — call when free',
    missedCallSub: 'Missed-call nudge from Sahaj',
    callMaa: 'Call Maa',
    openMaasDay: "Open Maa's day",
    voiceTitle: 'Voice for Maa',
    voiceSub: 'Send a real voice message or listen to Maa’s replies',
    voiceListTitle: 'Voice messages',
    noVoiceMessages: 'No voice messages yet.',
    playVoice: 'Play',
    stopVoice: 'Stop',
    sendVoiceBtn: 'Send voice message',
    voiceSent: 'Voice message queued',
    urgentTitle: 'Urgent call',
    noIncidents: 'No urgent incidents right now.',
    whoIsGoing: 'Who is going',
    liveClock: 'Elapsed time',
    responseChain: 'Response order',
    refillsTitle: 'Refill approvals',
    refillsSub: 'Medicine proposals waiting for family approval',
    noRefills: 'No refill proposals right now.',
    approve: 'Approve',
    decline: 'Decline',
    approvedBy: 'Approved by',
    retry: 'Retry',
    loading: 'Loading from server…',
    demoLabel: 'Demo mode · synthetic data',
    signInPrompt: 'Sign in to view live family updates.',
  },
  hi: {
    maasDayTitle: 'माँ का दिन',
    maasDaySub: 'दैनिक चेक-इन, मिस्ड कॉल और परिवार रिपोर्ट',
    todayCheckin: 'आज की बात (चेक-इन)',
    nextCheckin: 'अगला चेक-इन',
    recentCheckins: 'पिछले चेक-इन',
    noCheckins: 'अभी तक कोई चेक-इन कॉल दर्ज नहीं हुई है।',
    noNextCheckin: 'कोई अगला चेक-इन तय नहीं है।',
    familyReportBtn: 'परिवार रिपोर्ट मँगवाएँ (7 दिन)',
    familyReportSent: 'परिवार रिपोर्ट का अनुरोध भेजा गया',
    missedCallTitle: 'माँ की मिस्ड कॉल आई — समय मिलने पर कॉल करें',
    missedCallSub: 'सहज से मिस्ड-कॉल सूचना',
    callMaa: 'माँ को कॉल करें',
    openMaasDay: 'माँ का दिन देखें',
    voiceTitle: 'माँ के लिए आवाज़',
    voiceSub: 'अपनी आवाज़ में संदेश भेजें या माँ का जवाब सुनें',
    voiceListTitle: 'आवाज़ संदेश',
    noVoiceMessages: 'अभी तक कोई आवाज़ संदेश नहीं है।',
    playVoice: 'सुनें',
    stopVoice: 'रोकें',
    sendVoiceBtn: 'आवाज़ संदेश भेजें',
    voiceSent: 'आवाज़ संदेश कतार में भेजा गया',
    urgentTitle: 'ज़रूरी कॉल',
    noIncidents: 'अभी कोई ज़रूरी घटना नहीं है।',
    whoIsGoing: 'कौन जा रहा है',
    liveClock: 'बीता हुआ समय',
    responseChain: 'संपर्क क्रम',
    refillsTitle: 'दवा रिफिल मंज़ूरी',
    refillsSub: 'परिवार की मंज़ूरी के लिए दवा प्रस्ताव',
    noRefills: 'अभी कोई रिफिल प्रस्ताव नहीं है।',
    approve: 'मंज़ूर करें',
    decline: 'मना करें',
    approvedBy: 'मंज़ूरी देने वाले',
    retry: 'पुनः प्रयास करें',
    loading: 'सर्वर से लोड हो रहा है…',
    demoLabel: 'डेमो मोड · सिंथेटिक डेटा',
    signInPrompt: 'लाइव परिवार अपडेट देखने के लिए साइन इन करें।',
  },
} as const;

export const VoiceFeedItemSchema = z.object({
  id: z.string(),
  direction: z.enum(['inbound', 'outbound']),
  from_person_id: z.string(),
  from_display_name: z.string(),
  to_person_id: z.string(),
  to_display_name: z.string(),
  state: z.enum(['queued', 'sent', 'delivered', 'heard', 'failed']),
  created_at: z.string(),
  duration_s: z.number().nullable(),
  played_at: z.string().nullable(),
  reply_to: z.string().nullable(),
});
export type VoiceFeedItem = z.infer<typeof VoiceFeedItemSchema>;

export const VoiceFeedResponseSchema = z.object({
  family_id: z.string(),
  caller_person_id: z.string(),
  items: z.array(VoiceFeedItemSchema),
});
export type VoiceFeedResponse = z.infer<typeof VoiceFeedResponseSchema>;

export const VoiceMediaUrlResponseSchema = z.object({
  url: z.string().url(),
  expires_in: z.number(),
});
export type VoiceMediaUrlResponse = z.infer<typeof VoiceMediaUrlResponseSchema>;

export const IncidentAssignmentItemSchema = z.object({
  assignment_id: z.string(),
  person_id: z.string(),
  display_name: z.string(),
  state: z.enum(['offered', 'accepted', 'declined', 'expired', 'completed']),
  offered_at: z.string(),
  expires_at: z.string(),
  accepted_at: z.string().nullable(),
});
export type IncidentAssignmentItem = z.infer<typeof IncidentAssignmentItemSchema>;

export const IncidentFeedItemSchema = z.object({
  id: z.string(),
  subject_person_id: z.string(),
  subject_display_name: z.string(),
  state: z.enum(['open', 'offered', 'accepted', 'heard', 'done', 'reopened', 'escalated', 'closed']),
  severity: z.enum(['routine', 'urgent', 'critical']),
  responder: IncidentAssignmentItemSchema.nullable(),
  assignments: z.array(IncidentAssignmentItemSchema),
  promised_at: z.string().nullable(),
  created_at: z.string(),
});
export type IncidentFeedItem = z.infer<typeof IncidentFeedItemSchema>;

export const IncidentsFeedResponseSchema = z.object({
  family_id: z.string(),
  items: z.array(IncidentFeedItemSchema),
});
export type IncidentsFeedResponse = z.infer<typeof IncidentsFeedResponseSchema>;

export const RefillApprovalItemSchema = z.object({
  person_id: z.string(),
  display_name: z.string(),
  answer: z.boolean(),
  answered_at: z.string(),
});

export const RefillFeedItemSchema = z.object({
  id: z.string(),
  person_id: z.string(),
  person_display_name: z.string(),
  medicine_id: z.string().nullable(),
  medicine: z.string(),
  amount_minor: z.number(),
  currency: z.literal('INR'),
  vendor_id: z.string().nullable(),
  vendor: z.string(),
  state: z.enum(['pending', 'approved', 'denied', 'expired', 'executed', 'failed']),
  two_person_required: z.boolean(),
  who_approved: z.array(z.string()),
  approvals: z.array(RefillApprovalItemSchema),
  created_at: z.string(),
  expires_at: z.string(),
});
export type RefillFeedItem = z.infer<typeof RefillFeedItemSchema>;

export const RefillsFeedResponseSchema = z.object({
  family_id: z.string(),
  items: z.array(RefillFeedItemSchema),
});
export type RefillsFeedResponse = z.infer<typeof RefillsFeedResponseSchema>;

export const CheckInScheduleSummarySchema = z.object({
  schedule_id: z.string(),
  person_id: z.string(),
  person_display_name: z.string(),
  scheduled_for: z.string(),
  timezone: z.string(),
  enabled: z.boolean(),
});

export const CheckInFeedItemSchema = z.object({
  id: z.string(),
  person_id: z.string(),
  person_display_name: z.string(),
  scheduled_for: z.string(),
  started_at: z.string().nullable(),
  ended_at: z.string().nullable(),
  state: z.enum(['scheduled', 'ringing', 'connected', 'completed', 'failed', 'cancelled']),
  short_summary: z.string(),
  ai_disclosed: z.boolean(),
});
export type CheckInFeedItem = z.infer<typeof CheckInFeedItemSchema>;

export const MissedCallNudgeItemSchema = z.object({
  id: z.string(),
  person_id: z.string(),
  person_display_name: z.string(),
  kind: z.string(),
  status: z.enum(['pending', 'sent', 'cancelled', 'failed']),
  scheduled_at: z.string(),
});
export type MissedCallNudgeItem = z.infer<typeof MissedCallNudgeItemSchema>;

export const CheckInsFeedResponseSchema = z.object({
  family_id: z.string(),
  next_checkin: CheckInScheduleSummarySchema.nullable(),
  items: z.array(CheckInFeedItemSchema),
  missed_call_nudges: z.array(MissedCallNudgeItemSchema),
});
export type CheckInsFeedResponse = z.infer<typeof CheckInsFeedResponseSchema>;

export const Core1CommandAcceptedSchema = z.object({
  eventId: z.string(),
  commandType: z.string(),
  status: z.enum(['queued', 'requested']),
  deduped: z.boolean(),
});
export type Core1CommandAccepted = z.infer<typeof Core1CommandAcceptedSchema>;

export const VoiceUploadResponseSchema = z.object({
  ok: z.literal(true),
  media_id: z.string(),
  media_object_path: z.string(),
  consent_id: z.string(),
  content_type: z.string(),
  size_bytes: z.number(),
  duration_s: z.number().nullable(),
});
export type VoiceUploadResponse = z.infer<typeof VoiceUploadResponseSchema>;

export const VoicePlayedResponseSchema = z.object({
  ok: z.literal(true),
  id: z.string(),
  state: z.literal('heard'),
  played_at: z.string(),
});
export type VoicePlayedResponse = z.infer<typeof VoicePlayedResponseSchema>;

export const Core2ReassuranceResponseSchema = z
  .object({
    reassurance: z
      .object({
        id: z.string(),
        kind: z.string(),
        voice_post_id: z.string().nullable().optional(),
        voicePostId: z.string().nullable().optional(),
        delivery_status: z.string().optional(),
      })
      .passthrough()
      .nullable(),
  })
  .passthrough();
export type Core2ReassuranceResponse = z.infer<typeof Core2ReassuranceResponseSchema>;

const Core1ErrorResponseSchema = z.object({
  error: z.string(),
  message: z.string().optional(),
});

function makeIdempotencyKey(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createCore1Api(session: Session, familyId?: string) {
  async function request<T>(
    path: string,
    schema: z.ZodType<T>,
    options?: {
      method?: 'GET' | 'POST';
      body?: Record<string, unknown>;
      idempotencyKey?: string;
      signal?: AbortSignal;
    }
  ): Promise<T> {
    const method = options?.method ?? 'GET';
    const qs =
      method === 'GET' && familyId
        ? `${path.includes('?') ? '&' : '?'}familyId=${encodeURIComponent(familyId)}`
        : '';
    const url = `${session.url}/api/core1/${path}${qs}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${session.token}`,
    };
    if (familyId) {
      headers['x-sahaj-family-id'] = familyId;
    }
    let bodyStr: string | undefined;
    if (method === 'POST') {
      headers['Content-Type'] = 'application/json';
      headers['Idempotency-Key'] = options?.idempotencyKey ?? makeIdempotencyKey('child-c1');
      const payload = familyId ? { familyId, ...(options?.body ?? {}) } : (options?.body ?? {});
      bodyStr = JSON.stringify(payload);
    }

    const response = await fetch(url, {
      method,
      headers,
      ...(bodyStr !== undefined ? { body: bodyStr } : {}),
      signal: options?.signal ?? AbortSignal.timeout(12000),
    });

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new ApiError(response.status, 'Server response was unreadable.');
    }

    if (!response.ok) {
      const parsedErr = Core1ErrorResponseSchema.safeParse(json);
      throw new ApiError(
        response.status,
        parsedErr.success ? (parsedErr.data.message ?? parsedErr.data.error) : 'Request failed.'
      );
    }

    return schema.parse(json);
  }

  return {
    voiceFeed: (signal?: AbortSignal) =>
      request('feed/voice', VoiceFeedResponseSchema, { method: 'GET', signal }),
    voiceMediaUrl: (id: string, signal?: AbortSignal) =>
      request(`feed/voice/${encodeURIComponent(id)}/media`, VoiceMediaUrlResponseSchema, {
        method: 'GET',
        signal,
      }),
    incidentsFeed: (signal?: AbortSignal) =>
      request('feed/incidents', IncidentsFeedResponseSchema, { method: 'GET', signal }),
    refillsFeed: (signal?: AbortSignal) =>
      request('feed/refills', RefillsFeedResponseSchema, { method: 'GET', signal }),
    checkInsFeed: (signal?: AbortSignal) =>
      request('feed/checkins', CheckInsFeedResponseSchema, { method: 'GET', signal }),

    requestFamilyReport: (
      params: { periodStart: string; periodEnd: string },
      idempotencyKey?: string
    ) =>
      request('family-report', Core1CommandAcceptedSchema, {
        method: 'POST',
        body: {
          periodStart: params.periodStart,
          periodEnd: params.periodEnd,
        },
        idempotencyKey,
      }),

    sendVoiceMessage: (
      params: {
        recipientPersonId: string;
        mediaObjectPath: string;
        consentId: string;
        replyToId?: string;
      },
      idempotencyKey?: string
    ) =>
      request('voice-message', Core1CommandAcceptedSchema, {
        method: 'POST',
        body: {
          recipientPersonId: params.recipientPersonId,
          mediaObjectPath: params.mediaObjectPath,
          consentId: params.consentId,
          ...(params.replyToId ? { replyToId: params.replyToId } : {}),
        },
        idempotencyKey,
      }),

    uploadVoiceMessage: async (
      params: {
        recipientPersonId: string;
        fileUri?: string;
        blob?: Blob;
        audioBase64?: string;
        contentType?: string;
        filename?: string;
        durationS?: number;
        consentId?: string;
        consentGranted?: boolean;
      },
      signal?: AbortSignal
    ): Promise<VoiceUploadResponse> => {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${session.token}`,
      };
      if (familyId) {
        headers['x-sahaj-family-id'] = familyId;
      }

      let body: BodyInit;
      if (params.audioBase64) {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify({
          recipient_person_id: params.recipientPersonId,
          audio_base64: params.audioBase64,
          content_type: params.contentType ?? 'audio/mp4',
          filename: params.filename ?? 'voice-note.m4a',
          ...(params.durationS !== undefined ? { duration_s: params.durationS } : {}),
          ...(params.consentId ? { consent_id: params.consentId } : {}),
          ...(params.consentGranted ? { consent_granted: true } : {}),
        });
      } else {
        const form = new FormData();
        form.append('recipient_person_id', params.recipientPersonId);
        if (params.durationS !== undefined) {
          form.append('duration_s', String(params.durationS));
        }
        if (params.consentId) {
          form.append('consent_id', params.consentId);
        }
        if (params.consentGranted) {
          form.append('consent_granted', 'true');
        }

        const resolvedType = params.contentType ?? 'audio/mp4';
        const resolvedName =
          params.filename ?? (resolvedType.includes('ogg') ? 'voice-note.ogg' : 'voice-note.m4a');

        if (params.blob) {
          form.append('file', params.blob, resolvedName);
        } else if (params.fileUri) {
          if (params.fileUri.startsWith('blob:') || params.fileUri.startsWith('data:')) {
            const blobRes = await fetch(params.fileUri);
            const loadedBlob = await blobRes.blob();
            form.append('file', loadedBlob, resolvedName);
          } else {
            form.append(
              'file',
              {
                uri: params.fileUri,
                name: resolvedName,
                type: resolvedType,
              } as unknown as Blob
            );
          }
        } else {
          throw new ApiError(400, 'No recorded audio clip available.');
        }
        body = form;
      }

      const response = await fetch(`${session.url}/api/core1/voice-messages/upload`, {
        method: 'POST',
        headers,
        body,
        signal: signal ?? AbortSignal.timeout(20000),
      });

      let json: unknown;
      try {
        json = await response.json();
      } catch {
        throw new ApiError(response.status, 'Server response was unreadable.');
      }
      if (!response.ok) {
        const parsedErr = Core1ErrorResponseSchema.safeParse(json);
        throw new ApiError(
          response.status,
          parsedErr.success ? (parsedErr.data.message ?? parsedErr.data.error) : 'Upload failed.'
        );
      }
      return VoiceUploadResponseSchema.parse(json);
    },

    markVoicePlayed: (id: string, signal?: AbortSignal) =>
      request(`voice-messages/${encodeURIComponent(id)}/played`, VoicePlayedResponseSchema, {
        method: 'POST',
        body: {},
        signal,
      }),

    sendCore2Reassurance: async (
      params: {
        kind: 'im_safe' | 'reached_home' | 'truth_line';
        voicePostId?: string;
        recipientPersonIds?: string[];
        watchId?: string;
        sosId?: string;
      },
      idempotencyKey?: string,
      signal?: AbortSignal
    ): Promise<Core2ReassuranceResponse> => {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${session.token}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey ?? makeIdempotencyKey('child-c2-safe'),
      };
      if (familyId) {
        headers['x-sahaj-family-id'] = familyId;
      }

      const response = await fetch(`${session.url}/api/core2/reassurance`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          kind: params.kind,
          ...(params.voicePostId ? { voice_post_id: params.voicePostId } : {}),
          ...(params.recipientPersonIds?.length
            ? { recipient_person_ids: params.recipientPersonIds }
            : {}),
          ...(params.watchId ? { watch_id: params.watchId } : {}),
          ...(params.sosId ? { sos_id: params.sosId } : {}),
        }),
        signal: signal ?? AbortSignal.timeout(12000),
      });

      let json: unknown;
      try {
        json = await response.json();
      } catch {
        throw new ApiError(response.status, 'Server response was unreadable.');
      }
      if (!response.ok) {
        const parsedErr = Core1ErrorResponseSchema.safeParse(json);
        throw new ApiError(
          response.status,
          parsedErr.success
            ? (parsedErr.data.message ?? parsedErr.data.error)
            : 'Reassurance request failed.'
        );
      }
      return Core2ReassuranceResponseSchema.parse(json);
    },

    respondToRefill: (
      params: {
        medicineId: string;
        personId: string;
        vendorId: string;
        decision: 'approve' | 'decline';
        reorderPacks?: number;
      },
      idempotencyKey?: string
    ) =>
      request('refill', Core1CommandAcceptedSchema, {
        method: 'POST',
        body: {
          medicineId: params.medicineId,
          personId: params.personId,
          vendorId: params.vendorId,
          ...(params.decision === 'approve' ? { reorderPacks: params.reorderPacks ?? 1 } : {}),
        },
        idempotencyKey,
      }),
  };
}

export type Core1Api = ReturnType<typeof createCore1Api>;

export function useCore1Api(familyId?: string): Core1Api | null {
  const { session } = useSession();
  return React.useMemo(
    () => (session ? createCore1Api(session, familyId) : null),
    [session, familyId]
  );
}
