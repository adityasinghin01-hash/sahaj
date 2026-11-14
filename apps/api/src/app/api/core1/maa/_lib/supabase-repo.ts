import { createSupabaseCore1Repository } from '@/lib/core1/repository';
import { parseDemoTimerScale, scaleDurationSeconds } from '@/lib/core1/push-notify';
import { serviceDatabase } from '@/lib/database';
import { cedarMediaAuthorizer } from '@/lib/media/cedar-authorizer';
import { voiceShareConsentPurpose, type ConsentRow, type MediaAuthorizationContext, type VoiceContentRow } from '@/lib/media/contracts';
import { supabaseRepository, supabaseStorage } from '@/lib/media/supabase';
import type {
  MaaCommandIdempotencyRecord,
  MaaDeviceRecord,
  MaaIncidentAssignmentRecord,
  MaaPersonRecord,
  MaaRepo,
  MaaUrgentIncidentRecord,
  MaaUrgentState,
  MaaVoicePostRecord,
  MaaVoiceState,
} from './repo';

type ServiceDbClient = ReturnType<typeof serviceDatabase>;

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asNullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function createSupabaseMaaRepo(client: ServiceDbClient = serviceDatabase()): MaaRepo {
  const core1Repo = createSupabaseCore1Repository(client);
  const mediaRepo = supabaseRepository(client);
  const storage = supabaseStorage(client);

  return {
    storage,

    async authorizeMedia(ctx: MediaAuthorizationContext): Promise<'allow' | 'deny'> {
      const decision = await cedarMediaAuthorizer(ctx);
      return decision === 'allow' ? 'allow' : 'deny';
    },

    async getDevice(deviceId: string): Promise<MaaDeviceRecord | null> {
      const { data, error } = await client
        .from('shield_devices')
        .select('id, family_id, person_id, platform, device_secret_hash')
        .eq('id', deviceId)
        .maybeSingle();

      if (error || !data) return null;
      return {
        deviceId: String(data.id),
        familyId: String(data.family_id),
        personId: String(data.person_id),
        platform: asString(data.platform, 'android'),
        revoked: false,
        deviceSecretHash: String(data.device_secret_hash),
      };
    },

    async touchDeviceHeartbeat(deviceId: string, lastSeenAt: string): Promise<void> {
      await client
        .from('shield_devices')
        .update({ last_heartbeat_at: lastSeenAt })
        .eq('id', deviceId);
    },

    async getPersonInFamily(familyId: string, personId: string): Promise<MaaPersonRecord | null> {
      const { data, error } = await client
        .from('people')
        .select('id, family_id, display_name, role')
        .eq('family_id', familyId)
        .eq('id', personId)
        .maybeSingle();

      if (error || !data) return null;
      return {
        id: String(data.id),
        familyId: String(data.family_id),
        displayName: asString(data.display_name, 'Family'),
        role: data.role as MaaPersonRecord['role'],
      };
    },

    async listPeopleInFamily(familyId: string): Promise<MaaPersonRecord[]> {
      const { data, error } = await client
        .from('people')
        .select('id, family_id, display_name, role')
        .eq('family_id', familyId);

      if (error || !data) return [];
      return data.map((row) => ({
        id: String(row.id),
        familyId: String(row.family_id),
        displayName: asString(row.display_name, 'Family'),
        role: row.role as MaaPersonRecord['role'],
      }));
    },

    async listVoicePostsForRecipient(
      familyId: string,
      recipientId: string,
      limit: number,
    ): Promise<MaaVoicePostRecord[]> {
      const { data, error } = await client
        .from('voice_posts')
        .select('id, family_id, sender_id, recipient_id, reply_to, state, consent_id, created_at')
        .eq('family_id', familyId)
        .eq('recipient_id', recipientId)
        .order('created_at', { ascending: false })
        .limit(limit);

      if (error) {
        throw new Error(`maa_list_voice_posts_failed:${error.message}`);
      }

      return (data ?? []).map((row) => ({
        id: String(row.id),
        familyId: String(row.family_id),
        senderId: String(row.sender_id),
        recipientId: String(row.recipient_id),
        replyTo: asNullableString(row.reply_to),
        state: row.state as MaaVoiceState,
        consentId: String(row.consent_id),
        createdAt: String(row.created_at),
        durationS: null,
        playedAt: null,
      }));
    },

    async getVoicePostById(postId: string): Promise<MaaVoicePostRecord | null> {
      const { data, error } = await client
        .from('voice_posts')
        .select('id, family_id, sender_id, recipient_id, reply_to, state, consent_id, created_at')
        .eq('id', postId)
        .maybeSingle();

      if (error || !data) return null;
      return {
        id: String(data.id),
        familyId: String(data.family_id),
        senderId: String(data.sender_id),
        recipientId: String(data.recipient_id),
        replyTo: asNullableString(data.reply_to),
        state: data.state as MaaVoiceState,
        consentId: String(data.consent_id),
        createdAt: String(data.created_at),
        durationS: null,
        playedAt: null,
      };
    },

    async markVoicePostHeard(
      familyId: string,
      postId: string,
      recipientId: string,
      heardAt: string,
    ): Promise<{ playedAt: string }> {
      const { error } = await client
        .from('voice_posts')
        .update({ state: 'heard' })
        .eq('family_id', familyId)
        .eq('id', postId)
        .eq('recipient_id', recipientId);

      if (error) {
        throw new Error(`maa_mark_voice_heard_failed:${error.message}`);
      }

      return { playedAt: heardAt };
    },

    async getVoiceContent(familyId: string, postId: string): Promise<VoiceContentRow | null> {
      return mediaRepo.getVoiceContent(familyId, postId);
    },

    async getConsent(familyId: string, consentId: string): Promise<ConsentRow | null> {
      return mediaRepo.getConsent(familyId, consentId);
    },

    async listConsentHistory(familyId: string, personId: string, purpose: string): Promise<ConsentRow[]> {
      return mediaRepo.listConsentHistory(familyId, personId, purpose);
    },

    async createVoiceShareConsent(
      familyId: string,
      personId: string,
      recipientId: string,
      version: string,
      nowIso: string,
    ): Promise<ConsentRow> {
      const purpose = voiceShareConsentPurpose(recipientId);
      const { data, error } = await client
        .from('consents')
        .insert({
          family_id: familyId,
          person_id: personId,
          purpose,
          question: 'Share your voice reply with this family member?',
          answer: true,
          version,
          created_at: nowIso,
        })
        .select('id, family_id, person_id, call_id, purpose, answer, version, created_at')
        .single();

      if (error || !data) {
        throw new Error(`maa_create_consent_failed:${error?.message ?? 'unknown'}`);
      }

      return {
        id: String(data.id),
        familyId: String(data.family_id),
        personId: String(data.person_id),
        callId: asNullableString(data.call_id),
        purpose: String(data.purpose),
        answer: Boolean(data.answer),
        version: String(data.version),
        createdAt: String(data.created_at),
      };
    },

    async uploadVoiceObject(objectPath: string, bytes: Uint8Array, contentType: string): Promise<void> {
      const { error } = await client.storage.from('sahaj-voice').upload(objectPath, bytes, {
        contentType,
        upsert: false,
      });

      if (error) {
        throw new Error(`maa_voice_upload_failed:${error.message}`);
      }
    },

    async createFamilyVoicePost(params): Promise<MaaVoicePostRecord> {
      const { data, error } = await client.rpc('create_family_voice_post', {
        p_family_id: params.familyId,
        p_sender_id: params.senderId,
        p_recipient_id: params.recipientId,
        p_object_path: params.objectPath,
        p_consent_id: params.consentId,
        p_reply_to: params.replyTo,
      });

      if (error || !data) {
        throw new Error(`maa_create_voice_post_failed:${error?.message ?? 'empty_rpc_result'}`);
      }

      const rpcObj = (typeof data === 'object' ? data : {}) as Record<string, unknown>;
      const postId = asString(rpcObj.voice_post_id ?? rpcObj.id);
      if (postId) {
        const fetched = await this.getVoicePostById(postId);
        if (fetched) return fetched;
      }

      return {
        id: postId,
        familyId: params.familyId,
        senderId: params.senderId,
        recipientId: params.recipientId,
        replyTo: params.replyTo,
        state: (asString(rpcObj.state, 'sent') as MaaVoiceState),
        consentId: params.consentId,
        createdAt: asString(rpcObj.created_at, new Date().toISOString()),
        durationS: null,
        playedAt: null,
      };
    },

    async findCommandIdempotency(scopedIdempotencyKey: string): Promise<MaaCommandIdempotencyRecord | null> {
      const { data, error } = await client
        .from('raw_events')
        .select('id, metadata')
        .eq('source', 'core1_maa_device')
        .eq('provider_event_id', scopedIdempotencyKey)
        .maybeSingle();

      if (error || !data) return null;
      const metadata = (data.metadata ?? {}) as Record<string, unknown>;
      return {
        id: String(data.id),
        payloadHash: asString(metadata.payload_hash),
        entityId: asNullableString(metadata.entity_id),
      };
    },

    async persistCommandEvent(params): Promise<void> {
      const { error } = await client.from('raw_events').insert({
        id: params.eventId,
        family_id: params.familyId,
        source: 'core1_maa_device',
        provider_event_id: params.scopedIdempotencyKey,
        event_type: params.commandType,
        metadata: {
          payload_hash: params.payloadHash,
          encrypted_payload: params.payloadCiphertext,
          actor_person_id: params.actorPersonId,
          entity_id: params.entityId ?? null,
        },
        status: 'pending',
      });

      if (error) {
        throw new Error(`maa_persist_command_failed:${error.message}`);
      }
    },

    async createUrgentIncidentOffer(params) {
      const scale = parseDemoTimerScale(process.env);
      if (scale !== 1) {
        const scaledSeconds = scaleDurationSeconds(params.offerTimeoutMinutes ?? 3, scale);
        const { data, error } = await client.rpc('create_urgent_incident_offer_scaled', {
          p_family_id: params.familyId,
          p_subject_person_id: params.subjectPersonId,
          p_severity: params.severity,
          p_offer_timeout_seconds: scaledSeconds,
        });
        if (!error && data) {
          const row = data as Record<string, unknown>;
          return {
            incidentId: String(row.incident_id),
            assignmentId: typeof row.assignment_id === 'string' ? row.assignment_id : undefined,
            state: String(row.state ?? 'offered') as MaaUrgentState,
          };
        }
      }
      if (!core1Repo.createUrgentIncidentOffer) {
        throw new Error('maa_missing_urgent_incident_offer_rpc');
      }
      const result = await core1Repo.createUrgentIncidentOffer(params);
      return {
        incidentId: result.incidentId,
        assignmentId: result.assignmentId,
        state: result.state as MaaUrgentState,
      };
    },

    async getUrgentIncidentById(incidentId: string): Promise<MaaUrgentIncidentRecord | null> {
      const { data, error } = await client
        .from('incidents')
        .select('id, family_id, person_id, owner_person_id, promised_at, state, severity, created_at')
        .eq('id', incidentId)
        .maybeSingle();

      if (error || !data) return null;
      const rawState = String(data.state);
      const state: MaaUrgentState =
        rawState === 'done' || rawState === 'closed'
          ? 'resolved'
          : (rawState as MaaUrgentState);

      return {
        id: String(data.id),
        familyId: String(data.family_id),
        subjectPersonId: String(data.person_id),
        state,
        severity: data.severity as MaaUrgentIncidentRecord['severity'],
        responderId: asNullableString(data.owner_person_id),
        promisedAt: asNullableString(data.promised_at),
        createdAt: String(data.created_at),
      };
    },

    async listIncidentAssignments(familyId: string, incidentId: string): Promise<MaaIncidentAssignmentRecord[]> {
      const { data, error } = await client
        .from('assignments')
        .select('id, incident_id, family_id, person_id, status, offered_at, expires_at, accepted_at')
        .eq('family_id', familyId)
        .eq('incident_id', incidentId)
        .order('offered_at', { ascending: true });

      if (error || !data) return [];
      return data.map((row) => ({
        id: String(row.id),
        incidentId: String(row.incident_id),
        familyId: String(row.family_id),
        assigneePersonId: String(row.person_id),
        state: row.status as MaaIncidentAssignmentRecord['state'],
        offeredAt: String(row.offered_at),
        respondedAt: asNullableString(row.accepted_at),
        promisedAt: null,
        expiresAt: asNullableString(row.expires_at),
      }));
    },
  };
}
