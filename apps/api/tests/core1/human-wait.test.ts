import { describe, expect, it } from 'vitest';
import { humanWaitSeconds } from '../../src/lib/core1/push-notify';
import { humanWaitMs } from '../../src/lib/core2/security';

describe('human wait floor under DEMO_TIMER_SCALE', () => {
  it('urgent offer: 3 min at scale 60 becomes 90 s, not 3 s', () => {
    expect(humanWaitSeconds(3, 60, {})).toBe(90);
    expect(humanWaitSeconds(3, 60, { DEMO_HUMAN_WAIT_SECONDS: '45' })).toBe(45);
  });
  it('production (scale 1) keeps the base; floor never exceeds the base', () => {
    expect(humanWaitSeconds(3, 1, {})).toBe(180);
    expect(humanWaitSeconds(1, 60, {})).toBe(60);
    expect(humanWaitSeconds(3, 2, {})).toBe(90);
  });
  it('proof challenge: 60 s at scale 60 stays 60 s; scale 1 unchanged', () => {
    expect(humanWaitMs(60_000, { DEMO_TIMER_SCALE: '60' })).toBe(60_000);
    expect(humanWaitMs(60_000, {})).toBe(60_000);
    expect(humanWaitMs(600_000, { DEMO_TIMER_SCALE: '60' })).toBe(90_000);
  });
});
