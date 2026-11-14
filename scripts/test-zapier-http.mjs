// Actual localhost Next route + an inert localhost Supabase REST double. Never contacts a provider.
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import assert from 'node:assert/strict';
import path from 'node:path';
const family='10000000-0000-4000-8000-000000000001',parent='20000000-0000-4000-8000-000000000001',child='20000000-0000-4000-8000-000000000002';
const token='SYNTHETIC_LOCAL_HTTP_TEST_NOT_A_REAL_TOKEN';
let live=true,empty=false,reads=0,childProcess;
const mock=createServer((request,response)=>{
 const u=new URL(request.url,'http://127.0.0.1');
 if(u.searchParams.get('family_id')!=='eq.'+family){response.writeHead(403).end('{}');return;}
 let rows=[];
 if(u.pathname.endsWith('/family_memberships')) rows=live?[{person_id:child}]:[];
 else if(u.pathname.endsWith('/people')) rows=[{id:parent}];
 else if(u.pathname.endsWith('/timeline_events')) {
  reads++;assert.equal(u.searchParams.get('select'),'id,family_id,event_type,created_at');
  const start=u.searchParams.getAll('created_at').find(v=>v.startsWith('gte.'))?.slice(4);
  assert.ok(start,'bounded reporting start required');
  rows=empty?[]:[{id:'synthetic',family_id:family,event_type:'checkin.completed',created_at:new Date(Date.parse(start)+3600_000).toISOString()}];
 }
 response.setHeader('Content-Type','application/json');
 response.end(JSON.stringify(request.headers.accept?.includes('object+json')?rows[0]??null:rows));
});
try {
 mock.listen(0,'127.0.0.1');await once(mock,'listening');
 const mockPort=mock.address().port,port=3187;
 const cwd=path.resolve('apps/api');
 const env={...process.env,NEXT_TELEMETRY_DISABLED:'1',SUPABASE_URL:`http://127.0.0.1:${mockPort}`,SUPABASE_SERVICE_ROLE_KEY:'SYNTHETIC_LOCAL_ONLY_NOT_A_SERVICE_CREDENTIAL',
  ZAPIER_BEARER:token,ZAPIER_WEEKLY_FAMILY_ID:family,ZAPIER_WEEKLY_PARENT_ID:parent,ZAPIER_WEEKLY_REQUESTER_ID:child,
  ZAPIER_DISPATCH_ENABLED:'false',ZAPIER_CONTRACTS_APPROVED:'false',ZAPIER_DOWNSTREAM_DEDUPE_VERIFIED:'false',PROVIDER_DISPATCH_ENABLED:'false',ZAPIER_HOOK_LEDGER:'',ZAPIER_HOOK_DATES:''};
 childProcess=spawn(process.execPath,['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port',String(port)],{cwd,env,stdio:'ignore',windowsHide:true});
 const url=`http://127.0.0.1:${port}/api/zapier/weekly`;
 let ready=false;for(let i=0;i<100;i++){try{let r=await fetch(url);if(r.status===401){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}
 assert.ok(ready,'local Next server did not become ready');assert.equal(reads,0);
 const headers={Authorization:'Bearer '+token};
 let r=await fetch(url,{headers});assert.equal(r.status,200);let data=await r.json();assert.equal(Object.keys(data).length,9);assert.equal(data.checkin_summary,'Completed check-ins: 1.');assert.equal(r.headers.get('Cache-Control'),'no-store');
 empty=true;r=await fetch(url,{headers});assert.equal(r.status,200);assert.match((await r.json()).weekly_summary,/No recorded activities/);
 assert.equal((await fetch(url+'?family_id=foreign',{headers})).status,400);
 live=false;assert.equal((await fetch(url,{headers})).status,403);
 console.log(JSON.stringify({result:'ZAPIER_LOCAL_HTTP_PASS',checks:5,scope:'Built Next weekly route, localhost REST double only: invalid bearer, exact nine-field synthetic report, empty period, caller family override and revoked scope; no production HTTP or outbound action'}));
} finally {childProcess?.kill();mock.close();}
