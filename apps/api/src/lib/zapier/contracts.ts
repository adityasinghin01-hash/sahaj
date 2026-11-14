/** PROPOSED contracts for Issue #6; require Lead approval before any activation or Zap migration. */
export interface Z1Event {
  schema_version:'1.0'; event_id:string; event_type:'errand.updated'; occurred_at:string;
  errand_type:'medicine_refill'; vendor_label:'demo_pharmacy'; amount_inr:number;
  permission_ref:string; decision:'approved'|'denied'|'completed'; chain_hash:string;
}
export interface Z5Event {
  schema_version:'1.0'; event_id:string; reminder_id:string; event_type:'reminder.created';
  title:'Family reminder'; start_at:string; end_at:string; timezone:string;
  reminder_minutes_before:number; description:'Synthetic family reminder';
}
export type PaperworkEvent = Z1Event | Z5Event;
export type Channel = 'z1'|'z5';
const HASH = /^[0-9a-f]{64}$/;
const ID = /^[a-zA-Z0-9_-]{1,100}$/;
const time = (v: unknown): v is string => typeof v==='string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?(?:Z|[+-]\d\d:\d\d)$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v.slice(0,19)+'Z').toISOString().slice(0,19)===v.slice(0,19);
const exact = (v:Record<string,unknown>,keys:string[]) => Object.keys(v).sort().join('|')===keys.sort().join('|');
export function validatePaperwork(channel:Channel, value:unknown): PaperworkEvent {
  if (!value || typeof value!=='object' || Array.isArray(value)) throw new Error('invalid_contract');
  const v=value as Record<string,unknown>;
  if (v.schema_version!=='1.0' || typeof v.event_id!=='string' || !ID.test(v.event_id)) throw new Error('invalid_contract');
  if (channel==='z1') {
    if (!exact(v,['schema_version','event_id','event_type','occurred_at','errand_type','vendor_label','amount_inr','permission_ref','decision','chain_hash']) ||
      v.event_type!=='errand.updated' || !time(v.occurred_at) || v.errand_type!=='medicine_refill' || v.vendor_label!=='demo_pharmacy' ||
      typeof v.amount_inr!=='number' || !Number.isFinite(v.amount_inr) || Math.abs(v.amount_inr*100-Math.round(v.amount_inr*100))>1e-7 || v.amount_inr<0 || v.amount_inr>100000 ||
      typeof v.permission_ref!=='string' || !ID.test(v.permission_ref) || typeof v.decision!=='string' || !['approved','denied','completed'].includes(v.decision) ||
      typeof v.chain_hash!=='string' || !HASH.test(v.chain_hash)) throw new Error('invalid_contract');
  } else {
    if (!exact(v,['schema_version','event_id','reminder_id','event_type','title','start_at','end_at','timezone','reminder_minutes_before','description']) ||
      v.event_type!=='reminder.created' || typeof v.reminder_id!=='string' || !ID.test(v.reminder_id) ||
      v.title!=='Family reminder' || v.description!=='Synthetic family reminder' || !time(v.start_at) || !time(v.end_at) ||
      Date.parse(v.end_at)<=Date.parse(v.start_at) || typeof v.timezone!=='string' ||
      !Number.isInteger(v.reminder_minutes_before) || Number(v.reminder_minutes_before)<0 || Number(v.reminder_minutes_before)>40320) throw new Error('invalid_contract');
    try { new Intl.DateTimeFormat('en',{timeZone:v.timezone}); } catch { throw new Error('invalid_timezone'); }
  }
  return value as PaperworkEvent;
}
