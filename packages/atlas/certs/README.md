# Supabase public certificate

`supabase-root-2021.crt` was downloaded from the project's Supabase Dashboard Database Settings certificate link:
https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt

This is a public CA certificate, not a credential. Connections retain certificate-chain and hostname verification (`sslmode=verify-full`). Update it through a reviewed change when Supabase rotates the CA; never disable verification to bypass a connection failure.
