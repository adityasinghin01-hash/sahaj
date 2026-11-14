-- DEV ONLY: synthetic Vihaan X demo family (Meena "Maa" 67, Riya, Rohit, Sharma uncle).
-- Phone numbers are placeholders (+91XXXXXXXXXX) to be replaced manually in local dev if testing WhatsApp.
-- Code word: "gulab" -> SHA-256 hex = 33b2dc44201d3b1c10ef3a8f1cd0a3c5c7f0d339ee96d88aecdf2583a116b34a

insert into public.families (id, name, code_word_hash)
values (
  '11111111-1111-4111-8111-111111111111',
  'Meena Sharma Family',
  '33b2dc44201d3b1c10ef3a8f1cd0a3c5c7f0d339ee96d88aecdf2583a116b34a'
)
on conflict (id) do update
  set name = excluded.name,
      code_word_hash = excluded.code_word_hash;

insert into public.people (id, family_id, name, aliases, role, phone)
values
  (
    '22222222-2222-4222-8222-222222222221',
    '11111111-1111-4111-8111-111111111111',
    'Meena',
    array['Maa', 'Meena', 'Mummy'],
    'parent',
    '+91XXXXXXXXXX'
  ),
  (
    '22222222-2222-4222-8222-222222222222',
    '11111111-1111-4111-8111-111111111111',
    'Riya',
    array['Riya', 'Beti'],
    'child',
    '+91XXXXXXXXXX'
  ),
  (
    '22222222-2222-4222-8222-222222222223',
    '11111111-1111-4111-8111-111111111111',
    'Rohit',
    array['Rohit', 'Beta'],
    'child',
    '+91XXXXXXXXXX'
  ),
  (
    '22222222-2222-4222-8222-222222222224',
    '11111111-1111-4111-8111-111111111111',
    'Sharma uncle',
    array['Sharma uncle', 'Sharma ji', 'Sharma'],
    'circle',
    '+91XXXXXXXXXX'
  )
on conflict (id) do update
  set name = excluded.name,
      aliases = excluded.aliases,
      role = excluded.role,
      phone = excluded.phone;

insert into public.family_members (id, family_id, user_id, person_id, role)
values
  (
    '44444444-4444-4444-8444-444444444442',
    '11111111-1111-4111-8111-111111111111',
    '33333333-3333-4333-8333-333333333332',
    '22222222-2222-4222-8222-222222222222',
    'child'
  ),
  (
    '44444444-4444-4444-8444-444444444443',
    '11111111-1111-4111-8111-111111111111',
    '33333333-3333-4333-8333-333333333333',
    '22222222-2222-4222-8222-222222222223',
    'child'
  ),
  (
    '44444444-4444-4444-8444-444444444444',
    '11111111-1111-4111-8111-111111111111',
    '33333333-3333-4333-8333-333333333334',
    '22222222-2222-4222-8222-222222222224',
    'circle'
  )
on conflict (id) do update
  set role = excluded.role,
      person_id = excluded.person_id;

