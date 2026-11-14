import { describe, expect, it } from 'vitest';
import {
  buildRecordedVoiceRelayTwiml,
  buildRecordingConsentTwiml,
  buildReplyRecordingTwiml,
} from '../../../packages/adapters/src/twilio';
import { AI_DISCLOSURE } from '../../../packages/adapters/src/audio';
import { AdapterError } from '../../../packages/adapters/src/contracts';
import { createSyntheticCore1Fixtures } from '../../../harness/core1';
import { PHASE5_ACCEPTANCE_MATRIX, evaluateMatrixStatus } from './matrix';

describe('Matrix Row 07: Core 1 voice', () => {
  const rowSpec = PHASE5_ACCEPTANCE_MATRIX.find((r) => r.rowId === '07')!;

  it('unit/contract: voice relay includes AI disclosure + real recording consent, and refuses <Record> when unconsented', () => {
    const fam = createSyntheticCore1Fixtures('0007');
    const consent = {
      personId: fam.people.maa.id,
      recordingId: 'rec-synth-01',
      granted: true,
    };

    const relayTwiml = buildRecordedVoiceRelayTwiml({
      recordingUrl: 'https://media.synthetic.test/family/voice-01.mp3',
      allowedRecordingHosts: ['media.synthetic.test'],
      consent,
      personId: fam.people.maa.id,
      recordingId: 'rec-synth-01',
      actionUrl: 'https://api.synthetic.test/api/voice/gather',
      promptHindi: 'जवाब देने के लिए 1 दबाएँ',
    });
    expect(relayTwiml).toContain(AI_DISCLOSURE.Hindi);
    expect(relayTwiml).toContain('<Play>https://media.synthetic.test/family/voice-01.mp3</Play>');

    // Missing consent fails closed before generating relay TwiML.
    expect(() =>
      buildRecordedVoiceRelayTwiml({
        recordingUrl: 'https://media.synthetic.test/family/voice-01.mp3',
        allowedRecordingHosts: ['media.synthetic.test'],
        consent: { ...consent, granted: false },
        personId: fam.people.maa.id,
        recordingId: 'rec-synth-01',
        actionUrl: 'https://api.synthetic.test/api/voice/gather',
        promptHindi: 'जवाब दें',
      }),
    ).toThrowError(AdapterError);

    const askConsentTwiml = buildRecordingConsentTwiml('https://api.synthetic.test/api/voice/consent');
    expect(askConsentTwiml).toContain(AI_DISCLOSURE.Hindi);
    expect(askConsentTwiml).not.toContain('<Record');

    const refusedRecordTwiml = buildReplyRecordingTwiml(
      { choice: 'no', via: 'dtmf', confidence: null },
      'https://api.synthetic.test/api/voice/recording-status',
    );
    expect(refusedRecordTwiml).not.toContain('<Record');

    const consentedRecordTwiml = buildReplyRecordingTwiml(
      { choice: 'yes', via: 'dtmf', confidence: null },
      'https://api.synthetic.test/api/voice/recording-status',
    );
    expect(consentedRecordTwiml).toContain('<Record');
  });

  it('matrix status: remains blocked pending Core 1 voice endpoints & Phase 2 media pipeline', () => {
    const result = evaluateMatrixStatus(rowSpec, {
      unitPassed: true,
      unitDetail: 'Twilio relay + consent TwiML builders enforce AI disclosure & consent before <Record>',
      pgExecuted: false,
      pgPassed: false,
      pgDetail: 'Full voice_posts + sahaj_private storage flow blocked on agy-phase4 (core1) + kiro-a',
    });
    expect(result.overallStatus).toBe('blocked');
  });
});
