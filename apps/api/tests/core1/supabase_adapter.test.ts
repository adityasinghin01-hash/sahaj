import { describe, it, expect, vi } from 'vitest';
import { createSupabaseCore1Repository } from '../../src/lib/core1';
import type { SupabaseClient } from '@supabase/supabase-js';

describe('Supabase Repository Adapter (Blocker 6 Fix)', () => {
  it('resolves membership and handles ambiguous multi-family memberships', async () => {
    // Single membership
    const mockClientSingle = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockImplementation((col: string) => {
          if (col === 'user_id') {
            return {
              data: [
                {
                  family_id: 'fam-1',
                  user_id: 'user-1',
                  person_id: 'person-1',
                  role: 'child',
                },
              ],
              error: null,
            };
          }
          return { data: [], error: null };
        }),
      }),
    } as unknown as SupabaseClient;

    const repoSingle = createSupabaseCore1Repository(mockClientSingle);
    const m = await repoSingle.getMembership('user-1');
    expect(m.familyId).toBe('fam-1');
    expect(m.role).toBe('child');

    // Multiple memberships without requested familyId raises 400
    const mockClientMulti = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnValue({
          data: [
            { family_id: 'fam-1', user_id: 'user-1', person_id: 'p-1', role: 'child' },
            { family_id: 'fam-2', user_id: 'user-1', person_id: 'p-2', role: 'child' },
          ],
          error: null,
        }),
      }),
    } as unknown as SupabaseClient;

    const repoMulti = createSupabaseCore1Repository(mockClientMulti);
    await expect(repoMulti.getMembership('user-1')).rejects.toMatchObject({
      code: 'ambiguous_family_membership_family_id_required',
      status: 400,
    });
  });

  it('validates entity ownership against corresponding Supabase tables', async () => {
    const mockClient = {
      from: vi.fn().mockImplementation((table: string) => ({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({
          data: table === 'incidents' ? { id: 'inc-123' } : null,
          error: null,
        }),
      })),
    } as unknown as SupabaseClient;

    const repo = createSupabaseCore1Repository(mockClient);

    const exists = await repo.validateEntityOwnership('incident', 'fam-1', 'inc-123');
    expect(exists).toBe(true);

    const absent = await repo.validateEntityOwnership('medicine', 'fam-1', 'med-456');
    expect(absent).toBe(false);
  });

  it('reports duplicate conflict on provider_event_id unique violation (23505)', async () => {
    const mockClient = {
      from: vi.fn().mockReturnValue({
        insert: vi.fn().mockResolvedValue({
          error: { code: '23505', message: 'duplicate key value violates unique constraint' },
        }),
      }),
    } as unknown as SupabaseClient;

    const repo = createSupabaseCore1Repository(mockClient);

    await expect(
      repo.persistCommandEvent({
        eventId: 'evt-1',
        familyId: 'fam-1',
        scopedIdempotencyKey: 'idemp-dup-key',
        payloadHash: 'hash-1',
        payloadCiphertext: 'enc-1',
        commandType: 'check_in',
        actorPersonId: 'p-1',
      })
    ).rejects.toMatchObject({
      code: 'duplicate_command_event',
      status: 409,
    });
  });
});
