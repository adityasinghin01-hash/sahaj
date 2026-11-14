import * as React from 'react';
import { Platform } from 'react-native';

export interface Session {
  url: string;
  token: string;
}
type State = { ready: boolean; session: Session | null };
const KEY = 'sahaj.lab.session.v1';
let state: State = { ready: false, session: null };
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((fn) => fn());
export function initializeSession() {
  if (state.ready) return;
  let session: Session | null = null;
  try {
    // expo-secure-store is not installed: do not add a native dependency or persist native tokens insecurely.
    if (Platform.OS === 'web' && typeof localStorage !== 'undefined') {
      const parsed = JSON.parse(localStorage.getItem(KEY) ?? 'null');
      if (parsed && typeof parsed.url === 'string' && typeof parsed.token === 'string')
        session = validateLabSession(parsed);
    }
  } catch {
    /* Storage denied, corrupt, or unavailable: use labelled demo. */
  }
  state = { ready: true, session };
  notify();
}
export function validateLabSession(input: Session): Session {
  const url = new URL(input.url.trim());
  if (
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
  )
    throw new Error('Use HTTPS, or HTTP on localhost for the lab.');
  if (url.username || url.password || url.search || url.hash)
    throw new Error('Enter the server origin only.');
  const token = input.token.trim();
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token))
    throw new Error('Paste an access token from the lab mint script.');
  return { url: url.origin, token };
}
export function saveSession(input: Session | null) {
  const session = input ? validateLabSession(input) : null;
  try {
    if (Platform.OS === 'web' && typeof localStorage !== 'undefined') {
      if (session) localStorage.setItem(KEY, JSON.stringify(session));
      else localStorage.removeItem(KEY);
    }
  } catch {
    /* The current session remains usable in memory. */
  }
  state = { ready: true, session };
  notify();
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
  React.useEffect(initializeSession, []);
  return snapshot;
}
