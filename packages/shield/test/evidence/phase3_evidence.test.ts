import { describe, expect, it, vi } from "vitest";
import { ShieldEvent, Verdict } from "@sahaj/shared";
import {
  buildEvidencePack, decodePackRef, encodePackRef, evidenceContentsHash, verifyEvidencePack,
  type EvidenceDeps, type EvidenceIncident, type EvidenceReceipt,
} from "../../src/evidence";

const PACK_ID = "0a1b2c3d-1111-4222-8333-444455556666";
function fixture() {
  const incident: EvidenceIncident = {
    familyId: "family", parentId: "parent", verdictId: "verdict", createdAt: "2026-11-14T10:00:00Z", eventIds: ["event-a"],
    verdict: Verdict.parse({ level: "red", scam_type: "kyc_block", reasons: [{ rule_id: "otp", en: "Asked for OTP", hi: "OTP maanga" }],
      checks_fired: ["P1"], ai_used: false, confidence: 1, actions: ["alert_child", "speak_clip"] }),
    events: [{ id: "event-a", event: ShieldEvent.parse({ idempotency_key: "k-b8-evidence-a", family_id: "family", parent_id: "parent", channel: "gateway_sms",
      kind: "sms", occurred_at: "2026-11-14T09:58:00Z", masked_text: "KYC band hoga, OTP <NUM> bataiye <URL:kyc-fix.in>",
      context: { asks_for: "otp", money_sent: false } }) }],
  };
  const receipts: EvidenceReceipt[] = [];
  let chain = "0123456789abcdef".repeat(4);
  const deps: EvidenceDeps = {
    clock: { now: () => new Date("2026-11-14T10:05:00Z") },
    db: {
      isChild: vi.fn(async input => input.familyId === "family" && input.viewerUserId === "child"),
      getIncident: vi.fn(async () => structuredClone(incident)),
      savePack: vi.fn(async input => {
        receipts.push({ id: PACK_ID, familyId: input.familyId, verdictId: input.verdictId, createdFor: input.viewerUserId,
          contentsHash: input.contentsHash, chainHash: input.chainHash, createdAt: input.createdAt.toISOString() });
        return { id: PACK_ID };
      }),
      getPack: vi.fn(async ({ familyId, packId }) => receipts.find(r => r.id === packId && r.familyId === familyId) ?? null),
    },
    timeline: {
      chainHashFor: vi.fn(async () => chain),
      entriesFor: vi.fn(async () => [{ at: "2026-11-14T10:00:30Z", step: "call_parent", status: "ok" as const, action: "speak_clip" }]),
    },
  };
  return { deps, incident, receipts, setChain: (hex: string) => { chain = hex; } };
}
const input = { familyId: "family", verdictId: "verdict", viewerUserId: "child" };

describe("evidence pack remainder (Step 3.1)", () => {
  it("returns structured events, verdict, times, actions, what was asked, money sent and the 1930 / cybercrime fields", async () => {
    const { deps } = fixture();
    const pack = await buildEvidencePack(deps, input);
    expect(pack.verdict).toMatchObject({ level: "red", scam_type: "kyc_block", checks: ["P1"], planned_actions: ["alert_child", "speak_clip"] });
    expect(pack.events).toEqual([{ time: "Saturday, 14-Nov-26 09:58:00 GMT", kind: "SMS", channel: "gateway_sms",
      text: "KYC band hoga, OTP <NUM> bataiye <URL:kyc-fix.in>", asked: "otp" }]);
    expect(pack.actions).toEqual([{ time: "Saturday, 14-Nov-26 10:00:30 GMT", step: "call_parent", status: "ok", action: "speak_clip" }]);
    expect(pack.asked_for).toEqual(["otp"]);
    expect(pack.money_sent).toBe("no");
    expect(pack.summary_en).toContain("What was asked: otp");
    expect(pack.copy_for_1930).toMatch(/^For cybercrime helpline 1930/);
    expect(pack.cybercrime_url).toBe("https://cybercrime.gov.in");
    expect(pack.pack_ref).toBe(encodePackRef(PACK_ID));
    expect(pack.child_only).toBeNull();
    expect(pack.copy_for_1930_full).toBeNull();
    const serialized = JSON.stringify(pack);
    expect(serialized.match(/\p{Nd}{4,}/gu)?.every(run => run === "1930")).toBe(true);
  });

  it("full numbers + original message are added only for the child role, and never enter the stored hash", async () => {
    const plain = fixture();
    const plainPack = await buildEvidencePack(plain.deps, input);
    const { deps } = fixture();
    const forIncident = vi.fn(async () => ({ numbers: ["+919000000007"], messages: ["KYC band hoga, OTP 482913 bataiye https://kyc-fix.in/a"] }));
    deps.sensitive = { forIncident };
    await expect(buildEvidencePack(deps, { ...input, viewerUserId: "neighbor" })).rejects.toThrow("Evidence child access required");
    expect(forIncident).not.toHaveBeenCalled();
    const pack = await buildEvidencePack(deps, input);
    expect(forIncident).toHaveBeenCalledWith({ familyId: "family", parentId: "parent", verdictId: "verdict", eventIds: ["event-a"] });
    expect(pack.child_only).toEqual({ numbers: ["+919000000007"], messages: ["KYC band hoga, OTP 482913 bataiye https://kyc-fix.in/a"] });
    expect(pack.copy_for_1930_full).toContain("Suspect number(s): +919000000007");
    expect(pack.copy_for_1930).not.toContain("9000000007");
    const stored = vi.mocked(deps.db.savePack).mock.calls[0]![0];
    const plainStored = vi.mocked(plain.deps.db.savePack).mock.calls[0]![0];
    expect(stored.contentsHash).toBe(plainStored.contentsHash);
    const { created_at: _c, pack_ref: _r, child_only: _o, copy_for_1930_full: _f, ...contents } = plainPack;
    expect(evidenceContentsHash(contents)).toBe(plainStored.contentsHash);
  });

  it("verifyEvidencePack recomputes the contents hash and the chain checkpoint", async () => {
    const f = fixture();
    const pack = await buildEvidencePack(f.deps, input);
    expect(await verifyEvidencePack(f.deps, { familyId: "family", packId: pack.pack_ref! }))
      .toEqual({ ok: true, contents_match: true, chain_match: true, pack_id: PACK_ID, verdict_id: "verdict" });
    expect(await verifyEvidencePack(f.deps, { familyId: "family", packId: PACK_ID })).toMatchObject({ ok: true });
    // A changed signed timeline breaks both the contents (the checkpoint is printed in it) and the chain.
    f.setChain("f".repeat(64));
    expect(await verifyEvidencePack(f.deps, { familyId: "family", packId: PACK_ID })).toMatchObject({ ok: false, chain_match: false, contents_match: false });
    f.setChain("0123456789abcdef".repeat(4));
    // Changed incident content (a new reason) breaks only the contents hash.
    f.incident.verdict.reasons.push({ rule_id: "new", en: "Edited later", hi: "Baad mein badla" });
    expect(await verifyEvidencePack(f.deps, { familyId: "family", packId: PACK_ID })).toMatchObject({ ok: false, contents_match: false, chain_match: true });
  });

  it("verify refuses an unknown pack, another family's pack and a malformed id", async () => {
    const f = fixture();
    await buildEvidencePack(f.deps, input);
    await expect(verifyEvidencePack(f.deps, { familyId: "other", packId: PACK_ID })).rejects.toThrow("Evidence pack not found");
    await expect(verifyEvidencePack(f.deps, { familyId: "family", packId: "not-an-id" })).rejects.toThrow("Invalid evidence pack id");
    delete f.deps.db.getPack;
    await expect(verifyEvidencePack(f.deps, { familyId: "family", packId: PACK_ID })).rejects.toThrow("Evidence receipts not readable");
  });

  it("pack refs round-trip and hold no digit", () => {
    const ref = encodePackRef(PACK_ID);
    expect(ref).toMatch(/^ref-ap:[a-p]{32}$/);
    expect(decodePackRef(ref)).toBe(PACK_ID);
  });
});
