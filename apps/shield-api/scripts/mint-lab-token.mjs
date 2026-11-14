#!/usr/bin/env node
// Lab only. Never ship the signing secret or this script in an app bundle.
import { createHmac } from "node:crypto";
const secret = process.env.SUPABASE_JWT_SECRET;
const sub = process.argv[2];
if (
  !secret ||
  secret.length < 32 ||
  !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    sub ?? "",
  )
) {
  console.error(
    "Usage: SUPABASE_JWT_SECRET=<at least 32 chars> node scripts/mint-lab-token.mjs <auth-user-id>",
  );
  process.exit(2);
}
const encode = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
const now = Math.floor(Date.now() / 1000);
const data = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ sub, role: "authenticated", iat: now, exp: now + 12 * 60 * 60 })}`;
console.log(
  `${data}.${createHmac("sha256", secret).update(data).digest("base64url")}`,
);
