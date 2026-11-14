import { createPublicKey, randomUUID } from 'node:crypto';
import { serviceDatabase } from '../database';
import { runZapierOutbox, type ZapierConfig } from './outbox';
import { zapierStore } from './store';

/** Off by default. Singhal must call from the existing durable cron after combined review;
 * no second timer, public send endpoint, client hook or automatic deployment is created. */
export async function runConfiguredZapierTick(env:NodeJS.ProcessEnv=process.env) {
  if (env.ZAPIER_DISPATCH_ENABLED!=='true' || env.ZAPIER_CONTRACTS_APPROVED!=='true' || env.ZAPIER_DOWNSTREAM_DEDUPE_VERIFIED!=='true') return {state:'disabled'};
  try {
    const raw=env.SIGNING_PUBLIC_KEY ?? '';
    const publicKey=raw.includes('BEGIN PUBLIC KEY')?createPublicKey(raw):createPublicKey({key:Buffer.from(raw,'base64'),format:'der',type:'spki'});
    const config:ZapierConfig={enabled:true,contractsApproved:true,downstreamDedupeVerified:true,
      encryptionKey:env.WEBHOOK_ENCRYPTION_KEY ?? '',publicKeys:new Map([[env.SIGNING_KEY_ID ?? '',publicKey]]),
      hooks:{z1:env.ZAPIER_HOOK_LEDGER,z5:env.ZAPIER_HOOK_DATES}};
    return await runZapierOutbox(zapierStore(serviceDatabase()),config,randomUUID());
  } catch { return {state:'unavailable'}; } // No raw URL/key/db/provider error reaches core care or tick logs.
}
