import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createProductionSarvamDeps, type ProductionOverrides } from '@/lib/core1/sarvam-tools/production';
import { executeCore1Command } from '@/lib/core1/service';
import { dispatchUrgentCallAndPushForIncident } from '@/lib/core1/urgent-help-service';
import { createSupabaseCore1TimelinePort } from '@/lib/core1/wiring-common';

vi.mock('@/lib/core1/service', () => ({ executeCore1Command: vi.fn() }));
vi.mock('@/lib/core1/urgent-help-service', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/core1/urgent-help-service')>(), dispatchUrgentCallAndPushForIncident: vi.fn(),
}));
vi.mock('@/lib/core1/wiring-common', async importOriginal => ({ ...await importOriginal<typeof import('@/lib/core1/wiring-common')>(), createSupabaseCore1TimelinePort: vi.fn() }));

const ctx = { familyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', parentId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' };
const ROHIT = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const env = { WEBHOOK_ENCRYPTION_KEY: 'ab'.repeat(32), TIMELINE_SIGNING_PRIVATE_KEY: 'k', DEMO_TIMER_SCALE: '60' };

function fixture(openIncident: boolean) {
  const query = vi.fn(async (q: string): Promise<Record<string, unknown>[]> => {
    if (q.includes('from public.incidents')) return openIncident ? [{ id: 'x' }] : [];
    if (q.includes('display_name')) return [{ display_name: 'Rohit' }];
    return [{ id: 'x' }];
  });
  const sql = Object.assign(async (parts: TemplateStringsArray, ...args: unknown[]) => query(parts.join('?'), args as never), { reserve: vi.fn(), begin: vi.fn(), release: vi.fn() });
  const db = { from: vi.fn(() => ({ select: () => ({ eq: () => ({ eq: () => ({ is: () => ({ single: async () => ({ data: { family_id: ctx.familyId, person_id: ctx.parentId, user_id: 'u', role: 'parent' } }) }) }) }) }) })) };
  const create = vi.fn(async () => ({ incidentId: 'inc-1', assignmentId: 'asg-1', responderPersonId: ROHIT, state: 'offered', expiresAt: '' }));
  const urgent = { store: { createUrgentIncidentOfferScaled: create } } as unknown as ProductionOverrides['urgent'];
  const deps = createProductionSarvamDeps(env, { db, sql, urgent, now: () => new Date() } as unknown as ProductionOverrides);
  return { deps, create };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(createSupabaseCore1TimelinePort).mockReturnValue({ append: vi.fn() } as never);
  vi.mocked(executeCore1Command).mockResolvedValue({ eventId: 'e', commandType: 'urgent_help', status: 'queued', deduped: false });
});

describe('keypad "madad" (Sarvam raise_urgent) starts the real urgent chain', () => {
  it('creates the offer (90 s human floor) and dispatches the responder call + Riya push, naming the responder', async () => {
    const { deps, create } = fixture(false);
    expect(await deps.urgentCommand(ctx, { severity: 'critical', said: 'gir gayi' }, 'k1')).toEqual({ status: 'queued', responder_name: 'Rohit' });
    expect(create).toHaveBeenCalledWith({ familyId: ctx.familyId, subjectPersonId: ctx.parentId, severity: 'critical', offerTimeoutSeconds: 90 });
    expect(dispatchUrgentCallAndPushForIncident).toHaveBeenCalledOnce();
    expect(vi.mocked(dispatchUrgentCallAndPushForIncident).mock.calls[0][1]).toMatchObject({ incidentId: 'inc-1', assignmentId: 'asg-1', responderPersonId: ROHIT });
  });
  it('an incident already open for Maa, or a replayed tool call, never opens a second chain', async () => {
    const open = fixture(true);
    expect(await open.deps.urgentCommand(ctx, { severity: 'urgent', said: 'madad' }, 'k2')).toEqual({ status: 'queued' });
    expect(open.create).not.toHaveBeenCalled();
    vi.mocked(executeCore1Command).mockResolvedValue({ eventId: 'e', commandType: 'urgent_help', status: 'queued', deduped: true });
    const replay = fixture(false);
    await replay.deps.urgentCommand(ctx, { severity: 'urgent', said: 'madad' }, 'k3');
    expect(replay.create).not.toHaveBeenCalled();
    expect(dispatchUrgentCallAndPushForIncident).not.toHaveBeenCalled();
  });
});
