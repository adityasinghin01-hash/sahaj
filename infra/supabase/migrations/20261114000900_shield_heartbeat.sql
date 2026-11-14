-- AGY-09 Part C: store app_version alongside protections and last_heartbeat_at on paired devices.
alter table public.shield_devices
  add column if not exists app_version text;

