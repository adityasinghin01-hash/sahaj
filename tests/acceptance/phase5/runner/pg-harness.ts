import { createHmac, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// Resolve pg via workspace node_modules / packages/atlas without touching root manifests.
const pgPath = require.resolve('pg', {
  paths: [
    process.cwd(),
    `${process.cwd()}/packages/atlas`,
    `${process.cwd()}/node_modules`,
  ],
});
const { Pool } = require(pgPath) as typeof import('pg');
export type PgPool = import('pg').Pool;
export type PgPoolClient = import('pg').PoolClient;

export const TEST_IDENTITY_SECRET = 'p5h-disposable-identity-secret-32chars';

export function hashSyntheticPhone(e164: string, secret = TEST_IDENTITY_SECRET): string {
  return createHmac('sha256', secret).update(e164).digest('hex');
}

export function getDisposableDatabaseUrl(): string | null {
  const url = process.env.PHASE5_TEST_DATABASE_URL?.trim();
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('PHASE5_TEST_DATABASE_URL is not a valid URL');
  }
  const host = parsed.hostname.toLowerCase();
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    throw new Error(
      `Refusing non-local PHASE5_TEST_DATABASE_URL host "${host}". Disposable harness only runs against throwaway local Postgres.`,
    );
  }
  return url;
}

export function createDisposablePool(connectionString?: string): PgPool {
  const url = connectionString ?? getDisposableDatabaseUrl();
  if (!url) {
    throw new Error('PHASE5_TEST_DATABASE_URL is not set');
  }
  return new Pool({ connectionString: url, max: 8 });
}

export interface SyntheticPgFamily {
  familyId: string;
  maaPersonId: string;
  riyaPersonId: string;
  riyaUserId: string;
  rohitPersonId: string;
  rohitUserId: string;
  sharmaPersonId: string;
  sharmaUserId: string;
  cleanup: () => Promise<void>;
}

export async function seedSyntheticFamily(pool: PgPool, tag = 'p5h'): Promise<SyntheticPgFamily> {
  const familyId = randomUUID();
  const maaPersonId = randomUUID();
  const riyaPersonId = randomUUID();
  const riyaUserId = randomUUID();
  const rohitPersonId = randomUUID();
  const rohitUserId = randomUUID();
  const sharmaPersonId = randomUUID();
  const sharmaUserId = randomUUID();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO auth.users(id) VALUES ($1), ($2), ($3)`, [
      riyaUserId,
      rohitUserId,
      sharmaUserId,
    ]);
    await client.query(
      `INSERT INTO public.families(id, name, language, demo) VALUES ($1, $2, 'hi', true)`,
      [familyId, `Synthetic ${tag}`],
    );
    await client.query(
      `INSERT INTO public.people(id, family_id, display_name, role, device, timezone)
       VALUES
         ($1, $2, 'Meena Maa', 'parent', 'keypad', 'Asia/Kolkata'),
         ($3, $2, 'Riya', 'child', 'smartphone', 'Asia/Kolkata'),
         ($4, $2, 'Rohit', 'child', 'smartphone', 'Asia/Kolkata'),
         ($5, $2, 'Sharma Uncle', 'circle', 'keypad', 'Asia/Kolkata')`,
      [
        maaPersonId,
        familyId,
        riyaPersonId,
        rohitPersonId,
        sharmaPersonId,
      ],
    );
    await client.query(
      `INSERT INTO public.family_memberships(family_id, user_id, person_id, role)
       VALUES
         ($1, $2, $3, 'child'),
         ($1, $4, $5, 'child'),
         ($1, $6, $7, 'circle')`,
      [familyId, riyaUserId, riyaPersonId, rohitUserId, rohitPersonId, sharmaUserId, sharmaPersonId],
    );
    await client.query(
      `INSERT INTO public.provider_identities(family_id, person_id, source, account_id, external_id_hash, binding_kind, enabled)
       VALUES
         ($1, $2, 'twilio', $3, $4, 'contact', true),
         ($1, $5, 'sarvam', $6, $7, 'contact', true)`,
      [
        familyId,
        maaPersonId,
        `AC-${familyId.slice(0, 8)}`,
        hashSyntheticPhone(`+919000000001:${familyId}`),
        riyaPersonId,
        `app-${familyId.slice(0, 8)}`,
        hashSyntheticPhone(`+919000000002:${familyId}`),
      ],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return {
    familyId,
    maaPersonId,
    riyaPersonId,
    riyaUserId,
    rohitPersonId,
    rohitUserId,
    sharmaPersonId,
    sharmaUserId,
    cleanup: async () => {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await c.query(`DELETE FROM public.families WHERE id = $1`, [familyId]);
        await c.query(`DELETE FROM auth.users WHERE id IN ($1, $2, $3)`, [
          riyaUserId,
          rohitUserId,
          sharmaUserId,
        ]);
        await c.query('COMMIT');
      } finally {
        c.release();
      }
    },
  };
}

export async function runAsAuthenticatedUser<T>(
  pool: PgPool,
  userId: string,
  fn: (client: PgPoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL ROLE authenticated`);
    await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [userId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function withDisposableFamily<T>(
  tag: string,
  fn: (ctx: { pool: PgPool; family: SyntheticPgFamily }) => Promise<T>,
): Promise<T> {
  const pool = createDisposablePool();
  const family = await seedSyntheticFamily(pool, tag);
  try {
    return await fn({ pool, family });
  } finally {
    await family.cleanup().catch(() => undefined);
    await pool.end().catch(() => undefined);
  }
}
