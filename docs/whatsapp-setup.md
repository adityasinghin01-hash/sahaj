# WhatsApp (Meta Cloud API) setup for the Sahaj lab

Sahaj sends Riya the Shield alert cards and the family-check cards ("Kya ye sach mein Rohit hai?") on WhatsApp. This page covers the Meta side. Use `<PUBLIC_URL>` from `bash scripts/lab/tunnel.sh`. Never paste a real token or phone number into this file, a chat group or app code.

Env names the server uses: `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_GRAPH_VERSION` (default `v27.0`). For incoming messages it also needs `WHATSAPP_VERIFY_TOKEN` and `WHATSAPP_APP_SECRET` (see the note at the end).

## 1. Webhook (incoming messages and button taps)

1. Open [developers.facebook.com](https://developers.facebook.com) → **My Apps** → the Sahaj app.
2. Left menu: **WhatsApp → Configuration**.
3. Under **Webhook**, click **Edit**:
   - **Callback URL:** `<PUBLIC_URL>/api/whatsapp/webhook`
   - **Verify token:** the value of `WHATSAPP_VERIFY_TOKEN` from the env file. Pick any long random string, for example from `openssl rand -hex 24`. It is ours, not Meta's.
   - Click **Verify and save**. Meta sends one `GET` with `hub.mode=subscribe`, `hub.verify_token` and `hub.challenge`. The server must answer with the challenge.
4. Under **Webhook fields**, click **Manage** and **Subscribe** to `messages`. Nothing else is needed.
5. A quick-tunnel URL changes every time the tunnel restarts. Repeat step 3 after each restart.

## 2. App secret (to check that webhooks really come from Meta)

1. Same app → **App settings → Basic**.
2. **App secret** → **Show** (asks for your Facebook password).
3. Put it in the env file as `WHATSAPP_APP_SECRET`. Meta signs every webhook body with it in the `X-Hub-Signature-256` header (HMAC-SHA256 of the raw body). The server must reject any webhook whose signature doesn't match.

## 3. Permanent token (System User), instead of the 24-hour test token

The token on **WhatsApp → API Setup** expires after 24 hours. For the lab, make a permanent one:

1. Open [business.facebook.com](https://business.facebook.com) → **Settings** (Business settings).
2. **Users → System users → Add**. Name it `sahaj-lab`, role **Admin**.
3. With the system user selected, click **Assign assets**:
   - **Apps** → the Sahaj app → **Full control**.
   - **WhatsApp accounts** → the Sahaj WhatsApp Business account → **Full control**.
4. Click **Generate new token** → choose the Sahaj app → expiry **Never** → tick `whatsapp_business_messaging` and `whatsapp_business_management` → **Generate**.
5. Copy it once, straight into the env file as `WHATSAPP_TOKEN`. Meta won't show it again. If it leaks, revoke it on the same page and make a new one.
6. `WHATSAPP_PHONE_NUMBER_ID` is on **WhatsApp → API Setup**, under the sending number. It is the number's id, not the phone number itself.

## 4. Recipient list (test number)

While the app uses Meta's free **test number**, it can only message numbers on its allowed list:

1. **WhatsApp → API Setup** → **To** → **Manage phone number list**.
2. Add each team phone that should get cards (Riya's and Rohit's lab phones, at most 5). Each number gets a code on WhatsApp to confirm.
3. The server sends cards to the child's number stored in the family records (`people.phone`). That number must be one of the allowed numbers.

## 5. "Send hi first" (the 24-hour window)

Sahaj sends plain text messages, not approved templates. Meta delivers those only within **24 hours of the person's last message to the Sahaj number**.

- Before each demo or test session, every receiving phone sends **"hi"** to the Sahaj WhatsApp number.
- If a card doesn't arrive, first check when that phone last messaged the number. Send "hi" again, then retry.
- Outside the window the Graph API rejects the message. The server never retries in a loop. The card stays visible in Riya's app.

## 6. Check it

1. `bash scripts/lab/lab-up.sh` (with the env file that has the WhatsApp values), then `bash scripts/lab/tunnel.sh`.
2. `curl -s <PUBLIC_URL>/api/health` should show `"whatsapp":"real"`. `"outbox"` means `WHATSAPP_TOKEN` or `WHATSAPP_PHONE_NUMBER_ID` is missing, and messages only go to `dev_outbox`.
3. Send "hi" from Riya's lab phone, then play a red scene: `node scripts/lab/scenes.mjs --only A`.

## Note for the lead: not built yet

The Shield server (`apps/shield-api`) has **no `/api/whatsapp/webhook` route** today, and doesn't read `WHATSAPP_VERIFY_TOKEN` or `WHATSAPP_APP_SECRET`. Until that route exists:

- **Verify and save** in step 1 fails, because the route answers 404.
- Outgoing cards (section 6) still work.
- Riya's taps on a WhatsApp family-check card are not recorded. She answers in the app instead.
