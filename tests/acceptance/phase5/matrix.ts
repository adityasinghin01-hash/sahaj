import type { MatrixRowResult, MatrixRowSpec } from './runner/types';

export const PHASE5_ACCEPTANCE_MATRIX: readonly MatrixRowSpec[] = [
  {
    rowId: '01',
    title: 'Duplicate signed provider callback',
    requiredAssertion:
      'Duplicate callback produces one raw event, one delivery/acceptance update, one timeline event, and no second dispatch.',
    requiredLanes: ['kiro-a (phase2-dispatch)', 'kiro-b (phase3-orchestration)'],
    foundationChecksAvailable: true,
  },
  {
    rowId: '02',
    title: 'Restart / lost commit response',
    requiredAssertion:
      'Duplicate request with same Idempotency-Key returns same outcome without a second dispatch; changed payload with same key fails with 409.',
    requiredLanes: ['kiro-b (phase3-orchestration)', 'agy-phase4 (core1)', 'agy3 (core2)'],
    foundationChecksAvailable: true,
  },
  {
    rowId: '03',
    title: 'Revocation before dispatch',
    requiredAssertion:
      'Revoking a permission, consent, or trusted contact concurrently with scheduling blocks dispatch cleanly.',
    requiredLanes: ['kiro-a (phase2-dispatch)', 'kiro-b (phase3-orchestration)', 'agy3 (core2)'],
    foundationChecksAvailable: true,
  },
  {
    rowId: '04',
    title: 'Two-person approval',
    requiredAssertion:
      'Medicine refill cannot dispatch with 1 approval, same-person duplicate approval, or modified payload fingerprint; succeeds with 2 distinct authorized approvers.',
    requiredLanes: ['kiro-b (phase3-orchestration)', 'agy-phase4 (core1)'],
    foundationChecksAvailable: true,
  },
  {
    rowId: '05',
    title: 'Same-family target substitution',
    requiredAssertion:
      'Replacing a target or contact with another member of the same family fails outside active explicit scope.',
    requiredLanes: ['agy-phase4 (core1)', 'agy3 (core2)'],
    foundationChecksAvailable: false,
  },
  {
    rowId: '06',
    title: 'Responder acceptance',
    requiredAssertion:
      'Urgent alert does not show accepted on send; only verified provider accept proof sets accepted.',
    requiredLanes: ['kiro-a (phase2-dispatch)', 'kiro-b (phase3-orchestration)', 'agy-phase4 (core1)'],
    foundationChecksAvailable: true,
  },
  {
    rowId: '07',
    title: 'Core 1 voice',
    requiredAssertion:
      'Two-way voice plays only family recordings and records replies only with verified consent.',
    requiredLanes: ['agy-phase4 (core1)', 'kiro-a (phase2-dispatch)'],
    foundationChecksAvailable: true,
  },
  {
    rowId: '08',
    title: 'Core 2 SOS replay',
    requiredAssertion:
      'Emergency SOS request replays cleanly, conflicts on payload mismatch, and never reports delivered prematurely.',
    requiredLanes: ['agy3 (core2)'],
    foundationChecksAvailable: false,
  },
  {
    rowId: '09',
    title: 'Safe vs timeout',
    requiredAssertion:
      'Concurrent I am safe and watch-timeout transition settles monotonically without post-safe escalation.',
    requiredLanes: ['agy3 (core2)'],
    foundationChecksAvailable: false,
  },
  {
    rowId: '10',
    title: 'Missed cron / restart',
    requiredAssertion:
      'Overdue check-in or watch tick recovers without duplicate dispatch and respects quiet hours and DST.',
    requiredLanes: ['kiro-a (phase2-dispatch)', 'kiro-b (phase3-orchestration)', 'agy-phase4 (core1)', 'agy3 (core2)'],
    foundationChecksAvailable: false,
  },
  {
    rowId: '11',
    title: 'Lease / checkpoint theft',
    requiredAssertion:
      'Two workers run; Process A crashes; Process B resumes checkpoint; stale worker update is rejected.',
    requiredLanes: [],
    foundationChecksAvailable: true,
  },
  {
    rowId: '12',
    title: 'Unknown delivery',
    requiredAssertion:
      'Timeout/5xx on dispatch creates delivery_unknown; reconciled by callback; no automatic second send.',
    requiredLanes: ['kiro-a (phase2-dispatch)', 'kiro-b (phase3-orchestration)'],
    foundationChecksAvailable: true,
  },
  {
    rowId: '13',
    title: 'Reports / reassurance',
    requiredAssertion:
      'Redacted daily report and reassurance read enforce family isolation and exclude private content.',
    requiredLanes: ['agy-phase4 (core1)', 'agy3 (core2)'],
    foundationChecksAvailable: true,
  },
  {
    rowId: '14',
    title: 'Timeline verification',
    requiredAssertion:
      'Tampering any timeline event fails signature/chain verification across the full event stream.',
    requiredLanes: [],
    foundationChecksAvailable: true,
  },
];

export function evaluateMatrixStatus(
  spec: MatrixRowSpec,
  outcomes: {
    unitPassed: boolean;
    unitDetail: string;
    pgExecuted: boolean;
    pgPassed: boolean;
    pgDetail: string;
  },
): MatrixRowResult {
  const blockedBy = spec.requiredLanes;
  const isBlocked = blockedBy.length > 0;

  let disposableStatus: 'passed' | 'failed' | 'blocked' | 'skipped';
  if (!outcomes.pgExecuted && !isBlocked) {
    disposableStatus = 'skipped';
  } else if (outcomes.pgExecuted && !outcomes.pgPassed) {
    disposableStatus = 'failed';
  } else if (isBlocked) {
    disposableStatus = 'blocked';
  } else {
    disposableStatus = 'passed';
  }

  let overallStatus: 'passed' | 'failed' | 'blocked' | 'skipped';
  if (!outcomes.unitPassed || (outcomes.pgExecuted && !outcomes.pgPassed)) {
    overallStatus = 'failed';
  } else if (isBlocked) {
    overallStatus = 'blocked';
  } else if (!outcomes.pgExecuted) {
    overallStatus = 'skipped';
  } else {
    overallStatus = 'passed';
  }

  return {
    rowId: spec.rowId,
    title: spec.title,
    overallStatus,
    blockedBy,
    ...(isBlocked ? { blockReason: `needs ${blockedBy.join(' + ')}` } : {}),
    levels: {
      unitContract: {
        status: outcomes.unitPassed ? 'passed' : 'failed',
        detail: outcomes.unitDetail,
      },
      disposableIntegrated: {
        status: disposableStatus,
        detail: outcomes.pgDetail,
      },
      live: {
        status: 'skipped',
        detail: 'Live staging/provider sends disabled in phase 5 harness by safety rules',
      },
    },
  };
}
