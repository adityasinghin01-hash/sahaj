// LAB ONLY. Loads the real demo phones from the environment (LAB_PHONE_RIYA, LAB_PHONE_ROHIT, LAB_PHONE_MAA_KEYPAD,
// LAB_PHONE_MAA_SMARTPHONE; read at runtime from ~/dev/sahaj-secrets/shield.env by lab-reset2.sh) into encrypted
// public.provider_identities rows through the Shield contact port (apps/shield-api/src/ports/contacts.ts).
//
// Never prints, logs or writes a number anywhere: output is person name + status only. Refuses a non-loopback database
// and the public test-only fixture key from infra/supabase/dev/README.md.
//
// Run: node_modules/.bin/tsx scripts/lab/load-phones.ts   (DATABASE_URL + WEBHOOK_ENCRYPTION_KEY + IDENTITY_HASH_SECRET
//      + SARVAM_APP_ID or SARVAM_AGENT_ID_CHECKIN in env)
import postgres from "postgres";
import { createContactWriter, createContactsPort } from "../../apps/shield-api/src/ports/contacts";

const FAMILY = "11111111-1111-4111-8111-111111111111";
const MAA = "22222222-2222-4222-8222-222222222221";
const RIYA = "22222222-2222-4222-8222-222222222222";
const ROHIT = "22222222-2222-4222-8222-222222222223";
const PUBLIC_FIXTURE_KEY = "19".repeat(32);

async function main(): Promise<number> {
  const env = process.env;
  const url = new URL(env.DATABASE_URL ?? "postgres://invalid");
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname)) {
    console.error("load-phones: refusing a non-loopback DATABASE_URL");
    return 2;
  }
  if ((env.WEBHOOK_ENCRYPTION_KEY ?? "").toLowerCase() === PUBLIC_FIXTURE_KEY) {
    console.error("load-phones: WEBHOOK_ENCRYPTION_KEY is the public fixture key; refusing to encrypt real contacts");
    return 2;
  }
  // Maa has one person record and two handsets. Exactly one may be the enabled call target (contacts.resolve needs one
  // row); the keypad gets the Pulse calls by default. LAB_MAA_PRIMARY=smartphone flips it.
  const maaPrimary = env.LAB_MAA_PRIMARY === "smartphone" ? "smartphone" : "keypad";
  const plan = [
    { label: "Riya", personId: RIYA, envName: "LAB_PHONE_RIYA", primary: true },
    { label: "Rohit", personId: ROHIT, envName: "LAB_PHONE_ROHIT", primary: true },
    { label: "Maa (keypad)", personId: MAA, envName: "LAB_PHONE_MAA_KEYPAD", primary: maaPrimary === "keypad" },
    { label: "Maa (smartphone)", personId: MAA, envName: "LAB_PHONE_MAA_SMARTPHONE", primary: maaPrimary === "smartphone" },
  ].sort((a, b) => Number(a.primary) - Number(b.primary)); // secondaries first, so a primary is the last word

  const sql = postgres(env.DATABASE_URL!, { max: 1, onnotice: () => {} });
  const writer = createContactWriter(sql, env);
  const port = createContactsPort(sql, env);
  let failures = 0;
  try {
    for (const p of plan) {
      const phone = env[p.envName];
      if (!phone) { console.log(`  ${p.label}: skipped (${p.envName} not set)`); continue; }
      const status = await writer.bind({ familyId: FAMILY, personId: p.personId, source: "sarvam", phoneE164: phone, primary: p.primary });
      if (status !== "bound") failures += 1;
      let check = "";
      if (status === "bound" && p.primary) {
        const resolved = await port.resolve({ familyId: FAMILY, personId: p.personId, source: "sarvam" });
        check = resolved === phone ? ", contact port resolves it" : ", CONTACT PORT MISMATCH";
        if (resolved !== phone) failures += 1;
      }
      console.log(`  ${p.label}: ${status} (source=sarvam, ${p.primary ? "primary call target" : "stored disabled, secondary handset"}${check})`);
    }
  } finally {
    await sql.end({ timeout: 2 });
  }
  return failures ? 1 : 0;
}

main().then((code) => process.exit(code), () => { console.error("load-phones: failed (details withheld)"); process.exit(1); });
