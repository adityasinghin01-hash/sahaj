import { createSyntheticCore1Fixtures, type SyntheticFamilyFixtures } from '../core1/fixtures';

export interface Core2SyntheticWatchFixture {
  readonly etaMinutes: number;
  readonly graceMinutes: number;
  readonly timezone: 'Asia/Kolkata';
  readonly fromLabel: string;
  readonly toLabel: string;
  readonly cabNote: string;
}

export interface Core2TrustedContactFixture {
  readonly id: string;
  readonly subjectPersonId: string;
  readonly contactPersonId: string;
  readonly familyId: string;
  readonly rank: number;
  readonly scopes: readonly ('sos' | 'watch_escalation' | 'reassurance')[];
  readonly state: 'invited' | 'pending_consent' | 'active' | 'revoked' | 'expired';
  readonly effectiveFromIso: string;
  readonly effectiveUntilIso: string | null;
  readonly revokedAtIso: string | null;
  readonly consentApproved: boolean;
}

export interface Core2SharingPreferencesFixture {
  readonly shareStatusWithParent: boolean;
  readonly allowLocationShare: boolean;
  readonly allowHealthShare: boolean;
  readonly allowNarrativeShare: boolean;
}

export interface SyntheticCore2Suite {
  readonly family: SyntheticFamilyFixtures;
  readonly watch: Core2SyntheticWatchFixture;
  readonly defaultPreferences: Core2SharingPreferencesFixture;
  readonly contacts: {
    readonly sharmaActiveSos: Core2TrustedContactFixture;
    readonly rohitUnconsentedFamilyMember: Core2TrustedContactFixture;
  };
}

export function createSyntheticCore2Fixtures(seedTag = '0002'): SyntheticCore2Suite {
  const family = createSyntheticCore1Fixtures(seedTag);
  return {
    family,
    watch: {
      etaMinutes: 30,
      graceMinutes: 10,
      timezone: 'Asia/Kolkata',
      fromLabel: 'Office, Connaught Place',
      toLabel: 'Home, Lajpat Nagar',
      cabNote: 'Synthetic cab #0000',
    },
    defaultPreferences: {
      shareStatusWithParent: true,
      allowLocationShare: false,
      allowHealthShare: false,
      allowNarrativeShare: false,
    },
    contacts: {
      sharmaActiveSos: {
        id: `40000000-0000-4000-8000-00000001${seedTag.padStart(4, '0').slice(-4)}`,
        subjectPersonId: family.people.riya.id,
        contactPersonId: family.people.sharma.id,
        familyId: family.familyId,
        rank: 1,
        scopes: ['sos', 'watch_escalation', 'reassurance'],
        state: 'active',
        effectiveFromIso: '2026-11-01T00:00:00.000Z',
        effectiveUntilIso: null,
        revokedAtIso: null,
        consentApproved: true,
      },
      rohitUnconsentedFamilyMember: {
        id: `40000000-0000-4000-8000-00000002${seedTag.padStart(4, '0').slice(-4)}`,
        subjectPersonId: family.people.riya.id,
        contactPersonId: family.people.rohit.id,
        familyId: family.familyId,
        rank: 2,
        scopes: ['sos'],
        state: 'pending_consent',
        effectiveFromIso: '2026-11-01T00:00:00.000Z',
        effectiveUntilIso: null,
        revokedAtIso: null,
        consentApproved: false,
      },
    },
  };
}
