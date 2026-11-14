import type { EvidenceLevel, MatrixRowResult, ScenarioStatus } from './types';

export interface LevelSummary {
  evidenceLevel: EvidenceLevel;
  passed: number;
  failed: number;
  blocked: number;
  skipped: number;
}

export interface Phase5RunSummary {
  generatedAtIso: string;
  totalRows: number;
  levels: [LevelSummary, LevelSummary, LevelSummary];
  rows: readonly MatrixRowResult[];
}

function tallyLevel(
  rows: readonly MatrixRowResult[],
  level: EvidenceLevel,
): LevelSummary {
  const counts: LevelSummary = {
    evidenceLevel: level,
    passed: 0,
    failed: 0,
    blocked: 0,
    skipped: 0,
  };
  for (const row of rows) {
    const status: ScenarioStatus =
      level === 'unit/contract'
        ? row.levels.unitContract.status
        : level === 'disposable_integrated'
          ? row.levels.disposableIntegrated.status
          : row.levels.live.status;
    counts[status] += 1;
  }
  return counts;
}

export function summarizeRun(
  rows: readonly MatrixRowResult[],
  generatedAtIso = new Date().toISOString(),
): Phase5RunSummary {
  return {
    generatedAtIso,
    totalRows: rows.length,
    levels: [
      tallyLevel(rows, 'unit/contract'),
      tallyLevel(rows, 'disposable_integrated'),
      tallyLevel(rows, 'live'),
    ],
    rows,
  };
}

/**
 * Formats three separate evidence levels + per-row counts and blocking reasons.
 * Intentionally emits exact scenario counts and never prints percentages.
 */
export function formatRunSummary(summary: Phase5RunSummary): string {
  const lines: string[] = [];
  lines.push(`# Phase 5 Integrated Acceptance Harness Summary (${summary.generatedAtIso})`);
  lines.push(`Rows: ${summary.totalRows}`);
  lines.push('');
  lines.push('## Evidence Levels');
  for (const lvl of summary.levels) {
    lines.push(
      `- ${lvl.evidenceLevel}: passed=${lvl.passed}, failed=${lvl.failed}, blocked=${lvl.blocked}, skipped=${lvl.skipped}`,
    );
  }
  lines.push('');
  lines.push('## Matrix Rows');
  for (const row of summary.rows) {
    const blocker = row.blockedBy.length > 0 ? ` | needs: ${row.blockedBy.join(', ')}` : '';
    const reason = row.blockReason ? ` | reason: ${row.blockReason}` : '';
    lines.push(
      `- [${row.rowId}] ${row.title} => overall=${row.overallStatus}${blocker}${reason}`,
    );
    lines.push(
      `    unit/contract=${row.levels.unitContract.status} (${row.levels.unitContract.detail})`,
    );
    lines.push(
      `    disposable_integrated=${row.levels.disposableIntegrated.status} (${row.levels.disposableIntegrated.detail})`,
    );
    lines.push(`    live=${row.levels.live.status} (${row.levels.live.detail})`);
  }
  return lines.join('\n');
}
