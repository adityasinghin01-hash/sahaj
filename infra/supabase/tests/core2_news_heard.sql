-- AGY-X2 Postgres & RLS verification tests for G8 Gentle News, G9 After-Report, and Heard Proof.
begin;

do $$
declare
  v_fam_a uuid := 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaa1';
  v_fam_b uuid := 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbb2';
  v_riya uuid := '11111111-1111-4111-8111-111111111111';
  v_maa uuid := '22222222-2222-4222-8222-222222222222';
  v_sharma uuid := '33333333-3333-4333-8333-333333333333';
  v_fam_b_child uuid := '44444444-4444-4444-8444-444444444444';
  v_user_riya uuid := '55555555-5555-4555-8555-555555555551';
  v_user_maa uuid := '55555555-5555-4555-8555-555555555552';
  v_user_sharma uuid := '55555555-5555-4555-8555-555555555553';
  v_user_other uuid := '55555555-5555-4555-8555-555555555554';
  v_incident uuid := '66666666-6666-4666-8666-666666666661';
  v_raw_1 uuid := '77777777-7777-4777-8777-777777777771';
  v_raw_2 uuid := '77777777-7777-4777-8777-777777777772';
  v_raw_3 uuid := '77777777-7777-4777-8777-777777777773';
  v_consent_id uuid := '77777777-7777-4777-8777-777777777774';
  v_reassure_id uuid := '88888888-8888-4888-8888-888888888881';
  v_voice_id uuid := '99999999-9999-4999-8999-999999999991';
  v_failed boolean := false;
  v_rec record;
  v_count integer;
begin
  insert into auth.users (id) values
    (v_user_riya),
    (v_user_maa),
    (v_user_sharma),
    (v_user_other);

  insert into public.families (id, name, language, demo) values
    (v_fam_a, 'Sharma-Riya Family', 'hi', true),
    (v_fam_b, 'Other Family', 'hi', true);

  insert into public.people (id, family_id, display_name, role, device, timezone) values
    (v_riya, v_fam_a, 'Riya', 'child', 'smartphone', 'Asia/Kolkata'),
    (v_maa, v_fam_a, 'Meena Maa', 'parent', 'smartphone', 'Asia/Kolkata'),
    (v_sharma, v_fam_a, 'Sharma Uncle', 'circle', 'keypad', 'Asia/Kolkata'),
    (v_fam_b_child, v_fam_b, 'Other Child', 'child', 'smartphone', 'Asia/Kolkata');

  insert into public.family_memberships (family_id, person_id, user_id, role) values
    (v_fam_a, v_riya, v_user_riya, 'child'),
    (v_fam_a, v_maa, v_user_maa, 'parent'),
    (v_fam_a, v_sharma, v_user_sharma, 'circle'),
    (v_fam_b, v_fam_b_child, v_user_other, 'child');

  insert into public.raw_events (id, family_id, source, provider_event_id, event_type, payload_hash, metadata, status) values
    (v_raw_1, v_fam_a, 'test', 'raw-1', 'core2.news', repeat('a', 64), '{}'::jsonb, 'processed'),
    (v_raw_2, v_fam_a, 'test', 'raw-2', 'core2.heard.device', repeat('b', 64), '{}'::jsonb, 'processed'),
    (v_raw_3, v_fam_a, 'test', 'raw-3', 'core2.heard.twilio', repeat('c', 64), '{}'::jsonb, 'processed');

  insert into public.incidents (
    id, family_id, person_id, owner_person_id, state, severity
  ) values (
    v_incident, v_fam_a, v_riya, v_sharma, 'accepted', 'urgent'
  );

  insert into public.consents (
    id, family_id, person_id, purpose, question, answer, version
  ) values (
    v_consent_id, v_fam_a, v_riya, 'voice_share:parent', 'Share voice note with Maa?', true, 'v1'
  );

  insert into public.voice_posts (
    id, family_id, sender_id, recipient_id, state, consent_id
  ) values (
    v_voice_id, v_fam_a, v_riya, v_maa, 'delivered', v_consent_id
  );

  insert into public.core2_reassurance_updates (
    id, family_id, subject_person_id, recipient_person_id,
    kind, voice_post_id, status_label, delivery_status, delivery_verified, heard_verified
  ) values (
    v_reassure_id, v_fam_a, v_riya, v_maa,
    'im_safe', v_voice_id, 'Main safe hoon Maa', 'sent', false, false
  );

  insert into public.core2_gentle_news (
    family_id, incident_id, subject_person_id, parent_person_id, marked_by_person_id,
    status, calm_summary, voice_post_id, circle_person_id, circle_offer_status, maa_call_due_at, raw_event_id
  ) values (
    v_fam_a, v_incident, v_riya, v_maa, v_riya,
    'circle_offered', 'Riya ko chhoti chot lagi hai, doctor dekh rahe hain.', v_voice_id, v_sharma, 'offered',
    now() + interval '5 minutes', v_raw_1
  );

  insert into public.core2_after_reports (
    family_id, incident_id, closed_at, report_json, zapier_z3_status
  ) values (
    v_fam_a, v_incident, now(), '{"schema_version":"sahaj.after_report.v1"}'::jsonb, 'skipped'
  );

  -- 1. Constraint: smartphone ack requires played_duration_s >= clip_duration_s
  v_failed := false;
  begin
    insert into public.core2_heard_receipts (
      family_id, message_kind, delivery_id, recipient_person_id, channel, evidence_type,
      device_id, clip_duration_s, played_duration_s, raw_event_id, heard_at
    ) values (
      v_fam_a, 'core2_reassurance', v_reassure_id, v_maa, 'smartphone_app', 'device_signed_playback_end',
      'dev-1', 14, 10, v_raw_2, now()
    );
  exception when check_violation then
    v_failed := true;
  end;
  if not v_failed then
    raise exception 'expected smartphone ack with played < clip to fail check constraint';
  end if;

  -- 2. Constraint: Twilio gather requires DTMF digit
  v_failed := false;
  begin
    insert into public.core2_heard_receipts (
      family_id, message_kind, delivery_id, recipient_person_id, channel, evidence_type,
      call_sid, clip_duration_s, played_duration_s, dtmf_digit, raw_event_id, heard_at
    ) values (
      v_fam_a, 'core1_voice_post', v_voice_id, v_maa, 'keypad_twilio', 'twilio_gather_after_playback',
      'CA0001', 14, 14, null, v_raw_3, now()
    );
  exception when check_violation then
    v_failed := true;
  end;
  if not v_failed then
    raise exception 'expected twilio_gather_after_playback without dtmf_digit to fail';
  end if;

  -- 3. Constraint: Twilio status requires CallDuration >= clip_duration_s
  v_failed := false;
  begin
    insert into public.core2_heard_receipts (
      family_id, message_kind, delivery_id, recipient_person_id, channel, evidence_type,
      call_sid, clip_duration_s, played_duration_s, raw_event_id, heard_at
    ) values (
      v_fam_a, 'core1_voice_post', v_voice_id, v_maa, 'keypad_twilio', 'twilio_status_duration_gte_clip',
      'CA0002', 14, 8, v_raw_3, now()
    );
  exception when check_violation then
    v_failed := true;
  end;
  if not v_failed then
    raise exception 'expected twilio_status_duration_gte_clip with played < clip to fail';
  end if;

  -- 4. Atomic RPC updates reassurance + voice_post and is idempotent
  select * into v_rec from public.core2_record_heard_receipt(
    v_fam_a, 'core2_reassurance', v_reassure_id, v_reassure_id, v_voice_id, null,
    v_maa, 'smartphone_app', 'device_signed_playback_end', 'dev-1', null,
    14, 15, null, v_raw_2, now()
  );
  if v_rec.already_recorded is not false then
    raise exception 'expected first receipt insert already_recorded = false';
  end if;

  select count(*) into v_count
  from public.core2_reassurance_updates
  where id = v_reassure_id and heard_verified = true and delivery_verified = true;
  if v_count <> 1 then
    raise exception 'expected reassurance heard_verified=true';
  end if;

  select count(*) into v_count
  from public.voice_posts
  where id = v_voice_id and state = 'heard';
  if v_count <> 1 then
    raise exception 'expected voice_posts.state=heard';
  end if;

  select * into v_rec from public.core2_record_heard_receipt(
    v_fam_a, 'core2_reassurance', v_reassure_id, v_reassure_id, v_voice_id, null,
    v_maa, 'smartphone_app', 'device_signed_playback_end', 'dev-1', null,
    14, 15, null, v_raw_2, now()
  );
  if v_rec.already_recorded is not true then
    raise exception 'expected duplicate call already_recorded = true';
  end if;

  -- 5. RLS isolation tests
  set local role authenticated;

  -- Maa must NOT read gentle news
  perform set_config('request.jwt.claims', json_build_object('sub', v_user_maa, 'role', 'authenticated')::text, true);
  select count(*) into v_count from public.core2_gentle_news;
  if v_count <> 0 then
    raise exception 'expected parent Maa to see 0 rows in core2_gentle_news, got %', v_count;
  end if;

  -- Maa CAN read her heard receipt
  select count(*) into v_count from public.core2_heard_receipts;
  if v_count <> 1 then
    raise exception 'expected parent Maa to see 1 heard receipt, got %', v_count;
  end if;

  -- Maa must NOT read child after-reports
  select count(*) into v_count from public.core2_after_reports;
  if v_count <> 0 then
    raise exception 'expected parent Maa to see 0 rows in core2_after_reports, got %', v_count;
  end if;

  -- Assigned circle companion Sharma uncle CAN read gentle news
  perform set_config('request.jwt.claims', json_build_object('sub', v_user_sharma, 'role', 'authenticated')::text, true);
  select count(*) into v_count from public.core2_gentle_news;
  if v_count <> 1 then
    raise exception 'expected assigned circle Sharma uncle to see 1 row in core2_gentle_news, got %', v_count;
  end if;

  -- Riya (child) CAN read gentle news & after-reports
  perform set_config('request.jwt.claims', json_build_object('sub', v_user_riya, 'role', 'authenticated')::text, true);
  select count(*) into v_count from public.core2_after_reports;
  if v_count <> 1 then
    raise exception 'expected child Riya to see 1 row in core2_after_reports, got %', v_count;
  end if;

  -- Cross-family child sees 0 rows across all 3 tables
  perform set_config('request.jwt.claims', json_build_object('sub', v_user_other, 'role', 'authenticated')::text, true);
  select count(*) into v_count from public.core2_gentle_news;
  if v_count <> 0 then
    raise exception 'expected cross-family user to see 0 gentle_news rows';
  end if;
  select count(*) into v_count from public.core2_heard_receipts;
  if v_count <> 0 then
    raise exception 'expected cross-family user to see 0 heard_receipts rows';
  end if;
  select count(*) into v_count from public.core2_after_reports;
  if v_count <> 0 then
    raise exception 'expected cross-family user to see 0 after_reports rows';
  end if;

  reset role;
end
$$;

rollback;
