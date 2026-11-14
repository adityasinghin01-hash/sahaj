-- AGY-S1: Full synthetic demo family seed for all 3 cores (Core 1 Pulse, Core 2 Child Safety, Core 3 Shield).
-- Runs AFTER infra/supabase/dev/seed_demo.sql. Idempotent (safe to re-run without errors or duplicate rows).
-- Synthetic data only (+919000000001..+919000000006 encrypted under the disposable test-only fixture key from README.md).

-- ============================================================================
-- 1. Synthetic Auth Users (auth.users)
-- ============================================================================
insert into auth.users (id) values
  ('33333333-3333-4333-8333-333333333331'), -- Meena ("Maa")
  ('33333333-3333-4333-8333-333333333332'), -- Riya (daughter, Bengaluru)
  ('33333333-3333-4333-8333-333333333333'), -- Rohit (son, Pune, on duty)
  ('33333333-3333-4333-8333-333333333334'), -- Sharma uncle (neighbour, Lucknow)
  ('33333333-3333-4333-8333-333333333335'), -- Priya (Riya's local friend in Bengaluru, Core 2 trusted contact rank 1)
  ('33333333-3333-4333-8333-333333333336')  -- Gupta Medical (approved pharmacy vendor)
on conflict (id) do nothing;

-- ============================================================================
-- 2. Family (Meena Sharma Family — Akele Ghar)
-- ============================================================================
insert into public.families (id, name, category)
values ('11111111-1111-4111-8111-111111111111', 'Meena Sharma Family', 'akele_ghar')
on conflict (id) do update
  set name = excluded.name,
      category = excluded.category;

-- ============================================================================
-- 3. People (Meena "Maa", Riya, Rohit, Sharma uncle, Priya, Gupta Medical)
-- ============================================================================
insert into public.people (
  id, family_id, display_name, role, device, timezone,
  address_form, language, hearing_notes, quiet_windows, free_windows, aliases
) values
  (
    '22222222-2222-4222-8222-222222222221',
    '11111111-1111-4111-8111-111111111111',
    'Meena',
    'parent',
    'keypad',
    'Asia/Kolkata',
    'Mummy ji',
    'hi',
    'Age 67 · Akele Ghar (lives alone, Lucknow) · Lava keypad + Android smartphone · Safe-word greeting: Ram Ram Mummy ji',
    '[{"start":"21:00","end":"08:00","timezone":"Asia/Kolkata"}]'::jsonb,
    '[{"start":"18:00","end":"20:00","label":"shaam 6 se 8","timezone":"Asia/Kolkata","expected_visitors":["doodhwala subah 7 baje","Gupta Medical delivery"],"safe_word_greeting":"Ram Ram Mummy ji"}]'::jsonb,
    array['Maa','Meena','Mummy','Mummy ji','Meena ji']
  ),
  (
    '22222222-2222-4222-8222-222222222222',
    '11111111-1111-4111-8111-111111111111',
    'Riya',
    'child',
    'smartphone',
    'Asia/Kolkata',
    'Riya',
    'en',
    'Daughter · Bengaluru · Core 2 subject',
    '[{"start":"23:00","end":"07:00","timezone":"Asia/Kolkata"}]'::jsonb,
    '[{"start":"19:00","end":"21:00","label":"evening","timezone":"Asia/Kolkata"}]'::jsonb,
    array['Riya','Beti']
  ),
  (
    '22222222-2222-4222-8222-222222222223',
    '11111111-1111-4111-8111-111111111111',
    'Rohit',
    'child',
    'smartphone',
    'Asia/Kolkata',
    'Rohit',
    'en',
    'Son · Pune · On duty this week (circle rank 1 for Maa)',
    '[{"start":"23:00","end":"07:00","timezone":"Asia/Kolkata"}]'::jsonb,
    '[{"start":"19:00","end":"21:00","label":"evening","timezone":"Asia/Kolkata"}]'::jsonb,
    array['Rohit','Beta']
  ),
  (
    '22222222-2222-4222-8222-222222222224',
    '11111111-1111-4111-8111-111111111111',
    'Sharma uncle',
    'circle',
    'smartphone',
    'Asia/Kolkata',
    'Sharma ji',
    'hi',
    'Neighbour of Maa · Lucknow (3 min away) · Circle rank 2 · Can be offered go to Maa',
    '[{"start":"22:30","end":"06:30","timezone":"Asia/Kolkata"}]'::jsonb,
    '[{"start":"07:00","end":"21:00","label":"daytime","timezone":"Asia/Kolkata"}]'::jsonb,
    array['Sharma uncle','Sharma ji','Sharma']
  ),
  (
    '22222222-2222-4222-8222-222222222225',
    '11111111-1111-4111-8111-111111111111',
    'Priya',
    'circle',
    'smartphone',
    'Asia/Kolkata',
    'Priya',
    'en',
    'Riya local friend in Bengaluru · Core 2 trusted contact rank 1',
    '[{"start":"23:30","end":"07:00","timezone":"Asia/Kolkata"}]'::jsonb,
    '[{"start":"08:00","end":"23:00","label":"daytime","timezone":"Asia/Kolkata"}]'::jsonb,
    array['Priya','Priya friend']
  ),
  (
    '22222222-2222-4222-8222-222222222226',
    '11111111-1111-4111-8111-111111111111',
    'Gupta Medical',
    'vendor',
    'smartphone',
    'Asia/Kolkata',
    'Gupta ji',
    'hi',
    'Approved pharmacy vendor for Maa medicines · Lucknow',
    '[]'::jsonb,
    '[{"start":"08:00","end":"22:00","label":"shop hours","timezone":"Asia/Kolkata"}]'::jsonb,
    array['Gupta Medical','Gupta Chemist','Gupta ji']
  )
on conflict (id) do update
  set display_name  = excluded.display_name,
      role          = excluded.role,
      device        = excluded.device,
      timezone      = excluded.timezone,
      address_form  = excluded.address_form,
      language      = excluded.language,
      hearing_notes = excluded.hearing_notes,
      quiet_windows = excluded.quiet_windows,
      free_windows  = excluded.free_windows,
      aliases       = excluded.aliases;

-- ============================================================================
-- 4. Family Memberships (public.family_memberships)
-- ============================================================================
insert into public.family_memberships (family_id, user_id, person_id, role, revoked_at)
values
  ('11111111-1111-4111-8111-111111111111', '33333333-3333-4333-8333-333333333331', '22222222-2222-4222-8222-222222222221', 'parent', null),
  ('11111111-1111-4111-8111-111111111111', '33333333-3333-4333-8333-333333333332', '22222222-2222-4222-8222-222222222222', 'child',  null),
  ('11111111-1111-4111-8111-111111111111', '33333333-3333-4333-8333-333333333333', '22222222-2222-4222-8222-222222222223', 'child',  null),
  ('11111111-1111-4111-8111-111111111111', '33333333-3333-4333-8333-333333333334', '22222222-2222-4222-8222-222222222224', 'circle', null),
  ('11111111-1111-4111-8111-111111111111', '33333333-3333-4333-8333-333333333335', '22222222-2222-4222-8222-222222222225', 'circle', null)
on conflict (family_id, user_id) do update
  set person_id  = excluded.person_id,
      role       = excluded.role,
      revoked_at = null;

-- ============================================================================
-- 5. Server-Owned AI Principal (public.atlas_principals)
-- ============================================================================
insert into public.atlas_principals (id, family_id, label, active, revoked_at)
values (
  '44444444-4444-4444-8444-444444444441',
  '11111111-1111-4111-8111-111111111111',
  'Aasha Didi (Sahaj Core 1 Assistant)',
  true,
  null
)
on conflict (id) do update
  set label      = excluded.label,
      active     = true,
      revoked_at = null;

-- ============================================================================
-- 6. Core 1 Circle of Care for Maa (public.circle)
--    Rank 1: Rohit (son, Pune, on duty this week)
--    Rank 2: Sharma uncle (neighbour, consented, approved; offered "go to Maa")
--    Rank 3: Riya (daughter, Bengaluru)
-- ============================================================================
insert into public.circle (
  id, family_id, person_id, rank, duty_windows, access, approved_at, consent_at, revoked_at
) values
  (
    'cccccccc-cccc-4ccc-8ccc-cccccccccc01',
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222223', -- Rohit (Rank 1, on duty this week)
    1,
    '[{"days":["mon","tue","wed","thu","fri","sat","sun"],"start":"00:00","end":"23:59","on_duty":true,"city":"Pune"}]'::jsonb,
    'family',
    now() - interval '14 days',
    now() - interval '14 days',
    null
  ),
  (
    'cccccccc-cccc-4ccc-8ccc-cccccccccc02',
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222224', -- Sharma uncle (Rank 2, neighbour, can go to Maa)
    2,
    '[{"days":["mon","tue","wed","thu","fri","sat","sun"],"start":"06:00","end":"23:00","on_duty":false,"city":"Lucknow","offer_go_to_maa":true}]'::jsonb,
    'incident_only',
    now() - interval '14 days',
    now() - interval '14 days',
    null
  ),
  (
    'cccccccc-cccc-4ccc-8ccc-cccccccccc03',
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222', -- Riya (Rank 3, daughter, Bengaluru)
    3,
    '[{"days":["mon","tue","wed","thu","fri","sat","sun"],"start":"00:00","end":"23:59","on_duty":false,"city":"Bengaluru"}]'::jsonb,
    'family',
    now() - interval '14 days',
    now() - interval '14 days',
    null
  )
on conflict (family_id, person_id) do update
  set rank         = excluded.rank,
      duty_windows = excluded.duty_windows,
      access       = excluded.access,
      approved_at  = coalesce(public.circle.approved_at, excluded.approved_at),
      consent_at   = coalesce(public.circle.consent_at, excluded.consent_at),
      revoked_at   = null;

-- ============================================================================
-- 7. Consents (public.consents — append-only, past timestamps only)
--    Covers check-in, recording, voice_share both ways, AI disclosure,
--    permission setup (#12), urgent responder, and Core 2 trusted contact.
-- ============================================================================
insert into public.consents (
  id, family_id, person_id, call_id, turn_id, purpose, question, answer, version, created_at
) values
  (
    '88888888-8888-4888-8888-888888888801',
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222221',
    null,
    'seed-turn-checkin',
    'check_in',
    'Mummy ji, kya Aasha Didi roz subah 10 baje aapka haal-chaal poochne ke liye call kar sakti hain?',
    true,
    'v1',
    now() - interval '20 days'
  ),
  (
    '88888888-8888-4888-8888-888888888802',
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222221',
    null,
    'seed-turn-call-recording',
    'call_recording',
    'Mummy ji, kya hum aapka sandesh Riya aur Rohit ke liye record kar sakte hain?',
    true,
    'v1',
    now() - interval '20 days'
  ),
  (
    '88888888-8888-4888-8888-888888888803',
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222221',
    null,
    'seed-turn-record-audio',
    'record_audio',
    'Mummy ji, kya aap apni aawaaz mein sandesh record karne ki anumati deti hain?',
    true,
    'v1',
    now() - interval '20 days'
  ),
  (
    '88888888-8888-4888-8888-888888888804',
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222221',
    null,
    'seed-turn-voice-maa-to-riya',
    'voice_share:22222222-2222-4222-8222-222222222222',
    'Mummy ji, kya aap apna voice sandesh Riya ke saath bhejna chahti hain?',
    true,
    'v1',
    now() - interval '18 days'
  ),
  (
    '88888888-8888-4888-8888-888888888805',
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
    null,
    'seed-turn-voice-riya-to-maa',
    'voice_share:22222222-2222-4222-8222-222222222221',
    'Riya, do you consent to sharing your recorded voice messages with Maa (Meena)?',
    true,
    'v1',
    now() - interval '18 days'
  ),
  (
    '88888888-8888-4888-8888-888888888806',
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222221',
    null,
    'seed-turn-voice-maa-to-rohit',
    'voice_share:22222222-2222-4222-8222-222222222223',
    'Mummy ji, kya aap apna voice sandesh Rohit ke saath bhejna chahti hain?',
    true,
    'v1',
    now() - interval '18 days'
  ),
  (
    '88888888-8888-4888-8888-888888888807',
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222223',
    null,
    'seed-turn-voice-rohit-to-maa',
    'voice_share:22222222-2222-4222-8222-222222222221',
    'Rohit, do you consent to sharing your recorded voice messages with Maa (Meena)?',
    true,
    'v1',
    now() - interval '18 days'
  ),
  (
    '88888888-8888-4888-8888-888888888808',
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222221',
    null,
    'seed-turn-ai-disclosure',
    'ai_disclosure',
    'Namaste Mummy ji, main Aasha Didi hoon — Sahaj ki AI sahayika, parivaar ki sadasya nahi. Kya aapko yeh spasht hai?',
    true,
    'v1',
    now() - interval '20 days'
  ),
  (
    '88888888-8888-4888-8888-888888888809',
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222221',
    null,
    'seed-turn-permission-setup-maa',
    'permission_setup',
    'Mummy ji, kya Gupta Medical se mahine mein ek baar ₹600 tak Amlodipine 5 mg dawa mangwane ka niyam (#12) chalu rakhein?',
    true,
    'v1',
    now() - interval '15 days'
  ),
  (
    '88888888-8888-4888-8888-888888888810',
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
    null,
    'seed-turn-permission-setup-riya',
    'permission_setup',
    'Riya, do you approve Permission #12 (Amlodipine 5 mg refill <= ₹600 once/month from Gupta Medical, valid through 31 Dec 2026)?',
    true,
    'v1',
    now() - interval '15 days'
  ),
  (
    '88888888-8888-4888-8888-888888888811',
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222224',
    null,
    'seed-turn-circle-sharma',
    'urgent_responder',
    'Sharma ji, kya aap zaroorat padne par Meena ji (Maa) ke ghar jaakar haal dekhne ke liye sahmat hain?',
    true,
    'v1',
    now() - interval '14 days'
  ),
  (
    '88888888-8888-4888-8888-888888888812',
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222223',
    null,
    'seed-turn-circle-rohit',
    'urgent_responder',
    'Rohit, do you consent to being on duty Rank 1 in Maa urgent responder circle and Rank 2 for Riya Core 2 safety?',
    true,
    'v1',
    now() - interval '14 days'
  ),
  (
    '88888888-8888-4888-8888-888888888813',
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222225',
    null,
    'seed-turn-core2-priya',
    'core2_trusted_contact',
    'Priya, do you consent to being Riya Rank 1 local trusted contact in Bengaluru for SOS, late-home watch escalation, and reassurance?',
    true,
    'v1',
    now() - interval '10 days'
  ),
  (
    '88888888-8888-4888-8888-888888888814',
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
    null,
    'seed-turn-core2-riya-reassurance',
    'core2_reassurance',
    'Riya, do you consent to sharing "Main safe hoon" reassurance updates with Maa?',
    true,
    'v1',
    now() - interval '10 days'
  )
on conflict (id) do nothing;

-- ============================================================================
-- 8. Core 1 Daily Check-in Schedule (10:00 IST daily for Maa)
-- ============================================================================
insert into public.schedules (
  id, family_id, person_id, kind, next_at, timezone, enabled
) values (
  '99999999-9999-4999-8999-999999999901',
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222221',
  'check_in',
  (date_trunc('day', now() at time zone 'Asia/Kolkata') + interval '1 day 10 hours') at time zone 'Asia/Kolkata',
  'Asia/Kolkata',
  true
)
on conflict (id) do update
  set next_at  = excluded.next_at,
      timezone = excluded.timezone,
      enabled  = true;

-- ============================================================================
-- 9. Core 1 Vendor (Gupta Medical) & Medicine (Amlodipine 5 mg, 1/day, count 6)
-- ============================================================================
insert into public.vendors (
  id, family_id, person_id, category, approved_at, revoked_at
) values (
  '66666666-6666-4666-8666-666666666661',
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222226',
  'pharmacy',
  now() - interval '30 days',
  null
)
on conflict (id) do update
  set person_id   = excluded.person_id,
      category    = excluded.category,
      approved_at = coalesce(public.vendors.approved_at, excluded.approved_at),
      revoked_at  = null;

insert into public.medicines (
  id, family_id, person_id, label, remaining_count, refill_threshold, instructions_confirmed_by_person
) values (
  '55555555-5555-4555-8555-555555555551',
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222221',
  'Amlodipine 5 mg',
  6,
  7,
  true
)
on conflict (id) do update
  set label                            = excluded.label,
      remaining_count                  = excluded.remaining_count,
      refill_threshold                 = excluded.refill_threshold,
      instructions_confirmed_by_person = excluded.instructions_confirmed_by_person;

-- ============================================================================
-- 10. Core 1 Permissions (Permission #12 + two-person above limit + Core 1 actions)
--     Permission #12: refill <= ₹600 (60000 paise), once a month (max_uses = 1),
--     vendor Gupta Medical, expires 31 Dec 2026, single-approver inside limit,
--     two-person above.
-- ============================================================================
insert into public.permissions (
  id, family_id, person_id, principal_id, action, decision, limits,
  valid_from, expires_at, period_start, period_end,
  max_uses, used_count, max_amount_minor,
  target_ids, vendor_ids, item_ids,
  consent_id, two_person_required, revoked_at, created_at
) values
  (
    '77777777-7777-4777-8777-777777777712',
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222221',
    '44444444-4444-4444-8444-444444444441',
    'medicine_refill',
    'allow',
    '{"rule_id":"#12","title":"Medicine refill <= ₹600","max_amount_minor":60000,"max_amount_inr":600,"cadence":"monthly","max_uses_per_month":1,"vendor_id":"66666666-6666-4666-8666-666666666661","vendor_name":"Gupta Medical","medicine_id":"55555555-5555-4555-8555-555555555551","medicine_label":"Amlodipine 5 mg","dosage":"1 per day","expires_date":"2026-12-31","inside_limit_approval":"single_approver","above_limit_approval":"two_person"}'::jsonb,
    '2026-11-01T00:00:00+05:30'::timestamptz,
    '2026-12-31T23:59:59+05:30'::timestamptz,
    '2026-11-01T00:00:00+05:30'::timestamptz,
    '2026-12-31T23:59:59+05:30'::timestamptz,
    1,
    0,
    60000,
    array['22222222-2222-4222-8222-222222222221'],
    array['66666666-6666-4666-8666-666666666661'],
    array['55555555-5555-4555-8555-555555555551'],
    '88888888-8888-4888-8888-888888888809',
    false,
    null,
    '2026-11-01T10:00:00+05:30'::timestamptz
  ),
  (
    '77777777-7777-4777-8777-777777777713',
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222221',
    '44444444-4444-4444-8444-444444444441',
    'medicine_refill',
    'allow',
    '{"rule_id":"#12-two-person","title":"Medicine refill > ₹600 (two-person approval above limit)","min_amount_minor":60001,"max_amount_minor":500000,"vendor_id":"66666666-6666-4666-8666-666666666661","vendor_name":"Gupta Medical","medicine_id":"55555555-5555-4555-8555-555555555551","expires_date":"2026-12-31","approval_mode":"two_person"}'::jsonb,
    '2026-11-01T00:00:00+05:30'::timestamptz,
    '2026-12-31T23:59:59+05:30'::timestamptz,
    '2026-11-01T00:00:00+05:30'::timestamptz,
    '2026-12-31T23:59:59+05:30'::timestamptz,
    12,
    0,
    500000,
    array['22222222-2222-4222-8222-222222222221'],
    array['66666666-6666-4666-8666-666666666661'],
    array['55555555-5555-4555-8555-555555555551'],
    '88888888-8888-4888-8888-888888888810',
    true,
    null,
    '2026-11-01T10:01:00+05:30'::timestamptz
  ),
  (
    '77777777-7777-4777-8777-777777777701',
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222221',
    '44444444-4444-4444-8444-444444444441',
    'check_in',
    'allow',
    '{"rule_id":"#14","title":"Daily 10:00 IST check-in call to Maa"}'::jsonb,
    '2026-11-01T00:00:00+05:30'::timestamptz,
    '2026-12-31T23:59:59+05:30'::timestamptz,
    '2026-11-01T00:00:00+05:30'::timestamptz,
    '2026-12-31T23:59:59+05:30'::timestamptz,
    365,
    0,
    0,
    array['22222222-2222-4222-8222-222222222221'],
    '{}',
    '{}',
    '88888888-8888-4888-8888-888888888801',
    false,
    null,
    '2026-11-01T10:02:00+05:30'::timestamptz
  ),
  (
    '77777777-7777-4777-8777-777777777702',
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222221',
    '44444444-4444-4444-8444-444444444441',
    'urgent_responder',
    'allow',
    '{"title":"Urgent responder escalation chain for Maa"}'::jsonb,
    '2026-11-01T00:00:00+05:30'::timestamptz,
    '2026-12-31T23:59:59+05:30'::timestamptz,
    '2026-11-01T00:00:00+05:30'::timestamptz,
    '2026-12-31T23:59:59+05:30'::timestamptz,
    100,
    0,
    0,
    array[
      '22222222-2222-4222-8222-222222222221',
      '22222222-2222-4222-8222-222222222222',
      '22222222-2222-4222-8222-222222222223',
      '22222222-2222-4222-8222-222222222224'
    ],
    '{}',
    '{}',
    '88888888-8888-4888-8888-888888888809',
    false,
    null,
    '2026-11-01T10:03:00+05:30'::timestamptz
  ),
  (
    '77777777-7777-4777-8777-777777777703',
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222221',
    '44444444-4444-4444-8444-444444444441',
    'missed_call_nudge',
    'allow',
    '{"title":"Missed-call nudge callback to Maa"}'::jsonb,
    '2026-11-01T00:00:00+05:30'::timestamptz,
    '2026-12-31T23:59:59+05:30'::timestamptz,
    '2026-11-01T00:00:00+05:30'::timestamptz,
    '2026-12-31T23:59:59+05:30'::timestamptz,
    200,
    0,
    0,
    array['22222222-2222-4222-8222-222222222221'],
    '{}',
    '{}',
    '88888888-8888-4888-8888-888888888801',
    false,
    null,
    '2026-11-01T10:04:00+05:30'::timestamptz
  ),
  (
    '77777777-7777-4777-8777-777777777704',
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222221',
    '44444444-4444-4444-8444-444444444441',
    'family_report',
    'allow',
    '{"title":"Family check-in recap report"}'::jsonb,
    '2026-11-01T00:00:00+05:30'::timestamptz,
    '2026-12-31T23:59:59+05:30'::timestamptz,
    '2026-11-01T00:00:00+05:30'::timestamptz,
    '2026-12-31T23:59:59+05:30'::timestamptz,
    365,
    0,
    0,
    array[
      '22222222-2222-4222-8222-222222222221',
      '22222222-2222-4222-8222-222222222222',
      '22222222-2222-4222-8222-222222222223'
    ],
    '{}',
    '{}',
    '88888888-8888-4888-8888-888888888801',
    false,
    null,
    '2026-11-01T10:05:00+05:30'::timestamptz
  )
on conflict (id) do update
  set principal_id        = excluded.principal_id,
      decision            = excluded.decision,
      limits              = excluded.limits,
      valid_from          = excluded.valid_from,
      expires_at          = excluded.expires_at,
      period_start        = excluded.period_start,
      period_end          = excluded.period_end,
      max_uses            = excluded.max_uses,
      used_count          = excluded.used_count,
      max_amount_minor    = excluded.max_amount_minor,
      target_ids          = excluded.target_ids,
      vendor_ids          = excluded.vendor_ids,
      item_ids            = excluded.item_ids,
      consent_id          = excluded.consent_id,
      two_person_required = excluded.two_person_required,
      revoked_at          = null;

-- ============================================================================
-- 10b. Care-notice permissions for the C-15 authorized send path (authorized-send.ts -> prepare_care_send ->
--      load_gate_snapshot -> enqueue_authorized_command). Each care notice is one per-recipient Cedar request
--      bound to the family principal: send_alert for alerts, share_data for Maa's calm status line.
--      Without these rows Cedar answers "ask/no_permission" and no outbox row is queued.
--      * Riya send_alert -> Riya (watch check-in push), Priya + Rohit (her trusted contacts: SOS, watch
--        escalation, phone-dying notice). The SQL fence (care_send_problem) still requires the active,
--        consented trusted-contact row with the matching scope.
--      * Riya share_data -> Maa ("Main safe hoon" / phone-dying status line). Cedar still requires Riya's
--        voice_share:<Maa> consent and her core2 sharing preference.
--      * Maa send_alert -> Riya + Rohit (refill notice "Gupta Medical ko order bhej diya"). The SQL fence still
--        requires an authorized errand and a child recipient.
-- ============================================================================
insert into public.permissions (
  id, family_id, person_id, principal_id, action, decision, limits,
  valid_from, expires_at, period_start, period_end,
  max_uses, used_count, max_amount_minor,
  target_ids, vendor_ids, item_ids,
  consent_id, two_person_required, revoked_at, created_at
) values
  (
    '77777777-7777-4777-8777-777777777720',
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222', -- Riya
    '44444444-4444-4444-8444-444444444441',
    'send_alert',
    'allow',
    '{"title":"Riya safety alerts: check-in to herself, SOS / watch / phone-dying notices to her trusted contacts"}'::jsonb,
    '2026-11-01T00:00:00+05:30'::timestamptz,
    '2026-12-31T23:59:59+05:30'::timestamptz,
    '2026-11-01T00:00:00+05:30'::timestamptz,
    '2026-12-31T23:59:59+05:30'::timestamptz,
    1000,
    0,
    0,
    array[
      '22222222-2222-4222-8222-222222222222',
      '22222222-2222-4222-8222-222222222225',
      '22222222-2222-4222-8222-222222222223'
    ],
    '{}',
    '{}',
    '88888888-8888-4888-8888-888888888810',
    false,
    null,
    '2026-11-01T10:06:00+05:30'::timestamptz
  ),
  (
    '77777777-7777-4777-8777-777777777721',
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222', -- Riya
    '44444444-4444-4444-8444-444444444441',
    'share_data',
    'allow',
    '{"title":"Riya shares a calm status line with Maa"}'::jsonb,
    '2026-11-01T00:00:00+05:30'::timestamptz,
    '2026-12-31T23:59:59+05:30'::timestamptz,
    '2026-11-01T00:00:00+05:30'::timestamptz,
    '2026-12-31T23:59:59+05:30'::timestamptz,
    1000,
    0,
    0,
    array['22222222-2222-4222-8222-222222222221'],
    '{}',
    '{}',
    '88888888-8888-4888-8888-888888888814',
    false,
    null,
    '2026-11-01T10:07:00+05:30'::timestamptz
  ),
  (
    '77777777-7777-4777-8777-777777777722',
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222221', -- Maa
    '44444444-4444-4444-8444-444444444441',
    'send_alert',
    'allow',
    '{"title":"Refill notice to Maa''s children after an authorized Gupta Medical order"}'::jsonb,
    '2026-11-01T00:00:00+05:30'::timestamptz,
    '2026-12-31T23:59:59+05:30'::timestamptz,
    '2026-11-01T00:00:00+05:30'::timestamptz,
    '2026-12-31T23:59:59+05:30'::timestamptz,
    1000,
    0,
    0,
    array[
      '22222222-2222-4222-8222-222222222222',
      '22222222-2222-4222-8222-222222222223'
    ],
    '{}',
    '{}',
    '88888888-8888-4888-8888-888888888809',
    false,
    null,
    '2026-11-01T10:08:00+05:30'::timestamptz
  )
on conflict (id) do update
  set principal_id        = excluded.principal_id,
      decision            = excluded.decision,
      limits              = excluded.limits,
      valid_from          = excluded.valid_from,
      expires_at          = excluded.expires_at,
      period_start        = excluded.period_start,
      period_end          = excluded.period_end,
      max_uses            = excluded.max_uses,
      used_count          = excluded.used_count,
      max_amount_minor    = excluded.max_amount_minor,
      target_ids          = excluded.target_ids,
      vendor_ids          = excluded.vendor_ids,
      item_ids            = excluded.item_ids,
      consent_id          = excluded.consent_id,
      two_person_required = excluded.two_person_required,
      revoked_at          = null;

-- 10c. Core 1 / Core 2 authorized-send permissions the lab smoke fixtures used to add (K-GREEN): without them the
--      live demo refuses (correctly) Riya<->Maa voice messages, keypad leave_message, missed-call nudges, Riya's
--      urgent responder offer to Rohit and her own watch check-in. All bound to the family principal and an
--      existing consent; Cedar + SQL fences still check consent, targets and limits.
-- ============================================================================
insert into public.permissions (
  id, family_id, person_id, principal_id, action, decision, limits,
  valid_from, expires_at, period_start, period_end,
  max_uses, used_count, max_amount_minor,
  target_ids, vendor_ids, item_ids,
  consent_id, two_person_required, revoked_at, created_at
) values
  ('77777777-7777-4777-8777-777777777730', '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222',
   '44444444-4444-4444-8444-444444444441', 'voice_message', 'allow', '{"title":"Riya voice message to Maa (app push / keypad call)"}'::jsonb,
   '2026-11-01T00:00:00+05:30'::timestamptz, '2026-12-31T23:59:59+05:30'::timestamptz,
   '2026-11-01T00:00:00+05:30'::timestamptz, '2026-12-31T23:59:59+05:30'::timestamptz,
   1000, 0, 0, array['22222222-2222-4222-8222-222222222221'], '{}', '{}', '88888888-8888-4888-8888-888888888805', false, null, '2026-11-01T10:07:00+05:30'::timestamptz),
  ('77777777-7777-4777-8777-777777777731', '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222221',
   '44444444-4444-4444-8444-444444444441', 'voice_message', 'allow', '{"title":"Maa message to Riya (keypad leave_message / app reply push)"}'::jsonb,
   '2026-11-01T00:00:00+05:30'::timestamptz, '2026-12-31T23:59:59+05:30'::timestamptz,
   '2026-11-01T00:00:00+05:30'::timestamptz, '2026-12-31T23:59:59+05:30'::timestamptz,
   1000, 0, 0, array['22222222-2222-4222-8222-222222222222'], '{}', '{}', '88888888-8888-4888-8888-888888888804', false, null, '2026-11-01T10:07:00+05:30'::timestamptz),
  ('77777777-7777-4777-8777-777777777732', '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222221',
   '44444444-4444-4444-8444-444444444441', 'missed_call_nudge', 'allow', '{"title":"Maa missed call -> nudge push to Riya"}'::jsonb,
   '2026-11-01T00:00:00+05:30'::timestamptz, '2026-12-31T23:59:59+05:30'::timestamptz,
   '2026-11-01T00:00:00+05:30'::timestamptz, '2026-12-31T23:59:59+05:30'::timestamptz,
   1000, 0, 0, array['22222222-2222-4222-8222-222222222222'], '{}', '{}', '88888888-8888-4888-8888-888888888801', false, null, '2026-11-01T10:07:00+05:30'::timestamptz),
  ('77777777-7777-4777-8777-777777777733', '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222',
   '44444444-4444-4444-8444-444444444441', 'urgent_responder', 'allow', '{"title":"Riya Core 2 urgent responder -> Rohit"}'::jsonb,
   '2026-11-01T00:00:00+05:30'::timestamptz, '2026-12-31T23:59:59+05:30'::timestamptz,
   '2026-11-01T00:00:00+05:30'::timestamptz, '2026-12-31T23:59:59+05:30'::timestamptz,
   1000, 0, 0, array['22222222-2222-4222-8222-222222222223'], '{}', '{}', '88888888-8888-4888-8888-888888888810', false, null, '2026-11-01T10:07:00+05:30'::timestamptz),
  ('77777777-7777-4777-8777-777777777734', '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222',
   '44444444-4444-4444-8444-444444444441', 'check_in', 'allow', '{"title":"Riya going-home watch check-in to herself"}'::jsonb,
   '2026-11-01T00:00:00+05:30'::timestamptz, '2026-12-31T23:59:59+05:30'::timestamptz,
   '2026-11-01T00:00:00+05:30'::timestamptz, '2026-12-31T23:59:59+05:30'::timestamptz,
   1000, 0, 0, array['22222222-2222-4222-8222-222222222222'], '{}', '{}', '88888888-8888-4888-8888-888888888810', false, null, '2026-11-01T10:07:00+05:30'::timestamptz)
on conflict (id) do update set revoked_at = null, used_count = 0, expires_at = excluded.expires_at,
  principal_id = excluded.principal_id, target_ids = excluded.target_ids, consent_id = excluded.consent_id;

-- ============================================================================
-- 11. Core 2 Child Safety (Riya's trusted contacts, reassurance prefs, device)
--     Priya = Rank 1 local friend in Bengaluru (approved, consented, active)
--     Rohit = Rank 2 brother in Pune (approved, consented, active)
-- ============================================================================
insert into public.core2_trusted_contacts (
  id, family_id, subject_person_id, contact_person_id, rank, scopes, state,
  approved_at, consent_id, consent_at, effective_from, effective_until, revoked_at
) values
  (
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa01',
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222', -- Riya (subject)
    '22222222-2222-4222-8222-222222222225', -- Priya (Rank 1 trusted contact in Bengaluru)
    1,
    array['sos','watch_escalation','reassurance'],
    'active',
    now() - interval '10 days',
    '88888888-8888-4888-8888-888888888813',
    now() - interval '10 days',
    now() - interval '10 days',
    null,
    null
  ),
  (
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa02',
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222', -- Riya (subject)
    '22222222-2222-4222-8222-222222222223', -- Rohit (Rank 2 trusted contact)
    2,
    array['sos','watch_escalation','reassurance'],
    'active',
    now() - interval '10 days',
    '88888888-8888-4888-8888-888888888812',
    now() - interval '10 days',
    now() - interval '10 days',
    null,
    null
  )
on conflict (id) do update
  set rank            = excluded.rank,
      scopes          = excluded.scopes,
      state           = 'active',
      approved_at     = coalesce(public.core2_trusted_contacts.approved_at, excluded.approved_at),
      consent_id      = excluded.consent_id,
      consent_at      = coalesce(public.core2_trusted_contacts.consent_at, excluded.consent_at),
      effective_from  = coalesce(public.core2_trusted_contacts.effective_from, excluded.effective_from),
      effective_until = null,
      revoked_at      = null;

insert into public.core2_sharing_preferences (
  family_id, subject_person_id,
  share_status_with_parent, allow_location_share, allow_health_share, allow_narrative_share
) values (
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222', -- Riya
  true,
  false,
  false,
  true
)
on conflict (family_id, subject_person_id) do update
  set share_status_with_parent = excluded.share_status_with_parent,
      allow_location_share     = excluded.allow_location_share,
      allow_health_share       = excluded.allow_health_share,
      allow_narrative_share    = excluded.allow_narrative_share;

insert into public.core2_device_status (
  family_id, person_id, battery_level, is_charging, sampled_at, heartbeat_at
) values (
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222', -- Riya
  84,
  false,
  now() - interval '15 minutes',
  now() - interval '5 minutes'
)
on conflict (family_id, person_id) do update
  set battery_level = excluded.battery_level,
      is_charging   = excluded.is_charging,
      sampled_at    = excluded.sampled_at,
      heartbeat_at  = excluded.heartbeat_at;

-- ============================================================================
-- 12. Core 3 Shield (Family Code Word "gulmohar", Gateway, Devices, Drills)
--     normalizeCodeWord('gulmohar') = 'gulmohar'
--     sha256('gulmohar') = 95a55741b54dd9d41fd224c9260e630a9d5307165b4e2671b16d281c21d5d9df
-- ============================================================================
insert into public.shield_family_security (family_id, code_word_hash)
values (
  '11111111-1111-4111-8111-111111111111',
  encode(sha256(convert_to('gulmohar', 'UTF8')), 'hex')
)
on conflict (family_id) do update
  set code_word_hash = excluded.code_word_hash;

-- Maa's keypad gateway registration (numberFingerprint('+919000000001') = sha256('9000000001'))
insert into public.shield_gateway_parents (phone_hash, family_id, parent_id)
values (
  encode(sha256(convert_to('9000000001', 'UTF8')), 'hex'),
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222221'
)
on conflict (phone_hash) do update
  set family_id = excluded.family_id,
      parent_id = excluded.parent_id;

-- Maa's paired Android smartphone in public.shield_devices
insert into public.shield_devices (
  id, family_id, person_id, label, platform, device_secret_hash,
  protections, last_heartbeat_at, paired_at, app_version
) values (
  'dddddddd-dddd-4ddd-8ddd-dddddddddd01',
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222221',
  'Maa Smartphone (Android)',
  'android',
  encode(sha256(convert_to('sahaj-demo-maa-smartphone-secret', 'UTF8')), 'hex'),
  '{"sms":true,"screening":true,"redirection":true,"usage":true,"notifications":true,"overlay":true}'::jsonb,
  now() - interval '5 minutes',
  now() - interval '7 days',
  '1.0.0-demo'
)
on conflict (id) do update
  set label             = excluded.label,
      protections       = excluded.protections,
      last_heartbeat_at = excluded.last_heartbeat_at,
      app_version       = excluded.app_version;

-- Opt-in experience drills: Maa's active recorded consent + Riya's per-parent switch
insert into public.shield_drill_consents (
  id, family_id, parent_id, kind, clip_ref, given_at, revoked_at
) values (
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeee01',
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222221',
  'experience_drill',
  '11111111-1111-4111-8111-111111111111/voice/maa-experience-drill-consent.m4a',
  now() - interval '7 days',
  null
)
on conflict (id) do nothing;

insert into public.shield_experience_settings (
  parent_id, family_id, experience_drills_enabled, enabled_by, enabled_at
) values (
  '22222222-2222-4222-8222-222222222221',
  '11111111-1111-4111-8111-111111111111',
  true,
  '33333333-3333-4333-8333-333333333332',
  now() - interval '7 days'
)
on conflict (parent_id) do update
  set experience_drills_enabled = excluded.experience_drills_enabled,
      enabled_by                = excluded.enabled_by,
      enabled_at                = excluded.enabled_at;

-- Expected visitors & safe-word greeting metadata in dev_cache (and in Maa's people.free_windows)
insert into public.dev_cache (key, value, expires_at, updated_at)
values (
  'shield:family:11111111-1111-4111-8111-111111111111:security_meta',
  '{
    "family_id": "11111111-1111-4111-8111-111111111111",
    "parent_id": "22222222-2222-4222-8222-222222222221",
    "code_word": "gulmohar",
    "safe_word_greeting": "Ram Ram Mummy ji",
    "expected_visitors": [
      "doodhwala subah 7 baje",
      "Gupta Medical delivery"
    ],
    "parent_devices": [
      {"kind": "keypad", "label": "Maa Lava Keypad", "synthetic_e164": "+919000000001"},
      {"kind": "smartphone", "label": "Maa Smartphone (Android)", "device_id": "dddddddd-dddd-4ddd-8ddd-dddddddddd01"}
    ]
  }'::jsonb,
  '2026-12-31T23:59:59+05:30'::timestamptz,
  now()
)
on conflict (key) do update
  set value      = excluded.value,
      expires_at = excluded.expires_at,
      updated_at = excluded.updated_at;

-- ============================================================================
-- 13. Provider Identities (public.provider_identities)
--     - Maa's two device identities (Lava keypad + Android smartphone)
--     - Synthetic encrypted contact rows (+919000000001..+919000000006)
--       using the disposable test-only fixture encryption from README.md.
-- ============================================================================
insert into public.provider_identities (
  family_id, person_id, source, account_id, external_id_hash, binding_kind, contact_ciphertext
) values
  -- Maa's two device bindings (Lava keypad + Android smartphone)
  (
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222221',
    'sarvam',
    'synthetic-sarvam-app',
    encode(sha256(convert_to('device:maa-lava-keypad', 'UTF8')), 'hex'),
    'device',
    null
  ),
  (
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222221',
    'whatsapp',
    'synthetic-wa-account',
    encode(sha256(convert_to('device:maa-android-smartphone', 'UTF8')), 'hex'),
    'device',
    null
  ),
  -- WhatsApp & Sarvam synthetic contacts for Priya (+919000000005) and Gupta Medical (+919000000006)
  (
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222225',
    'whatsapp',
    'synthetic-wa-account',
    'c9093c734c6daa5855a80a075808583405afbda712e2fcba08a7944ef56d545f',
    'contact',
    'v1.5tDO2L8c_tDcSe3e.QDexmMVAAtEaa06nEti9xw.YCTovGLnqHUprSadRg'
  ),
  (
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222226',
    'whatsapp',
    'synthetic-wa-account',
    '4db340666c0da81d8177eb878504958b197a753baef6b6d87650e040b1a49e59',
    'contact',
    'v1.ageJ0RGC0RjNfWeC.J4uIUcdwzR1BrebQxrGiNQ.MpfHfTNdO0ORew6hTg'
  ),
  (
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222225',
    'sarvam',
    'synthetic-sarvam-app',
    'd8bdef7bb265be1503b056231e4ff63e77742d6b0bd90d94f530d83c38fa805b',
    'contact',
    'v1.Dm8aBWHxIksGgKIU.HPnMyvTSD1CvsA79jZWsmw.VN1PnRcc9ZAxLUAY-Q'
  ),
  (
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222226',
    'sarvam',
    'synthetic-sarvam-app',
    'aa920a1c02407aa01cf8b3dc7942a471c0236be8bf8077b73356f950b3084371',
    'contact',
    'v1.UYECO1acaIT-nQgO.ejI716rlN-FMxjFb_1tsYg.RM5HdnDS9kQzVe-2vg'
  ),
  -- Twilio synthetic contacts for Maa (+919000000001), Riya (+919000000002), Rohit (+919000000003),
  -- Sharma uncle (+919000000004), Priya (+919000000005), and Gupta Medical (+919000000006)
  (
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222221',
    'twilio',
    'synthetic-twilio-account',
    '46022cb2d1b94560e0e730f0b0918ba3274512b1e16a8297353bce96d3136de8',
    'contact',
    'v1.MS2d5KyVLnBIcfyI.CC4PEKi3TC6-2kskNXzr7w.O6IG0hHsgVqFruZNvA'
  ),
  (
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
    'twilio',
    'synthetic-twilio-account',
    'e9c19b14b18988fc2bdbf24eef78b46c321ee26e132834bcb147c49e8cd0203c',
    'contact',
    'v1.P15EEj4m2poShyP7.bHy3aPkNxWYg7URtirYi1g.J3tY_L2CJ7ZSmjCCYQ'
  ),
  (
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222223',
    'twilio',
    'synthetic-twilio-account',
    'f0ee12e60e0a5f340b5742d90fab7015892b6e537a5b7e31e77b25db8255c6a5',
    'contact',
    'v1.1bIMzvFwYBUKNG1f.Zr9GIGztuAJzgVeoaz6phA.bM4St3wwUswRHoKXDw'
  ),
  (
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222224',
    'twilio',
    'synthetic-twilio-account',
    'c8aa8b5bced25b65cadc219792436ee398c64976393572b30d07b4eb38b2d2d3',
    'contact',
    'v1.o1ALNMlZVC0kkFbM.qmBHJEl8X89_cZ2BChOVWA.CL6jAk6ZKyUutvnHlA'
  ),
  (
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222225',
    'twilio',
    'synthetic-twilio-account',
    'c0704f20804de88815e80188906de1a2f25231e12ed9930df15c02d48ff3d22e',
    'contact',
    'v1.7ksDD1eWcmoFCf4c.6V7R1IzRmQjpjY8Bh9zrBQ.Ybtb9awigJzYaI1LNw'
  ),
  (
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222226',
    'twilio',
    'synthetic-twilio-account',
    '806aae7c82bdff9cfe8b6aa7c97d03ee51963f6003d25a5736161839bc1d0a24',
    'contact',
    'v1.S8qDztR-WNy6nUD6.ofv47NR6XJ1WiW-FEv6Vog.hrwgkgsB-P0g7K4hUg'
  ),
  -- TeleCMI inbound missed-call synthetic contact for Maa (+919000000001)
  (
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222221',
    'telecmi',
    'synthetic-telecmi-account',
    '177f2ac654ee116072af44643fa9cfabce83b0121d38d26a4900fcdcf7e0e151',
    'contact',
    'v1.LmxIGwUnrJKGhqZD.zdVWxheIqW1yGZuUOOcq0w.3J84RO3w7L6WGCiJhg'
  )
on conflict (source, account_id, external_id_hash, binding_kind) do update
  set family_id          = excluded.family_id,
      person_id          = excluded.person_id,
      contact_ciphertext = excluded.contact_ciphertext,
      enabled            = true,
      revoked_at         = null;
