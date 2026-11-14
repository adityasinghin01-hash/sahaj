import { describe,it,expect,vi } from 'vitest';
import { handleWeekly,weeklyWindow,WEEKLY_FIELDS,type WeeklyConfig,type WeeklyStore } from '../../src/lib/zapier/weekly';
const family='10000000-0000-4000-8000-000000000001',parent='20000000-0000-4000-8000-000000000001',child='20000000-0000-4000-8000-000000000002';
const config:WeeklyConfig={familyId:family,parentId:parent,requesterId:child,bearer:'SYNTHETIC_TEST_ONLY_NOT_A_REAL_TOKEN'};
const now=new Date('2026-11-15T14:30:00.000Z');
const req=(token=config.bearer,query='')=>new Request('https://example.invalid/api/zapier/weekly'+query,{headers:{Authorization:'Bearer '+token}});
function store(records:any[]=[]):WeeklyStore { return {scopeIsLive:vi.fn(async()=>true),timeline:vi.fn(async()=>records)}; }
function record(eventType:string,extra={}) {return {id:'synthetic',familyId:family,source:'signed_timeline',eventType,createdAt:'2026-11-10T12:00:00.000Z',...extra};}
describe('weekly report, local fakes only',()=>{
 it('returns the exact nine-field empty schema without sensitive records',async()=>{let r=await handleWeekly(req(),config,()=>store(),now),d=await r.json();expect(r.status).toBe(200);expect(Object.keys(d).sort()).toEqual([...WEEKLY_FIELDS].sort());expect(d.weekly_summary).toContain('No recorded');expect(d.parent_name).toBe('Parent');expect(r.headers.get('Cache-Control')).toBe('no-store');});
 it.each(['','wrong','Bearer another'])('rejects invalid bearer without touching storage: %s',async(token)=>{let db=vi.fn(()=>store());expect((await handleWeekly(req(token),config,db,now)).status).toBe(401);expect(db).not.toHaveBeenCalled();});
 it('fails closed when unconfigured',async()=>expect((await handleWeekly(req(),undefined,()=>store(),now)).status).toBe(503));
 it('rejects short bearer configuration',async()=>expect((await handleWeekly(req(),{...config,bearer:'short'},()=>store(),now)).status).toBe(503));
 it('rejects caller-selected family and cutoff',async()=>expect((await handleWeekly(req(config.bearer,'?family_id=other&cutoff=tomorrow'),config,()=>store(),now)).status).toBe(400));
 it('rejects revoked/missing scope',async()=>{let db=store();db.scopeIsLive=async()=>false;expect((await handleWeekly(req(),config,()=>db,now)).status).toBe(403);expect(db.timeline).not.toHaveBeenCalled();});
 it('refuses a foreign family even if a repository leaks it',async()=>expect((await handleWeekly(req(),config,()=>store([record('checkin.completed',{familyId:child})]),now)).status).toBe(503));
 it.each(['2026-11-08T14:29:59.999Z','2026-11-15T14:30:00.000Z','invalid'])('rejects invalid/outside half-open window: %s',async(createdAt)=>expect((await handleWeekly(req(),config,()=>store([record('checkin.completed',{createdAt})]),now)).status).toBe(503));
 it('accepts equivalent offset dates at the inclusive start',async()=>expect((await handleWeekly(req(),config,()=>store([record('checkin.completed',{createdAt:'2026-11-08T14:30:00+00:00'})]),now)).status).toBe(200));
 it('reuses compiler counts but never returns raw text, metadata, event names or recordings',async()=>{let raw='PRIVATE_RAW_TEXT';let db=store([record('checkin.completed',{contentPreview:raw,metadata:{recording:'private/audio',otp:'PRIVATE'}}),record('general.private',{contentPreview:raw}),record('refill.proposed'),record('errand.approved')]);let d=await(await handleWeekly(req(),config,()=>db,now)).json();let text=JSON.stringify(d);expect(d.checkin_summary).toBe('Completed check-ins: 1.');expect(d.errand_summary).toContain('1');expect(d.medicine_summary).toContain('1');expect(text).not.toContain(raw);expect(text).not.toContain('private/audio');expect(text).not.toContain('general.private');expect(d.mood_summary).toContain('not available');});
 it('does not silently truncate oversized periods',async()=>expect((await handleWeekly(req(),config,()=>store(Array.from({length:1001},()=>record('x'))),now)).status).toBe(503));
 it('sanitizes storage errors',async()=>{let db=store();db.timeline=async()=>{throw new Error('PRIVATE_PROVIDER_TOKEN');};let r=await handleWeekly(req(),config,()=>db,now);expect(await r.text()).not.toContain('PRIVATE_PROVIDER_TOKEN');expect(r.status).toBe(503);});
 it('uses prior completed cutoff before Sunday 20:00 IST',()=>expect(weeklyWindow(new Date('2026-11-15T14:29:59Z')).end).toBe('2026-11-08T14:30:00.000Z'));
 it('starts the new period exactly at Sunday 20:00 IST',()=>expect(weeklyWindow(now)).toEqual({start:'2026-11-08T14:30:00.000Z',end:'2026-11-15T14:30:00.000Z'}));
});
