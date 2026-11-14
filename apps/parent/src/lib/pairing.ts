// Pairing (Core 3 Step 1.3): exchange Riya's 6-digit code for device credentials at
// POST {base}/api/shield/pair, then hand them to the native module.
// The server is selected at runtime; public parent/family IDs scope the live device.
// With no server or IDs configured, the setup remains a labelled demo.
import { Platform } from 'react-native';
import { validateServerAddress } from '@/lib/server-address';

import { family } from '@/lib/demo';
import { shield, shieldAvailable } from '@/lib/shield';

export const defaultServerAddress = () => shield.getServerAddress() || process.env.EXPO_PUBLIC_SAHAJ_API_URL || '';
const PARENT_ID = process.env.EXPO_PUBLIC_SAHAJ_PARENT_ID;
const FAMILY_ID = process.env.EXPO_PUBLIC_SAHAJ_FAMILY_ID;

export type PairResult = 'paired' | 'demo' | 'failed';

export async function pairWithCode(code: string, serverAddress: string = defaultServerAddress()): Promise<PairResult> {
  if (!/^\d{6}$/.test(code)) return 'failed';
  if (!serverAddress.trim() && !PARENT_ID && !FAMILY_ID) return 'demo';
  // A partially configured live app must not pretend to pair. Events are family scoped.
  if (!serverAddress.trim() || !PARENT_ID || !FAMILY_ID) return 'failed';
  try {
    const baseUrl = validateServerAddress(serverAddress);
    const res = await fetch(`${baseUrl}/api/shield/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(12000),
      redirect: 'error',
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
    if (!shieldAvailable) return 'failed';
    const ok = await shield.setPairing({
      baseUrl,
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
