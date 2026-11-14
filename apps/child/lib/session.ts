import * as React from 'react';
import { Platform } from 'react-native';

export interface Session {
  url: string;
  token: string;
  /** Required by Core 2 for accounts with multiple active families. */
  familyId?: string;
}
type State = { ready: boolean; session: Session | null; storage: 'memory' | 'secure' | 'browser' };
const KEY = 'sahaj.lab.session.v1';
export const DEFAULT_SERVER_URL = process.env.EXPO_PUBLIC_SAHAJ_API_URL ?? '';
let state: State = { ready: false, session: null, storage: 'memory' };
let initializing: Promise<void> | undefined;
let revision = 0;
let writes = Promise.resolve();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((fn) => fn());
async function nativeStore() {
  const store = await import('expo-secure-store');
  return (await store.isAvailableAsync()) ? store : null;
}
export function initializeSession(): Promise<void> {
  if (state.ready) return Promise.resolve();
  if (initializing) return initializing;
  const startedAt = revision;
  initializing = (async () => {
    let session: Session | null = null;
    let storage: State['storage'] = 'memory';
    try {
      let raw: string | null = null;
      if (Platform.OS === 'web' && typeof localStorage !== 'undefined') {
        raw = localStorage.getItem(KEY);
        storage = 'browser';
      } else if (Platform.OS !== 'web') {
        const store = await nativeStore();
        if (store) {
          raw = await store.getItemAsync(KEY);
          storage = 'secure';
        }
      }
      const parsed = JSON.parse(raw ?? 'null');
      if (parsed && typeof parsed.url === 'string' && typeof parsed.token === 'string')
        session = validateLabSession(parsed);
    } catch {
      // Denied/corrupt/unavailable storage: keep the session in memory only.
    }
    if (revision === startedAt) {
      state = { ready: true, session, storage };
      notify();
    }
  })();
  return initializing;
}
export function validateLabSession(input: Session): Session {
  const url = new URL(input.url.trim());
  if (
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
  )
    throw new Error('Use HTTPS, or HTTP on localhost for the lab.');
  if (url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname))
    throw new Error('Enter the server origin only.');
  const token = input.token.trim();
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token))
    throw new Error('Paste an access token from the lab mint script.');
  const familyId = input.familyId?.trim();
  if (familyId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(familyId))
    throw new Error('Enter a valid family UUID.');
  return { url: url.origin, token, ...(familyId ? { familyId } : {}) };
}
export function saveSession(input: Session | null): Promise<void> {
  const session = input ? validateLabSession(input) : null;
  const savedAt = ++revision;
  state = { ...state, ready: true, session };
  notify();
  // Serialize writes so a slow save cannot resurrect a signed-out session.
  writes = writes.then(async () => {
    let storage: State['storage'] = 'memory';
    try {
      if (Platform.OS === 'web' && typeof localStorage !== 'undefined') {
        if (session) localStorage.setItem(KEY, JSON.stringify(session));
        else localStorage.removeItem(KEY);
        storage = 'browser';
      } else if (Platform.OS !== 'web') {
        const store = await nativeStore();
        if (store) {
          if (session) await store.setItemAsync(KEY, JSON.stringify(session));
          else await store.deleteItemAsync(KEY);
          storage = 'secure';
        }
      }
    } catch {
      // No insecure native disk fallback. Never log the session or token.
    }
    if (revision === savedAt) {
      state = { ...state, storage };
      notify();
    }
  });
  return writes;
}
export function useSession() {
  const snapshot = React.useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    () => state,
    () => state
  );
  React.useEffect(() => {
    void initializeSession();
  }, []);
  return snapshot;
}
