-- AGY-X2: Core 2 G8 Gentle News, G9 After-Report (Zapier Z3), and Verified "Maa Heard It" Proof.
-- Additive migration extending Phase 5 Core 2; preserves all existing tables and RPCs.

create table public.core2_gentle_news (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete cascade,
  incident_id uuid not null,
  subject_person_id uuid not null,
  parent_person_id uuid not null,
  marked_by_person_id uuid not null,
  status text not null default 'circle_offered' check (
    status in ('circle_offered', 'companion_with_maa', 'maa_call_queued', 'maa_called', 'closed')
  ),
  calm_summary text not null check (length(calm_summary) between 1 and 400),
  voice_post_id uuid,
  circle_person_id uuid,
  circle_offer_status text not null default 'offered' check (
    circle_offer_status in ('none', 'offered', 'accepted', 'declined', 'timed_out', 'with_maa')
  ),
  tried_circle_person_ids uuid[] not null default '{}',
  circle_offered_at timestamptz,
  circle_accepted_at timestamptz,
  circle_with_maa_at timestamptz,
  maa_call_due_at timestamptz not null,
  maa_call_outbox_id uuid references public.outbox(id),
  maa_call_queued_at timestamptz,
  maa_questions jsonb not null default '[]'::jsonb,
  raw_event_id uuid not null,
  version integer not null default 1 check (version >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (incident_id),
  unique (family_id, incident_id),
  check (subject_person_id <> parent_person_id),
  check (circle_person_id is null or (circle_person_id <> subject_person_id and circle_person_id <> parent_person_id)),
  check (jsonb_typeof(maa_questions) = 'array'),
  foreign key (family_id, incident_id) references public.incidents(family_id, id) on delete cascade,
  foreign key (family_id, subject_person_id) references public.people(family_id, id),
  foreign key (family_id, parent_person_id) references public.people(family_id, id),
  foreign key (family_id, marked_by_person_id) references public.people(family_id, id),
  foreign key (family_id, circle_person_id) references public.people(family_id, id),
  foreign key (family_id, voice_post_id) references public.voice_posts(family_id, id),
  foreign key (family_id, raw_event_id) references public.raw_events(family_id, id)
);

create index core2_gentle_news_due_idx
  on public.core2_gentle_news (maa_call_due_at)
  where status in ('circle_offered', 'companion_with_maa') and maa_call_queued_at is null;

create table public.core2_heard_receipts (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete cascade,
  message_kind text not null check (
    message_kind in ('core2_reassurance', 'core1_voice_post', 'gentle_news_voice')
  ),
  delivery_id uuid not null,
  reassurance_id uuid references public.core2_reassurance_updates(id) on delete set null,
  voice_post_id uuid,
  outbox_id uuid references public.outbox(id) on delete set null,
  recipient_person_id uuid not null,
  channel text not null check (channel in ('smartphone_app', 'keypad_twilio')),
  evidence_type text not null check (
    evidence_type in (
      'device_signed_playback_end',
      'twilio_gather_after_playback',
      'twilio_status_duration_gte_clip'
    )
  ),
  device_id text,
  call_sid text,
  clip_duration_s integer not null check (clip_duration_s between 1 and 3600),
  played_duration_s integer check (played_duration_s is null or played_duration_s >= 0),
  dtmf_digit text check (dtmf_digit is null or dtmf_digit ~ '^[0-9*#]{1,4}$'),
  raw_event_id uuid not null,
  heard_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (family_id, message_kind, delivery_id),
  check (
    (
      channel = 'smartphone_app'
      and evidence_type = 'device_signed_playback_end'
      and device_id is not null
      and played_duration_s is not null
      and played_duration_s >= clip_duration_s
    ) or (
      channel = 'keypad_twilio'
      and call_sid is not null
      and evidence_type in ('twilio_gather_after_playback', 'twilio_status_duration_gte_clip')
    )
  ),
  check (evidence_type <> 'twilio_gather_after_playback' or dtmf_digit is not null),
  check (
    evidence_type <> 'twilio_status_duration_gte_clip'
    or (played_duration_s is not null and played_duration_s >= clip_duration_s)
  ),
  foreign key (family_id, recipient_person_id) references public.people(family_id, id),
  foreign key (family_id, voice_post_id) references public.voice_posts(family_id, id),
  foreign key (family_id, raw_event_id) references public.raw_events(family_id, id)
);

create index core2_heard_receipts_delivery_idx
  on public.core2_heard_receipts (family_id, delivery_id, heard_at desc);

create table public.core2_after_reports (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete cascade,
  incident_id uuid not null unique,
  closed_at timestamptz not null,
  report_json jsonb not null,
  zapier_z3_status text not null default 'skipped' check (zapier_z3_status in ('skipped', 'sent', 'failed')),
  zapier_z3_attempted_at timestamptz,
  zapier_z3_http_status integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (family_id, incident_id) references public.incidents(family_id, id) on delete cascade
);

-- RLS & least privilege: family-scoped read projections only; mutations exclusively via service_role.
alter table public.core2_gentle_news enable row level security;
alter table public.core2_heard_receipts enable row level security;
alter table public.core2_after_reports enable row level security;

revoke all on
  public.core2_gentle_news,
  public.core2_heard_receipts,
  public.core2_after_reports
from public, anon, authenticated;

grant all on
  public.core2_gentle_news,
  public.core2_heard_receipts,
  public.core2_after_reports
to service_role;

-- Never expose pending gentle-news to parent via direct table reads.
grant select (
  id, family_id, incident_id, subject_person_id, status, calm_summary,
  circle_person_id, circle_offer_status, circle_offered_at, circle_accepted_at,
  circle_with_maa_at, maa_call_due_at, maa_call_queued_at, maa_questions, version, created_at, updated_at
) on public.core2_gentle_news to authenticated;

create policy core2_gentle_news_read on public.core2_gentle_news
  for select to authenticated
  using (
    sahaj_private.has_role(family_id, array['child'])
    or sahaj_private.is_person(family_id, circle_person_id)
  );

grant select (
  id, family_id, message_kind, delivery_id, reassurance_id, voice_post_id,
  recipient_person_id, channel, evidence_type, clip_duration_s, played_duration_s,
  heard_at, created_at
) on public.core2_heard_receipts to authenticated;

create policy core2_heard_receipts_read on public.core2_heard_receipts
  for select to authenticated
  using (
    sahaj_private.has_role(family_id, array['child'])
    or sahaj_private.is_person(family_id, recipient_person_id)
  );

grant select (
  id, family_id, incident_id, closed_at, report_json,
  zapier_z3_status, zapier_z3_attempted_at, created_at, updated_at
) on public.core2_after_reports to authenticated;

create policy core2_after_reports_read on public.core2_after_reports
  for select to authenticated
  using (sahaj_private.has_role(family_id, array['child']));

-- Atomically persist verified heard evidence and synchronize reassurance / voice_post projections.
create function public.core2_record_heard_receipt(
  p_family_id uuid,
  p_message_kind text,
  p_delivery_id uuid,
  p_reassurance_id uuid,
  p_voice_post_id uuid,
  p_outbox_id uuid,
  p_recipient_person_id uuid,
  p_channel text,
  p_evidence_type text,
  p_device_id text,
  p_call_sid text,
  p_clip_duration_s integer,
  p_played_duration_s integer,
  p_dtmf_digit text,
  p_raw_event_id uuid,
  p_heard_at timestamptz
) returns table (
  receipt_id uuid,
  heard_at timestamptz,
  already_recorded boolean
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  existing_row public.core2_heard_receipts;
  inserted_row public.core2_heard_receipts;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('core2:heard:' || p_family_id::text || ':' || p_delivery_id::text, 0)
  );

  select * into existing_row
  from public.core2_heard_receipts r
  where r.family_id = p_family_id
    and r.message_kind = p_message_kind
    and r.delivery_id = p_delivery_id
  limit 1;

  if existing_row.id is not null then
    receipt_id := existing_row.id;
    heard_at := existing_row.heard_at;
    already_recorded := true;
    return next;
    return;
  end if;

  insert into public.core2_heard_receipts (
    family_id, message_kind, delivery_id, reassurance_id, voice_post_id, outbox_id,
    recipient_person_id, channel, evidence_type, device_id, call_sid,
    clip_duration_s, played_duration_s, dtmf_digit, raw_event_id, heard_at
  ) values (
    p_family_id, p_message_kind, p_delivery_id, p_reassurance_id, p_voice_post_id, p_outbox_id,
    p_recipient_person_id, p_channel, p_evidence_type, p_device_id, p_call_sid,
    p_clip_duration_s, p_played_duration_s, p_dtmf_digit, p_raw_event_id, p_heard_at
  )
  returning * into strict inserted_row;

  if p_reassurance_id is not null then
    update public.core2_reassurance_updates u set
      heard_verified = true,
      delivery_verified = true,
      delivery_status = 'delivered',
      verified_raw_event_id = coalesce(u.verified_raw_event_id, p_raw_event_id)
    where u.family_id = p_family_id
      and u.id = p_reassurance_id
      and u.recipient_person_id = p_recipient_person_id;
  end if;

  if p_voice_post_id is not null then
    update public.voice_posts v set
      state = 'heard'
    where v.family_id = p_family_id
      and v.id = p_voice_post_id
      and v.recipient_id = p_recipient_person_id;
  end if;

  receipt_id := inserted_row.id;
  heard_at := inserted_row.heard_at;
  already_recorded := false;
  return next;
end
$$;

revoke all on function public.core2_record_heard_receipt(
  uuid, text, uuid, uuid, uuid, uuid, uuid, text, text, text, text, integer, integer, text, uuid, timestamptz
) from public, anon, authenticated;

grant execute on function public.core2_record_heard_receipt(
  uuid, text, uuid, uuid, uuid, uuid, uuid, text, text, text, text, integer, integer, text, uuid, timestamptz
) to service_role;
