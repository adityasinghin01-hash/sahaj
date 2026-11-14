-- AGY-S1: Verification suite for the full synthetic demo family seed (seed_demo.sql + seed_demo_full.sql).
-- Runs after migrations + infra/supabase/dev/seed_demo.sql + infra/supabase/dev/seed_demo_full.sql.
-- Asserts every Core 1, Core 2, and Core 3 demo flow has its prerequisites and fails loudly with which piece is missing.

begin;

do $$
declare
  v_family_id        constant uuid := '11111111-1111-4111-8111-111111111111';
  v_maa_id           constant uuid := '22222222-2222-4222-8222-222222222221';
  v_riya_id          constant uuid := '22222222-2222-4222-8222-222222222222';
  v_rohit_id         constant uuid := '22222222-2222-4222-8222-222222222223';
  v_sharma_id        constant uuid := '22222222-2222-4222-8222-222222222224';
  v_priya_id         constant uuid := '22222222-2222-4222-8222-222222222225';
  v_gupta_person_id  constant uuid := '22222222-2222-4222-8222-222222222226';
  v_principal_id     constant uuid := '44444444-4444-4444-8444-444444444441';
  v_medicine_id      constant uuid := '55555555-5555-4555-8555-555555555551';
  v_vendor_id        constant uuid := '66666666-6666-4666-8666-666666666661';
  v_perm12_id        constant uuid := '77777777-7777-4777-8777-777777777712';
  v_perm12_two_id    constant uuid := '77777777-7777-4777-8777-777777777713';
  v_schedule_id      constant uuid := '99999999-9999-4999-8999-999999999901';
  v_gulmohar_hash    constant text := encode(sha256(convert_to('gulmohar', 'UTF8')), 'hex');

  v_maa              public.people%rowtype;
  v_sched            public.schedules%rowtype;
  v_med              public.medicines%rowtype;
  v_ven              public.vendors%rowtype;
  v_perm12           public.permissions%rowtype;
  v_perm12_two       public.permissions%rowtype;
  v_tc_priya         public.core2_trusted_contacts%rowtype;
  v_prefs            public.core2_sharing_preferences%rowtype;
  v_dev_status       public.core2_device_status%rowtype;
  v_code_hash        text;
  v_sec_meta         jsonb;
  v_offer1           jsonb;
  v_offer2           jsonb;
  v_count            integer;
begin
  -- ==========================================================================
  -- 0. Family & People Prerequisites
  -- ==========================================================================
  if not exists (
    select 1 from public.families
    where id = v_family_id and name = 'Meena Sharma Family' and category = 'akele_ghar'
  ) then
    raise exception 'DEMO_SEED_CHECK FAILED [missing: family]: Meena Sharma Family (11111111-1111-4111-8111-111111111111, category=akele_ghar) not found';
  end if;

  select * into v_maa from public.people where id = v_maa_id and family_id = v_family_id;
  if not found then
    raise exception 'DEMO_SEED_CHECK FAILED [missing: people.maa]: Meena (Maa, 22222222-2222-4222-8222-222222222221) not found';
  end if;
  if v_maa.role <> 'parent' or v_maa.address_form <> 'Mummy ji' or v_maa.language <> 'hi' or v_maa.timezone <> 'Asia/Kolkata' then
    raise exception 'DEMO_SEED_CHECK FAILED [missing: people.maa.profile]: Maa must have role=parent, address_form=Mummy ji, language=hi, timezone=Asia/Kolkata';
  end if;
  if not (v_maa.quiet_windows @> '[{"start":"21:00","end":"08:00"}]'::jsonb) then
    raise exception 'DEMO_SEED_CHECK FAILED [missing: people.maa.quiet_windows]: Maa quiet hours 21:00-08:00 missing from quiet_windows (%)', v_maa.quiet_windows;
  end if;
  if not (v_maa.free_windows @> '[{"start":"18:00","end":"20:00","label":"shaam 6 se 8"}]'::jsonb) then
    raise exception 'DEMO_SEED_CHECK FAILED [missing: people.maa.free_windows]: Maa free time shaam 6 se 8 (18:00-20:00) missing from free_windows (%)', v_maa.free_windows;
  end if;

  if not exists (select 1 from public.people where id = v_riya_id and family_id = v_family_id and role = 'child' and display_name = 'Riya') then
    raise exception 'DEMO_SEED_CHECK FAILED [missing: people.riya]: Riya (child) not found';
  end if;
  if not exists (select 1 from public.people where id = v_rohit_id and family_id = v_family_id and role = 'child' and display_name = 'Rohit') then
    raise exception 'DEMO_SEED_CHECK FAILED [missing: people.rohit]: Rohit (child) not found';
  end if;
  if not exists (select 1 from public.people where id = v_sharma_id and family_id = v_family_id and role = 'circle' and display_name = 'Sharma uncle') then
    raise exception 'DEMO_SEED_CHECK FAILED [missing: people.sharma_uncle]: Sharma uncle (circle) not found';
  end if;
  if not exists (select 1 from public.people where id = v_priya_id and family_id = v_family_id and role = 'circle' and display_name = 'Priya') then
    raise exception 'DEMO_SEED_CHECK FAILED [missing: people.priya]: Priya (circle, Riya friend in Bengaluru) not found';
  end if;
  if not exists (select 1 from public.people where id = v_gupta_person_id and family_id = v_family_id and role = 'vendor' and display_name = 'Gupta Medical') then
    raise exception 'DEMO_SEED_CHECK FAILED [missing: people.gupta_medical]: Gupta Medical (vendor person) not found';
  end if;

  -- Maa has BOTH keypad and smartphone identities/devices
  select count(*) into v_count
  from public.provider_identities
  where family_id = v_family_id and person_id = v_maa_id and binding_kind = 'device' and enabled and revoked_at is null;
  if v_count < 2 then
    raise exception 'DEMO_SEED_CHECK FAILED [missing: maa.two_devices]: Maa needs 2 active device identities (keypad + smartphone) in provider_identities, found %', v_count;
  end if;

  if not exists (
    select 1 from public.shield_devices
    where family_id = v_family_id and person_id = v_maa_id and platform = 'android'
  ) then
    raise exception 'DEMO_SEED_CHECK FAILED [missing: maa.shield_device]: Maa paired Android smartphone missing in public.shield_devices';
  end if;

  if not exists (
    select 1 from public.shield_gateway_parents
    where family_id = v_family_id and parent_id = v_maa_id
      and phone_hash = encode(sha256(convert_to('9000000001', 'UTF8')), 'hex')
  ) then
    raise exception 'DEMO_SEED_CHECK FAILED [missing: maa.keypad_gateway]: Maa keypad gateway registration missing in public.shield_gateway_parents';
  end if;

  -- ==========================================================================
  -- 1. Core 1 ("Pulse") Prerequisites
  -- ==========================================================================
  -- 1a. Active Atlas Principal
  if not exists (
    select 1 from public.atlas_principals
    where id = v_principal_id and family_id = v_family_id and active = true and revoked_at is null
  ) then
    raise exception 'DEMO_SEED_CHECK FAILED [missing: core1.atlas_principal]: Active Atlas principal (44444444-4444-4444-8444-444444444441) not found';
  end if;

  -- 1b. Daily 10:00 IST Check-in Schedule for Maa
  select * into v_sched
  from public.schedules
  where id = v_schedule_id and family_id = v_family_id and person_id = v_maa_id and kind = 'check_in';
  if not found or not v_sched.enabled or v_sched.timezone <> 'Asia/Kolkata' then
    raise exception 'DEMO_SEED_CHECK FAILED [missing: core1.checkin_schedule]: Enabled check_in schedule in Asia/Kolkata for Maa not found';
  end if;
  if extract(hour from (v_sched.next_at at time zone 'Asia/Kolkata')) <> 10
     or extract(minute from (v_sched.next_at at time zone 'Asia/Kolkata')) <> 0 then
    raise exception 'DEMO_SEED_CHECK FAILED [missing: core1.checkin_schedule_time]: Maa check-in schedule must be at 10:00 IST, got %',
      (v_sched.next_at at time zone 'Asia/Kolkata');
  end if;

  -- 1c. Circle Ranks (Rank 1 = Rohit on duty, Rank 2 = Sharma uncle consented & approved)
  if not exists (
    select 1 from public.circle
    where family_id = v_family_id and person_id = v_rohit_id and rank = 1
      and approved_at is not null and consent_at is not null and revoked_at is null
  ) then
    raise exception 'DEMO_SEED_CHECK FAILED [missing: core1.circle.rank1_rohit]: Rohit must be Circle Rank 1 (approved, consented, unrevoked)';
  end if;

  if not exists (
    select 1 from public.circle
    where family_id = v_family_id and person_id = v_sharma_id and rank = 2
      and approved_at is not null and consent_at is not null and revoked_at is null
  ) then
    raise exception 'DEMO_SEED_CHECK FAILED [missing: core1.circle.rank2_sharma_uncle]: Sharma uncle must be Circle Rank 2 (approved, consented, unrevoked)';
  end if;

  -- Verify live urgent escalation offer chain: Rank 1 (Rohit) offered first -> on decline, Rank 2 (Sharma uncle) offered next
  begin
    v_offer1 := public.create_urgent_incident_offer(v_family_id, v_maa_id, 'urgent', 3);
    if (v_offer1->>'responder_person_id')::uuid is distinct from v_rohit_id then
      raise exception 'DEMO_SEED_CHECK FAILED [missing: core1.urgent_chain.rank1]: Expected first urgent offer to go to Rohit (%), got %',
        v_rohit_id, v_offer1;
    end if;
    v_offer2 := public.advance_urgent_incident_offer(
      v_family_id,
      (v_offer1->>'incident_id')::uuid,
      (v_offer1->>'assignment_id')::uuid,
      'declined',
      180
    );
    if (v_offer2->>'responder_person_id')::uuid is distinct from v_sharma_id then
      raise exception 'DEMO_SEED_CHECK FAILED [missing: core1.urgent_chain.rank2]: Expected second urgent offer to go to Sharma uncle (%), got %',
        v_sharma_id, v_offer2;
    end if;
    -- Clean up test incident rows created inside this check
    delete from public.assignments where incident_id = (v_offer1->>'incident_id')::uuid;
    delete from public.incidents where id = (v_offer1->>'incident_id')::uuid;
  end;

  -- 1d. Medicine (Amlodipine 5 mg, remaining_count = 6) & Vendor (Gupta Medical)
  select * into v_ven from public.vendors where id = v_vendor_id and family_id = v_family_id;
  if not found or v_ven.person_id <> v_gupta_person_id or v_ven.approved_at is null or v_ven.revoked_at is not null then
    raise exception 'DEMO_SEED_CHECK FAILED [missing: core1.vendor.gupta_medical]: Approved Gupta Medical vendor row (66666666-6666-4666-8666-666666666661) missing';
  end if;

  select * into v_med from public.medicines where id = v_medicine_id and family_id = v_family_id and person_id = v_maa_id;
  if not found or v_med.label <> 'Amlodipine 5 mg' or v_med.remaining_count <> 6 or not v_med.instructions_confirmed_by_person then
    raise exception 'DEMO_SEED_CHECK FAILED [missing: core1.medicine.amlodipine]: Amlodipine 5 mg with remaining_count=6 and confirmed instructions missing (got %)',
      row_to_json(v_med);
  end if;
  if v_med.remaining_count > v_med.refill_threshold then
    raise exception 'DEMO_SEED_CHECK FAILED [missing: core1.medicine.refill_threshold]: Amlodipine remaining_count (6) must be <= refill_threshold (%)',
      v_med.refill_threshold;
  end if;

  -- 1e. Permission #12 (refill <= ₹600 = 60000 minor, once a month, Gupta Medical, expires 31 Dec 2026, single-approver inside limit, two-person above)
  select * into v_perm12 from public.permissions where id = v_perm12_id and family_id = v_family_id;
  if not found
     or v_perm12.action <> 'medicine_refill'
     or v_perm12.decision <> 'allow'
     or v_perm12.max_amount_minor <> 60000
     or v_perm12.max_uses <> 1
     or v_perm12.used_count <> 0
     or v_perm12.two_person_required <> false
     or v_perm12.revoked_at is not null
     or not (v_vendor_id::text = any(v_perm12.vendor_ids))
     or not (v_medicine_id::text = any(v_perm12.item_ids))
     or not (v_maa_id::text = any(v_perm12.target_ids))
     or (v_perm12.expires_at at time zone 'Asia/Kolkata')::date <> date '2026-12-31' then
    raise exception 'DEMO_SEED_CHECK FAILED [missing: core1.permission_12]: Permission #12 (<= ₹600, max_uses=1, Gupta Medical, expires 2026-12-31, single-approver) invalid or missing: %',
      row_to_json(v_perm12);
  end if;

  select * into v_perm12_two from public.permissions where id = v_perm12_two_id and family_id = v_family_id;
  if not found
     or v_perm12_two.action <> 'medicine_refill'
     or v_perm12_two.decision <> 'allow'
     or v_perm12_two.two_person_required <> true
     or v_perm12_two.max_amount_minor <= 60000
     or v_perm12_two.revoked_at is not null then
    raise exception 'DEMO_SEED_CHECK FAILED [missing: core1.permission_12_two_person]: Companion two-person medicine_refill permission above ₹600 missing';
  end if;

  -- Core 1 check_in & urgent_responder permissions for dispatch preparation
  if not exists (
    select 1 from public.permissions
    where family_id = v_family_id and person_id = v_maa_id and action = 'check_in'
      and decision = 'allow' and revoked_at is null and used_count < max_uses
  ) then
    raise exception 'DEMO_SEED_CHECK FAILED [missing: core1.permission.check_in]: Active check_in permission for Maa missing';
  end if;

  if not exists (
    select 1 from public.permissions
    where family_id = v_family_id and person_id = v_maa_id and action = 'urgent_responder'
      and decision = 'allow' and revoked_at is null and used_count < max_uses
  ) then
    raise exception 'DEMO_SEED_CHECK FAILED [missing: core1.permission.urgent_responder]: Active urgent_responder permission for Maa missing';
  end if;

  -- 1f. Consents (check_in, call_recording, record_audio, voice_share both ways, ai_disclosure, permission_setup, core2_trusted_contact)
  if sahaj_private.consent_current(v_family_id, v_maa_id, 'check_in') is null then
    raise exception 'DEMO_SEED_CHECK FAILED [missing: consent.check_in]: Maa check_in consent not effective';
  end if;
  if sahaj_private.consent_current(v_family_id, v_maa_id, 'call_recording') is null then
    raise exception 'DEMO_SEED_CHECK FAILED [missing: consent.call_recording]: Maa call_recording consent not effective';
  end if;
  if sahaj_private.consent_current(v_family_id, v_maa_id, 'record_audio') is null then
    raise exception 'DEMO_SEED_CHECK FAILED [missing: consent.record_audio]: Maa record_audio consent not effective';
  end if;
  if sahaj_private.consent_current(v_family_id, v_maa_id, 'voice_share:' || v_riya_id::text) is null then
    raise exception 'DEMO_SEED_CHECK FAILED [missing: consent.voice_share_maa_to_riya]: Maa -> Riya voice_share consent not effective';
  end if;
  if sahaj_private.consent_current(v_family_id, v_riya_id, 'voice_share:' || v_maa_id::text) is null then
    raise exception 'DEMO_SEED_CHECK FAILED [missing: consent.voice_share_riya_to_maa]: Riya -> Maa voice_share consent not effective';
  end if;
  if sahaj_private.consent_current(v_family_id, v_maa_id, 'voice_share:' || v_rohit_id::text) is null then
    raise exception 'DEMO_SEED_CHECK FAILED [missing: consent.voice_share_maa_to_rohit]: Maa -> Rohit voice_share consent not effective';
  end if;
  if sahaj_private.consent_current(v_family_id, v_rohit_id, 'voice_share:' || v_maa_id::text) is null then
    raise exception 'DEMO_SEED_CHECK FAILED [missing: consent.voice_share_rohit_to_maa]: Rohit -> Maa voice_share consent not effective';
  end if;
  if sahaj_private.consent_current(v_family_id, v_maa_id, 'ai_disclosure') is null then
    raise exception 'DEMO_SEED_CHECK FAILED [missing: consent.ai_disclosure]: Maa ai_disclosure consent not effective';
  end if;
  if sahaj_private.consent_current(v_family_id, v_maa_id, 'permission_setup') is null then
    raise exception 'DEMO_SEED_CHECK FAILED [missing: consent.permission_setup]: Maa permission_setup consent not effective';
  end if;
  if sahaj_private.consent_current(v_family_id, v_priya_id, 'core2_trusted_contact') is null then
    raise exception 'DEMO_SEED_CHECK FAILED [missing: consent.core2_trusted_contact]: Priya core2_trusted_contact consent not effective';
  end if;

  -- ==========================================================================
  -- 2. Core 2 (Child Safety) Prerequisites
  -- ==========================================================================
  select * into v_tc_priya
  from public.core2_trusted_contacts
  where family_id = v_family_id and subject_person_id = v_riya_id and contact_person_id = v_priya_id;
  if not found
     or v_tc_priya.rank <> 1
     or v_tc_priya.state <> 'active'
     or v_tc_priya.approved_at is null
     or v_tc_priya.consent_at is null
     or v_tc_priya.consent_id is null
     or v_tc_priya.revoked_at is not null
     or not (v_tc_priya.scopes @> array['sos','watch_escalation','reassurance']) then
    raise exception 'DEMO_SEED_CHECK FAILED [missing: core2.trusted_contact.priya]: Priya must be Riya active Rank 1 trusted contact with sos, watch_escalation, reassurance scopes (got %)',
      row_to_json(v_tc_priya);
  end if;

  select * into v_prefs
  from public.core2_sharing_preferences
  where family_id = v_family_id and subject_person_id = v_riya_id;
  if not found
     or v_prefs.share_status_with_parent <> true
     or v_prefs.allow_narrative_share <> true
     or v_prefs.allow_location_share <> false then
    raise exception 'DEMO_SEED_CHECK FAILED [missing: core2.sharing_preferences]: Riya Core 2 reassurance preferences missing or invalid (got %)',
      row_to_json(v_prefs);
  end if;

  select * into v_dev_status
  from public.core2_device_status
  where family_id = v_family_id and person_id = v_riya_id;
  if not found or v_dev_status.battery_level <> 84 then
    raise exception 'DEMO_SEED_CHECK FAILED [missing: core2.device_status]: Riya Core 2 device status missing';
  end if;

  -- ==========================================================================
  -- 3. Core 3 ("Shield") Prerequisites
  -- ==========================================================================
  select code_word_hash into v_code_hash
  from public.shield_family_security
  where family_id = v_family_id;
  if v_code_hash is distinct from v_gulmohar_hash then
    raise exception 'DEMO_SEED_CHECK FAILED [missing: core3.code_word_gulmohar]: shield_family_security.code_word_hash must equal sha256("gulmohar") (%), got %',
      v_gulmohar_hash, v_code_hash;
  end if;

  select value into v_sec_meta
  from public.dev_cache
  where key = 'shield:family:11111111-1111-4111-8111-111111111111:security_meta';
  if v_sec_meta is null
     or v_sec_meta->>'safe_word_greeting' <> 'Ram Ram Mummy ji'
     or not ((v_sec_meta->'expected_visitors') @> '["doodhwala subah 7 baje", "Gupta Medical delivery"]'::jsonb) then
    raise exception 'DEMO_SEED_CHECK FAILED [missing: core3.expected_visitors_and_greeting]: Safe-word greeting "Ram Ram Mummy ji" or expected visitors ("doodhwala subah 7 baje", "Gupta Medical delivery") missing in dev_cache (%)',
      v_sec_meta;
  end if;

  if not exists (
    select 1 from public.shield_drill_consents
    where family_id = v_family_id and parent_id = v_maa_id and kind = 'experience_drill' and revoked_at is null
  ) then
    raise exception 'DEMO_SEED_CHECK FAILED [missing: core3.experience_drill_consent]: Maa active experience_drill consent missing';
  end if;

  if not exists (
    select 1 from public.shield_experience_settings
    where family_id = v_family_id and parent_id = v_maa_id and experience_drills_enabled = true
  ) then
    raise exception 'DEMO_SEED_CHECK FAILED [missing: core3.experience_drill_settings]: Maa experience_drills_enabled setting missing';
  end if;

  -- ==========================================================================
  -- 4. Ground Rule #1 Guard: No plaintext phone numbers in domain rows
  -- ==========================================================================
  if exists (
    select 1 from public.people
    where family_id = v_family_id
      and (display_name ~ '[0-9]{10}' or coalesce(hearing_notes, '') ~ '[0-9]{10}' or coalesce(address_form, '') ~ '[0-9]{10}')
  ) then
    raise exception 'DEMO_SEED_CHECK FAILED [ground_rule_1: plaintext_phone_in_people]: Plaintext 10-digit phone number found in public.people';
  end if;

  -- Verify all 6 demo people have encrypted contact identities for Sarvam/WhatsApp/Twilio
  select count(distinct person_id) into v_count
  from public.provider_identities
  where family_id = v_family_id and binding_kind = 'contact' and enabled and revoked_at is null;
  if v_count < 6 then
    raise exception 'DEMO_SEED_CHECK FAILED [missing: provider_identities.contacts]: Expected encrypted contact identities for all 6 demo people, found %', v_count;
  end if;
end;
$$;

select 'PASS demo_seed_check' as status;

rollback;
