// Two-session regression checks. Migration order: 20261114201500 -> 20261114201600 (Phase 2) -> 20261114210000 -> 20261114213000.
// SOURCE ONLY: not executed by its author (no PostgreSQL available). Run against a SCRATCH database with all
// migrations applied, using an administrative connection:
//   SCRATCH_DATABASE_URL=postgres://... SAHAJ_SCRATCH_OK=1 node packages/atlas/scripts/phase3-two-session.mjs
// It creates synthetic committed rows (random ids) and never touches rows it did not create. Do not point it at production.
import { randomUUID } from 'node:crypto';
import pg from 'pg';

if (process.env.SAHAJ_SCRATCH_OK !== '1' || !process.env.SCRATCH_DATABASE_URL) {
  console.error('Refusing to run: set SAHAJ_SCRATCH_OK=1 and SCRATCH_DATABASE_URL for a disposable database.');
  process.exit(2);
}
const url = process.env.SCRATCH_DATABASE_URL;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const connect = async (role) => { const c = new pg.Client({ connectionString: url }); await c.connect(); if (role) await c.query(`set role ${role}`); return c; };
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ' ' + detail}`); };

async function fixture(admin, { permissionExpiresIn = '1 hour', leaseSeconds = 300, maxUses = 1 } = {}) {
  const f = { fam: randomUUID(), subject: randomUUID(), principal: randomUUID(), consent: randomUUID(), event: randomUUID(), job: randomUUID(),
    lease: randomUUID(), request: randomUUID(), fp: 'f'.repeat(64) };
  await admin.query('insert into public.families(id,name) values($1,$2)', [f.fam, 'synthetic two-session']);
  await admin.query("insert into public.people(id,family_id,display_name,role) values($1,$2,'Subject','parent')", [f.subject, f.fam]);
  await admin.query("insert into public.atlas_principals(id,family_id,label) values($1,$2,'synthetic')", [f.principal, f.fam]);
  // The atomic enqueue requires a contact binding for the routed provider (check_in -> sarvam).
  await admin.query("insert into public.provider_identities(family_id,person_id,source,account_id,external_id_hash,binding_kind,contact_ciphertext) values($1,$2,'sarvam','app-1',$3,'contact','synthetic-ct')", [f.fam, f.subject, randomUUID().replace(/-/g, '').padEnd(64, '0')]);
  await admin.query("insert into public.consents(id,family_id,person_id,purpose,question,answer,version) values($1,$2,$3,'permission_setup','q',true,'v1')", [f.consent, f.fam, f.subject]);
  await admin.query(`insert into public.permissions(family_id,person_id,principal_id,action,decision,expires_at,consent_id,valid_from,period_start,period_end,max_uses,target_ids)
    values($1,$2,$3,'check_in','allow',now()+interval '${permissionExpiresIn}',$4,now()-interval '1 hour',now()-interval '1 hour',now()+interval '1 day',$5,array[$6::text])`, [f.fam, f.subject, f.principal, f.consent, maxUses, f.subject]);
  await admin.query("insert into public.raw_events(id,family_id,source,provider_event_id,event_type,status,payload_hash) values($1,$2,'whatsapp',$3,'whatsapp.text','processed',$4)", [f.event, f.fam, randomUUID(), 'a'.repeat(64)]);
  await admin.query(`insert into public.workflow_jobs(id,family_id,raw_event_id,thread_id,workflow_kind,state,lease_token,lease_until)
    values($1,$2,$3,'t','core1.atlas','processing',$4,clock_timestamp()+interval '${leaseSeconds} seconds')`, [f.job, f.fam, f.event, f.lease]);
  await admin.query("select public.ensure_action_request($1,$2,$3,$4,$5,'check_in',$6::text,$7)", [f.fam, f.job, f.lease, f.request, f.subject, f.subject, f.fp]);
  f.revision = (await admin.query('select sahaj_private.authorization_revision($1,$2) r', [f.fam, f.request])).rows[0].r;
  return f;
}
const enqueue = (c, f, key) => c.query('select public.enqueue_authorized_command($1,$2,$3,$4,$5,$6,$7,$8,$9,null,null) r',
  [f.fam, f.job, f.lease, f.request, 'check_in', key, 'ct', 'b'.repeat(64), f.revision]).then(r => ({ ok: r.rows[0].r }), e => ({ err: e.code }));
async function isBlocked(admin, pidFilter) {
  const r = await admin.query("select count(*)::int n from pg_stat_activity where wait_event_type='Lock' and query like $1 and pid<>pg_backend_pid()", [pidFilter]);
  return r.rows[0].n > 0;
}

const admin = await connect();
try {
  // 1. Permission expires while the enqueue waits for the family lock: the post-lock clock must deny it.
  {
    const f = await fixture(admin, { permissionExpiresIn: '2 seconds' });
    const a = await connect('service_role'), b = await connect('service_role');
    await a.query('begin'); await a.query('select sahaj_private.lock_family_authorization($1)', [f.fam]);
    const pending = enqueue(b, f, 'k-expiry');
    await sleep(300); check('expiry: enqueue is blocked behind the family lock', await isBlocked(admin, '%enqueue_authorized_command%'));
    await sleep(3000); await a.query('commit');
    const r = await pending;
    check('expiry: enqueue after lock wait is denied, not authorized with the transaction-start clock', r.ok?.status === 'denied', JSON.stringify(r));
    const o = await admin.query('select count(*)::int n from public.outbox where family_id=$1', [f.fam]);
    const p = await admin.query('select used_count from public.permissions where family_id=$1', [f.fam]);
    check('expiry: nothing reserved or enqueued', o.rows[0].n === 0 && p.rows[0].used_count === 0);
    await a.end(); await b.end();
  }
  // 2. Lease expires while blocked: SJ001, no outbox.
  {
    const f = await fixture(admin, { leaseSeconds: 2 });
    const a = await connect('service_role'), b = await connect('service_role');
    await a.query('begin'); await a.query('select sahaj_private.lock_family_authorization($1)', [f.fam]);
    const pending = enqueue(b, f, 'k-lease'); await sleep(3000); await a.query('commit');
    const r = await pending; check('lease: expired during lock wait raises SJ001', r.err === 'SJ001', JSON.stringify(r));
    await a.end(); await b.end();
  }
  // 3. DELETE of an authorization fact holds the family lock; the waiting enqueue then sees a changed revision.
  {
    const f = await fixture(admin);
    const approver = randomUUID();
    await admin.query("insert into public.people(id,family_id,display_name,role) values($1,$2,'Child','child')", [approver, f.fam]);
    await admin.query('insert into public.action_answers(family_id,action_request_id,approver_person_id,answer) values($1,$2,$3,true)', [f.fam, f.request, approver]);
    f.revision = (await admin.query('select sahaj_private.authorization_revision($1,$2) r', [f.fam, f.request])).rows[0].r;
    const a = await connect('service_role'), b = await connect('service_role');
    await a.query('begin'); await a.query('delete from public.action_answers where action_request_id=$1', [f.request]);
    const pending = enqueue(b, f, 'k-delete');
    await sleep(500); check('delete: enqueue blocks behind an uncommitted DELETE', await isBlocked(admin, '%enqueue_authorized_command%'));
    await a.query('commit');
    const r = await pending; check('delete: stale snapshot rejected after the DELETE commits', r.err === '40001', JSON.stringify(r));
    await a.end(); await b.end();
  }
  // 4. Last quota slot: two jobs, exactly one outbox.
  {
    const f1 = await fixture(admin);
    // Second job and request on the same permission.
    const f2 = { ...f1, job: randomUUID(), lease: randomUUID(), request: randomUUID(), event: randomUUID() };
    await admin.query("insert into public.raw_events(id,family_id,source,provider_event_id,event_type,status,payload_hash) values($1,$2,'whatsapp',$3,'whatsapp.text','processed',$4)", [f2.event, f2.fam, randomUUID(), 'c'.repeat(64)]);
    await admin.query("insert into public.workflow_jobs(id,family_id,raw_event_id,thread_id,workflow_kind,state,lease_token,lease_until) values($1,$2,$3,'t2','core1.atlas','processing',$4,clock_timestamp()+interval '5 minutes')", [f2.job, f2.fam, f2.event, f2.lease]);
    await admin.query("select public.ensure_action_request($1,$2,$3,$4,$5,'check_in',$6::text,$7)", [f2.fam, f2.job, f2.lease, f2.request, f2.subject, f2.subject, f2.fp]);
    f2.revision = (await admin.query('select sahaj_private.authorization_revision($1,$2) r', [f2.fam, f2.request])).rows[0].r;
    const a = await connect('service_role'), b = await connect('service_role');
    const [ra, rb] = await Promise.all([enqueue(a, f1, 'k-q1'), enqueue(b, f2, 'k-q2')]);
    const enq = [ra, rb].filter(r => r.ok?.status === 'enqueued').length;
    const rows = await admin.query('select count(*)::int n from public.outbox where family_id=$1', [f1.fam]);
    const used = await admin.query('select used_count from public.permissions where family_id=$1', [f1.fam]);
    check('quota: exactly one of two concurrent jobs enqueues the last slot', enq === 1 && rows.rows[0].n === 1 && used.rows[0].used_count === 1, JSON.stringify([ra, rb]));
    await a.end(); await b.end();
  }
} finally { await admin.end(); }
process.exit(results.every(r => r.ok) ? 0 : 1);
