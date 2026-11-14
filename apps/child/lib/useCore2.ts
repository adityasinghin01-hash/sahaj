import * as React from 'react';
import { AppState, Platform } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { Core2Error, createCore2, newCore2Key, type Core2Api } from './core2';
import { useSession } from './session';

export function useCore2Api() {
  const { session } = useSession();
  return React.useMemo(() => (session ? createCore2(session) : null), [session]);
}
/** Focus-scoped polling, cancelled on family/session changes; no demo fallback. */
export function useCore2Read<T>(load: (api: Core2Api, signal: AbortSignal) => Promise<T>) {
  const api = useCore2Api();
  const [snapshot, set] = React.useState<{
    api: Core2Api | null;
    load: typeof load;
    data: T | null;
    error: unknown;
  }>({
    api,
    load,
    data: null,
    error: null,
  });
  const [revision, refresh] = React.useReducer((n) => n + 1, 0);
  useFocusEffect(
    React.useCallback(() => {
      let stopped = false;
      let controller: AbortController | undefined;
      let timer: ReturnType<typeof setTimeout>;
      set({ api, load, data: null, error: null });
      async function poll() {
        if (stopped || !api) return;
        if (
          AppState.currentState !== 'background' &&
          (Platform.OS !== 'web' || typeof document === 'undefined' || !document.hidden)
        ) {
          controller = new AbortController();
          const timeout = setTimeout(() => controller?.abort(), 12000);
          try {
            const data = await load(api, controller.signal);
            if (!stopped) set({ api, load, data, error: null });
          } catch (error) {
            if (!stopped) set((prev) => ({ ...prev, error }));
          } finally {
            clearTimeout(timeout);
          }
        }
        if (!stopped) timer = setTimeout(poll, 4000);
      }
      void poll();
      return () => {
        stopped = true;
        clearTimeout(timer);
        controller?.abort();
      };
    }, [api, load, revision])
  );
  return {
    data: snapshot.api === api && snapshot.load === load ? snapshot.data : null,
    error: snapshot.api === api && snapshot.load === load ? snapshot.error : null,
    refresh,
  };
}
/** A retry reuses the captured payload AND key. A new action gets a new key. */
export function useCore2Mutation() {
  const api = useCore2Api();
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<unknown>(null);
  const [success, setSuccess] = React.useState(false);
  const locked = React.useRef(false);
  const retryJob = React.useRef<(() => Promise<void>) | null>(null);
  const identity = React.useRef(api);
  identity.current = api;
  React.useEffect(() => {
    identity.current = api;
    return () => {
      identity.current = null;
    };
  }, [api]);
  const run = async <T>(
    job: (api: Core2Api, key: string) => Promise<T>,
    done: (value: T) => void
  ) => {
    if (!api || locked.current || retryJob.current) return;
    const key = newCore2Key();
    const attempt = async () => {
      if (locked.current || identity.current !== api) return;
      locked.current = true;
      setPending(true);
      setError(null);
      setSuccess(false);
      try {
        const value = await job(api, key);
        if (identity.current === api) {
          done(value);
          retryJob.current = null;
          setSuccess(true);
        }
      } catch (e) {
        if (identity.current === api) {
          setError(e);
          retryJob.current = attempt;
        }
      } finally {
        locked.current = false;
        if (identity.current === api) setPending(false);
      }
    };
    await attempt();
  };
  const canEdit =
    !!error &&
    ((error instanceof Core2Error && [400, 401, 403, 404, 409, 410, 422].includes(error.status)) ||
      (error instanceof Error && error.name === 'ZodError'));
  return {
    pending,
    blocked: pending || !!error,
    error,
    success,
    run,
    canEdit,
    edit: () => {
      if (canEdit) {
        retryJob.current = null;
        setError(null);
        setSuccess(false);
      }
    },
    retry: () => {
      void retryJob.current?.();
    },
  };
}
