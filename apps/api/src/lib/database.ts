import { createClient } from "@supabase/supabase-js";
import { WebhookError } from "./webhook-security";

/** Import only from server route handlers. No service credentials enter public app code. */
export function serviceDatabase() {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new WebhookError("database_not_configured", 503);
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}
