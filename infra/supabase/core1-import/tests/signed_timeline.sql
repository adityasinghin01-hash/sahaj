-- Cross-language fixtures signed once by Node Ed25519; ephemeral private key discarded.
-- Public key: MCowBQYDK2VwAyEAiZevVmXHlUIiWLQZbsPVisxnuZqqq26E3nKO5Igeyt0=
-- The database verifies hashes/CAS, while the application verifies Ed25519 signatures.
begin;
insert into public.families(id,name) values
 ('b2000000-0000-4000-8000-000000000001','Synthetic Timeline Family A'),
 ('b2000000-0000-4000-8000-000000000002','Synthetic Timeline Family B');
set local role service_role;
do $$declare
  e1 jsonb:='{"familyId":"b2000000-0000-4000-8000-000000000001","eventId":"d2000000-0000-4000-8000-000000000001","sequence":1,"dedupeKey":"synthetic-signed-1","eventType":"checkin.completed","entityId":null,"humanLine":"Synthetic AI check-in complete.","previousHash":null,"occurredAt":"2026-11-14T12:00:00.000Z","keyId":"synthetic-test-key","version":1,"payloadHash":"e33c9d06a1605b0b8afbfddc7e7d6bf03e941d1ffd21093dfa5ae2fac40befc1"}';
  e2 jsonb:='{"familyId":"b2000000-0000-4000-8000-000000000001","eventId":"d2000000-0000-4000-8000-000000000002","sequence":2,"dedupeKey":"synthetic-signed-2","eventType":"checkin.completed","entityId":null,"humanLine":"Synthetic AI check-in complete.","previousHash":"96c83d9a751cf3da26f256705a4cb7fb3005629f72f0677d765534e50f5b0aec","occurredAt":"2026-11-14T12:00:00.000Z","keyId":"synthetic-test-key","version":1,"payloadHash":"e33c9d06a1605b0b8afbfddc7e7d6bf03e941d1ffd21093dfa5ae2fac40befc1"}';
  h1 text:='96c83d9a751cf3da26f256705a4cb7fb3005629f72f0677d765534e50f5b0aec';
  h2 text:='b214cc440bedc202933c4304cce4db8dac7e96833aed84392bbfdb19638f3377';
  s1 text:='QfK2c6qVgEdFanWVv96DTuGEHPPZscNEJ/ITC15hd5Uh59zQblc7TP2fnZhoTAQ1Io03sdD1QXIx0R1KCwZ2Bw==';
  s2 text:='MX3lHBmcVcOk66A7JQeWBA7rAfX0P63YpZ3I2tzwLVqn9GTVkDOksUTUq67MuEQoOTKqFwxxGbfihbHHkCZQCw==';
  payload text:='{"synthetic":true}';r public.timeline_events;dup public.timeline_events;changed jsonb;changed_hash text;
begin
  r:=public.append_timeline_event(e1,payload,h1,s1);
  if r.sequence<>1 or r.chain_hash<>h1 then raise exception 'FAIL first append';end if;
  dup:=public.append_timeline_event(e1,payload,h1,s1);
  if dup.id<>r.id then raise exception 'FAIL idempotent timeline append';end if;
  begin
    perform public.append_timeline_event(e1,payload,h1,s2);
    raise exception 'FAIL duplicate immutable signature conflict';
  exception when unique_violation then null;end;
  begin
    perform public.append_timeline_event(e2,'{"synthetic":false}',h2,s2);
    raise exception 'FAIL payload hash mismatch accepted';
  exception when invalid_parameter_value then null;end;
  changed:=jsonb_set(e1,'{eventId}','"d2000000-0000-4000-8000-000000000003"');
  changed:=jsonb_set(changed,'{dedupeKey}','"synthetic-stale-head"');
  changed_hash:=encode(sha256(convert_to(E'SAHAJ.timeline.chain.v1\n'||sahaj_private.timeline_envelope_canonical(changed),'UTF8')),'hex');
  begin
    perform public.append_timeline_event(changed,payload,changed_hash,s1);
    raise exception 'FAIL stale head append accepted';
  exception when serialization_failure then null;end;
  changed:=jsonb_set(e2,'{familyId}','"b2000000-0000-4000-8000-000000000002"');
  changed_hash:=encode(sha256(convert_to(E'SAHAJ.timeline.chain.v1\n'||sahaj_private.timeline_envelope_canonical(changed),'UTF8')),'hex');
  begin
    perform public.append_timeline_event(changed,payload,changed_hash,s2);
    raise exception 'FAIL cross-family previous head accepted';
  exception when serialization_failure then null;end;
  r:=public.append_timeline_event(e2,payload,h2,s2);
  if r.sequence<>2 or (select last_chain_hash from public.timeline_stream_heads where family_id=r.family_id)<>h2 then raise exception 'FAIL next append';end if;
  -- Service code cannot sidestep the serialized append routine.
  begin update public.timeline_stream_heads set last_sequence=0;raise exception 'FAIL direct head write';
  exception when insufficient_privilege then null;end;
  begin delete from public.timeline_events where id=r.id;raise exception 'FAIL service audit deletion';
  exception when insufficient_privilege then null;end;
end$$;
reset role;
-- Even the table owner cannot rewrite or delete audit rows through ordinary DML.
do $$begin
  begin
    update public.timeline_events set human_line='tampered' where id='d2000000-0000-4000-8000-000000000001';
    raise exception 'FAIL append-only timeline trigger';
  exception when integrity_constraint_violation then null;end;
end$$;
set local role authenticated;
do $$begin
  begin perform * from public.timeline_events;raise exception 'FAIL timeline private content readable';
  exception when insufficient_privilege then null;end;
  begin perform * from public.timeline_stream_heads;raise exception 'FAIL client head readable';
  exception when insufficient_privilege then null;end;
  begin perform public.append_timeline_event('{}','{}',repeat('a',64),repeat('A',86)||'==');raise exception 'FAIL client append';
  exception when insufficient_privilege then null;end;
end$$;
reset role;
rollback;
