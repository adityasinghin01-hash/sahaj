import type {
  CallRow,
  ConsentPurpose,
  ConsentRow,
  Identity,
  ProviderEvent,
  ProviderStore,
} from '../../apps/api/src/lib/provider-ingestion/gateway';

export interface InMemoryProviderLog {
  ingested: ProviderEvent[];
  uniqueKeys: Set<string>;
}

/**
 * Deterministic in-memory ProviderStore backed by real gateway handlers (`handleTwilioStatus`,
 * `handleTwilioRecording`, `handleSarvam`, `handleTeleCmi`) for unit/contract tests.
 * Disposable Postgres runs bypass this and test real `public.ingest_raw_event` RPC directly.
 */
export function createContractProviderStore(seed: {
  identities?: Array<{ provider: 'sarvam' | 'telecmi'; account: string; digits: string; identity: Identity }>;
  calls?: Array<{ provider: 'twilio' | 'sarvam'; externalId: string; call: CallRow }>;
  sarvamAttempts?: Array<{ appId: string; attemptId: string; identity: Identity }>;
  consents?: ConsentRow[];
}): { store: ProviderStore; log: InMemoryProviderLog } {
  const log: InMemoryProviderLog = {
    ingested: [],
    uniqueKeys: new Set<string>(),
  };

  const store: ProviderStore = {
    async resolveContact(provider, account, digits) {
      const match = seed.identities?.find(
        (i) => i.provider === provider && i.account === account && i.digits === digits,
      );
      return match?.identity ?? null;
    },
    async findCall(provider, externalId) {
      const match = seed.calls?.find((c) => c.provider === provider && c.externalId === externalId);
      return match?.call ?? null;
    },
    async findSarvamAttempt(appId, attemptId) {
      const match = seed.sarvamAttempts?.find((a) => a.appId === appId && a.attemptId === attemptId);
      return match?.identity ?? null;
    },
    async findConsents(familyId, personId, callId, purpose: ConsentPurpose) {
      return (seed.consents ?? []).filter(
        (r) =>
          r.familyId === familyId &&
          r.personId === personId &&
          r.purpose === purpose &&
          (r.callId === callId || (r.callId === null && r.answer === false)),
      );
    },
    async ingest(event) {
      const dedupeKey = `${event.source}:${event.id}`;
      if (log.uniqueKeys.has(dedupeKey)) {
        // Foundation semantics: duplicate signed delivery replays cleanly without inserting a second row.
        return;
      }
      log.uniqueKeys.add(dedupeKey);
      log.ingested.push(event);
    },
  };

  return { store, log };
}
