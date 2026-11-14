/**
 * K-SARVAMCALL: every apps/api outbound phone call goes through Sarvam (CALL_PROVIDER=sarvam, the default). The free
 * Twilio trial only runs Twilio-hosted templates, so our TwiML (Gather, voice play, notices) cannot run there. Twilio code
 * stays for a paid account and is used only with CALL_PROVIDER=twilio.
 *
 * Calls still go through Phase 2 `dispatchOutbound` (re-authorization, ledger claim, contact fence). This module adds:
 * - the provider switch;
 * - a Sarvam runtime per agent role (RESPONDER / CALLBACK). The contact account (what provider_identities rows are bound
 *   to, `SARVAM_APP_ID` else `SARVAM_AGENT_ID_CHECKIN`) stays the ledger account; the transport only swaps `app_id` to the
 *   role's agent and adds that call's `agent_variables`;
 * - a contact resolver that reads both registry envelopes in use (Phase 2 `CONTACT_ENCRYPTION_KEY` + versioned AAD, and the
 *   Shield writer's `WEBHOOK_ENCRYPTION_KEY` + JSON AAD that scripts/lab/load-phones.ts uses);
 * - masked agent-variable building. No phone number, OTP or 4+ digit run is ever put in a variable.
 */

import type { FetchTransport } from '@sahaj/adapters';
import { decryptWebhook, identityHash } from '../webhook-security';
import { contactAad, contactDigits, type ContactDb, type ContactResolver, type ResolvedContact } from '../provider-dispatch/contacts';
import { dispatchStore } from '../provider-dispatch/supabase-store';
import type { DispatchDeps } from '../provider-dispatch';
import { createSupabaseDispatchAuthorizer, sanitizeNoDigitsRun } from './push-notify';
import type { SupabaseClientLike } from './wiring-common';

export type CallProvider = 'sarvam' | 'twilio';
export type SarvamAgentRole = 'CHECKIN' | 'RESPONDER' | 'CALLBACK';

/** `CALL_PROVIDER=twilio` keeps the old Twilio path; anything else (or unset) is Sarvam. */
export function callProvider(env: Readonly<Record<string, string | undefined>> = process.env): CallProvider {
  return (env.CALL_PROVIDER ?? '').trim().toLowerCase() === 'twilio' ? 'twilio' : 'sarvam';
}

export const SARVAM_AI_INTRODUCTION = 'Main Sahaj ki AI sahayak hoon.';
export const VOICE_NOTE_FALLBACK_LINE = 'Riya ne aapke liye awaaz bheji hai — app ya missed call par sunein';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const E164 = /^\+[1-9]\d{7,14}$/;
const ACCOUNT = /^[A-Za-z0-9_.-]{1,128}$/;
const LABEL = /^[A-Za-z_.:-]{1,64}$/;

/** The provider account contacts are registered under (same rule as apps/shield-api/src/ports/contacts.ts). */
export function sarvamContactAccount(env: Readonly<Record<string, string | undefined>>): string | undefined {
  const v = (env.SARVAM_APP_ID ?? env.SARVAM_AGENT_ID_CHECKIN)?.trim();
  return v && ACCOUNT.test(v) ? v : undefined;
}

/** Agent ids that may report post-call events for calls placed under the contact account. */
export function sarvamAgentAliases(env: Readonly<Record<string, string | undefined>>): string[] {
  return [env.SARVAM_AGENT_ID_CHECKIN, env.SARVAM_AGENT_ID_RESPONDER, env.SARVAM_AGENT_ID_CALLBACK, env.SARVAM_AGENT_ID_EXPERIENCE]
    .map((v) => v?.trim()).filter((v): v is string => !!v && ACCOUNT.test(v));
}

/** Nonnumeric transfer label only (same rule as docs/sarvam-setup.md section 3). A number or bad label gives ''. */
export function sarvamBridgeLabel(env: Readonly<Record<string, string | undefined>>): string {
  const v = env.SARVAM_BRIDGE_TO?.trim() ?? '';
  return LABEL.test(v) ? v : '';
}

/** Short speech-safe text: no 4+ digit runs, no phone numbers, bounded. */
export function speechText(value: string, max = 300): string {
  return sanitizeNoDigitsRun(value, max);
}

/**
 * Agent variables for one call. `*_id` keys must be UUIDs (dropped otherwise, never masked into nonsense); every other
 * value is masked text. Empty values are kept as '' so dashboard defaults are not needed for the variables we own.
 */
export function buildSarvamAgentVariables(input: Record<string, string | undefined | null>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(input)) {
    if (!/^[a-z][a-z0-9_]{0,40}$/.test(key) || raw === undefined || raw === null) continue;
    if (key.endsWith('_id')) { if (UUID.test(raw)) out[key] = raw.toLowerCase(); continue; }
    out[key] = raw === '' ? '' : speechText(raw, key.endsWith('line') ? 400 : 300);
  }
  return out;
}

/**
 * Wraps the Phase 2 transport for ONE Sarvam outbound request: sets `app_config.app_id` to the role's agent and merges the
 * call's agent variables. Only the Sarvam `/outbounds` POST is touched; every other request passes through unchanged.
 */
export function withSarvamAgentTransport(base: FetchTransport, opts: { agentId?: string; variables: Record<string, string> }): FetchTransport {
  return async (url: string, init?: RequestInit) => {
    if (init && typeof init.body === 'string' && /\/outbounds(?:$|\?)/.test(url)) {
      try {
        const parsed = JSON.parse(init.body) as Record<string, unknown>;
        const app = parsed?.app_config;
        if (app && typeof app === 'object') {
          const cfg = app as Record<string, unknown>;
          const existing = cfg.agent_variables && typeof cfg.agent_variables === 'object' ? cfg.agent_variables as Record<string, unknown> : {};
          parsed.app_config = {
            ...cfg,
            ...(opts.agentId ? { app_id: opts.agentId } : {}),
            agent_variables: { ...existing, ...opts.variables },
          };
          return base(url, { ...init, body: JSON.stringify(parsed) });
        }
      } catch { /* fall through with the original body */ }
    }
    return base(url, init ?? {});
  };
}

/** Shield writer AAD (apps/shield-api/src/ports/contacts.ts contactContext). */
const shieldContactAad = (familyId: string, personId: string, source: string, accountId: string, hash: string) =>
  JSON.stringify(['contact', familyId, personId, source, accountId, hash]);

/**
 * Sarvam contact resolver for the dispatcher. Same row filters and checks as `createContactResolver` (exactly one enabled,
 * unrevoked contact for this family/person/source/account; ciphertext opens only under its AAD; E.164; identity hash
 * matches). It accepts either registry envelope so the numbers loaded by the lab are usable.
 */
export function createSarvamContactResolver(db: ContactDb, cfg: {
  account: string; identitySecret: string; contactKeyHex?: string; webhookKeyHex?: string;
}): ContactResolver {
  const resolveIdentity = async (familyId: string, personId: string, provider: 'sarvam' | 'twilio' | 'whatsapp'): Promise<ResolvedContact | null> => {
    if (provider !== 'sarvam' || !ACCOUNT.test(cfg.account) || !UUID.test(familyId) || !UUID.test(personId)) return null;
    const { data, error } = await db.from('provider_identities')
      .select('id,family_id,person_id,source,account_id,external_id_hash,binding_kind,contact_ciphertext,enabled,revoked_at')
      .eq('family_id', familyId).eq('person_id', personId).eq('source', 'sarvam').eq('account_id', cfg.account)
      .eq('binding_kind', 'contact').eq('enabled', true).is('revoked_at', null).limit(2);
    if (error || !Array.isArray(data)) throw new Error('contact_lookup_failed');
    if (data.length !== 1) return null;
    const row = data[0] as Record<string, unknown>;
    if (row.family_id !== familyId || row.person_id !== personId || row.source !== 'sarvam' || row.account_id !== cfg.account
      || row.binding_kind !== 'contact' || row.enabled !== true || row.revoked_at !== null) return null;
    const hash = row.external_id_hash, ct = row.contact_ciphertext;
    if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash) || typeof ct !== 'string' || typeof row.id !== 'string' || !UUID.test(row.id)) return null;
    const attempts: Array<[string | undefined, string]> = [
      [cfg.contactKeyHex, contactAad(familyId, personId, 'sarvam', cfg.account, hash)],
      [cfg.webhookKeyHex, shieldContactAad(familyId, personId, 'sarvam', cfg.account, hash)],
    ];
    for (const [key, aad] of attempts) {
      if (!key || !/^[0-9a-fA-F]{64}$/.test(key)) continue;
      let e164: string;
      try { e164 = decryptWebhook(ct, key, aad).toString('utf8'); } catch { continue; }
      if (!E164.test(e164) || identityHash('sarvam', cfg.account, contactDigits(e164), cfg.identitySecret) !== hash) return null;
      return { e164, identityId: row.id, accountId: cfg.account, identityHash: hash };
    }
    return null;
  };
  const resolver = async (familyId: string, personId: string, provider: 'sarvam' | 'twilio' | 'whatsapp') =>
    (await resolveIdentity(familyId, personId, provider))?.e164 ?? null;
  return Object.assign(resolver, { resolveIdentity });
}

export interface SarvamCallRuntime {
  provider: 'sarvam';
  deps: DispatchDeps;
  /** Sarvam agent placed for this role (the request `app_id`). */
  agentId: string;
}

/**
 * Committed version of one agent role. Each Sarvam agent has its own version history, so a per-role
 * `SARVAM_AGENT_VERSION_<ROLE>` wins over the shared `SARVAM_AGENT_VERSION` (then `SARVAM_APP_VERSION`, then 1).
 */
export function sarvamAgentVersion(env: Readonly<Record<string, string | undefined>>, role: string): number {
  const raw = env[`SARVAM_AGENT_VERSION_${role}`]?.trim() || env.SARVAM_AGENT_VERSION?.trim() || env.SARVAM_APP_VERSION?.trim() || '1';
  return /^[1-9]\d{0,5}$/.test(raw) ? Number(raw) : NaN;
}

/**
 * Sarvam outbound runtime for one agent role, or null when anything required is missing or outbound is switched off
 * (`SARVAM_OUTBOUND_ENABLED=0`, as the lab sets with providers off). Callers keep the authorized outbox row pending.
 */
export function createSarvamCallRuntime(
  db: SupabaseClientLike,
  env: Readonly<Record<string, string | undefined>>,
  role: SarvamAgentRole,
  transport: FetchTransport = globalThis.fetch as FetchTransport,
): SarvamCallRuntime | null {
  if (env.SARVAM_OUTBOUND_ENABLED === '0') return null;
  const account = sarvamContactAccount(env);
  const agentId = (env[`SARVAM_AGENT_ID_${role}`] ?? account)?.trim();
  const appVersion = sarvamAgentVersion(env, role);
  const agentPhoneNumber = env.SARVAM_AGENT_NUMBER ?? env.SARVAM_AGENT_PHONE_NUMBER;
  const identitySecret = env.IDENTITY_HASH_SECRET;
  const contactKeyHex = env.CONTACT_ENCRYPTION_KEY?.trim();
  const webhookKeyHex = env.WEBHOOK_ENCRYPTION_KEY?.trim();
  if (!env.SARVAM_API_KEY || !env.SARVAM_ORG_ID || !env.SARVAM_WORKSPACE_ID || !account || !agentId || !ACCOUNT.test(agentId)
    || !Number.isSafeInteger(appVersion) || !env.SARVAM_CONNECTION_ID || !agentPhoneNumber || !env.SARVAM_OUTBOUND_WEBHOOK_URL
    || !identitySecret || (!contactKeyHex && !webhookKeyHex)) return null;
  return {
    provider: 'sarvam',
    agentId,
    deps: {
      store: dispatchStore(db as unknown as Parameters<typeof dispatchStore>[0]),
      authorize: createSupabaseDispatchAuthorizer(db),
      transport,
      identitySecret,
      resolveDestination: createSarvamContactResolver(db as unknown as ContactDb, { account, identitySecret, contactKeyHex, webhookKeyHex }),
      providers: {
        sarvam: {
          apiKey: env.SARVAM_API_KEY, orgId: env.SARVAM_ORG_ID, workspaceId: env.SARVAM_WORKSPACE_ID,
          // The ledger/contact account. The transport wrapper swaps the request app_id to `agentId`.
          appId: account, appVersion, connectionId: env.SARVAM_CONNECTION_ID, agentPhoneNumber,
          webhookUrl: env.SARVAM_OUTBOUND_WEBHOOK_URL,
        },
      },
    },
  };
}

/** The callback line for a keypad voice note. Says it is an AI-read transcript; falls back when no transcript exists. */
export function voiceNoteLine(senderName: string, transcript?: string | null): string {
  const name = speechText(senderName || 'Parivar', 40).split(' ')[0] || 'Parivar';
  const text = transcript ? speechText(transcript, 300) : '';
  if (!text || text === 'Sahaj update') {
    return /^riya$/i.test(name) ? VOICE_NOTE_FALLBACK_LINE : VOICE_NOTE_FALLBACK_LINE.replace(/^Riya/, name);
  }
  return `${name} ka sandesh: ${text} — ye AI ka likha transcript hai, ${name} ki apni awaaz nahi.`;
}

/**
 * Heard proof rule for a Sarvam callback: a post-call event for OUR call that says the call connected and lasted at least
 * 10 seconds. Sarvam's outbound post-call statuses are connected / no_answer / busy / failed; `connected` with a duration is
 * the completed call. No event, or a shorter call, is not heard.
 */
export const SARVAM_HEARD_MIN_SECONDS = 10;
export function sarvamCallHeard(status: string | null | undefined, durationSeconds: number | null | undefined): boolean {
  return (status === 'connected' || status === 'completed') && typeof durationSeconds === 'number' && Number.isFinite(durationSeconds) && durationSeconds >= SARVAM_HEARD_MIN_SECONDS;
}
