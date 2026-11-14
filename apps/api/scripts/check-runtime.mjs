import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const localEnv = fileURLToPath(new URL("../.env.local", import.meta.url));
if (existsSync(localEnv)) process.loadEnvFile(localEnv);
const keys = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "DATABASE_URL", "WEBHOOK_ENCRYPTION_KEY", "IDENTITY_HASH_SECRET", "CRON_SECRET", "WHATSAPP_APP_SECRET", "WHATSAPP_PHONE_NUMBER_ID"];
const configured = Object.fromEntries(keys.map(key => [key, Boolean(process.env[key] && !/your_|replace|placeholder|example/i.test(process.env[key]))]));
console.log(JSON.stringify({ configured }));
if (configured.SUPABASE_URL && configured.SUPABASE_SERVICE_ROLE_KEY) {
  try {
    const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    const { error, count } = await db.from("families").select("id", { count: "exact", head: true });
    console.log(JSON.stringify({ database: error ? "failed" : "connected", error_code: error?.code, family_count: count }));
    if (error) process.exitCode = 1;
  } catch { console.log(JSON.stringify({ database: "unreachable" })); process.exitCode = 1; }
}
