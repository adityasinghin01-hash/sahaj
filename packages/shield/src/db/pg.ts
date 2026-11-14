/**
 * Postgres implementation of the Shield database interfaces (card K-B3).
 *
 *   const sql = postgres(process.env.DATABASE_URL!, { prepare: false, max_pipeline: 1 });
 *   const pg = createShieldPg(sql);
 *   // pg.server satisfies ShieldServerDb, pg.tools satisfies ShieldDeps["db"].
 *
 * Every query is a postgres.js tagged template, so every value is sent as a bound parameter.
 * The connection must be the service role: the shield_* tables have no write policies.
 */
import type { ISql } from "postgres";
import type {
  NewPairingCode,
  NewShieldDevice,
  NewShieldEventRow,
  ShieldDeviceRow,
  ShieldServerDb,
} from "../server/types";
import type { CreateFamilyCheckInput, FamilyCheckRecord, FamilyCheckStateValue, ShieldDeps } from "../tools/types";

export type ShieldToolsDb = ShieldDeps["db"];

export interface ShieldPg {
  /** For ShieldServerDeps.db (pairing + event routes). */
  server: ShieldServerDb;
  /** For ShieldDeps.db (voice tools). */
  tools: ShieldToolsDb;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Ids reach these lookups from request headers, request bodies and AI tool input. A value that is
 * not a uuid cannot match a row, so it gets "not found" instead of a Postgres cast error (22P02).
 */
export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

/** NFC, trim, collapse whitespace runs to one space, lowercase. Must match NORM_SQL below. */
export function normalizePersonName(name: string): string {
  return name.normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();
}

export function createShieldPg(sql: ISql): ShieldPg {
  /** SQL twin of normalizePersonName for a column or array element. Static text, no values. */
  const norm = (expr: "p.name" | "a") =>
    expr === "p.name"
      ? sql`lower(btrim(regexp_replace(normalize(p.name, NFC), '[[:space:]]+', ' ', 'g')))`
      : sql`lower(btrim(regexp_replace(normalize(a, NFC), '[[:space:]]+', ' ', 'g')))`;

  const server: ShieldServerDb = {
    async getDevice(deviceId: string): Promise<ShieldDeviceRow | null> {
      if (!isUuid(deviceId)) return null;
      const [row] = await sql<ShieldDeviceRow[]>`
        select id, family_id, person_id, device_secret_hash
        from public.shield_devices
        where id = ${deviceId}`;
      return row ?? null;
    },

    async insertDevice(row: NewShieldDevice): Promise<void> {
      await sql`
        insert into public.shield_devices
          (id, family_id, person_id, label, platform, android_version, protections, paired_at, device_secret_hash)
        values
          (${row.id}, ${row.family_id}, ${row.person_id}, ${row.label}, ${row.platform}, ${row.android_version},
           ${sql.json(row.protections)}, ${row.paired_at}::timestamptz, ${row.device_secret_hash})`;
    },

    async insertEvent(row: NewShieldEventRow): Promise<{ id: string } | { duplicate: true }> {
      const [inserted] = await sql<{ id: string }[]>`
        insert into public.shield_events
          (idempotency_key, family_id, parent_id, device_id, channel, kind, occurred_at, masked_text,
           sender_type, caller_type, link_domains, matched_rules, local_level, context)
        values
          (${row.idempotency_key}, ${row.family_id}, ${row.parent_id}, ${row.device_id}, ${row.channel}, ${row.kind},
           ${row.occurred_at}::timestamptz, ${row.masked_text}, ${row.sender_type}, ${row.caller_type},
           ${row.link_domains}::text[], ${row.matched_rules}::text[], ${row.local_level}, ${sql.json(row.context)})
        on conflict (idempotency_key) do nothing
        returning id`;
      return inserted ? { id: inserted.id } : { duplicate: true };
    },

    async touchHeartbeat(deviceId: string, at: Date): Promise<void> {
      if (!isUuid(deviceId)) return;
      // Heartbeats run in the background and can land out of order; never move the time backwards.
      await sql`
        update public.shield_devices
        set last_heartbeat_at = greatest(coalesce(last_heartbeat_at, ${at}::timestamptz), ${at}::timestamptz)
        where id = ${deviceId}`;
    },

    async getPerson(personId: string): Promise<{ id: string; family_id: string } | null> {
      if (!isUuid(personId)) return null;
      const [row] = await sql<{ id: string; family_id: string }[]>`
        select id, family_id from public.people where id = ${personId}`;
      return row ?? null;
    },

    async countActivePairingCodes(familyId: string, now: Date): Promise<number> {
      if (!isUuid(familyId)) return 0;
      const [row] = await sql<{ n: number }[]>`
        select count(*)::int as n
        from public.shield_pairing_codes
        where family_id = ${familyId} and used_at is null and expires_at > ${now}::timestamptz`;
      return row?.n ?? 0;
    },

    async insertPairingCode(row: NewPairingCode): Promise<void> {
      await sql`
        insert into public.shield_pairing_codes (family_id, created_by_user_id, code_hash, expires_at)
        values (${row.family_id}, ${row.created_by_user_id}, ${row.code_hash}, ${row.expires_at}::timestamptz)`;
    },

    async claimPairingCode({ familyId, codeHash, now }): Promise<{ id: string } | null> {
      if (!isUuid(familyId)) return null;
      // One conditional UPDATE, no read-then-write. Concurrent claims of the same row queue on its row
      // lock; under READ COMMITTED each waiter re-checks the WHERE once the winner commits, sees
      // used_at set, and updates nothing. So exactly one caller gets the id back.
      const [row] = await sql<{ id: string }[]>`
        update public.shield_pairing_codes
        set used_at = ${now}::timestamptz
        where family_id = ${familyId} and code_hash = ${codeHash}
          and used_at is null and expires_at > ${now}::timestamptz
        returning id`;
      return row ?? null;
    },

    async expireActivePairingCodes(familyId: string, now: Date): Promise<void> {
      if (!isUuid(familyId)) return;
      await sql`
        update public.shield_pairing_codes
        set expires_at = ${now}::timestamptz
        where family_id = ${familyId} and used_at is null and expires_at > ${now}::timestamptz`;
    },

    async recordPairingFailure(familyId: string, at: Date): Promise<void> {
      await sql`
        insert into public.shield_pairing_failures (family_id, attempted_at)
        values (${familyId}, ${at}::timestamptz)`;
    },

    async countPairingFailures(familyId: string, since: Date): Promise<number> {
      if (!isUuid(familyId)) return 0;
      const [row] = await sql<{ n: number }[]>`
        select count(*)::int as n
        from public.shield_pairing_failures
        where family_id = ${familyId} and attempted_at >= ${since}::timestamptz`;
      return row?.n ?? 0;
    },

    async getPairingLockedUntil(familyId: string): Promise<Date | null> {
      if (!isUuid(familyId)) return null;
      const [row] = await sql<{ locked_until: Date }[]>`
        select locked_until from public.shield_pairing_locks where family_id = ${familyId}`;
      return row?.locked_until ?? null;
    },

    async setPairingLockedUntil(familyId: string, until: Date): Promise<void> {
      await sql`
        insert into public.shield_pairing_locks (family_id, locked_until)
        values (${familyId}, ${until}::timestamptz)
        on conflict (family_id) do update set locked_until = excluded.locked_until`;
    },
  };

  const tools: ShieldToolsDb = {
    async createFamilyCheck(input: CreateFamilyCheckInput): Promise<{ id: string }> {
      // family_checks has no column for input.askedWhat; it travels on the WhatsApp card and the
      // signed timeline event instead. The first channel is always the WhatsApp card.
      const [row] = await sql<{ id: string }[]>`
        insert into public.family_checks
          (family_id, parent_id, claimed_name, asked_person_id, channel, state, asked_at, created_at)
        values
          (${input.familyId}, ${input.parentId}, ${input.claimedName}, ${input.toPersonId}, 'whatsapp',
           ${input.state}, ${input.createdAt}::timestamptz, ${input.createdAt}::timestamptz)
        returning id`;
      if (!row) throw new Error("family_checks insert returned no row");
      return { id: row.id };
    },

    async getFamilyCheck(id: string): Promise<FamilyCheckRecord | null> {
      if (!isUuid(id)) return null;
      const [row] = await sql<
        { state: FamilyCheckStateValue; family_id: string; asked_person_id: string | null; claimed_name: string | null }[]
      >`
        select state, family_id, asked_person_id, claimed_name
        from public.family_checks
        where id = ${id}`;
      if (!row) return null;
      const rec: FamilyCheckRecord = { state: row.state, familyId: row.family_id };
      if (row.asked_person_id !== null) rec.toPersonId = row.asked_person_id;
      if (row.claimed_name !== null) rec.claimedName = row.claimed_name;
      return rec;
    },

    async findPersonByName(familyId: string, name: string): Promise<{ id: string; name: string } | null> {
      if (!isUuid(familyId) || typeof name !== "string") return null;
      const wanted = normalizePersonName(name);
      if (wanted === "") return null;
      // Same family only. A match on the name itself wins over an alias match; ties go to the lowest id
      // so the answer is stable.
      const [row] = await sql<{ id: string; name: string }[]>`
        select p.id, p.name
        from public.people p
        where p.family_id = ${familyId}
          and (${norm("p.name")} = ${wanted}
               or exists (select 1 from unnest(p.aliases) as a where ${norm("a")} = ${wanted}))
        order by (${norm("p.name")} = ${wanted}) desc, p.id
        limit 1`;
      return row ?? null;
    },

    async getCodeWordHash(familyId: string): Promise<string | null> {
      if (!isUuid(familyId)) return null;
      const [row] = await sql<{ code_word_hash: string | null }[]>`
        select code_word_hash from public.families where id = ${familyId}`;
      return row?.code_word_hash ?? null;
    },
  };

  return { server, tools };
}
