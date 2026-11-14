// Demo family (synthetic). One data layer: screens read only from here; later this file is
// swapped for Supabase queries + Realtime with the same shapes.

export type Level = 'green' | 'yellow' | 'red';

export const family = {
  child: { name: 'Riya', city: 'Bengaluru' },
  parent: { name: 'Meena', called: 'Maa', age: 67, phone: 'Lava keypad', city: 'Lucknow' },
};

export const today = {
  level: 'green' as Level,
  headline: 'Maa is doing well',
  checkin: { time: '10:14 AM', minutes: 4, by: 'Aasha Didi (Sahaj)' },
  lines: [
    { icon: 'moon', text: 'Slept well, woke at 6' },
    { icon: 'pill', text: 'Took her BP tablet' },
    { icon: 'activity', text: 'Knee hurts a little (2/5)' },
  ],
  clip: { seconds: 12, quote: '“Beta, aaj dhoop achhi hai, main theek hoon.”' },
  nextCheckin: 'Tomorrow, 10:00 AM',
};

export const approvals = [
  {
    id: 'a1',
    title: 'Plumber visit',
    detail: 'Ramesh (Sharma Plumbing) · today 4 PM',
    amount: '₹900',
    why: 'Over the ₹500 limit, and someone will enter the home — needs your yes and Maa’s yes.',
  },
];

export const done = [
  { id: 'd1', title: 'Medicine refill ordered', detail: 'Amlodipine 5 mg · Gupta Medical', amount: '₹184', rule: '#12' },
];

export type ChainState = 'done' | 'live' | 'skipped' | 'waiting';
export const incident = {
  id: 'inc-0914',
  level: 'red' as Level,
  title: 'Maa called the urgent line',
  startedAt: '9:41 PM',
  how: '2 missed calls → Sahaj called back',
  words: { seconds: 6, quote: '“Main gir gayi… pair mein dard hai.”', translation: 'I fell… my leg hurts.' },
  acceptedIn: '2 min 48 s',
  chain: [
    { who: 'Rohit', role: 'Brother · on duty', state: 'skipped' as ChainState, note: 'No answer in 2 min', time: '9:42' },
    { who: 'Sharma uncle', role: 'Neighbour · 3 min away', state: 'done' as ChainState, note: 'Accepted — “Main aa raha hoon”', time: '9:44' },
    { who: 'You', role: 'Daughter', state: 'live' as ChainState, note: 'Informed · Maa will hear his voice', time: 'now' },
  ],
  next: 'Sahaj will call Maa back in 10 min to check he reached.',
};

export const circle = [
  { id: 'p1', name: 'Rohit', role: 'Brother', city: 'Pune', onDuty: true, sees: 'Alerts, reports, voice' },
  { id: 'p2', name: 'Sharma uncle', role: 'Neighbour', city: 'Lucknow · 3 min', onDuty: false, sees: 'Only urgent cards' },
  { id: 'p3', name: 'Priya', role: 'Friend (for you)', city: 'Bengaluru', onDuty: false, sees: 'Only your safety alerts' },
  { id: 'p4', name: 'Gupta Medical', role: 'Chemist', city: 'Lucknow', onDuty: false, sees: 'Only orders' },
];

export const permissions = [
  { id: '#12', title: 'Medicine refill', who: 'Gupta Medical', limit: 'Up to ₹500 / month', expires: '14 Feb', on: true, used: 'Used today · ₹184' },
  { id: '#13', title: 'Grocery order', who: 'Kirana Store', limit: 'Up to ₹800 / week', expires: '30 Nov', on: true, used: 'Not used yet' },
  { id: '#14', title: 'Call Maa when silent', who: 'Sahaj', limit: 'After 2 missed check-ins', expires: 'Never', on: true, used: 'Safety — always allowed' },
];
export const askEveryTime = ['Anyone entering the home', 'Any payment over ₹500', 'Sharing Maa’s location'];

export type TimelineKind = 'checkin' | 'shield' | 'voice' | 'order' | 'urgent' | 'safe';
export const timeline = [
  { id: 't1', time: '9:44 PM', kind: 'urgent' as TimelineKind, text: 'Sharma uncle accepted Maa’s urgent call', signed: true },
  { id: 't2', time: '9:41 PM', kind: 'urgent' as TimelineKind, text: 'Maa gave 2 missed calls → urgent line', signed: true },
  { id: 't3', time: '6:20 PM', kind: 'shield' as TimelineKind, text: 'Shield stopped a KYC scam SMS', signed: true },
  { id: 't4', time: '2:05 PM', kind: 'order' as TimelineKind, text: 'Refill ordered · allowed by #12', signed: true },
  { id: 't5', time: '11:30 AM', kind: 'voice' as TimelineKind, text: 'Maa heard your voice message ✓✓', signed: true },
  { id: 't6', time: '10:14 AM', kind: 'checkin' as TimelineKind, text: 'Check-in call · all well', signed: true },
];

export const shield = {
  protections: [
    { name: 'SMS check', on: true },
    { name: 'Unknown-call watch', on: true },
    { name: 'Red warning screen', on: true },
    { name: 'Keypad help line (speed dial 2)', on: true },
    { name: 'Banking-app alert', on: false },
  ],
  week: { checks: 12, stopped: 2 },
  scamSense: { score: 4, of: 5 },
  alerts: [
    {
      id: 's1', level: 'red' as Level, type: 'KYC scam SMS', time: '6:20 PM', channel: 'Maa’s smartphone',
      snippet: 'SBI KYC expire ho raha hai, update karein: <link:bit.ly>',
      reasons: ['Bank name in a message from a 10-digit mobile', 'Short link that hides the real website', 'Pressure words: “expire”, “turant”'],
      told: '“Ruk jaiye. Ye fraud ho sakta hai. OTP ya paise kisi ko mat dijiye.”',
      actions: [
        { t: '6:20:01', a: 'Red screen + Hindi voice on Maa’s phone' },
        { t: '6:20:03', a: 'You were alerted on WhatsApp + app' },
        { t: '6:21:10', a: 'You called Maa' },
      ],
    },
    {
      id: 's2', level: 'yellow' as Level, type: 'Call claiming to be “Rohit”', time: 'Yesterday', channel: 'Keypad line',
      snippet: 'Caller asked for money for a hospital bill',
      reasons: ['Family check: Rohit tapped “It wasn’t me”'],
      told: '“Ye Rohit nahi the. Paise mat bhejiye.”',
      actions: [{ t: '7:02 PM', a: 'Rohit was asked on WhatsApp' }, { t: '7:03 PM', a: 'Maa told in the same call' }],
    },
  ],
};

export const watch = { homeEta: '11:30 PM', from: 'Office, Koramangala', cabNote: 'Uber · KA 05 AB 1234' };
