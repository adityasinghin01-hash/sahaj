import { createClient } from "@supabase/supabase-js";
import { WebhookError } from "./webhook-security";
import { applyLabAuth, LabModeConfigError } from "./lab-auth";

/** Import only from server route handlers. No service credentials enter public app code. */
export function serviceDatabase() {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new WebhookError("database_not_configured", 503);
  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  try {
    // No-op unless SAHAJ_LAB_MODE=1 with a loopback SUPABASE_URL (see lab-auth.ts).
    return applyLabAuth(client);
  } catch (error) {
    if (error instanceof LabModeConfigError) throw new WebhookError("lab_mode_misconfigured", 503);
    throw error;
  }
}
