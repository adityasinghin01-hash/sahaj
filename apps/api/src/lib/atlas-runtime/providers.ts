import type { ProviderBridge } from "./bridge";

/**
 * The single seam where Phase 2 provider entrypoints are attached. This branch does not contain Phase 2 source, so it
 * returns an empty bridge: dispatch, status normalization and recording retrieval report `unavailable` and their queued
 * work waits. It never fabricates a result.
 *
 * Integration (after the Phase 2 branch is merged), constructed from injected configuration, never from this module's
 * own environment reads:
 *
 *   const store = dispatchStore();                       // provider-dispatch/supabase-store
 *   return {
 *     normalize: input => normalizeDeliveryOutcome(store, input),
 *     dispatch: cmd => dispatchOutbound({ store, authorize: createDispatchAuthorizer(db), resolveDestination, transport,
 *                                         identitySecret, providers }, cmd),
 *     sweepStale: () => sweepStaleClaims(store),
 *     recording: async i => processRecordingEvent(recordingDeps, (await readRawEvent(db, i.eventId))!),
 *   };
 *
 * Each entry stays omitted when its configuration (provider credentials, transport, contact decryption) is missing.
 */
export function buildProviderBridge(): ProviderBridge {
  return {};
}
