// Local PostgreSQL/WASM validation of the new migration on a minimal compatible schema.
// NOT a full joined migration/RLS/concurrency acceptance suite. No network/hosted DB.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const root=process.cwd();
const modulePath=process.env.PGLITE_MODULE ?? path.join(root,'tmp/zapier-db-test/node_modules/@electric-sql/pglite/dist/index.js');
const {PGlite}=await import(pathToFileURL(modulePath).href);
const db=new PGlite();let checks=0;
try {
 await db.exec(`create role anon; create role authenticated; create role service_role;
 create table public.timeline_events(id uuid primary key,family_id uuid,entity_id uuid,event_type text,chain_hash text,payload_canonical text);
 create table public.action_requests(id uuid primary key,family_id uuid,permission_id uuid,action text,status text,amount_minor bigint);
 create table public.errands(id uuid primary key,family_id uuid,action_request_id uuid,status text);
 create table public.schedules(id uuid primary key,family_id uuid,enabled boolean,next_at timestamptz,timezone text);
 create table public.outbox(id uuid primary key default gen_random_uuid(),family_id uuid,kind text,dedupe_key text,payload_ciphertext text,
 status text default 'pending',attempt_count int default 0,max_attempts int default 5,retry_at timestamptz default now(),lease_token uuid,
 lease_until timestamptz,worker_id text,last_error_code text,completed_at timestamptz,created_at timestamptz default now(),unique(family_id,dedupe_key));`);
 const base=await fs.readFile('infra/supabase/migrations/20261114130240_core1_security_workflows.sql','utf8');
 const finishStart=base.indexOf('create function public.finish_outbox('),finishEnd=base.indexOf('end $$;',finishStart);
 assert.ok(finishStart>=0&&finishEnd>finishStart);await db.exec(base.slice(finishStart,finishEnd+'end $$;'.length));
 await db.exec(await fs.readFile('infra/supabase/migrations/20261115011500_zapier_paperwork.sql','utf8'));
 const f='10000000-0000-4000-8000-000000000001',t='30000000-0000-4000-8000-000000000001',e='40000000-0000-4000-8000-000000000001',a='50000000-0000-4000-8000-000000000001',p='60000000-0000-4000-8000-000000000001';
 const hash='a'.repeat(64),chain='b'.repeat(64),cipher='v1.synthetic.encrypted.payload';
 const params=[f,t,'z1',hash,cipher,chain];
 const enqueue=values=>db.query('select public.enqueue_zapier_outbox($1,$2,$3,$4,$5,$6) as id',values);
 await assert.rejects(()=>enqueue(params));checks++;
 await db.query('insert into timeline_events values($1,$2,$3,$4,$5,$6)',[t,f,e,'errand.approved',chain,JSON.stringify({zapier:{permission_ref:p,amount_inr:350}})]);
 await assert.rejects(()=>enqueue(params));checks++;
 await db.query('insert into action_requests values($1,$2,$3,$4,$5,$6)',[a,f,p,'medicine_refill','approved',35000]);
 await db.query('insert into errands values($1,$2,$3,$4)',[e,f,a,'authorized']);
 const first=(await enqueue(params)).rows[0].id;checks++;
 assert.equal((await enqueue(params)).rows[0].id,first);checks++;
 await assert.rejects(()=>enqueue([f,t,'z1','c'.repeat(64),cipher,chain]));checks++;
 await assert.rejects(()=>enqueue([e,t,'z1',hash,cipher,chain]));checks++;
 await assert.rejects(()=>enqueue([f,t,'z1',hash,cipher,'d'.repeat(64)]));checks++;
 await db.query('update action_requests set amount_minor=90000 where id=$1',[a]);
 await assert.rejects(()=>enqueue(params));checks++;
 await db.query('update action_requests set amount_minor=35000 where id=$1',[a]);
 await db.query("insert into outbox(family_id,kind,dedupe_key,payload_ciphertext) values($1,'sarvam.outbound_call','provider-stays-pending','opaque')",[f]);
 let claimed=(await db.query('select * from claim_zapier_outbox($1,$2,$3)',['synthetic-worker',['z1'],2])).rows;
 assert.equal(claimed.length,1);assert.equal(claimed[0].id,first);assert.equal(claimed[0].attempt_count,1);checks++;
 assert.equal((await db.query("select attempt_count from outbox where kind='sarvam.outbound_call'")).rows[0].attempt_count,0);checks++;
 assert.equal((await db.query('select finish_outbox($1,$2,false,$3) as ok',[first,claimed[0].lease_token,'zapier_http_rejected'])).rows[0].ok,true);checks++;
 let failure=(await db.query('select status,retry_at>now() as delayed from outbox where id=$1',[first])).rows[0];assert.equal(failure.status,'failed');assert.equal(failure.delayed,true);checks++;
 await db.query("update outbox set retry_at=now()-interval '1 second' where id=$1",[first]);
 claimed=(await db.query('select * from claim_zapier_outbox($1,$2,$3)',['synthetic-worker',['z1'],2])).rows;
 assert.equal(claimed[0].attempt_count,2);checks++;
 await db.query("update outbox set lease_until=now()-interval '1 second' where id=$1",[first]);
 assert.equal((await db.query('select * from claim_zapier_outbox($1,$2,$3)',['synthetic-worker',['z1'],2])).rows.length,0);
 assert.equal((await db.query('select status from outbox where id=$1',[first])).rows[0].status,'delivery_unknown');checks++;
 await assert.rejects(()=>db.query('select * from claim_zapier_outbox($1,$2,$3)',['worker',['unexpected'],2]));checks++;
 assert.equal((await db.query("select has_function_privilege('authenticated','public.enqueue_zapier_outbox(uuid,uuid,text,text,text,text)','execute') as allowed")).rows[0].allowed,false);checks++;
 const rt='30000000-0000-4000-8000-000000000002',rs='40000000-0000-4000-8000-000000000002';
 await db.query('insert into schedules values($1,$2,true,$3,$4)',[rs,f,'2026-11-19T10:00:00+05:30','Asia/Kolkata']);
 await db.query('insert into timeline_events values($1,$2,$3,$4,$5,$6)',[rt,f,rs,'reminder.created',chain,JSON.stringify({zapier:{reminder_id:rs,start_at:'2026-11-19T10:00:00+05:30',timezone:'Asia/Kolkata'}})]);
 assert.ok((await enqueue([f,rt,'z5',hash,cipher,chain])).rows[0].id);checks++;
 await db.query('update schedules set enabled=false where id=$1',[rs]);
 await assert.rejects(()=>enqueue([f,rt,'z5',hash,cipher,chain]));checks++;
 await db.query("update schedules set enabled=true,timezone='UTC' where id=$1",[rs]);
 await assert.rejects(()=>enqueue([f,rt,'z5',hash,cipher,chain]));checks++;
 await db.query("update outbox set status='failed',attempt_count=5 where id=$1",[first]);
 await db.query('select * from claim_zapier_outbox($1,$2,$3)',['worker',['z1'],2]);
 assert.equal((await db.query('select status from outbox where id=$1',[first])).rows[0].status,'dead');checks++;
 console.log(JSON.stringify({result:'ZAPIER_SQL_PASS',checks,engine:'PGlite ephemeral PostgreSQL',scope:'New migration, business/source checks, replay/conflict, family isolation, capability claim, expired lease and client RPC denial on a minimal compatible schema; not full joined production acceptance'}));
} finally {await db.close();}
