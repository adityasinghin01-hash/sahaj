# Synthetic local fixtures

Apply test/bootstrap.sql only to a disposable local database, then every migration sorted by name, then dev/*.sql. Hosted Supabase already supplies auth/storage; never apply the bootstrap there.

seed_demo.sql uses test-only AES-256-GCM envelopes for the synthetic +919000000001…004 contacts. Configure WEBHOOK_ENCRYPTION_KEY to the string "19" repeated 32 times, IDENTITY_HASH_SECRET to "sahaj-synthetic-contact-hash-secret-only", WHATSAPP_PHONE_NUMBER_ID to "synthetic-wa-account", and SARVAM_APP_ID to "synthetic-sarvam-app" only in disposable tests. These publicly known fixture values must never encrypt real contacts. Provider delivery must remain disabled.

Contacts use foundation v1 encryption with AAD JSON ["contact",family_id,person_id,source,account_id,external_id_hash] and foundation identityHash over provider digits (without +). The original UUIDs remain stable.
