/**
 * createWarningsPg + shield_record_scam_indicator against a real Postgres (card K-B5).
 * Run through infra/supabase/test/run-shield-db-test.sh. Skips without DATABASE_URL.
 */
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createWarningsPg } from "../../src/db";
import {
  CONFIRM_MIN_FAMILIES,
  DEFAULT_TIP,
  FALLBACK_SUMMARY,
  fingerprint,
  onChildFeedback,
  pickWeeklyTip,
  type WarningsDb,
  type WarningsDeps,
} from "../../src/warnings";

const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
const DATABASE_URL = env.DATABASE_URL;
if (!DATABASE_URL && env.SHIELD_DB_TEST_REQUIRED) throw new Error("SHIELD_DB_TEST_REQUIRED is set but DATABASE_URL is not");

const NOW = new Date("2026-11-14T10:00:00.000Z");
const DAY = 24 * 60 * 60_000;
const SCAM_TEXT = "Dear customer your SBI KYC is blocked. Update now at link or account closed. Call <MOBILE_10>";
const RAW_NUMBER = "9876543210";

describe.skipIf(!DATABASE_URL)("createWarningsPg against Postgres", () => {
  let sql: Sql;
  let db: WarningsDb;
  let seq = 0;

  beforeAll(() => {
    sql = postgres(DATABASE_URL!, { max: 10, onnotice: () => undefined });
    db = createWarningsPg(sql);
  });
  afterAll(async () => {
    await sql?.end({ timeout: 5 });
  });
  // Indicators are shared across families, so each test starts from an empty table.
  beforeEach(async () => {
    await sql`delete from public.scam_indicators`;
  });

  function deps(now = NOW): WarningsDeps {
    return {
      db,
      llm: { understand: vi.fn(async () => ({ ok: false as const, reason: "offline" })) },
      clock: { now: () => now },
    };
  }

  async function seedFamily() {
    const [fam] = await sql<{ id: string }[]>`insert into public.families default values returning id`;
    const [maa] = await sql<{ id: string }[]>`
      insert into public.people (family_id, name, role) values (${fam!.id}, 'Maa', 'parent') returning id`;
    return { familyId: fam!.id, parentId: maa!.id };
  }

  async function seedEvent(
    f: { familyId: string; parentId: string },
    opts: { domains?: string[]; text?: string | null; context?: Record<string, string> } = {},
  ) {
    const [row] = await sql<{ id: string }[]>`
      insert into public.shield_events
        (family_id, parent_id, channel, kind, occurred_at, masked_text, link_domains, context, idempotency_key)
      values
        (${f.familyId}, ${f.parentId}, 'device', 'sms', ${NOW}::timestamptz, ${opts.text === undefined ? SCAM_TEXT : opts.text},
         ${opts.domains ?? ["login.sbi-update.co.in"]}::text[], ${sql.json(opts.context ?? {})}, ${`warn-evt-${++seq}-${Date.now()}`})
      returning id`;
    return row!.id;
  }

  async function seedVerdict(f: { familyId: string; parentId: string }, eventIds: string[], scamType = "kyc_block", feedback: string | null = "fraud") {
    const [row] = await sql<{ id: string }[]>`
      insert into public.shield_verdicts (family_id, parent_id, event_ids, level, scam_type, confidence, child_feedback, feedback_at)
      values (${f.familyId}, ${f.parentId}, ${eventIds}::uuid[], 'red', ${scamType}, 0.9, ${feedback},
              ${feedback ? NOW : null}::timestamptz)
      returning id`;
    return row!.id;
  }

  it("getVerdictForFeedback collects the verdict's own-family events only", async () => {
    const f = await seedFamily();
    const g = await seedFamily();
    const numFp = (await fingerprint("number", RAW_NUMBER))!;
    const e1 = await seedEvent(f, { domains: ["a.sbi-update.co.in", "bit.ly"], context: { number_fingerprint: numFp } });
    const e2 = await seedEvent(f, { domains: ["bit.ly"], text: null });
    const foreign = await seedEvent(g, { domains: ["other-family.com"], text: "other family text that must not leak" });
    const v = await seedVerdict(f, [e1, e2, foreign]);

    const got = await db.getVerdictForFeedback(v);
    expect(got).toEqual({
      id: v,
      familyId: f.familyId,
      scamType: "kyc_block",
      childFeedback: "fraud",
      linkDomains: ["a.sbi-update.co.in", "bit.ly"],
      maskedTexts: [SCAM_TEXT],
      numberFingerprints: [numFp],
    });
    expect(await db.getVerdictForFeedback("not-a-uuid")).toBeNull();
    expect(await db.getVerdictForFeedback(globalThis.crypto.randomUUID())).toBeNull();
  });

  it("same scam from 2 families → families_affected 2, confirmed; raw values are never stored", async () => {
    const numFp = (await fingerprint("number", RAW_NUMBER))!;
    const fa = await seedFamily();
    const fb = await seedFamily();
    const va = await seedVerdict(fa, [await seedEvent(fa, { context: { number_fingerprint: numFp } })]);
    const vb = await seedVerdict(fb, [await seedEvent(fb, { domains: ["https://WWW.sbi-update.co.in/x"], context: { number_fingerprint: numFp } })]);

    const a = await onChildFeedback(deps(), { verdictId: va, feedback: "fraud" });
    expect(a.indicators.map((i) => i.kind).sort()).toEqual(["domain", "number", "template"]);
    expect(a.indicators.every((i) => i.familiesAffected === 1 && !i.confirmed)).toBe(true);

    const b = await onChildFeedback(deps(), { verdictId: vb, feedback: "fraud" });
    expect(b.indicators.every((i) => i.familiesAffected === 2 && i.confirmed && i.counted)).toBe(true);

    const rows = await sql<Record<string, unknown>[]>`select * from public.scam_indicators order by kind`;
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r).toMatchObject({ times_seen: 2, families_affected: 2, confirmed: true, scam_type: "kyc_block" });
      expect(r.summary_en).toBe(FALLBACK_SUMMARY.kyc_block.summary_en);
    }
    const dump = JSON.stringify(rows).toLowerCase();
    expect(dump).not.toContain("sbi-update");
    expect(dump).not.toContain(RAW_NUMBER);
    expect(dump).not.toContain("kyc is blocked");
    expect(rows.find((r) => r.kind === "domain")!.fingerprint).toBe(await fingerprint("domain", "sbi-update.co.in"));
  });

  it("the same verdict reported twice counts once; safe adds nothing", async () => {
    const f = await seedFamily();
    const v = await seedVerdict(f, [await seedEvent(f)]);
    await onChildFeedback(deps(), { verdictId: v, feedback: "fraud" });
    const again = await onChildFeedback(deps(), { verdictId: v, feedback: "fraud" });
    expect(again.indicators.every((i) => !i.counted)).toBe(true);
    const [sum] = await sql<{ n: number }[]>`select coalesce(sum(times_seen), 0)::int as n from public.scam_indicators`;
    expect(sum!.n).toBe(2); // domain + template, once each

    const g = await seedFamily();
    const vs = await seedVerdict(g, [await seedEvent(g, { domains: ["only-safe.example"] })], "kyc_block", "safe");
    expect((await onChildFeedback(deps(), { verdictId: vs, feedback: "safe" })).outcome).toBe("ignored_safe");
    expect((await onChildFeedback(deps(), { verdictId: vs, feedback: "fraud" })).outcome).toBe("feedback_mismatch");
    const [cnt] = await sql<{ c: number }[]>`select count(*)::int as c from public.scam_indicators`;
    expect(cnt!.c).toBe(2);
  });

  it(`8 families reporting the same indicator at once → exact counts (confirm at ${CONFIRM_MIN_FAMILIES})`, async () => {
    const fp = (await fingerprint("domain", "race.example"))!;
    const fams = await Promise.all(Array.from({ length: 8 }, () => seedFamily()));
    const verdicts = await Promise.all(fams.map((f) => seedVerdict(f, [])));
    const res = await Promise.all(
      fams.map((f, i) =>
        db.recordScamIndicator({
          kind: "domain",
          fingerprint: fp,
          scamType: "unknown",
          summaryHi: "hi line here",
          summaryEn: "en line here",
          familyId: f.familyId,
          verdictId: verdicts[i]!,
          seenAt: NOW,
          confirmMinFamilies: CONFIRM_MIN_FAMILIES,
        }),
      ),
    );
    expect(new Set(res.map((r) => r.id)).size).toBe(1);
    expect(res.map((r) => r.familiesAffected).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const [row] = await sql<{ times_seen: number; families_affected: number; confirmed: boolean }[]>`
      select times_seen, families_affected, confirmed from public.scam_indicators where fingerprint = ${fp}`;
    expect(row).toEqual({ times_seen: 8, families_affected: 8, confirmed: true });
  });

  it("the table rejects a fingerprint that is not hex SHA-256", async () => {
    await expect(
      sql`insert into public.scam_indicators (kind, fingerprint, scam_type, summary_hi, summary_en, first_seen_at, last_seen_at)
          values ('number', ${RAW_NUMBER}, 'unknown', 'x', 'y', now(), now())`,
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("pickWeeklyTip picks the most-seen confirmed indicator of the last 7 days", async () => {
    const mk = async (scamType: string, domain: string, families: number, perFamily = 1, at = NOW) => {
      for (let i = 0; i < families; i++) {
        const f = await seedFamily();
        for (let j = 0; j < perFamily; j++) {
          const v = await seedVerdict(f, [await seedEvent(f, { domains: [domain], text: null })], scamType);
          await onChildFeedback(deps(at), { verdictId: v, feedback: "fraud" });
        }
      }
    };
    expect(await pickWeeklyTip({ db }, { familyId: "x", now: NOW })).toEqual(DEFAULT_TIP);
    await mk("otp_theft", "otp-help.in", 2); // confirmed, 2 sightings
    await mk("digital_arrest", "cbi-notice.in", 3); // confirmed, 3 sightings → winner
    await mk("lottery_prize", "win-prize.xyz", 1, 6); // 6 sightings, 1 family → not confirmed
    await mk("parcel_customs", "old-parcel.in", 5, 1, new Date(NOW.getTime() - 9 * DAY)); // confirmed, but too old

    const tip = await pickWeeklyTip({ db }, { familyId: "x", now: NOW });
    expect(tip).toEqual({
      fraud_tip_hi: FALLBACK_SUMMARY.digital_arrest.summary_hi,
      fraud_tip_en: FALLBACK_SUMMARY.digital_arrest.summary_en,
    });
    expect(JSON.stringify(tip)).not.toMatch(/cbi-notice|\d{4,}/);
  });
});
