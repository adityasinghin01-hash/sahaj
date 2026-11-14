import { useFocusEffect } from 'expo-router';
import * as React from 'react';
import { AppState } from 'react-native';

import { createMaaPoller, type MaaRefresh } from './maa-poll';

export function useMaaPoll(load: MaaRefresh) {
  const [poller] = React.useState(createMaaPoller);
  const current = React.useRef<ReturnType<typeof poller.start> | null>(null);

  useFocusEffect(React.useCallback(() => {
    const session = poller.start(load, AppState);
    current.current = session;
    return () => {
      session.stop();
      current.current = null;
    };
  }, [load, poller]));

  return React.useCallback(() => current.current?.refresh(), []);
}
