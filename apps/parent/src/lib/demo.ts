// Demo family for Maa's phone (synthetic). Screens read only from here; later this file is
// swapped for real data with the same shapes. Same family as apps/child/lib/demo.ts.

export type Level = 'green' | 'yellow' | 'red';
export type Lang = 'en' | 'hi';
export type Bi = Record<Lang, string>;

export const family = {
  maa: { name: 'Meena', called: { en: 'Meena ji', hi: 'मीना जी' } as Bi },
  riya: {
    name: { en: 'Riya', hi: 'रिया' } as Bi,
    city: 'Bengaluru',
    // Demo number. A paired phone uses the number Riya entered during pairing.
    phone: process.env.EXPO_PUBLIC_SAHAJ_CHILD_NUMBER ?? '',
  },
  helper: {
    name: { en: 'Sharma uncle', hi: 'शर्मा अंकल' } as Bi,
    minutesAway: 3,
    phone: process.env.EXPO_PUBLIC_SAHAJ_HELPER_NUMBER ?? '',
  },
};

/** Latest voice message from Riya (0:08). Audio is simulated until real clips are wired. */
export const latestVoice = {
  seconds: 8,
  seed: 11,
  sentAt: { en: 'Today, 10:30 AM', hi: 'आज, सुबह 10:30' } as Bi,
  quote: {
    en: '“Maa, I reached office. I will call you at lunch.”',
    hi: '“माँ, मैं ऑफ़िस पहुँच गई। लंच में फ़ोन करूँगी।”',
  } as Bi,
};

/** One calm line about Riya. Never a map, never a location. */
export const riyaStatus = {
  level: 'green' as Level,
  line: { en: 'Riya is at work. She is fine.', hi: 'रिया ऑफ़िस में है। वो ठीक है।' } as Bi,
  updated: { en: 'Updated 20 minutes ago', hi: '20 मिनट पहले' } as Bi,
};

/** Demo reply from Aasha after "Talk to Aasha". */
export const aashaReply = {
  en: 'Namaste Meena ji. Riya is fine. Your BP tablet is at 8 PM.',
  hi: 'नमस्ते मीना जी। रिया ठीक है। BP की गोली रात 8 बजे है।',
} as Bi;

/** What Shield protects (Home chip → list). */
export type ProtectionIcon = 'sms' | 'call' | 'link' | 'app' | 'video' | 'bank' | 'long' | 'pause' | 'verified';

export const protections: { id: string; icon: ProtectionIcon; title: Bi; sub: Bi }[] = [
  { id: 'sms', icon: 'sms', title: { en: 'Fraud SMS', hi: 'फ्रॉड SMS' }, sub: { en: 'Warns you before you reply', hi: 'जवाब से पहले चेतावनी' } },
  { id: 'call', icon: 'call', title: { en: 'Unknown calls', hi: 'अनजान कॉल' }, sub: { en: 'Checks calls from new numbers', hi: 'नए नंबर की कॉल जाँचता है' } },
  { id: 'link', icon: 'link', title: { en: 'Fake bank links', hi: 'नकली बैंक लिंक' }, sub: { en: 'KYC, refund, prize tricks', hi: 'KYC, रिफ़ंड, इनाम के झाँसे' } },
  { id: 'app', icon: 'app', title: { en: 'Risky apps', hi: 'ख़तरनाक ऐप' }, sub: { en: 'Screen-sharing and .apk files', hi: 'स्क्रीन-शेयर और .apk फ़ाइलें' } },
  { id: 'video', icon: 'video', title: { en: 'Fake police calls', hi: 'नकली पुलिस कॉल' }, sub: { en: 'Long video calls from strangers', hi: 'अनजान लोगों की लंबी वीडियो कॉल' } },
  { id: 'bank_app', icon: 'bank', title: { en: 'Bank app on a call', hi: 'कॉल पर बैंक ऐप' }, sub: { en: 'Stranger on the call + UPI app', hi: 'अनजान कॉल + UPI ऐप' } },
  { id: 'long_call', icon: 'long', title: { en: 'Very long calls', hi: 'बहुत लंबी कॉल' }, sub: { en: 'Unknown number, much longer than usual', hi: 'अनजान नंबर, आम से बहुत लंबी' } },
  { id: 'bank_number', icon: 'verified', title: { en: 'Real bank numbers', hi: 'असली बैंक नंबर' }, sub: { en: 'Tells you when it was a 1600 number', hi: '1600 वाला नंबर हो तो बताता है' } },
  { id: 'pause_call', icon: 'pause', title: { en: 'Calling back a fraud number', hi: 'फ्रॉड नंबर पर वापस कॉल' }, sub: { en: 'Asks you to stop first', hi: 'पहले रुकने को कहता है' } },
];
