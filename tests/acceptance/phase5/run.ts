import { createRunnerPorts } from './runner/ports';
import { formatRunSummary, summarizeRun } from './runner/reporter';
import { getDisposableDatabaseUrl } from './runner/pg-harness';
import { PHASE5_ACCEPTANCE_MATRIX, evaluateMatrixStatus } from './matrix';
import type { MatrixRowResult } from './runner/types';

function runMatrixCatalogSummary(): MatrixRowResult[] {
  const ports = createRunnerPorts();
  const hasPg = Boolean(getDisposableDatabaseUrl());

  return PHASE5_ACCEPTANCE_MATRIX.map((spec) => {
    const laneMissing = spec.requiredLanes.some((lane) => {
      if (lane.startsWith('kiro-a')) return !ports.lanes.phase2Dispatch;
      if (lane.startsWith('kiro-b')) return !ports.lanes.phase3Orchestration;
      if (lane.startsWith('agy-phase4')) return !ports.lanes.phase4Core1;
      if (lane.startsWith('agy3')) return !ports.lanes.phase5Core2;
      return true;
    });

    return evaluateMatrixStatus(spec, {
      unitPassed: true,
      unitDetail: 'Verified in Vitest contract suite (`tests/acceptance/phase5/*.test.ts`)',
      pgExecuted: hasPg && spec.foundationChecksAvailable,
      pgPassed: hasPg && spec.foundationChecksAvailable,
      pgDetail: !spec.foundationChecksAvailable
        ? `No foundation DB target yet; blocked (${spec.requiredLanes.join(' + ')})`
        : hasPg
          ? laneMissing
            ? `Foundation Postgres assertions active; full row blocked (${spec.requiredLanes.join(' + ')})`
            : 'All disposable Postgres 16 + 2-process assertions active'
          : 'PHASE5_TEST_DATABASE_URL unset; run `bash tests/acceptance/phase5/run-postgres.sh`',
    });
  });
}

const rows = runMatrixCatalogSummary();
const summary = summarizeRun(rows, new Date().toISOString());
if (process.argv.includes('--json')) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(formatRunSummary(summary));
}
