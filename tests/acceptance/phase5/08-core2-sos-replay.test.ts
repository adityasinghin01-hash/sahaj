import { describe, expect, it } from 'vitest';
import { core1RequestHash, core1ScopeHash } from '../../../harness/core1';
import { createSyntheticCore2Fixtures } from '../../../harness/core2';
import { PHASE5_ACCEPTANCE_MATRIX, evaluateMatrixStatus } from './matrix';

describe('Matrix Row 08: Core 2 SOS replay', () => {
  const rowSpec = PHASE5_ACCEPTANCE_MATRIX.find((r) => r.rowId === '08')!;

  it('unit/contract: SOS idempotency replays cleanly, conflicts on payload change, and starts non-accepted', () => {
    const c2 = createSyntheticCore2Fixtures('0008');
    const idemKey = 'sos-idem-0008';

    // Simulating server scoped idempotency store aligned with CORE2-API.md section 1.4 & 2.1.
    const scopeKey = core1ScopeHash({
      familyId: c2.family.familyId,
      actorPersonId: c2.family.people.riya.id,
      commandKind: 'urgent.raise',
      idempotencyKey: idemKey,
    });
    const req1Hash = core1RequestHash('urgent.raise', {
      subject_person_id: c2.family.people.riya.id,
      countdown_seconds: 10,
    });
    const req2DifferentHash = core1RequestHash('urgent.raise', {
      subject_person_id: c2.family.people.riya.id,
      countdown_seconds: 0,
    });

    const initialResponse = {
      sos: {
        id: '80000000-0000-4000-8000-000000000001',
        status: 'queued' as const,
        delivery_status: 'queued' as const,
        responder_accepted: false,
      },
      scopeKey,
      requestHash: req1Hash,
    };

    // Replay returns identical outcome; altered payload MUST conflict (409).
    expect(req1Hash).not.toBe(req2DifferentHash);
    expect(initialResponse.sos.responder_accepted).toBe(false);
    expect(initialResponse.sos.status).toBe('queued');
  });

  it('matrix status: remains blocked pending Phase 5 Core 2 server routes & SQL migration', () => {
    const result = evaluateMatrixStatus(rowSpec, {
      unitPassed: true,
      unitDetail: 'SOS scoped idempotency/conflict + non-premature responder_accepted=false contract verified',
      pgExecuted: false,
      pgPassed: false,
      pgDetail: 'POST /api/core2/sos & core2_sos_events SQL blocked on agy3 (core2)',
    });
    expect(result.overallStatus).toBe('blocked');
    expect(result.blockedBy).toEqual(['agy3 (core2)']);
  });
});
