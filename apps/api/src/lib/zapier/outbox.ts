import { createHash } from 'node:crypto';
import { canonicalJson, timelinePayloadHash, verifyTimelineEvent, type SignedTimelineEvent, type TimelineKey } from '../timeline';
import { decryptWebhook, encryptWebhook } from '../webhook-security';
import { validatePaperwork, type Channel, type PaperworkEvent } from './contracts';

export interface CommittedSource { signed:SignedTimelineEvent; payload:unknown }
export interface ZapierRow { id:string; family_id:string; kind:string; dedupe_key:string; payload_ciphertext:string; lease_token:string }
export interface ZapierStore {
  source(family:string,id:string):Promise<CommittedSource|null>;
  enqueue(input:{family:string;timeline:string;channel:Channel;hash:string;ciphertext:string;chainHash:string}):Promise<string>;
  claim(worker:string,channels:Channel[],limit:number):Promise<ZapierRow[]>;
  finish(row:ZapierRow,success:boolean,code:string|null):Promise<boolean>;
}
export interface ZapierConfig {
  contractsApproved:boolean; enabled:boolean; downstreamDedupeVerified:boolean; encryptionKey:string;
  publicKeys:ReadonlyMap<string,TimelineKey>; hooks:Partial<Record<Channel,string>>;
}
const TYPES:Record<Channel,readonly string[]>={z1:['errand.approved','errand.denied','errand.completed'],z5:['reminder.created']};
const digest=(v:string)=>createHash('sha256').update(v).digest('hex');
const aad=(family:string,dedupe:string)=>`outbox:${family}:${dedupe}`;

/** Read back the COMMITTED timeline; never accept a caller-supplied hash, signature or business projection. */
export async function prepareCommittedEvent(store:ZapierStore,config:ZapierConfig,family:string,id:string,channel:Channel) {
  if (!config.contractsApproved) throw new Error('contracts_not_approved');
  const source=await store.source(family,id);
  if (!source || source.signed.envelope.familyId!==family || source.signed.envelope.eventId!==id ||
    !TYPES[channel].includes(source.signed.envelope.eventType)) throw new Error('source_not_eligible');
  const key=config.publicKeys.get(source.signed.envelope.keyId);
  if (!key || !verifyTimelineEvent(source.signed,key) || timelinePayloadHash(source.payload)!==source.signed.envelope.payloadHash) throw new Error('source_not_verified');
  const projection=(source.payload as {zapier?:unknown})?.zapier;
  if (!projection || typeof projection!=='object' || Array.isArray(projection)) throw new Error('source_projection_missing');
  // Envelope-derived fields cannot be supplied/replaced by raw care input.
  const derived=channel==='z1' ? {schema_version:'1.0',event_id:`z1_${id}`,event_type:'errand.updated',occurred_at:source.signed.envelope.occurredAt,
    ...projection,chain_hash:source.signed.chainHash} : {schema_version:'1.0',event_id:`z5_${id}`,event_type:'reminder.created',...projection};
  if ('schema_version' in projection || 'event_id' in projection || 'event_type' in projection || 'occurred_at' in projection || 'chain_hash' in projection) throw new Error('source_projection_overrides');
  const event=validatePaperwork(channel,derived), body=canonicalJson(event), dedupe=`zapier:${channel}:${id}`;
  if (channel==='z1' && (event as {decision:string}).decision!==source.signed.envelope.eventType.slice('errand.'.length)) throw new Error('decision_mismatch');
  if (channel==='z5' && (event as {reminder_id:string}).reminder_id!==source.signed.envelope.entityId) throw new Error('reminder_identity_mismatch');
  return {event,body,dedupe,chainHash:source.signed.chainHash};
}

/** Invoke after the owning business transaction commits. Failure cannot roll back that care action.
 * The caller must retain/retry the durable source reference; this module does not invent a source-event writer. */
export async function enqueueCommittedEvent(store:ZapierStore,config:ZapierConfig,family:string,id:string,channel:Channel) {
  const value=await prepareCommittedEvent(store,config,family,id,channel);
  return store.enqueue({family,timeline:id,channel,hash:digest(value.body),chainHash:value.chainHash,
    ciphertext:encryptWebhook(Buffer.from(value.body),config.encryptionKey,aad(family,value.dedupe))});
}

export function approvedHook(raw:string):URL {
  let u:URL;try{u=new URL(raw);}catch{throw new Error('invalid_hook_configuration');}
  if (u.protocol!=='https:' || u.hostname!=='hooks.zapier.com' || u.port || u.username || u.password || u.search || u.hash || !/^\/hooks\/catch\/[0-9]+\/[a-zA-Z0-9_-]+\/?$/.test(u.pathname)) throw new Error('invalid_hook_configuration');
  return u;
}

export type Post=(url:URL,body:string)=>Promise<{status:number}>;
export const postOnce:Post=async(url,body)=>{
  const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body,redirect:'error',signal:AbortSignal.timeout(8000)});
  await response.body?.cancel(); // Never print/log provider response bodies or hook URLs.
  return {status:response.status};
};

export async function runZapierOutbox(store:ZapierStore,config:ZapierConfig,worker:string,post:Post=postOnce) {
  if (!config.enabled || !config.contractsApproved || !config.downstreamDedupeVerified) return {state:'disabled',claimed:0,accepted:0,unknown:0,failed:0};
  const channels=(['z1','z5'] as const).filter(c=>!!config.hooks[c]);
  const hooks=new Map(channels.map(c=>[c,approvedHook(config.hooks[c]!)]));
  if (!channels.length) return {state:'disabled',claimed:0,accepted:0,unknown:0,failed:0};
  const rows=await store.claim(worker,channels,2), counts={state:'processed',claimed:rows.length,accepted:0,unknown:0,failed:0};
  for (const row of rows) {
    let channel:Channel,body:string;
    try {
      channel=row.kind==='zapier.z1'?'z1':row.kind==='zapier.z5'?'z5':(()=>{throw new Error('invalid_kind');})();
      if (!hooks.has(channel) || !row.dedupe_key.startsWith(`zapier:${channel}:`)) throw new Error('invalid_scope');
      body=decryptWebhook(row.payload_ciphertext,config.encryptionKey,aad(row.family_id,row.dedupe_key)).toString('utf8');
      const event:PaperworkEvent=validatePaperwork(channel,JSON.parse(body));
      const id=row.dedupe_key.slice(`zapier:${channel}:`.length);
      const committed=await prepareCommittedEvent(store,config,row.family_id,id,channel);
      if (canonicalJson(event)!==committed.body) throw new Error('projection_mismatch');
    } catch { if(!await store.finish(row,false,'invalid_paperwork'))throw new Error('stale_outbox_lease');counts.failed++;continue; }
    let response:{status:number};
    try { response=await post(hooks.get(channel)!,body); }
    catch { if(!await store.finish(row,false,'delivery_unknown'))throw new Error('stale_outbox_lease');counts.unknown++;continue; }
    const ok=response.status>=200 && response.status<300;
    // Reuse durable finish/backoff. Retrying explicit non-2xx needs verified downstream event_id dedupe.
    if (!await store.finish(row,ok,ok?null:'zapier_http_rejected')) throw new Error('stale_outbox_lease');
    if(ok)counts.accepted++;else counts.failed++;
  }
  return counts; // HTTP acceptance is not Sheet/Calendar acceptance.
}
