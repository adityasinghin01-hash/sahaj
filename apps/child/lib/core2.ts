/** C-11: the single Core 2 wire contract. No /api/app or provider calls here. */
import { z } from 'zod';
import type { Session } from './session';
const uuid = z.uuid();
const version = z.number().int().positive();
const timestamp = z.iso.datetime({ offset: true });
const text = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .regex(/^[^\u0000-\u001f\u007f]*$/);
const expected = { expected_version: version.optional() };
const SosSchema = z.object({
  id: uuid,
  version,
  status: z.enum([
    'countdown',
    'queued',
    'pending_contacts',
    'awaiting_approval',
    'denied',
    'escalated',
    'cancelled',
    'safe',
    'verified_accepted',
  ]),
  delivery_status: z.enum(['none', 'queued', 'delivery_unknown', 'delivered', 'failed']),
  responder_accepted: z.boolean(),
  countdown_until: timestamp.nullable().optional(),
  family_id: uuid.optional(),
  subject_person_id: uuid.optional(),
  incident_id: uuid.optional(),
  request_id: uuid.optional(),
  created_at: timestamp.optional(),
});
const WatchSchema = z.object({
  id: uuid,
  version,
  state: z.enum(['active', 'checking_in', 'escalated', 'safe', 'cancelled']),
  deadline_at: timestamp,
  grace_until: timestamp,
  timezone: z.string(),
  created_at: timestamp.optional(),
  subject_person_id: uuid.optional(),
  family_id: uuid.optional(),
});
const ScopeSchema = z.enum(['sos', 'watch_escalation', 'reassurance']);
const ContactSchema = z.object({
  id: uuid,
  subject_person_id: uuid,
  contact_person_id: uuid,
  display_name: z.string(),
  rank: z.number().int().min(1).max(20),
  scopes: z.array(ScopeSchema).min(1),
  state: z.enum(['invited', 'pending_consent', 'active', 'revoked', 'expired']),
  effective_from: timestamp,
  effective_until: timestamp.nullable(),
  revoked_at: timestamp.nullable(),
  version,
});
const PreferencesSchema = z.object({
  share_status_with_parent: z.boolean(),
  allow_location_share: z.boolean(),
  allow_health_share: z.boolean(),
  allow_narrative_share: z.boolean(),
});
const ReassuranceSchema = z.object({
  id: uuid,
  kind: z.enum(['im_safe', 'reached_home', 'truth_line']),
  status: z.enum(['queued', 'delivered', 'failed', 'denied', 'awaiting_approval']),
  delivery_verified: z.boolean(),
  facts_exposed: z
    .object({
      status_label: z.string(),
      location_included: z.boolean(),
      health_included: z.boolean(),
      narrative_included: z.boolean(),
    })
    .optional(),
  status_label: z.string().optional(),
  occurred_at: timestamp.optional(),
  created_at: timestamp.optional(),
  voice_post_id: uuid.optional(),
});
const StartSosSchema = z
  .object({
    subject_person_id: uuid.optional(),
    countdown_seconds: z.number().int().min(0).max(60).optional(),
    note: text(240).optional(),
    client_triggered_at: timestamp.optional(),
  })
  .strict();
const CancelSosSchema = z
  .object({ reason: z.enum(['false_alarm', 'im_safe']).optional(), ...expected })
  .strict();
const StartWatchSchema = z
  .object({
    eta_minutes: z.number().int().min(1).max(240),
    grace_minutes: z.number().int().min(1).max(60).optional(),
    timezone: z.string().refine((s) => {
      try {
        new Intl.DateTimeFormat('en', { timeZone: s });
        return true;
      } catch {
        return false;
      }
    }),
    from_label: text(160),
    to_label: text(160),
    cab_note: text(160).optional(),
  })
  .strict();
const ExtendWatchSchema = z
  .object({ add_minutes: z.number().int().min(1).max(120), expected_version: version })
  .strict();
const SafeWatchSchema = z
  .object({ ...expected, voice_post_id: uuid.optional(), note: text(160).optional() })
  .strict();
const InviteSchema = z
  .object({
    subject_person_id: uuid.optional(),
    contact_person_id: uuid,
    rank: z.number().int().min(1).max(20),
    scopes: z.array(ScopeSchema).min(1),
    effective_from: timestamp.optional(),
    effective_until: timestamp.nullable().optional(),
  })
  .strict();
const UpdateContactSchema = z
  .object({
    rank: z.number().int().min(1).max(20).optional(),
    scopes: z.array(ScopeSchema).min(1).optional(),
    effective_until: timestamp.nullable().optional(),
    expected_version: version,
  })
  .strict();
const ReassureSchema = z
  .object({
    kind: z.enum(['im_safe', 'reached_home', 'truth_line']),
    watch_id: uuid.optional(),
    sos_id: uuid.optional(),
    voice_post_id: uuid.optional(),
    recipient_person_ids: z.array(uuid).min(1).max(50),
  })
  .strict();
export type Sos = z.infer<typeof SosSchema>;
export type Watch = z.infer<typeof WatchSchema>;
export type TrustedContact = z.infer<typeof ContactSchema>;
export type ContactScope = z.infer<typeof ScopeSchema>;
export type SharingPreferences = z.infer<typeof PreferencesSchema>;
export type Reassurance = z.infer<typeof ReassuranceSchema>;
export type StartSos = z.infer<typeof StartSosSchema>;
export type CancelSos = z.infer<typeof CancelSosSchema>;
export type StartWatch = z.infer<typeof StartWatchSchema>;
export type ExtendWatch = z.infer<typeof ExtendWatchSchema>;
export type SafeWatch = z.infer<typeof SafeWatchSchema>;
export type InviteContact = z.infer<typeof InviteSchema>;
export type UpdateContact = z.infer<typeof UpdateContactSchema>;
export type SendReassurance = z.infer<typeof ReassureSchema>;
export type PageQuery = { limit?: number; cursor?: string };
export type MutationKey = string;
export class Core2Error extends Error {
  constructor(
    public status: number,
    public code: string
  ) {
    super(code);
  }
}
export const newCore2Key = (): MutationKey =>
  `core2-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
const page = <T extends z.ZodType>(key: string, schema: T) =>
  z.object({ [key]: z.array(schema), next_cursor: z.string().nullable().optional() });
const sosResult = z.object({
  sos: SosSchema,
  contacts_notified_count: z.number().int().nonnegative().optional(),
  dispatches: z
    .array(
      z.object({
        assignment_id: uuid,
        contact_person_id: uuid,
        rank: z.number().int(),
        status: z.string(),
      })
    )
    .optional(),
  idempotent_replay: z.boolean().optional(),
});
// §2.2 describes a bare safe DTO; §3 refers to watch.id. Normalize both at this seam.
const watchResult = z.union([
  z.object({ watch: WatchSchema, idempotent_replay: z.boolean().optional() }),
  WatchSchema.transform((watch) => ({ watch })),
]);
const contactResult = z.object({
  contact: ContactSchema,
  idempotent_replay: z.boolean().optional(),
});
const reassuranceResult = z.object({
  reassurance: ReassuranceSchema,
  idempotent_replay: z.boolean().optional(),
});
const preferencesResult = z.object({ preferences: PreferencesSchema });
const DeviceInputSchema = z.object({
  battery_level: z.number().int().min(0).max(100).nullable(),
  is_charging: z.boolean().nullable(),
  sampled_at: timestamp,
}).strict();
const DeviceStateSchema = DeviceInputSchema.extend({
  family_id: uuid, person_id: uuid, heartbeat_at: timestamp,
});
const deviceResult = z.object({
  device_status: DeviceStateSchema.nullable(), idempotent_replay: z.boolean().optional(),
});
export type DeviceInput = z.infer<typeof DeviceInputSchema>;

export function createCore2(session: Session) {
  async function request<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'PUT',
    path: string,
    schema: z.ZodType<T>,
    input?: unknown,
    key?: MutationKey,
    signal?: AbortSignal
  ): Promise<T> {
    if (method !== 'GET' && (!key || !/^[\x20-\x7e]{1,128}$/.test(key)))
      throw new Core2Error(400, 'idempotency_key_required');
    const response = await fetch(`${session.url}/api/core2/${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${session.token}`,
        ...(session.familyId ? { 'X-Sahaj-Family-Id': session.familyId } : {}),
        ...(method === 'GET'
          ? {}
          : { 'Content-Type': 'application/json', 'Idempotency-Key': key! }),
      },
      ...(method === 'GET' ? {} : { body: JSON.stringify(input) }),
      signal: signal ?? AbortSignal.timeout(12000),
    });
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new Core2Error(response.status, 'unreadable_response');
    }
    if (!response.ok) {
      const error = z.object({ error: z.string() }).safeParse(body);
      throw new Core2Error(response.status, error.success ? error.data.error : 'request_failed');
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new Core2Error(response.status, 'invalid_response');
    return parsed.data;
  }
  function query(input: PageQuery = {}) {
    const q = z
      .object({
        limit: z.number().int().min(1).max(50).optional(),
        cursor: z.string().min(1).max(1024).optional(),
      })
      .strict()
      .parse(input);
    const params = Object.entries(q)
      .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
      .join('&');
    return params ? `?${params}` : '';
  }
  const resource = (name: string, id: string) => `${name}/${encodeURIComponent(uuid.parse(id))}`;
  return {
    deviceStatus: (signal?: AbortSignal) =>
      request('GET', 'device-status', deviceResult, undefined, undefined, signal),
    reportDeviceStatus: (input: DeviceInput, key: MutationKey, signal?: AbortSignal) =>
      request('POST', 'device-status', deviceResult, DeviceInputSchema.parse(input), key, signal),
    sosList: async (q?: PageQuery, signal?: AbortSignal) =>
      request(
        'GET',
        `sos${query(q)}`,
        page('sos', SosSchema),
        undefined,
        undefined,
        signal
      ) as Promise<{ sos: Sos[]; next_cursor?: string | null }>,
    sos: async (id: string, signal?: AbortSignal) =>
      request('GET', resource('sos', id), sosResult, undefined, undefined, signal),
    startSos: async (input: StartSos, key: MutationKey) =>
      request('POST', 'sos', sosResult, StartSosSchema.parse(input), key),
    cancelSos: async (id: string, input: CancelSos, key: MutationKey) =>
      request(
        'POST',
        `${resource('sos', id)}/cancel`,
        sosResult,
        CancelSosSchema.parse(input),
        key
      ),
    watches: async (q?: PageQuery, signal?: AbortSignal) =>
      request(
        'GET',
        `watches${query(q)}`,
        page('watches', WatchSchema),
        undefined,
        undefined,
        signal
      ) as Promise<{ watches: Watch[]; next_cursor?: string | null }>,
    watch: async (id: string, signal?: AbortSignal) =>
      request('GET', resource('watches', id), watchResult, undefined, undefined, signal),
    startWatch: async (input: StartWatch, key: MutationKey) =>
      request('POST', 'watches', watchResult, StartWatchSchema.parse(input), key),
    extendWatch: async (id: string, input: ExtendWatch, key: MutationKey) =>
      request(
        'POST',
        `${resource('watches', id)}/extend`,
        watchResult,
        ExtendWatchSchema.parse(input),
        key
      ),
    cancelWatch: async (id: string, input: { expected_version?: number }, key: MutationKey) =>
      request(
        'POST',
        `${resource('watches', id)}/cancel`,
        watchResult,
        z.object(expected).strict().parse(input),
        key
      ),
    safeWatch: async (id: string, input: SafeWatch, key: MutationKey) =>
      request(
        'POST',
        `${resource('watches', id)}/safe`,
        watchResult,
        SafeWatchSchema.parse(input),
        key
      ),
    contacts: async (q?: PageQuery, signal?: AbortSignal) =>
      request(
        'GET',
        `trusted-contacts${query(q)}`,
        page('contacts', ContactSchema),
        undefined,
        undefined,
        signal
      ) as Promise<{ contacts: TrustedContact[]; next_cursor?: string | null }>,
    inviteContact: async (input: InviteContact, key: MutationKey) =>
      request('POST', 'trusted-contacts', contactResult, InviteSchema.parse(input), key),
    approveContact: async (id: string, input: { consent_id?: string }, key: MutationKey) =>
      request(
        'POST',
        `${resource('trusted-contacts', id)}/approve`,
        contactResult,
        z.object({ consent_id: uuid.optional() }).strict().parse(input),
        key
      ),
    updateContact: async (id: string, input: UpdateContact, key: MutationKey) =>
      request(
        'PATCH',
        resource('trusted-contacts', id),
        contactResult,
        UpdateContactSchema.parse(input),
        key
      ),
    revokeContact: async (id: string, input: { expected_version?: number }, key: MutationKey) =>
      request(
        'POST',
        `${resource('trusted-contacts', id)}/revoke`,
        contactResult,
        z.object(expected).strict().parse(input),
        key
      ),
    reassurance: async (q?: PageQuery, signal?: AbortSignal) =>
      request(
        'GET',
        `reassurance${query(q)}`,
        page('reassurance', ReassuranceSchema),
        undefined,
        undefined,
        signal
      ) as Promise<{ reassurance: Reassurance[]; next_cursor?: string | null }>,
    sendReassurance: async (input: SendReassurance, key: MutationKey) =>
      request('POST', 'reassurance', reassuranceResult, ReassureSchema.parse(input), key),
    preferences: async (signal?: AbortSignal) =>
      request('GET', 'reassurance/preferences', preferencesResult, undefined, undefined, signal),
    savePreferences: async (input: SharingPreferences, key: MutationKey) =>
      request(
        'PUT',
        'reassurance/preferences',
        preferencesResult,
        PreferencesSchema.strict().parse(input),
        key
      ),
  };
}
export type Core2Api = ReturnType<typeof createCore2>;
