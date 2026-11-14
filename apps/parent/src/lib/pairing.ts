// Pairing (Core 3 Step 1.3): exchange Riya's 6-digit code for device credentials at
// POST {base}/api/shield/pair, then hand them to the native module.
// Without EXPO_PUBLIC_SAHAJ_API_URL + EXPO_PUBLIC_SAHAJ_PARENT_ID the app runs in demo mode:
// any 6-digit code "pairs" locally and nothing is sent.
import { Platform } from 'react-native';

import { family } from '@/lib/demo';
import { shield, shieldAvailable } from '@/lib/shield';

const BASE_URL = process.env.EXPO_PUBLIC_SAHAJ_API_URL;
const PARENT_ID = process.env.EXPO_PUBLIC_SAHAJ_PARENT_ID;
const FAMILY_ID = process.env.EXPO_PUBLIC_SAHAJ_FAMILY_ID;

export type PairResult = 'paired' | 'demo' | 'failed';

export async function pairWithCode(code: string): Promise<PairResult> {
  if (!/^\d{6}$/.test(code)) return 'failed';
  if (!BASE_URL && !PARENT_ID && !FAMILY_ID) return 'demo';
  // A partially configured live app must not pretend to pair. Events are family scoped.
  if (!BASE_URL || !PARENT_ID || !FAMILY_ID) return 'failed';
  try {
    const res = await fetch(`${BASE_URL.replace(/\/$/, '')}/api/shield/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code,
        parent_person_id: PARENT_ID,
        label: 'Maa phone',
        platform: 'android',
        android_version: String(Platform.Version),
      }),
    });
    if (!res.ok) return 'failed';
    const body = (await res.json()) as { device_id?: string; device_secret?: string };
    if (!body.device_id || !body.device_secret) return 'failed';
    if (!shieldAvailable) return 'paired';
    const ok = await shield.setPairing({
      baseUrl: BASE_URL,
      deviceId: body.device_id,
      deviceSecret: body.device_secret,
      childNumber: family.riya.phone,
      childName: family.riya.name.en,
      parentId: PARENT_ID,
      familyId: FAMILY_ID,
    });
    return ok ? 'paired' : 'failed';
  } catch {
    return 'failed';
  }
}
