-- App push registrations: service-role writes only after bearer membership verification.
create table public.app_push_tokens (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete cascade,
  user_id uuid not null,
  expo_token text not null unique check (length(expo_token) <= 250),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index app_push_tokens_family_idx on public.app_push_tokens(family_id,user_id);
alter table public.app_push_tokens enable row level security;
revoke all on public.app_push_tokens from public, anon, authenticated;
grant all on public.app_push_tokens to service_role;
