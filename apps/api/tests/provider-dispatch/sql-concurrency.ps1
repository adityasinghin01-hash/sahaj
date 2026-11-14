# Two-session concurrency checks for 20261114201600_phase2_dispatch_recording.sql.
# SCRATCH DATABASE ONLY. This script COMMITS synthetic fixtures (it cannot interleave sessions inside one rolled-back transaction)
# and deletes them at the end. Never point it at the real project.
#   $env:PHASE2_SCRATCH_DATABASE_URL = 'postgresql://...scratch...'
#   powershell -ExecutionPolicy Bypass -File apps/api/tests/provider-dispatch/sql-concurrency.ps1
# Requires psql on PATH. NOT YET EXECUTED by its author (no Postgres available): run after review.
$ErrorActionPreference = 'Stop'
$url = $env:PHASE2_SCRATCH_DATABASE_URL
if (-not $url) { throw 'Set PHASE2_SCRATCH_DATABASE_URL to a scratch database.' }

# psql -f with a temp file prints each statement's result (psql -c only reports the last one on older versions). -q hides command tags.
function Run-File([string]$u, [string]$sql) {
  $f = [IO.Path]::GetTempFileName()
  try { Set-Content -Path $f -Value $sql -Encoding utf8; $o = & psql -q -X -A -t -v ON_ERROR_STOP=1 $u -f $f 2>&1; [pscustomobject]@{ Out = ($o | Out-String).Trim(); Code = $LASTEXITCODE } }
  finally { Remove-Item $f -ErrorAction SilentlyContinue }
}
function First-Line([string]$s) { (($s -split "`n") | ForEach-Object { $_.Trim() } | Where-Object { $_ })[0] }
function Sql([string]$sql) {
  $r = Run-File $url $sql
  if ($r.Code -ne 0) { throw "psql failed: $($r.Out)" }
  First-Line $r.Out
}
function Async([string]$sql) {
  Start-Job -ArgumentList $url, $sql -ScriptBlock {
    param($u, $s)
    $f = [IO.Path]::GetTempFileName(); Set-Content -Path $f -Value $s -Encoding utf8
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $o = & psql -q -X -A -t -v ON_ERROR_STOP=1 $u -f $f 2>&1
    $code = $LASTEXITCODE; Remove-Item $f -ErrorAction SilentlyContinue
    [pscustomobject]@{ Out = ($o | Out-String).Trim(); Ms = $sw.ElapsedMilliseconds; Code = $code }
  }
}function Check($ok, [string]$msg) { if (-not $ok) { throw "FAIL $msg" } else { Write-Host "ok   $msg" } }

$F = 'b9000000-0000-4000-8000-000000000001'; $P = 'c9000000-0000-4000-8000-000000000001'; $R = 'c9000000-0000-4000-8000-000000000002'
$CALL_TW = 'd9000000-0000-4000-8000-000000000001'; $CALL_REC = 'd9000000-0000-4000-8000-000000000002'
$OB1 = 'e9000000-0000-4000-8000-000000000001'; $OB2 = 'e9000000-0000-4000-8000-000000000002'
$L1 = 'f9000000-0000-4000-8000-000000000001'; $L2 = 'f9000000-0000-4000-8000-000000000002'
$INC = 'a9000000-0000-4000-8000-000000000001'; $AR = 'a9000000-0000-4000-8000-000000000002'; $ASG = 'a9000000-0000-4000-8000-000000000003'

function Cleanup {
  Sql "delete from public.assignments where family_id='$F'; alter table public.raw_events disable trigger raw_events_guard_proof; delete from public.raw_events where family_id='$F'; alter table public.raw_events enable trigger raw_events_guard_proof;
       delete from public.dispatch_ledger where family_id='$F'; alter table public.dispatch_bindings disable trigger dispatch_bindings_immutable;
       delete from public.dispatch_bindings where family_id='$F'; alter table public.dispatch_bindings enable trigger dispatch_bindings_immutable;
       delete from public.outbox where family_id='$F'; delete from public.action_requests where family_id='$F'; delete from public.incidents where family_id='$F';
       delete from sahaj_private.call_content where family_id='$F'; alter table public.consents disable trigger consents_append_only;
       delete from public.consents where family_id='$F'; alter table public.consents enable trigger consents_append_only;
       delete from public.provider_identities where family_id='$F'; delete from public.calls where family_id='$F'; delete from public.people where family_id='$F'; delete from public.families where id='$F';" | Out-Null
}
try {
  Cleanup
  Sql "insert into public.families(id,name) values('$F','Synthetic concurrency');
       insert into public.people(id,family_id,display_name,role) values('$P','$F','Synthetic Parent','parent'),('$R','$F','Synthetic Responder','circle');
       insert into public.calls(id,family_id,person_id,provider) values('$CALL_TW','$F','$R','twilio'),('$CALL_REC','$F','$P','twilio');
       insert into public.incidents(id,family_id,person_id,severity) values('$INC','$F','$P','urgent');
       insert into public.action_requests(id,family_id,person_id,action,expires_at) values('$AR','$F','$P','urgent_responder',now()+interval '1 hour');
       insert into public.assignments(id,family_id,incident_id,person_id,expires_at) values('$ASG','$F','$INC','$R',now()+interval '1 hour');
       insert into public.outbox(id,family_id,kind,dedupe_key,payload_ciphertext,status,attempt_count,lease_token,lease_until,action_request_id) values
         ('$OB1','$F','call','conc1','x','processing',1,'$L1',now()+interval '10 minutes','$AR'),('$OB2','$F','call','conc2','x','processing',1,'$L2',now()+interval '10 minutes',null);
       alter table public.outbox add column if not exists action text; alter table public.outbox add column if not exists incident_id uuid;
       update public.outbox set action='urgent_responder', incident_id='$INC' where id='$OB1'; update public.outbox set action='check_in' where id='$OB2';
       select public.bind_outbox_dispatch('$F','$OB1','$R','twilio','twilio.create_call','$CALL_TW','$INC','$ASG');
       select public.bind_outbox_dispatch('$F','$OB2','$P','twilio','twilio.create_call','$CALL_REC');" | Out-Null

  # 1. Two workers claim the same dispatch key at once: exactly one claims.
  $claim = "begin; select public.claim_dispatch('$F','$R','dispatch:conc1:a1','twilio','twilio.create_call','$OB1','$L1','$CALL_TW'); select pg_sleep(1.5); commit;"
  $jobs = 1..2 | ForEach-Object { Async $claim }; $res = $jobs | Receive-Job -Wait -AutoRemoveJob
  $outs = ($res | ForEach-Object { First-Line $_.Out }) | Sort-Object
  Check (($outs -join ',') -eq 'claimed,duplicate') "claim race yields exactly one 'claimed' ($($outs -join ','))"
  Check ([int](Sql "select count(*) from public.dispatch_ledger where outbox_id='$OB1'") -eq 1) 'one ledger row for the outbox'

  # 2. Responder acceptance replays in parallel return one proof and accept once.
  Sql "select public.complete_dispatch('$F','dispatch:conc1:a1','CA$('d' * 32)','AC$('a' * 32)','$('c' * 64)',true);
       insert into public.raw_events(family_id,source,provider_event_id,event_type,metadata,status) values
        ('$F','twilio','ACX:gather:CAX','twilio.gather.response',jsonb_build_object('call_id','$CALL_TW','person_id','$R','digit','1'),'processed');" | Out-Null
  $acc = "select public.record_responder_acceptance('$F','ACX:gather:CAX')->>'proof_event_id';"
  $res = (1..4 | ForEach-Object { Async $acc }) | Receive-Job -Wait -AutoRemoveJob
  $ids = $res | ForEach-Object { First-Line $_.Out } | Sort-Object -Unique
  Check ($ids.Count -eq 1 -and $res.Code -notcontains 1) 'parallel Gather replays produce one proof id'
  Check ((Sql "select public.accept_assignment_verified('$F','$ASG','$($ids[0])')") -eq 't') 'assignment accepted by the proof'
  $res = (1..3 | ForEach-Object { Async "select public.accept_assignment_verified('$F','$ASG','$($ids[0])');" }) | Receive-Job -Wait -AutoRemoveJob
  Check (($res | Where-Object { (First-Line $_.Out) -ne 't' }).Count -eq 0) 'parallel accept replays stay idempotent'
  Check ([int](Sql "select count(*) from public.assignments where verified_by_provider_event='$($ids[0])'") -eq 1) 'event verifies exactly one assignment'

  # 3. Two simultaneous FIRST recordings: one stored, one ignored_additional, never a unique violation.
  Sql "insert into public.consents(family_id,person_id,call_id,purpose,question,answer,version,created_at) values('$F','$P','$CALL_REC','call_recording','Synthetic?',true,'v1',now()-interval '1 hour');" | Out-Null
  $yes = Sql "select id from public.consents where call_id='$CALL_REC' and answer"
  $p1 = "$F/calls/$CALL_REC/$('1' * 32).wav"; $p2 = "$F/calls/$CALL_REC/$('2' * 32).wav"
  $a = Async "begin; select public.put_call_recording('$F','$CALL_REC','$yes','$p1',now()+interval '30 days','$('1' * 64)'); select pg_sleep(1.5); commit;"
  $b = Async "begin; select public.put_call_recording('$F','$CALL_REC','$yes','$p2',now()+interval '30 days','$('2' * 64)'); select pg_sleep(1.5); commit;"
  $res = @($a, $b) | Receive-Job -Wait -AutoRemoveJob
  Check ($res.Code -notcontains 1) 'no unique violation or error from the recording race'
  $outs = ($res | ForEach-Object { First-Line $_.Out }) | Sort-Object
  Check (($outs -join ',') -eq 'ignored_additional,stored') "first-recording race yields stored + ignored_additional ($($outs -join ','))"

  # 4. A refusal inserted while a recording write is in flight serializes behind it (person lock), so the write saw consistent history.
  Sql "delete from sahaj_private.call_content where family_id='$F' and call_id='$CALL_REC';" | Out-Null
  $w = Async "begin; select public.put_call_recording('$F','$CALL_REC','$yes','$p1',now()+interval '30 days','$('1' * 64)'); select pg_sleep(3); commit;"
  Start-Sleep -Milliseconds 1000
  $refusal = Async "insert into public.consents(family_id,person_id,call_id,purpose,question,answer,version) values('$F','$P',null,'call_recording','Synthetic withdrawal',false,'v1');"
  $res = @($w, $refusal) | Receive-Job -Wait -AutoRemoveJob
  Check ($res[1].Ms -ge 1500) "refusal insert waited for the in-flight recording write ($($res[1].Ms) ms)"
  Check ((Sql "select count(*) from public.list_recording_purge_candidates(10,null) where call_id='$CALL_REC' and reason='consent'") -eq '1') 'the refusal makes the stored recording a purge candidate'
  Write-Host 'ALL CONCURRENCY CHECKS PASSED'
}
finally { try { Cleanup } catch { Write-Warning "cleanup failed: $_" } }
