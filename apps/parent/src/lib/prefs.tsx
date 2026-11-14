// Language and text size persist locally; no account or server is required.
import * as React from 'react';
import { Platform } from 'react-native';

import type { Bi, Lang } from '@/lib/demo';
import { STRINGS, type StringKey } from '@/lib/strings';
import { shield } from '@/lib/shield';

export type TextSize = 'large' | 'xlarge';

type Prefs = {
  lang: Lang;
  setLang: (l: Lang) => void;
  size: TextSize;
  setSize: (s: TextSize) => void;
  /** 1 for Large, 1.2 for Extra large. */
  scale: number;
};

const PrefsContext = React.createContext<Prefs>({
  lang: 'en',
  setLang: () => {},
  size: 'large',
  setSize: () => {},
  scale: 1,
});

export function PrefsProvider({ children }: { children: React.ReactNode }) {
  const [saved] = React.useState(() => {
    try {
      const value = Platform.OS === 'web'
        ? JSON.parse(globalThis.localStorage?.getItem('sahaj-maa-display') ?? '{}')
        : shield.getUiPreferences();
      return { lang: value?.lang === 'hi' ? 'hi' as const : 'en' as const,
        size: value?.size === 'xlarge' ? 'xlarge' as const : 'large' as const };
    } catch {
      return { lang: 'en' as const, size: 'large' as const };
    }
  });
  const [lang, setLang] = React.useState<Lang>(saved.lang);
  const [size, setSize] = React.useState<TextSize>(saved.size);
  React.useEffect(() => {
    try {
      if (Platform.OS === 'web') globalThis.localStorage?.setItem('sahaj-maa-display', JSON.stringify({ lang, size }));
      else shield.setUiPreferences(lang, size);
    } catch {
      // Display settings still apply when local storage is unavailable.
    }
  }, [lang, size]);
  const value = React.useMemo(
    () => ({ lang, setLang, size, setSize, scale: size === 'xlarge' ? 1.2 : 1 }),
    [lang, size]
  );
  return <PrefsContext.Provider value={value}>{children}</PrefsContext.Provider>;
}

export function usePrefs() {
  return React.useContext(PrefsContext);
}

/** t('key') for app strings, pick({en, hi}) for demo data. */
export function useT() {
  const { lang } = usePrefs();
  return React.useMemo(() => {
    const table = STRINGS[lang];
    const t = (key: StringKey, vars?: Record<string, string | number>) => {
      let s = table[key];
      if (vars) for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, String(v));
      return s;
    };
    const pick = (b: Bi) => b[lang];
    return { t, pick, lang };
  }, [lang]);
}
