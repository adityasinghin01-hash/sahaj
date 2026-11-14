/**
 * Missed-call grouping and family nudge intent generation.
 *
 * Implements:
 * - Domain-separated deduplication binding family, recipient, provider account, and call ID
 * - Prevents cross-family providerCallId collisions from dropping valid events
 * - Stable, deterministic ordering by timestamp and composite key tie-breaking
 * - Strict timestamp and window validation
 * - Injected clock for deterministic deferred scheduling
 * - Three differentiated urgency tiers:
 *     1 call  -> Single (routine)
 *     2 calls -> Repeated (elevated)
 *     3+ calls -> Urgent (urgent family alert)
 * - Absolute prohibition on irreversible actions: emits nudge intents only
 */

import type {
  MissedCallEvent,
  MissedCallNudgeIntent,
  MissedCallTier,
  MissedCallGroupingResult,
  Clock,
} from './types';

export interface GroupMissedCallsOptions {
  /** Grouping window in seconds; defaults to 20 */
  windowSeconds?: number;
  clock: Clock;
}

/**
 * Deduplicates and deterministically orders missed call events.
 * Crucial fix: Deduplication key binds familyId, recipientPersonId, providerAccountId, and providerCallId,
 * ensuring an identical providerCallId in Family A does NOT drop a call in Family B.
 */
export function deduplicateAndOrderCalls(calls: MissedCallEvent[]): MissedCallEvent[] {
  const seenKeys = new Set<string>();
  const unique: MissedCallEvent[] = [];

  for (const call of calls) {
    if (!call.providerCallId || !call.familyId || !call.recipientPersonId) {
      throw new Error('MissedCallEvent missing required identifiers (providerCallId, familyId, or recipientPersonId)');
    }

    const time = new Date(call.timestamp).getTime();
    if (isNaN(time)) {
      throw new Error(`Invalid missed call timestamp: ${call.timestamp}`);
    }

    const account = call.providerAccountId ?? 'default';
    const dedupeKey = `${call.familyId}:${call.recipientPersonId}:${account}:${call.providerCallId}`;

    if (!seenKeys.has(dedupeKey)) {
      seenKeys.add(dedupeKey);
      unique.push(call);
    }
  }

  // Deterministic sort: ascending by timestamp, then familyId, recipient, and providerCallId
  return unique.sort((a, b) => {
    const timeA = new Date(a.timestamp).getTime();
    const timeB = new Date(b.timestamp).getTime();
    if (timeA !== timeB) {
      return timeA - timeB;
    }
    const famComp = a.familyId.localeCompare(b.familyId);
    if (famComp !== 0) return famComp;
    const recipComp = a.recipientPersonId.localeCompare(b.recipientPersonId);
    if (recipComp !== 0) return recipComp;
    return a.providerCallId.localeCompare(b.providerCallId);
  });
}

function partitionByCallerAndFamily(calls: MissedCallEvent[]): Map<string, MissedCallEvent[]> {
  const map = new Map<string, MissedCallEvent[]>();
  for (const call of calls) {
    const key = `${call.familyId}::${call.callerPersonId}::${call.recipientPersonId}`;
    let list = map.get(key);
    if (!list) {
      list = [];
      map.set(key, list);
    }
    list.push(call);
  }
  return map;
}

/**
 * Groups raw missed call events into differentiated family nudge intents.
 *
 * Guarantee: No irreversible side effects are performed. Outputs intent descriptors only.
 */
export function groupMissedCalls(
  rawCalls: MissedCallEvent[],
  options: GroupMissedCallsOptions
): MissedCallGroupingResult {
  const windowSeconds = options.windowSeconds ?? 20;
  if (typeof windowSeconds !== 'number' || windowSeconds <= 0 || !Number.isFinite(windowSeconds)) {
    throw new Error(`Invalid windowSeconds: ${windowSeconds}`);
  }
  const windowMs = windowSeconds * 1000;

  const dedupedAndOrdered = deduplicateAndOrderCalls(rawCalls);
  const partitioned = partitionByCallerAndFamily(dedupedAndOrdered);
  const clusters: MissedCallNudgeIntent[] = [];

  for (const [_partitionKey, calls] of partitioned) {
    if (!calls.length) continue;

    let currentClusterCalls: MissedCallEvent[] = [];
    let clusterStartTimeMs = 0;

    for (const call of calls) {
      const callTimeMs = new Date(call.timestamp).getTime();

      if (currentClusterCalls.length === 0) {
        currentClusterCalls.push(call);
        clusterStartTimeMs = callTimeMs;
      } else if (callTimeMs - clusterStartTimeMs <= windowMs) {
        currentClusterCalls.push(call);
      } else {
        // Finalize previous cluster
        clusters.push(createNudgeIntent(currentClusterCalls, options.clock));
        // Start new cluster
        currentClusterCalls = [call];
        clusterStartTimeMs = callTimeMs;
      }
    }

    if (currentClusterCalls.length > 0) {
      clusters.push(createNudgeIntent(currentClusterCalls, options.clock));
    }
  }

  // Sort clusters deterministically by window start time
  clusters.sort((a, b) => new Date(a.windowStart).getTime() - new Date(b.windowStart).getTime());

  return {
    clusters,
    dedupedCount: dedupedAndOrdered.length,
    rawEventCount: rawCalls.length,
  };
}

function createNudgeIntent(calls: MissedCallEvent[], clock: Clock): MissedCallNudgeIntent {
  const first = calls[0];
  const last = calls[calls.length - 1];
  const count = calls.length;

  let tier: MissedCallTier;
  let kind: 'missed_call_single' | 'missed_call_repeated' | 'missed_call_urgent';
  let urgency: 'routine' | 'elevated' | 'urgent';

  if (count === 1) {
    tier = 'single';
    kind = 'missed_call_single';
    urgency = 'routine';
  } else if (count === 2) {
    tier = 'repeated';
    kind = 'missed_call_repeated';
    urgency = 'elevated';
  } else {
    // 3 or more calls
    tier = 'urgent';
    kind = 'missed_call_urgent';
    urgency = 'urgent';
  }

  return {
    familyId: first.familyId,
    callerPersonId: first.callerPersonId,
    recipientPersonId: first.recipientPersonId,
    tier,
    callCount: count,
    windowStart: first.timestamp,
    windowEnd: last.timestamp,
    callIds: calls.map(c => c.providerCallId),
    proposedNudge: {
      kind,
      urgency,
      scheduledAt: clock.nowIso(),
    },
  };
}
