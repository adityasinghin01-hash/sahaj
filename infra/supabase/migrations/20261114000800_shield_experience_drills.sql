-- K-B8 · Core 3 Step 3.5: opt-in experience drills.
-- DEPENDS ON: 20261114000100_shield.sql, 20261114000400_shield_drills_evidence.sql (public.drills,
-- type 'experience') and the core public.families / public.people / public.family_members.
--
-- Three locks before Aasha Didi places an experience drill call (enforced by the Shield runtime):
--   1. Maa's recorded "yes" (shield_drill_consents, active = revoked_at is null),
--   2. the child's per-parent switch (shield_experience_settings.experience_drills_enabled),
--   3. at most one experience drill per rolling 7 days, outside quiet hours.
-- Results are rows in public.drills (type 'experience'); their masked answers hold no 4+ digit run.
-- Praise after a refusal / hang-up is queued in shield_checkin_lines for the next daily check-in.
--
-- RLS: family members read their own family's rows. Writes are service role only.

create table public.shield_drill_consents (
  id         uuid primary key default gen_random_uuid(),
  family_id  uuid not null references public.families(id) on delete cascade,
  parent_id  uuid not null references public.people(id) on delete cascade,
  kind       text not null check (kind = 'experience_drill'),
  -- Storage reference of Maa's recorded yes (the clip itself lives in the host's storage).
  clip_ref   text not null check (char_length(clip_ref) between 1 and 300),
  given_at   timestamptz not null,
  revoked_at timestamptz,
  check (revoked_at is null or revoked_at >= given_at)
);
-- One active consent per parent and kind.
create unique index shield_drill_consents_active_idx
  on public.shield_drill_consents (family_id, parent_id, kind) where revoked_at is null;
create index shield_drill_consents_parent_idx on public.shield_drill_consents (family_id, parent_id, given_at desc);

-- The child's per-parent switch. enabled_by = the child's auth user id.
create table public.shield_experience_settings (
  parent_id                 uuid primary key references public.people(id) on delete cascade,
  family_id                 uuid not null references public.families(id) on delete cascade,
  experience_drills_enabled boolean not null default false,
  enabled_by                uuid,
  enabled_at                timestamptz,
  check (not experience_drills_enabled or (enabled_by is not null and enabled_at is not null))
);
create index shield_experience_settings_family_idx on public.shield_experience_settings (family_id);

-- Lines Aasha Didi says at the next check-in (praise after a safe experience drill).
create table public.shield_checkin_lines (
  id           uuid primary key default gen_random_uuid(),
  family_id    uuid not null references public.families(id) on delete cascade,
  parent_id    uuid not null references public.people(id) on delete cascade,
  kind         text not null check (kind in ('experience_praise')),
  line         text not null check (char_length(line) between 1 and 500 and line !~ '[[:digit:]]{4,}'),
  created_at   timestamptz not null,
  delivered_at timestamptz
);
create index shield_checkin_lines_pending_idx
  on public.shield_checkin_lines (family_id, parent_id, created_at, id) where delivered_at is null;

-- Cross-family references are rejected even for service-role writes.
create function public.shield_experience_parent_scope() returns trigger language plpgsql
set search_path = '' as $$
begin
  if not exists (select 1 from public.people p
                 where p.id = new.parent_id and p.family_id = new.family_id and p.role = 'parent') then
    raise exception 'Invalid experience drill parent scope' using errcode = '23514';
  end if;
  return new;
end $$;

create function public.shield_experience_switch_scope() returns trigger language plpgsql
set search_path = '' as $$
begin
  if not exists (select 1 from public.people p
                 where p.id = new.parent_id and p.family_id = new.family_id and p.role = 'parent') then
    raise exception 'Invalid experience drill parent scope' using errcode = '23514';
  end if;
  if new.enabled_by is not null and not exists (
       select 1 from public.family_members m
       where m.family_id = new.family_id and m.user_id = new.enabled_by and m.role = 'child') then
    raise exception 'Experience drill switch needs a child of the family' using errcode = '23514';
  end if;
  return new;
end $$;

create trigger shield_drill_consents_scope before insert or update on public.shield_drill_consents
for each row execute function public.shield_experience_parent_scope();
create trigger shield_checkin_lines_scope before insert or update on public.shield_checkin_lines
for each row execute function public.shield_experience_parent_scope();
create trigger shield_experience_settings_scope before insert or update on public.shield_experience_settings
for each row execute function public.shield_experience_switch_scope();

revoke all on public.shield_drill_consents, public.shield_experience_settings, public.shield_checkin_lines
  from public, anon, authenticated;
grant select on public.shield_drill_consents, public.shield_experience_settings, public.shield_checkin_lines
  to authenticated;
grant all on public.shield_drill_consents, public.shield_experience_settings, public.shield_checkin_lines
  to service_role;
revoke all on function public.shield_experience_parent_scope(), public.shield_experience_switch_scope()
  from public, anon, authenticated;
grant execute on function public.shield_experience_parent_scope(), public.shield_experience_switch_scope()
  to service_role;

alter table public.shield_drill_consents      enable row level security;
alter table public.shield_experience_settings enable row level security;
alter table public.shield_checkin_lines       enable row level security;

create policy shield_drill_consents_select_family on public.shield_drill_consents for select to authenticated
using (exists (select 1 from public.family_members m
               where m.family_id = shield_drill_consents.family_id and m.user_id = (select auth.uid())));
create policy shield_experience_settings_select_family on public.shield_experience_settings for select to authenticated
using (exists (select 1 from public.family_members m
               where m.family_id = shield_experience_settings.family_id and m.user_id = (select auth.uid())));
create policy shield_checkin_lines_select_family on public.shield_checkin_lines for select to authenticated
using (exists (select 1 from public.family_members m
               where m.family_id = shield_checkin_lines.family_id and m.user_id = (select auth.uid())));
