# Two-session concurrency checks for 20261114201600_phase2_dispatch_recording.sql, in the combined migration order
# (Phase 3 base 201500 -> Phase 2 201600 -> Phase 3 review 210000 -> Phase 3 bridge 213000).
# SCRATCH LOOPBACK DATABASE ONLY. It COMMITS synthetic fixtures (sessions cannot interleave inside one rolled-back transaction)
# under one synthetic family and deletes exactly that family's rows at the start and the end. Never point it at a hosted project.
#   powershell -ExecutionPolicy Bypass -File apps/api/tests/provider-dispatch/sql-concurrency.ps1 `
#     -Psql D:/path/to/psql.exe -HostName 127.0.0.1 -Port 55439 -User postgres -Database postgres
# Nothing is read from the environment or env files. The host must be a loopback address.
param(
  [Parameter(Mandatory = $true)][string]$Psql,
  [Parameter(Mandatory = $true)][string]$HostName,
  [Parameter(Mandatory = $true)][int]$Port,
  [Parameter(Mandatory = $true)][string]$User,
  [Parameter(Mandatory = $true)][string]$Database
)
$ErrorActionPreference = 'Stop'
if ($HostName -notin @('127.0.0.1', 'localhost', '::1')) { throw 'Refusing a non-loopback host: this script is for a disposable scratch database only.' }
if (-not (Test-Path $Psql)) { throw "psql not found at $Psql" }
$conn = @('-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-h', $HostName, '-p', "$Port", '-U', $User, '-d', $Database)

function Run-File([string]$sql) {
  $f = [IO.Path]::GetTempFileName()
  try { Set-Content -Path $f -Value $sql -Encoding utf8; $o = & $Psql @conn -f $f 2>&1; [pscustomobject]@{ Out = ($o | Out-String).Trim(); Code = $LASTEXITCODE } }
  finally { Remove-Item $f -ErrorAction SilentlyContinue }
}
function First-Line([string]$s) { @(($s -split "`n") | ForEach-Object { $_.Trim() } | Where-Object { $_ })[0] } # @() so one line is not indexed as a string
function Sql([string]$sql) {
  $r = Run-File $sql
  if ($r.Code -ne 0) { throw "psql failed: $($r.Out)" }
  First-Line $r.Out
}
function Async([string]$sql) {
  Start-Job -ArgumentList $Psql, $conn, $sql -ScriptBlock {
    param($p, $c, $s)
    $f = [IO.Path]::GetTempFileName(); Set-Content -Path $f -Value $s -Encoding utf8
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $o = & $p @c -f $f 2>&1
    $code = $LASTEXITCODE; Remove-Item $f -ErrorAction SilentlyContinue
    [pscustomobject]@{ Out = ($o | Out-String).Trim(); Ms = $sw.ElapsedMilliseconds; Code = $code }
  }
}
function Check($ok, [string]$msg) { if (-not $ok) { throw "FAIL $msg" } else { Write-Host "ok   $msg" } }
# Wait until a session whose query contains $marker is running (so ordering does not depend on job start-up time).
function Wait-Running([string]$marker) {
  for ($i = 0; $i -lt 100; $i++) {
    if ((Sql "select count(*) from pg_stat_activity where state='active' and query like '%$marker%' and pid<>pg_backend_pid()") -ne '0') { return }
    Start-Sleep -Milliseconds 100
  }
  throw "session with marker $marker never started"
}

$F = 'b9000000-0000-4000-8000-000000000001'; $P = 'c9000000-0000-4000-8000-000000000001'; $R = 'c9000000-0000-4000-8000-000000000002'
$CALL_TW = 'd9000000-0000-4000-8000-000000000001'; $CALL_REC = 'd9000000-0000-4000-8000-000000000002'
$OB1 = 'e9000000-0000-4000-8000-000000000001'; $OB2 = 'e9000000-0000-4000-8000-000000000002'
$L1 = 'f9000000-0000-4000-8000-000000000001'; $L2 = 'f9000000-0000-4000-8000-000000000002'
$INC = 'a9000000-0000-4000-8000-000000000001'; $AR = 'a9000000-0000-4000-8000-000000000002'; $ASG = 'a9000000-0000-4000-8000-000000000003'
$PRIN = 'a9000000-0000-4000-8000-000000000004'; $PERM = 'a9000000-0000-4000-8000-000000000005'; $SETUP = 'a9000000-0000-4000-8000-000000000006'

# session_replication_role=replica disables triggers for THIS cleanup session only (superuser on the scratch DB), so the
# append-only / immutable / proof guards stay active for every other session. Only this synthetic family's rows are removed.
function Cleanup {
  Sql "set session_replication_role=replica;
       delete from public.assignments where family_id='$F'; delete from public.raw_events where family_id='$F';
       delete from public.dispatch_ledger where family_id='$F'; delete from public.dispatch_bindings where family_id='$F';
       delete from public.outbox where family_id='$F'; delete from public.action_requests where family_id='$F';
       delete from public.permissions where family_id='$F'; delete from public.atlas_principals where family_id='$F';
       delete from public.incidents where family_id='$F'; delete from sahaj_private.call_content where family_id='$F';
       delete from public.consents where family_id='$F'; delete from public.provider_identities where family_id='$F';
       delete from public.calls where family_id='$F'; delete from public.people where family_id='$F'; delete from public.families where id='$F';
       select 1;" | Out-Null
}
try {
  Cleanup
  # Real Phase 3 authorization facts, so dispatch_ledger_authorize (bridge) admits the claim: active principal, live allow
  # permission covering the stored request, executed + consumed request, offered assignment.
  Sql "insert into public.families(id,name) values('$F','Synthetic concurrency');
       insert into public.people(id,family_id,display_name,role) values('$P','$F','Synthetic Parent','parent'),('$R','$F','Synthetic Responder','circle');
       insert into public.calls(id,family_id,person_id,provider) values('$CALL_TW','$F','$R','twilio'),('$CALL_REC','$F','$P','twilio');
       insert into public.incidents(id,family_id,person_id,severity) values('$INC','$F','$P','urgent');
       insert into public.atlas_principals(id,family_id,label) values('$PRIN','$F','Synthetic principal');
       insert into public.consents(id,family_id,person_id,purpose,question,answer,version,created_at) values('$SETUP','$F','$P','setup','Synthetic setup?',true,'v1',now()-interval '2 hours');
       insert into public.permissions(id,family_id,person_id,action,decision,expires_at,consent_id,principal_id,valid_from,period_start,period_end,max_uses,used_count,target_ids)
         values('$PERM','$F','$P','urgent_responder','allow',now()+interval '1 hour','$SETUP','$PRIN',now()-interval '1 hour',now()-interval '1 hour',now()+interval '1 hour',5,1,array['$R']);
       insert into public.action_requests(id,family_id,person_id,action,status,expires_at,principal_id,target_id,consumed_at)
         values('$AR','$F','$P','urgent_responder','executed',now()+interval '1 hour','$PRIN','$R',now());
       insert into public.assignments(id,family_id,incident_id,person_id,expires_at) values('$ASG','$F','$INC','$R',now()+interval '1 hour');
       insert into public.outbox(id,family_id,kind,dedupe_key,payload_ciphertext,status,attempt_count,lease_token,lease_until,action_request_id,action,incident_id,permission_id) values
         ('$OB1','$F','call','conc1','x','processing',1,'$L1',now()+interval '10 minutes','$AR','urgent_responder','$INC','$PERM'),
         ('$OB2','$F','call','conc2','x','processing',1,'$L2',now()+interval '10 minutes',null,'check_in',null,null);
       select public.bind_outbox_dispatch('$F','$OB1','$R','twilio','twilio.create_call','$CALL_TW',null,'$ASG');
       select public.bind_outbox_dispatch('$F','$OB2','$P','twilio','twilio.create_call','$CALL_REC');" | Out-Null
  $problem = Sql "select coalesce(sahaj_private.dispatch_authorization_problem('$OB1',clock_timestamp()),'ok')"
  Check ($problem -eq 'ok') "fixture satisfies the Phase 3 dispatch authorization ($problem)"

  # 1. Two workers claim the same dispatch key at once: exactly one claims, through the Phase 3 authorization trigger.
  $claim = "begin; select public.claim_dispatch('$F','$R','dispatch:conc1:a1','twilio','twilio.create_call','$OB1','$L1','$CALL_TW'); select pg_sleep(1.5); commit;"
  $res = (1..2 | ForEach-Object { Async $claim }) | Receive-Job -Wait -AutoRemoveJob
  Check ($res.Code -notcontains 1) "no claim errored ($(($res | ForEach-Object { First-Line $_.Out }) -join ' | '))"
  $outs = ($res | ForEach-Object { First-Line $_.Out }) | Sort-Object
  Check (($outs -join ',') -eq 'claimed,duplicate') "claim race yields exactly one 'claimed' ($($outs -join ','))"
  Check ([int](Sql "select count(*) from public.dispatch_ledger where outbox_id='$OB1'") -eq 1) 'one ledger row for the outbox'
  # A second key for the same outbox, concurrently with nothing, is still a duplicate (one live row per outbox).
  Check ((Sql "select public.claim_dispatch('$F','$R','dispatch:conc1:a2','twilio','twilio.create_call','$OB1','$L1','$CALL_TW')") -eq 'duplicate') 'second key for the same outbox is a duplicate'

  # 2. Responder acceptance replays in parallel return one proof and accept once.
  Sql "select public.complete_dispatch('$F','dispatch:conc1:a1','CA$('d' * 32)','AC$('a' * 32)','$('c' * 64)',true);
       insert into public.raw_events(family_id,source,provider_event_id,event_type,metadata,status) values
        ('$F','twilio','ACX:gather:CAX','twilio.gather.response',jsonb_build_object('call_id','$CALL_TW','person_id','$R','digit','1'),'processed');" | Out-Null
  $acc = "select public.record_responder_acceptance('$F','ACX:gather:CAX')->>'proof_event_id';"
  $res = (1..4 | ForEach-Object { Async $acc }) | Receive-Job -Wait -AutoRemoveJob
  Check ($res.Code -notcontains 1) "no acceptance replay errored ($(($res | ForEach-Object { First-Line $_.Out }) -join ' | '))"
  $ids = @($res | ForEach-Object { First-Line $_.Out } | Sort-Object -Unique)
  Check ($ids.Count -eq 1) 'parallel Gather replays produce one proof id'
  Check ((Sql "select public.accept_assignment_verified('$F','$ASG','$($ids[0])')") -eq 't') 'assignment accepted by the proof'
  $res = (1..3 | ForEach-Object { Async "select public.accept_assignment_verified('$F','$ASG','$($ids[0])');" }) | Receive-Job -Wait -AutoRemoveJob
  Check (($res | Where-Object { (First-Line $_.Out) -ne 't' }).Count -eq 0) 'parallel accept replays stay idempotent'
  Check ([int](Sql "select count(*) from public.assignments where verified_by_provider_event='$($ids[0])'") -eq 1) 'event verifies exactly one assignment'
  Check ((Sql "select sahaj_private.outbox_acceptance('$OB1')") -eq 't') 'Phase 3 outbox_acceptance accepts the committed proof'

  # 3. Two simultaneous FIRST recordings: one stored, one ignored_additional, never a unique violation.
  Sql "insert into public.consents(family_id,person_id,call_id,purpose,question,answer,version,created_at) values('$F','$P','$CALL_REC','call_recording','Synthetic?',true,'v1',now()-interval '1 hour');" | Out-Null
  $yes = Sql "select id from public.consents where call_id='$CALL_REC' and answer"
  $p1 = "$F/calls/$CALL_REC/$('1' * 32).wav"; $p2 = "$F/calls/$CALL_REC/$('2' * 32).wav"
  $a = Async "begin; select public.put_call_recording('$F','$CALL_REC','$yes','$p1',now()+interval '30 days','$('1' * 64)'); select pg_sleep(1.5); commit;"
  $b = Async "begin; select public.put_call_recording('$F','$CALL_REC','$yes','$p2',now()+interval '30 days','$('2' * 64)'); select pg_sleep(1.5); commit;"
  $res = @($a, $b) | Receive-Job -Wait -AutoRemoveJob
  Check ($res.Code -notcontains 1) "no unique violation or error from the recording race ($(($res | ForEach-Object { First-Line $_.Out }) -join ' | '))"
  $outs = ($res | ForEach-Object { First-Line $_.Out }) | Sort-Object
  Check (($outs -join ',') -eq 'ignored_additional,stored') "first-recording race yields stored + ignored_additional ($($outs -join ','))"

  # 4. A refusal inserted while a recording write is in flight waits for it (person lock), then makes it a purge candidate.
  Sql "set session_replication_role=replica; delete from sahaj_private.call_content where family_id='$F' and call_id='$CALL_REC'; select 1;" | Out-Null
  $w = Async "begin; select public.put_call_recording('$F','$CALL_REC','$yes','$p1',now()+interval '30 days','$('1' * 64)'); select pg_sleep(4) /*conc-writer*/; commit;"
  Wait-Running 'conc-writer'
  $refusal = Async "insert into public.consents(family_id,person_id,call_id,purpose,question,answer,version) values('$F','$P',null,'call_recording','Synthetic withdrawal',false,'v1');"
  $res = @($w, $refusal) | Receive-Job -Wait -AutoRemoveJob
  Check ($res.Code -notcontains 1) "writer and refusal both committed ($(($res | ForEach-Object { First-Line $_.Out }) -join ' | '))"
  Check ((First-Line $res[0].Out) -eq 'stored') 'in-flight write stored before the refusal'
  Check ($res[1].Ms -ge 1500) "refusal insert waited for the in-flight recording write ($($res[1].Ms) ms)"
  Check ((Sql "select count(*) from public.list_recording_purge_candidates(10,null) where call_id='$CALL_REC' and reason='consent'") -eq '1') 'the refusal makes the stored recording a purge candidate'
  Write-Host 'ALL CONCURRENCY CHECKS PASSED'
}
finally { try { Cleanup } catch { Write-Warning "cleanup failed: $_" } }
