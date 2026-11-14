import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from "node:crypto";

/** Environment variable names this runtime reads. Values are never logged or returned. */
export const ATLAS_ENV = {
  encryptionKey: "WEBHOOK_ENCRYPTION_KEY",
  databaseUrl: "DATABASE_URL",
  signingPrivateKey: "SIGNING_PRIVATE_KEY",
  signingPublicKey: "SIGNING_PUBLIC_KEY",
  signingKeyId: "SIGNING_KEY_ID",
} as const;

export interface AtlasConfig {
  encryptionKeyHex: string;
  databaseUrl: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
  keyId: string;
}
export type AtlasConfigResult = { ok: true; config: AtlasConfig } | { ok: false; problems: string[] };

/** PEM (literal "\n" sequences allowed) or base64 DER (PKCS#8 private, SPKI public). */
function parseKey(raw: string, kind: "private" | "public"): KeyObject {
  const value = raw.trim().replace(/\\n/g, "\n");
  if (value.includes("-----BEGIN")) return kind === "private" ? createPrivateKey(value) : createPublicKey(value);
  const key = Buffer.from(value, "base64");
  return kind === "private" ? createPrivateKey({ key, format: "der", type: "pkcs8" }) : createPublicKey({ key, format: "der", type: "spki" });
}
/**
 * Validate configuration from an environment-like record passed in by the route. Reports variable NAMES that are
 * missing or invalid, never values. The key pair must be a matching Ed25519 pair; a mismatch is a configuration error.
 */
export function loadAtlasConfig(env: Record<string, string | undefined>): AtlasConfigResult {
  const problems: string[] = [];
  const get = (name: string) => { const v = env[name]; if (!v) problems.push(`${name}:missing`); return v ?? ""; };
  const encryptionKeyHex = get(ATLAS_ENV.encryptionKey), databaseUrl = get(ATLAS_ENV.databaseUrl), keyId = get(ATLAS_ENV.signingKeyId);
  const priv = get(ATLAS_ENV.signingPrivateKey), pub = get(ATLAS_ENV.signingPublicKey);
  if (encryptionKeyHex && !/^[0-9a-fA-F]{64}$/.test(encryptionKeyHex)) problems.push(`${ATLAS_ENV.encryptionKey}:invalid`);
  if (keyId && !/^[a-zA-Z0-9_.:-]{1,120}$/.test(keyId)) problems.push(`${ATLAS_ENV.signingKeyId}:invalid`);
  let privateKey: KeyObject | undefined, publicKey: KeyObject | undefined;
  if (priv) { try { privateKey = parseKey(priv, "private"); if (privateKey.asymmetricKeyType !== "ed25519") throw new Error(); } catch { problems.push(`${ATLAS_ENV.signingPrivateKey}:invalid`); } }
  if (pub) { try { publicKey = parseKey(pub, "public"); if (publicKey.asymmetricKeyType !== "ed25519") throw new Error(); } catch { problems.push(`${ATLAS_ENV.signingPublicKey}:invalid`); } }
  if (privateKey && publicKey) {
    const probe = Buffer.from("sahaj.config.probe");
    if (!verify(null, probe, publicKey, sign(null, probe, privateKey))) problems.push("SIGNING_KEYS:mismatch");
  }
  if (problems.length || !privateKey || !publicKey) return { ok: false, problems };
  return { ok: true, config: { encryptionKeyHex, databaseUrl, privateKey, publicKey, keyId } };
}
