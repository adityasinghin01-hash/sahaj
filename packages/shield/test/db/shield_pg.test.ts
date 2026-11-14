/**
 * Integration tests for src/db against a real Postgres (card K-B3).
 * Run through infra/supabase/test/run-shield-db-test.sh, which starts a throwaway cluster, applies
 * both Shield migrations and sets DATABASE_URL. Without DATABASE_URL (plain `pnpm test`) they skip.
 */
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createShieldPg, type ShieldPg } from "../../src/db";
import {
  createPairingCode,
  handleShieldEvent,
  handleShieldPair,
  type NewShieldEventRow,
  type ShieldServerDeps,
} from "../../src/server";
import { checkCodeWord, familyCheck, familyCheckResult, type ShieldDeps } from "../../src/tools";
import { sha256Hex } from "../../src/tools/check_code_word";
import { makeEvent, PAIRING_SECRET, pairBody, pairRequest, signedEventRequest } from "../server/fakes";
import { ctx as toolCtx, makeDeps } from "../tools/fakes";

const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
const DATABASE_URL = env.DATABASE_URL;
if (!DATABASE_URL && env.SHIELD_DB_TEST_REQUIRED) throw new Error("SHIELD_DB_TEST_REQUIRED is set but DATABASE_URL is not");

const T0 = new Date("2026-11-14T10:00:00.000Z");
const MIN = 60_000;
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

describe.skipIf(!DATABASE_URL)("createShieldPg against Postgres", () => {
  let sql: Sql;
  let pg: ShieldPg;
  let seq = 0;

  beforeAll(() => {
    sql = postgres(DATABASE_URL!, { max: 10, onnotice: () => undefined });
    pg = createShieldPg(sql);
  });
  afterAll(async () => {
    await sql?.end({ timeout: 5 });
  });

  /** A fresh family with one parent and the given extra people. Each test gets its own family. */
  async function seedFamily(opts: { codeWordHash?: string | null; people?: { name: string; aliases?: string[]; role?: string }[] } = {}) {
    const [fam] = await sql<{ id: string }[]>`
      insert into public.families (name) values ('Synthetic family') returning id`;
    const familyId = fam!.id;
    await sql`insert into public.shield_family_security(family_id,code_word_hash) values (${familyId},${opts.codeWordHash ?? null})`;
    const [parent] = await sql<{ id: string }[]>`
      insert into public.people (family_id, display_name, role) values (${familyId}, 'Maa', 'parent') returning id`;
    const people: Record<string, string> = {};
    for (const p of opts.people ?? []) {
      const [row] = await sql<{ id: string }[]>`
        insert into public.people (family_id, display_name, aliases, role)
        values (${familyId}, ${p.name}, ${p.aliases ?? []}::text[], ${p.role ?? "child"})
        returning id`;
      people[p.name] = row!.id;
    }
    return { familyId, parentId: parent!.id, people };
  }

  async function seedDevice(familyId: string, personId: string) {
    const id = globalThis.crypto.randomUUID();
    await pg.server.insertDevice({
      id,
      family_id: familyId,
      person_id: personId,
      label: "Maa ka phone",
      platform: "android",
      android_version: "14",
      protections: { sms: true, screening: false },
      paired_at: T0,
      device_secret_hash: HASH_A,
    });
    return id;
  }

  function eventRow(f: { familyId: string; parentId: string }, deviceId: string, key: string): NewShieldEventRow {
    return {
      idempotency_key: key,
      family_id: f.familyId,
      parent_id: f.parentId,
      device_id: deviceId,
      channel: "device",
      kind: "sms",
      occurred_at: "2026-11-14T09:59:00.000Z",
      masked_text: "Aapka KYC block hoga, OTP <NUM> bataiye",
      sender_type: "mobile_10",
      caller_type: null,
      link_domains: ["kyc-update.in", "bit.ly"],
      matched_rules: ["P2"],
      local_level: "red",
      context: { app: "messages", count: 2, saved: false },
    };
  }

  const key = (label: string) => `${label}-${Date.now()}-${++seq}`;

  /* ---------------------------------------------------------------- pairing codes */

  describe("pairing codes", () => {
    it("create → use once → second use fails", async () => {
      const f = await seedFamily();
      const userId = globalThis.crypto.randomUUID();
      await pg.server.insertPairingCode({ family_id: f.familyId, created_by_user_id: userId, code_hash: HASH_A, expires_at: new Date(T0.getTime() + 10 * MIN) });
      expect(await pg.server.countActivePairingCodes(f.familyId, T0)).toBe(1);

      const first = await pg.server.claimPairingCode({ familyId: f.familyId, codeHash: HASH_A, now: T0 });
      expect(first).toEqual({ id: expect.any(String) });
      expect(await pg.server.claimPairingCode({ familyId: f.familyId, codeHash: HASH_A, now: T0 })).toBeNull();
      expect(await pg.server.countActivePairingCodes(f.familyId, T0)).toBe(0);

      const [row] = await sql<{ used_at: Date; created_by_user_id: string }[]>`
        select used_at, created_by_user_id from public.shield_pairing_codes where id = ${first!.id}`;
      expect(row!.used_at.toISOString()).toBe(T0.toISOString());
      expect(row!.created_by_user_id).toBe(userId);
    });

    it("10 parallel uses of one code → exactly 1 succeeds", async () => {
      const f = await seedFamily();
      await pg.server.insertPairingCode({ family_id: f.familyId, created_by_user_id: globalThis.crypto.randomUUID(), code_hash: HASH_A, expires_at: new Date(T0.getTime() + 10 * MIN) });

      const results = await Promise.all(
        Array.from({ length: 10 }, () => pg.server.claimPairingCode({ familyId: f.familyId, codeHash: HASH_A, now: T0 })),
      );
      expect(results.filter((r) => r !== null)).toHaveLength(1);
      expect(results.filter((r) => r === null)).toHaveLength(9);

      // The 10 claims really ran on separate connections (the pool is max 10).
      const [conn] = await sql<{ n: number }[]>`select count(*)::int as n from pg_stat_activity where usename = 'service_role'`;
      expect(conn!.n).toBeGreaterThan(1);
    });

    it("expired code, wrong hash and other family's code all fail", async () => {
      const f = await seedFamily();
      const other = await seedFamily();
      const user = globalThis.crypto.randomUUID();
      await pg.server.insertPairingCode({ family_id: f.familyId, created_by_user_id: user, code_hash: HASH_A, expires_at: new Date(T0.getTime() + 10 * MIN) });

      expect(await pg.server.claimPairingCode({ familyId: f.familyId, codeHash: HASH_A, now: new Date(T0.getTime() + 10 * MIN) })).toBeNull();
      expect(await pg.server.claimPairingCode({ familyId: f.familyId, codeHash: HASH_B, now: T0 })).toBeNull();
      expect(await pg.server.claimPairingCode({ familyId: other.familyId, codeHash: HASH_A, now: T0 })).toBeNull();
      expect(await pg.server.claimPairingCode({ familyId: "not-a-uuid", codeHash: HASH_A, now: T0 })).toBeNull();
      // Still claimable by the right family before expiry.
      expect(await pg.server.claimPairingCode({ familyId: f.familyId, codeHash: HASH_A, now: T0 })).not.toBeNull();
    });

    it("expireActivePairingCodes ends only the family's active codes", async () => {
      const f = await seedFamily();
      const other = await seedFamily();
      const user = globalThis.crypto.randomUUID();
      const exp = new Date(T0.getTime() + 10 * MIN);
      await pg.server.insertPairingCode({ family_id: f.familyId, created_by_user_id: user, code_hash: HASH_A, expires_at: exp });
      await pg.server.insertPairingCode({ family_id: f.familyId, created_by_user_id: user, code_hash: HASH_B, expires_at: exp });
      await pg.server.insertPairingCode({ family_id: other.familyId, created_by_user_id: user, code_hash: HASH_A, expires_at: exp });

      await pg.server.expireActivePairingCodes(f.familyId, T0);
      expect(await pg.server.countActivePairingCodes(f.familyId, T0)).toBe(0);
      expect(await pg.server.claimPairingCode({ familyId: f.familyId, codeHash: HASH_A, now: T0 })).toBeNull();
      expect(await pg.server.countActivePairingCodes(other.familyId, T0)).toBe(1);
    });

    it("failures are counted in the window and the lock is upserted", async () => {
      const f = await seedFamily();
      await pg.server.recordPairingFailure(f.familyId, new Date(T0.getTime() - 11 * MIN));
      await pg.server.recordPairingFailure(f.familyId, new Date(T0.getTime() - 2 * MIN));
      await pg.server.recordPairingFailure(f.familyId, T0);
      expect(await pg.server.countPairingFailures(f.familyId, new Date(T0.getTime() - 10 * MIN))).toBe(2);

      expect(await pg.server.getPairingLockedUntil(f.familyId)).toBeNull();
      const until1 = new Date(T0.getTime() + 10 * MIN);
      const until2 = new Date(T0.getTime() + 20 * MIN);
      await pg.server.setPairingLockedUntil(f.familyId, until1);
      expect((await pg.server.getPairingLockedUntil(f.familyId))?.toISOString()).toBe(until1.toISOString());
      await pg.server.setPairingLockedUntil(f.familyId, until2);
      expect((await pg.server.getPairingLockedUntil(f.familyId))?.toISOString()).toBe(until2.toISOString());
    });
  });

  /* ---------------------------------------------------------------- devices + events */

  describe("devices and events", () => {
    it("getPerson and getDevice return the row, null for unknown or non-uuid ids", async () => {
      const f = await seedFamily();
      expect(await pg.server.getPerson(f.parentId)).toEqual({ id: f.parentId, family_id: f.familyId });
      expect(await pg.server.getPerson(globalThis.crypto.randomUUID())).toBeNull();
      expect(await pg.server.getPerson("maa_1")).toBeNull();

      const deviceId = await seedDevice(f.familyId, f.parentId);
      expect(await pg.server.getDevice(deviceId)).toEqual({ id: deviceId, family_id: f.familyId, person_id: f.parentId, device_secret_hash: HASH_A });
      expect(await pg.server.getDevice(globalThis.crypto.randomUUID())).toBeNull();
      expect(await pg.server.getDevice("dev-1")).toBeNull();

      const [row] = await sql<{ protections: Record<string, boolean>; platform: string; label: string }[]>`
        select protections, platform, label from public.shield_devices where id = ${deviceId}`;
      expect(row).toEqual({ protections: { sms: true, screening: false }, platform: "android", label: "Maa ka phone" });
    });

    it("event insert, then the same idempotency_key is a duplicate", async () => {
      const f = await seedFamily();
      const deviceId = await seedDevice(f.familyId, f.parentId);
      const k = key("evt");

      const first = await pg.server.insertEvent(eventRow(f, deviceId, k));
      expect(first).toEqual({ id: expect.any(String) });
      expect(await pg.server.insertEvent(eventRow(f, deviceId, k))).toEqual({ duplicate: true });

      const rows = await sql<{ id: string; link_domains: string[]; matched_rules: string[]; context: unknown; occurred_at: Date; caller_type: string | null }[]>`
        select id, link_domains, matched_rules, context, occurred_at, caller_type
        from public.shield_events where idempotency_key = ${k}`;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual({
        id: (first as { id: string }).id,
        link_domains: ["kyc-update.in", "bit.ly"],
        matched_rules: ["P2"],
        context: { app: "messages", count: 2, saved: false },
        occurred_at: new Date("2026-11-14T09:59:00.000Z"),
        caller_type: null,
      });
    });

    it("event with empty arrays, empty context and null text", async () => {
      const f = await seedFamily();
      const deviceId = await seedDevice(f.familyId, f.parentId);
      const k = key("evt");
      const res = await pg.server.insertEvent({ ...eventRow(f, deviceId, k), masked_text: null, local_level: null, link_domains: [], matched_rules: [], context: {} });
      expect(res).toEqual({ id: expect.any(String) });
      const [row] = await sql<{ link_domains: string[]; context: unknown; masked_text: string | null }[]>`
        select link_domains, context, masked_text from public.shield_events where idempotency_key = ${k}`;
      expect(row).toEqual({ link_domains: [], context: {}, masked_text: null });
    });

    it("an event that breaks a constraint throws (it is not reported as a duplicate)", async () => {
      const f = await seedFamily();
      const deviceId = await seedDevice(f.familyId, f.parentId);
      await expect(pg.server.insertEvent({ ...eventRow(f, deviceId, key("evt")), channel: "carrier_pigeon" })).rejects.toMatchObject({ code: "23514" });
    });

    it("heartbeat update, and an older heartbeat never moves it back", async () => {
      const f = await seedFamily();
      const deviceId = await seedDevice(f.familyId, f.parentId);
      const read = async () =>
        (await sql<{ at: Date | null }[]>`select last_heartbeat_at as at from public.shield_devices where id = ${deviceId}`)[0]!.at;

      expect(await read()).toBeNull();
      const t1 = new Date(T0.getTime() + 5 * MIN);
      await pg.server.touchHeartbeat(deviceId, t1);
      expect((await read())?.toISOString()).toBe(t1.toISOString());
      await pg.server.touchHeartbeat(deviceId, T0);
      expect((await read())?.toISOString()).toBe(t1.toISOString());
      const t2 = new Date(T0.getTime() + 9 * MIN);
      await pg.server.touchHeartbeat(deviceId, t2);
      expect((await read())?.toISOString()).toBe(t2.toISOString());
      await expect(pg.server.touchHeartbeat("dev-1", t2)).resolves.toBeUndefined();
    });
  });

  /* ---------------------------------------------------------------- voice tools db */

  describe("voice tools", () => {
    it("family check create/get returns state, familyId, toPersonId, claimedName", async () => {
      const f = await seedFamily({ people: [{ name: "Rahul" }] });
      const rahul = f.people.Rahul!;
      const { id } = await pg.tools.createFamilyCheck({
        familyId: f.familyId,
        parentId: f.parentId,
        toPersonId: rahul,
        claimedName: "Rahul",
        askedWhat: "paise bhejo <NUM>",
        state: "asked",
        createdAt: T0,
      });
      expect(await pg.tools.getFamilyCheck(id)).toEqual({ state: "asked", familyId: f.familyId, toPersonId: rahul, claimedName: "Rahul" });

      const [row] = await sql<{ channel: string; asked_at: Date; parent_id: string }[]>`
        select channel, asked_at, parent_id from public.family_checks where id = ${id}`;
      expect(row).toEqual({ channel: "whatsapp", asked_at: T0, parent_id: f.parentId });

      await sql`update public.family_checks set state = 'denied' where id = ${id}`;
      expect((await pg.tools.getFamilyCheck(id))?.state).toBe("denied");

      expect(await pg.tools.getFamilyCheck(globalThis.crypto.randomUUID())).toBeNull();
      expect(await pg.tools.getFamilyCheck("chk_1")).toBeNull();
      expect(await pg.tools.getFamilyCheck("'; drop table public.family_checks; --")).toBeNull();
    });

    it("findPersonByName matches name or alias, any case, extra spaces; Hindi as typed", async () => {
      const f = await seedFamily({
        people: [
          { name: "Rahul Sharma", aliases: ["Bittu", "  Munna  Bhai "] },
          { name: "राहुल", aliases: ["छोटू"] },
        ],
      });
      const rahul = { id: f.people["Rahul Sharma"]!, name: "Rahul Sharma" };
      const hindi = { id: f.people["राहुल"]!, name: "राहुल" };

      expect(await pg.tools.findPersonByName(f.familyId, "Rahul Sharma")).toEqual(rahul);
      expect(await pg.tools.findPersonByName(f.familyId, "  rAHUL   sharma ")).toEqual(rahul);
      expect(await pg.tools.findPersonByName(f.familyId, "BITTU")).toEqual(rahul);
      expect(await pg.tools.findPersonByName(f.familyId, "munna bhai")).toEqual(rahul);
      expect(await pg.tools.findPersonByName(f.familyId, "राहुल")).toEqual(hindi);
      expect(await pg.tools.findPersonByName(f.familyId, " छोटू ")).toEqual(hindi);

      expect(await pg.tools.findPersonByName(f.familyId, "Rahul")).toBeNull(); // no partial matches
      expect(await pg.tools.findPersonByName(f.familyId, "Rah%")).toBeNull(); // no LIKE wildcards
      expect(await pg.tools.findPersonByName(f.familyId, "   ")).toBeNull();
    });

    it("an exact name match wins over another person's alias", async () => {
      const f = await seedFamily({ people: [{ name: "Ravi", aliases: ["Rinku"] }, { name: "Rinku" }] });
      expect(await pg.tools.findPersonByName(f.familyId, "rinku")).toEqual({ id: f.people.Rinku!, name: "Rinku" });
    });

    it("another family's person is never returned", async () => {
      const mine = await seedFamily({ people: [{ name: "Priya" }] });
      const theirs = await seedFamily({ people: [{ name: "Neha", aliases: ["Guddi"] }, { name: "Priya" }] });

      expect(await pg.tools.findPersonByName(mine.familyId, "Neha")).toBeNull();
      expect(await pg.tools.findPersonByName(mine.familyId, "guddi")).toBeNull();
      expect(await pg.tools.findPersonByName(mine.familyId, "Priya")).toEqual({ id: mine.people.Priya!, name: "Priya" });
      expect(await pg.tools.findPersonByName(theirs.familyId, "Priya")).toEqual({ id: theirs.people.Priya!, name: "Priya" });
      expect(await pg.tools.findPersonByName("not-a-uuid", "Priya")).toBeNull();
    });

    it("code word hash read", async () => {
      const hash = await sha256Hex("neem ka ped");
      const withWord = await seedFamily({ codeWordHash: hash });
      const without = await seedFamily();
      expect(await pg.tools.getCodeWordHash(withWord.familyId)).toBe(hash);
      expect(await pg.tools.getCodeWordHash(without.familyId)).toBeNull();
      expect(await pg.tools.getCodeWordHash(globalThis.crypto.randomUUID())).toBeNull();
      expect(await pg.tools.getCodeWordHash("fam_1")).toBeNull();
    });
  });

  /* ---------------------------------------------------------------- end to end through the handlers */

  describe("plugged into the existing handlers", () => {
    it("pairing code → pair → signed event → duplicate", async () => {
      const f = await seedFamily();
      const waits: Promise<unknown>[] = [];
      const deps: ShieldServerDeps = {
        db: pg.server,
        atlas: { enqueueShieldEvent: vi.fn(async () => undefined) },
        waitUntil: (p) => void waits.push(p),
        env: { SHIELD_DEVICE_PAIRING_SECRET: PAIRING_SECRET },
        clock: { now: () => new Date() },
        log: { error: vi.fn() },
      };

      const created = await createPairingCode(deps, { familyId: f.familyId, userId: globalThis.crypto.randomUUID() });
      if (!created.ok) throw new Error(`createPairingCode: ${created.reason}`);

      const paired = await handleShieldPair(pairRequest(pairBody(created.code, { parent_person_id: f.parentId })), deps);
      expect(paired.status).toBe(200);
      const { device_id, device_secret } = (await paired.json()) as { device_id: string; device_secret: string };
      const again = await handleShieldPair(pairRequest(pairBody(created.code, { parent_person_id: f.parentId })), deps);
      expect(again.status).toBe(400);

      const body = JSON.stringify(makeEvent(device_id, { family_id: f.familyId, parent_id: f.parentId, idempotency_key: key("e2e") }));
      const res = await handleShieldEvent(await signedEventRequest({ deviceId: device_id, deviceSecret: device_secret, body }), deps);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, event_id: expect.any(String) });
      await Promise.all(waits.splice(0));
      expect(deps.atlas.enqueueShieldEvent).toHaveBeenCalledTimes(1);

      const dup = await handleShieldEvent(await signedEventRequest({ deviceId: device_id, deviceSecret: device_secret, body }), deps);
      expect(await dup.json()).toEqual({ ok: true, duplicate: true });
      await Promise.all(waits.splice(0));
      expect(deps.atlas.enqueueShieldEvent).toHaveBeenCalledTimes(1);

      const [hb] = await sql<{ at: Date | null }[]>`select last_heartbeat_at as at from public.shield_devices where id = ${device_id}`;
      expect(hb!.at).toBeInstanceOf(Date);
      expect(deps.log?.error).not.toHaveBeenCalled();
    });

    it("family_check → family_check_result and check_code_word with the real db", async () => {
      const f = await seedFamily({ codeWordHash: await sha256Hex("neem ka ped"), people: [{ name: "Rahul", aliases: ["Bittu"] }] });
      const fake = (await makeDeps()).deps;
      const deps = { ...fake, db: pg.tools } as ShieldDeps;
      const ctx = { ...toolCtx, familyId: f.familyId, parentId: f.parentId };

      const asked = await familyCheck.run(deps, ctx, { claimed_name: "bittu", asked_for: "paise chahiye" });
      expect(asked).toMatchObject({ status: "checking", check_id: expect.any(String) });
      const checkId = (asked as { check_id: string }).check_id;

      const [row] = await sql<{ asked_person_id: string; claimed_name: string }[]>`
        select asked_person_id, claimed_name from public.family_checks where id = ${checkId}`;
      expect(row).toEqual({ asked_person_id: f.people.Rahul, claimed_name: "Rahul" });

      expect(await familyCheckResult.run(deps, ctx, { check_id: checkId })).toMatchObject({ status: "pending" });
      await sql`update public.family_checks set state = 'confirmed' where id = ${checkId}`;
      const confirmed = await familyCheckResult.run(deps, ctx, { check_id: checkId });
      expect(confirmed).toMatchObject({ status: "confirmed", level: "green" });
      expect((confirmed as { line_hi: string }).line_hi).toContain("Rahul");

      // Another family asking about this check id gets not_found.
      const other = await seedFamily();
      expect(await familyCheckResult.run(deps, { ...ctx, familyId: other.familyId }, { check_id: checkId })).toMatchObject({ status: "not_found" });

      expect(await checkCodeWord.run(deps, ctx, { heard: "  Neem Ka Ped " })).toEqual({ ok: true });
      expect(await checkCodeWord.run(deps, ctx, { heard: "aam ka ped" })).toMatchObject({ ok: false });
    });
  });
});
