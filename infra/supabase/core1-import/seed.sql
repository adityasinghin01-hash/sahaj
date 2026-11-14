-- Explicit synthetic demo seed; no Auth users, phone numbers, credentials, or health records.
-- Membership provisioning requires the authenticated server onboarding flow.
begin;
insert into public.families(id,name,demo,category) values
 ('10000000-0000-4000-8000-000000000001','SAHAJ Synthetic Demo Family',true,'demo')
on conflict(id) do nothing;
insert into public.people(id,family_id,display_name,role,device) values
 ('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','Demo Parent','parent','keypad'),
 ('20000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001','Demo Child','child','smartphone'),
 ('20000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000001','Demo Trusted Responder','circle','smartphone')
on conflict(id) do nothing;
-- No fake consent, accepted responder, provider binding, or completed task is seeded.
commit;
