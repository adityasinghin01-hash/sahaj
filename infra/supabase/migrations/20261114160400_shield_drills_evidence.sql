-- C-04: masked helper/experience drill results and child-only incident export receipts.
-- Requires the core families/people/family_memberships tables and shield_verdicts.
-- Weekly helper issuance is serialized with a parent-scoped advisory transaction
-- lock by createDrillPg; no calendar-week boundary allows two adjacent drills.
create table public.drills (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete cascade,
  parent_id uuid not null references public.people(id) on delete cascade,
  drill_id text not null check (char_length(drill_id) between 1 and 100),
  type text not null check (type in ('helper', 'experience')),
  asked_at timestamptz not null,
  answer_masked text check (char_length(answer_masked) <= 2000 and answer_masked !~ '[[:digit:]]{4,}'),
  score smallint check (score between 0 and 2),
  teach_line_played boolean not null default false,
  check ((answer_masked is null and score is null and not teach_line_played)
      or (answer_masked is not null and score is not null))
);
create index drills_parent_asked_idx on public.drills (family_id, parent_id, asked_at desc, id desc);

create table public.evidence_packs (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete cascade,
  verdict_id uuid not null references public.shield_verdicts(id) on delete cascade,
  created_for uuid not null,
  contents_hash text not null check (contents_hash ~ '^[a-f0-9]{64}$'),
  chain_hash text not null check (chain_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null
);
create index evidence_packs_family_verdict_idx on public.evidence_packs (family_id, verdict_id, created_at desc);

-- Avoid adding constraints/indexes to core tables owned by another card.
-- These triggers still reject cross-family references for service-role writes.
create function public.shield_drill_parent_scope() returns trigger language plpgsql
set search_path = '' as $$
begin
  if not exists (select 1 from public.people p
                 where p.id = new.parent_id and p.family_id = new.family_id and p.role = 'parent') then
    raise exception 'Invalid drill parent scope' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger shield_drill_parent_scope before insert or update on public.drills
for each row execute function public.shield_drill_parent_scope();

create function public.shield_evidence_scope() returns trigger language plpgsql
set search_path = '' as $$
begin
  if not exists (select 1 from public.shield_verdicts v
                 where v.id = new.verdict_id and v.family_id = new.family_id and v.level = 'red')
     or not exists (select 1 from public.family_memberships m
                    where m.revoked_at is null and m.family_id = new.family_id and m.user_id = new.created_for and m.role = 'child') then
    raise exception 'Invalid evidence child scope' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger shield_evidence_scope before insert or update on public.evidence_packs
for each row execute function public.shield_evidence_scope();

revoke all on public.drills, public.evidence_packs from public, anon, authenticated;
grant select on public.drills, public.evidence_packs to authenticated;
grant all on public.drills, public.evidence_packs to service_role;
revoke all on function public.shield_drill_parent_scope(), public.shield_evidence_scope() from public, anon, authenticated;
grant execute on function public.shield_drill_parent_scope(), public.shield_evidence_scope() to service_role;

alter table public.drills enable row level security;
alter table public.evidence_packs enable row level security;
create policy drills_select_family on public.drills for select to authenticated
using (exists (select 1 from public.family_memberships m
               where m.revoked_at is null and m.family_id = drills.family_id and m.user_id = (select auth.uid())));
create policy evidence_packs_select_child on public.evidence_packs for select to authenticated
using (exists (select 1 from public.family_memberships m
               where m.revoked_at is null and m.family_id = evidence_packs.family_id and m.user_id = (select auth.uid()) and m.role = 'child'));
