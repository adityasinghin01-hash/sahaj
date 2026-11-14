import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMaaPoller, MAA_POLL_MS } from './maa-poll';

function fakeAppState(currentState: string | null | undefined = 'active') {
  let listener: ((state: string) => void) | undefined;
  const remove = vi.fn(() => { listener = undefined; });
  return {
    currentState,
    addEventListener: vi.fn((_event: 'change', next: (state: string) => void) => {
      listener = next;
      return { remove };
    }),
    change(state: string) { listener?.(state); },
    remove,
  };
}

describe('Maa focused foreground polling', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('refreshes on focus, then every 15 seconds', async () => {
    const load = vi.fn(async () => {});
    const session = createMaaPoller().start(load, fakeAppState());
    await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(MAA_POLL_MS - 1);
    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(load).toHaveBeenCalledTimes(2);
    session.stop();
  });

  it.each(['background', 'inactive', null])('does not fetch in %s, resumes immediately when active', async (state) => {
    const app = fakeAppState(state);
    const load = vi.fn(async () => {});
    const session = createMaaPoller().start(load, app);
    await vi.advanceTimersByTimeAsync(30_000);
    await session.refresh();
    expect(load).not.toHaveBeenCalled();
    app.change('active');
    await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(1);
    app.change('background');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(load).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    session.stop();
  });

  it('removes timers and AppState listener on blur/unmount', async () => {
    const app = fakeAppState();
    const load = vi.fn(async () => {});
    const session = createMaaPoller().start(load, app);
    session.stop();
    await vi.advanceTimersByTimeAsync(30_000);
    await session.refresh();
    expect(load).not.toHaveBeenCalled();
    expect(app.remove).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('skips ticks and retries in flight, including after blur/refocus', async () => {
    let finish!: () => void;
    let isCurrent!: () => boolean;
    const load = vi.fn((check: () => boolean) => {
      isCurrent = check;
      return new Promise<void>((resolve) => { finish = resolve; });
    });
    const poller = createMaaPoller();
    const first = poller.start(load, fakeAppState());
    await vi.advanceTimersByTimeAsync(0);
    expect(isCurrent()).toBe(true);
    await vi.advanceTimersByTimeAsync(30_000);
    await first.refresh();
    expect(load).toHaveBeenCalledTimes(1);
    first.stop();
    expect(isCurrent()).toBe(false);
    const second = poller.start(load, fakeAppState());
    await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(1);
    finish();
    await vi.advanceTimersByTimeAsync(MAA_POLL_MS);
    expect(load).toHaveBeenCalledTimes(2);
    second.stop();
    finish();
  });

  it('discards a response begun before backgrounding, even after resuming', async () => {
    const app = fakeAppState();
    let finish!: () => void;
    let isCurrent!: () => boolean;
    const session = createMaaPoller().start((check) => {
      isCurrent = check;
      return new Promise<void>((resolve) => { finish = resolve; });
    }, app);
    await vi.advanceTimersByTimeAsync(0);
    app.change('background');
    app.change('active');
    expect(isCurrent()).toBe(false);
    session.stop();
    finish();
  });

  it('releases the request lock after a failed refresh', async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
    const session = createMaaPoller().start(load, fakeAppState());
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(MAA_POLL_MS);
    expect(load).toHaveBeenCalledTimes(2);
    session.stop();
  });
});
