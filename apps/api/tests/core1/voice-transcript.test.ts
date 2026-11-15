import { describe, expect, it, vi } from 'vitest';
import { keypadVoiceTranscript, type KeypadTranscriptDeps } from '../../src/lib/core1/voice-transcript';
import { voiceNoteLine } from '../../src/lib/core1/sarvam-calls';

const FAM = '11111111-1111-4111-8111-111111111111';
const env = { CALL_PROVIDER: 'sarvam', SARVAM_API_KEY: 'k' };
function deps(device: 'keypad' | 'smartphone', text = 'Maa main shaam ko aaungi, khana kha lena'): KeypadTranscriptDeps & { transcribe: ReturnType<typeof vi.fn> } {
  return {
    getPerson: async () => ({ id: 'p', familyId: FAM, displayName: 'Meena', device, language: 'hi' }),
    download: async () => ({ bytes: new Uint8Array([1, 2, 3]), contentType: 'audio/mp4' }),
    transcribe: vi.fn(async () => text),
  };
}
const input = { familyId: FAM, recipientId: 'p', objectPath: `${FAM}/voice/abc.m4a` };

describe('keypad voice note transcript (Saaras)', () => {
  it('transcribes only for a keypad recipient on the Sarvam path, and the call line says it is an AI transcript', async () => {
    const t = await keypadVoiceTranscript(deps('keypad'), input, env);
    expect(t).toBe('Maa main shaam ko aaungi, khana kha lena');
    expect(voiceNoteLine('Riya', t)).toContain('Riya ka sandesh: Maa main shaam ko aaungi');
    expect(voiceNoteLine('Riya', t)).toContain('AI');
  });
  it('never transcribes for a smartphone, Twilio, missing key, foreign path; failures fall back to null', async () => {
    const sm = deps('smartphone');
    expect(await keypadVoiceTranscript(sm, input, env)).toBeNull();
    expect(sm.transcribe).not.toHaveBeenCalled();
    expect(await keypadVoiceTranscript(deps('keypad'), input, { CALL_PROVIDER: 'twilio', SARVAM_API_KEY: 'k' })).toBeNull();
    expect(await keypadVoiceTranscript(deps('keypad'), input, { CALL_PROVIDER: 'sarvam' })).toBeNull();
    expect(await keypadVoiceTranscript(deps('keypad'), { ...input, objectPath: 'other-family/voice/x.m4a' }, env)).toBeNull();
    const broken = deps('keypad'); broken.transcribe.mockRejectedValueOnce(new Error('503'));
    expect(await keypadVoiceTranscript(broken, input, env)).toBeNull();
    expect(voiceNoteLine('Riya', null)).toContain('awaaz bheji hai');
  });
});
