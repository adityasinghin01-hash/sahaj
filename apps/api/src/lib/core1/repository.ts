/**
 * Supabase repository adapter for Core 1 commands.
 *
 * Implements:
 * - Authoritative entity ownership validation (Blocker 1 fix)
 * - Explicit family resolution: handles users with multiple active families without arbitrary selection (Blocker 4 fix)
 * - Live circle capability record lookup (Blocker 5 fix)
 * - Durable encrypted event ingestion into public.raw_events before 202 response
 * - Scoped idempotency lookups and duplicate reporting (Blocker 3 & 6 fix)
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { Core1CommandError } from './errors';
import { encryptWebhook } from '../webhook-security';
import type {
  Core1RepositoryPort,
  FamilyMembership,
  CircleRecord,
  StoredRawEvent,
  CommandType,
} from './types';

export class SupabaseCore1Repository implements Core1RepositoryPort {
  constructor(
    private readonly client: SupabaseClient,
    private readonly encryptionKeyHex?: string
  ) {}

  /**
   * Resolves family membership for a user.
   * Crucial fix for Blocker 4:
   * - If requestedFamilyId is provided, resolves ONLY that family.
   * - If not provided and user belongs to multiple active families, REJECTS ambiguity (requires familyId).
   */
  async getMembership(userId: string, requestedFamilyId?: string): Promise<FamilyMembership> {
    let query = this.client
      .from('family_memberships')
      .select('family_id, user_id, person_id, role')
      .eq('user_id', userId);

    if (requestedFamilyId) {
      query = query.eq('family_id', requestedFamilyId);
    }

    const { data, error } = await query;
    if (error) {
      throw new Core1CommandError('database_query_error', 500);
    }

    if (!data || data.length === 0) {
      throw new Core1CommandError('family_membership_not_found', 403);
    }

    if (!requestedFamilyId && data.length > 1) {
      throw new Core1CommandError('ambiguous_family_membership_family_id_required', 400);
    }

    const row = data[0];
    return {
      familyId: row.family_id,
      userId: row.user_id,
      personId: row.person_id,
      role: row.role as FamilyMembership['role'],
    };
  }

  /**
   * Retrieves live circle record. Missing or inactive entry fails closed.
   */
  async getCircleRecord(familyId: string, personId: string): Promise<CircleRecord | null> {
    const { data, error } = await this.client
      .from('circle')
      .select('family_id, person_id, rank, approved_at, consent_at, revoked_at')
      .eq('family_id', familyId)
      .eq('person_id', personId)
      .maybeSingle();

    if (error || !data) {
      return null;
    }

    return {
      familyId: data.family_id,
      personId: data.person_id,
      rank: data.rank,
      // public.circle has no active column: a circle entry is active until revoked.
      active: data.revoked_at === null,
      approvedAt: data.approved_at,
      consentAt: data.consent_at,
      revokedAt: data.revoked_at,
    };
  }

  /**
   * Proves that a referenced entity belongs to this family before ingestion.
   * Crucial fix for Blocker 1: Never accepts foreign entity IDs into durable workflows.
   */
  async validateEntityOwnership(entityType: string, familyId: string, entityId: string): Promise<boolean> {
    const tableMap: Record<string, string> = {
      incident: 'incidents',
      person: 'people',
      medicine: 'medicines',
      vendor: 'vendors',
      consent: 'consents',
      schedule: 'schedules',
      call: 'calls',
      assignment: 'assignments',
    };

    const table = tableMap[entityType];
    if (!table) {
      throw new Core1CommandError(`unsupported_entity_type_${entityType}`, 400);
    }

    const { data, error } = await this.client
      .from(table)
      .select('id')
      .eq('family_id', familyId)
      .eq('id', entityId)
      .maybeSingle();

    if (error || !data) {
      return false;
    }

    return true;
  }

  /**
   * Finds stored event by scoped idempotency key.
   */
  async findEventByIdempotency(scopedKey: string): Promise<StoredRawEvent | null> {
    const { data, error } = await this.client
      .from('raw_events')
      .select('id, family_id, source, provider_event_id, payload_hash, payload_ciphertext, status')
      .eq('source', 'core1_command')
      .eq('provider_event_id', scopedKey)
      .maybeSingle();

    if (error || !data) {
      return null;
    }

    return {
      id: data.id,
      familyId: data.family_id,
      source: data.source,
      providerEventId: data.provider_event_id,
      payloadHash: data.payload_hash,
      payloadCiphertext: data.payload_ciphertext,
      status: data.status,
    };
  }

  /**
   * Persists command event encrypted into public.raw_events.
   */
  async persistCommandEvent(params: {
    eventId: string;
    familyId: string;
    scopedIdempotencyKey: string;
    payloadHash: string;
    payloadCiphertext: string;
    commandType: CommandType;
    actorPersonId: string;
  }): Promise<void> {
    const { error } = await this.client.from('raw_events').insert({
      id: params.eventId,
      family_id: params.familyId,
      source: 'core1_command',
      provider_event_id: params.scopedIdempotencyKey,
      event_type: `command.${params.commandType}`,
      payload_hash: params.payloadHash,
      payload_ciphertext: params.payloadCiphertext,
      status: 'pending',
      metadata: {
        command: params.commandType,
        actorPersonId: params.actorPersonId,
      },
    });

    if (error) {
      // Check for unique collision on provider_event_id
      if (error.code === '23505' || error.message?.includes('duplicate key')) {
        throw new Core1CommandError('duplicate_command_event', 409);
      }
      throw new Core1CommandError('event_persistence_failed', 500);
    }
  }

  async createUrgentIncidentOffer(params: {
    familyId: string;
    subjectPersonId: string;
    severity: string;
    offerTimeoutMinutes?: number;
  }): Promise<{ incidentId: string; assignmentId?: string; state: string }> {
    const { data, error } = await this.client.rpc('create_urgent_incident_offer', {
      p_family_id: params.familyId,
      p_subject_person_id: params.subjectPersonId,
      p_severity: params.severity,
      p_offer_timeout_minutes: params.offerTimeoutMinutes ?? 3,
    });

    if (error) {
      throw new Core1CommandError(`rpc_error_${error.code ?? 'failed'}`, 500);
    }

    return {
      incidentId: data.incident_id,
      assignmentId: data.assignment_id,
      state: data.state,
    };
  }

  async recordMedicineDose(params: {
    familyId: string;
    medicineId: string;
    personId: string;
    actionType: string;
    count?: number;
  }): Promise<{ remainingCount: number; isLowStock: boolean }> {
    const { data, error } = await this.client.rpc('record_medicine_dose', {
      p_family_id: params.familyId,
      p_medicine_id: params.medicineId,
      p_person_id: params.personId,
      p_action_type: params.actionType,
      p_count: params.count,
    });

    if (error) {
      throw new Core1CommandError(`rpc_error_${error.code ?? 'failed'}`, 500);
    }

    return {
      remainingCount: data.remaining_count,
      isLowStock: data.is_low_stock,
    };
  }
}

export function createSupabaseCore1Repository(
  client: SupabaseClient,
  encryptionKeyHex?: string
): Core1RepositoryPort {
  return new SupabaseCore1Repository(client, encryptionKeyHex);
}
