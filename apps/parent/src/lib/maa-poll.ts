export const MAA_POLL_MS = 15_000;

type AppStateSource = {
  readonly currentState: string | null | undefined;
  addEventListener: (event: 'change', listener: (state: string) => void) => { remove: () => void };
};

export type MaaRefresh = (isCurrent: () => boolean) => Promise<void>;

/** Keep one request lock across blur/refocus, including requests still settling after cleanup. */
export function createMaaPoller() {
  let inFlight = false;

  return {
    start(load: MaaRefresh, appState: AppStateSource) {
      let stopped = false;
      let foreground = false;
      let generation = 0;
      let initial: ReturnType<typeof setTimeout> | undefined;
      let interval: ReturnType<typeof setInterval> | undefined;

      const refresh = async () => {
        if (stopped || !foreground || inFlight) return;
        inFlight = true;
        const startedIn = generation;
        try {
          await load(() => !stopped && foreground && generation === startedIn);
        } finally {
          inFlight = false;
        }
      };
      // Screens own their error UI; don't leave a rejected timer promise unhandled.
      const tick = () => { void refresh().catch(() => {}); };
      const clearTimers = () => {
        clearTimeout(initial);
        clearInterval(interval);
      };
      const onState = (state: string | null | undefined) => {
        const next = state === 'active';
        if (next === foreground) return;
        foreground = next;
        generation += 1;
        clearTimers();
        if (foreground) {
          initial = setTimeout(tick, 0);
          interval = setInterval(tick, MAA_POLL_MS);
        }
      };
      const subscription = appState.addEventListener('change', onState);
      onState(appState.currentState);

      return {
        refresh,
        stop() {
          stopped = true;
          clearTimers();
          subscription.remove();
        },
      };
    },
  };
}
