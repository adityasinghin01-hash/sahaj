import * as React from 'react';
import { useFocusEffect } from 'expo-router';
import { AppState, Platform } from 'react-native';
import { createApi, ApiError, type AppApi } from './api';
import { useSession } from './session';
import type { AppAlert } from '@sahaj/shared';

export function useApi() {
  const { session } = useSession();
  return React.useMemo(() => (session ? createApi(session) : null), [session]);
}
type LiveLoader<T> = ((api: AppApi, signal: AbortSignal) => Promise<T>) & { reset?: () => void };
export function useLive<T>(load: LiveLoader<T>) {
  const api = useApi();
  const [state, setState] = React.useState<{
    data: T | null;
    error: string | null;
    updated: number;
  }>({ data: null, error: null, updated: 0 });
  const [revision, refresh] = React.useReducer((n) => n + 1, 0);
  useFocusEffect(
    React.useCallback(() => {
      let stopped = false,
        timer: ReturnType<typeof setTimeout> | undefined,
        controller: AbortController | undefined,
        failures = 0;
      const active = () =>
        AppState.currentState !== 'background' &&
        (Platform.OS !== 'web' || typeof document === 'undefined' || !document.hidden);
      load.reset?.();
      setState({ data: null, error: null, updated: 0 });
      async function poll() {
        if (stopped || !api) return;
        if (active()) {
          controller = new AbortController();
          const timeout = setTimeout(() => controller?.abort(), 12000);
          try {
            const data = await load(api, controller.signal);
            failures = 0;
            if (!stopped) setState({ data, error: null, updated: Date.now() });
          } catch (error) {
            failures++;
            if (!stopped)
              setState((prev) => ({
                ...prev,
                error:
                  error instanceof ApiError && error.status === 401
                    ? 'Session expired. Sign in again.'
                    : error instanceof Error
                      ? error.message
                      : 'Connection failed.',
              }));
          } finally {
            clearTimeout(timeout);
          }
        }
        if (!stopped) timer = setTimeout(poll, Math.min(30000, 3000 * 2 ** Math.min(failures, 4)));
      }
      void poll();
      return () => {
        stopped = true;
        clearTimeout(timer);
        controller?.abort();
      };
    }, [api, load, revision])
  );
  return { ...state, refresh };
}
export function useLiveAlerts() {
  const { session } = useSession();
  // Each focus starts from a fresh snapshot; later polls merge only actual live verdicts.
  const loader = React.useMemo(() => {
    let cursor: string | undefined,
      rows: AppAlert[] = [];
    const load = async (api: AppApi, signal: AbortSignal) => {
      const result = await api.alerts(cursor, signal);
      cursor = result.next_cursor ?? cursor;
      const merged = new Map(rows.map((r) => [r.id, r]));
      result.alerts.forEach((r) => merged.set(r.id, r));
      rows = [...merged.values()]
        .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id))
        .slice(0, 300);
      return rows;
    };
    return Object.assign(load, {
      reset: () => {
        cursor = undefined;
        rows = [];
      },
    });
  }, [session]);
  return useLive(loader);
}
