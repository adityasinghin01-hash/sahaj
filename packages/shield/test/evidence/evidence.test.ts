import { describe, expect, it, vi } from "vitest";
import { buildEvidencePack, decodeChainHash, type EvidenceDeps, type EvidenceIncident } from "../../src/evidence";
import { ShieldEvent, Verdict } from "@sahaj/shared";

function fixture() {
  const incident: EvidenceIncident = {
    familyId: "family", parentId: "parent", verdictId: "verdict", createdAt: "2026-11-14T10:00:00Z", eventIds: ["event-b", "event-a"],
    verdict: Verdict.parse({ level: "red", scam_type: "otp_theft", reasons: [{ rule_id: "otp", en: "Asked for OTP 123456", hi: "Code १२३४५६ maanga" }], checks_fired: ["P1"], ai_used: false, confidence: 1, actions: ["offer_1930", "alert_child"] }),
    events: ["event-b", "event-a"].map((id, i) => ({ id, event: ShieldEvent.parse({ idempotency_key: `masked-${id}`, family_id: "family", parent_id: "parent", channel: "device", kind: "sms", occurred_at: `2026-11-14T10:0${i}:00Z`, masked_text: "OTP 123456 phone +91 98765 43210 https://fraud.in/private?otp=654321", context: { money_sent: true } }) })),
  };
  const deps: EvidenceDeps = {
    clock: { now: () => new Date("2026-11-14T10:05:00Z") },
    db: {
      isChild: vi.fn(async input => input.familyId === "family" && input.viewerUserId === "child"),
      getIncident: vi.fn(async () => incident),
      savePack: vi.fn(async () => {}),
    },
    timeline: {
      chainHashFor: vi.fn(async () => "0123456789abcdef".repeat(4)),
      entriesFor: vi.fn(async () => [
        { at: "2026-11-14T10:02:00Z", step: "alert_child", status: "ok" as const, details: "OTP 777777 number 9999999999" },
        { at: "2026-11-14T10:03:00Z", step: "pause_call", status: "denied" as const },
      ]),
    },
  };
  return { deps, incident };
}
const input = { familyId: "family", verdictId: "verdict", viewerUserId: "child" };

describe("golden-hour evidence pack", () => {
  it("collects masked events, verdict reasons/actions, performed action statuses, times, money and exact chain hash", async () => {
    const { deps } = fixture(); const pack = await buildEvidencePack(deps, input);
    expect(pack.cybercrime_url).toBe("https://cybercrime.gov.in");
    expect(pack.copy_for_1930).toContain("1930");
    expect(pack.copy_for_1930).toContain("number: ask Maa / check her call log");
    expect(pack.summary_en).toContain("Money sent? yes");
    expect(pack.summary_hi).toContain("Paise bheje? haan");
    expect(pack.summary_en).toMatch(/alert_child.*ok/);
    expect(pack.summary_en).toMatch(/pause_call.*denied/);
    expect(pack.summary_en).toContain("P1");
    expect(pack.summary_en).toContain("SMS");
    expect(decodeChainHash(pack.chain_hash)).toBe("0123456789abcdef".repeat(4));
    expect(deps.timeline.chainHashFor).toHaveBeenCalledWith(["event-a", "event-b"]);
    expect(deps.db.savePack).toHaveBeenCalledWith(expect.objectContaining({ familyId: "family", verdictId: "verdict", viewerUserId: "child", contentsHash: expect.stringMatching(/^[a-f0-9]{64}$/), chainHash: "0123456789abcdef".repeat(4) }));
    expect(new Date(pack.created_at).getTime()).toBe(deps.clock.now().getTime());
  });
  it("has no four-digit run anywhere in the returned pack except the public helpline 1930", async () => {
    const { deps } = fixture(); const serialized = JSON.stringify(await buildEvidencePack(deps, input));
    expect(serialized.match(/\p{Nd}{4,}/gu)?.every(run => run === "1930")).toBe(true);
    expect(serialized).not.toMatch(/123456|654321|777777|9999999999|98765|43210|१२३४५६/);
    expect(serialized).not.toContain("/private");
  });
  it.each(["parent", "neighbor", "stranger"])("denies %s before incident or timeline reads", async viewerUserId => {
    const { deps } = fixture();
    await expect(buildEvidencePack(deps, { ...input, viewerUserId })).rejects.toThrow("Evidence child access required");
    expect(deps.db.getIncident).not.toHaveBeenCalled(); expect(deps.timeline.entriesFor).not.toHaveBeenCalled();
    expect(deps.db.savePack).not.toHaveBeenCalled();
  });
  it("rejects wrong families, non-red incidents and mismatched event membership", async () => {
    const { deps, incident } = fixture();
    await expect(buildEvidencePack(deps, { ...input, familyId: "other" })).rejects.toThrow();
    incident.verdict.level = "yellow";
    await expect(buildEvidencePack(deps, input)).rejects.toThrow("Evidence red incident required");
    incident.verdict.level = "red"; incident.events[0]!.event.family_id = "other";
    await expect(buildEvidencePack(deps, input)).rejects.toThrow("Evidence incident not found");
  });
  it("keeps unknown money unknown and never infers it from an offer_1930 action", async () => {
    const { deps, incident } = fixture(); incident.events.forEach(row => { row.event.context = {}; });
    expect((await buildEvidencePack(deps, input)).copy_for_1930).toContain("Money sent? unknown; ask Maa");
    incident.events.forEach(row => { row.event.context = { money_sent: false }; });
    expect((await buildEvidencePack(deps, input)).summary_en).toContain("Money sent? no");
    vi.mocked(deps.timeline.entriesFor).mockResolvedValue([{ at: "2026-11-14T10:02:00Z", step: "money_sent", status: "ok", money_sent: true }]);
    expect((await buildEvidencePack(deps, input)).summary_en).toContain("Money sent? yes");
  });
  it("recognizes an explicit report from the existing money_sent voice tool", async () => {
    const { deps, incident } = fixture();
    incident.events.forEach(row => { row.event.context = {}; });
    incident.verdict.reasons[0]!.rule_id = "voice.money_sent";
    expect((await buildEvidencePack(deps, input)).summary_en).toContain("Money sent? yes");
  });
  it("hashes content deterministically across ordering and creation times, and changes hash when evidence changes", async () => {
    const { deps, incident } = fixture();
    await buildEvidencePack(deps, input);
    const first = vi.mocked(deps.db.savePack).mock.calls[0]![0].contentsHash;
    incident.events.reverse(); incident.eventIds.reverse();
    vi.mocked(deps.timeline.entriesFor).mockResolvedValue((await deps.timeline.entriesFor([])).reverse());
    deps.clock.now = () => new Date("2026-11-14T12:00:00Z");
    await buildEvidencePack(deps, input);
    expect(vi.mocked(deps.db.savePack).mock.calls[1]![0].contentsHash).toBe(first);
    incident.events[0]!.event.masked_text = "Different masked evidence";
    await buildEvidencePack(deps, input);
    expect(vi.mocked(deps.db.savePack).mock.calls[2]![0].contentsHash).not.toBe(first);
  });
  it("hashes simultaneous timeline entries identically regardless of object property insertion order", async () => {
    const { deps } = fixture();
    vi.mocked(deps.timeline.entriesFor).mockResolvedValue([
      { at: "2026-11-14T10:02:00Z", step: "bridge_child", status: "ok" },
      { at: "2026-11-14T10:02:00Z", step: "alert_child", status: "ok" },
    ]);
    await buildEvidencePack(deps, input);
    const hash = vi.mocked(deps.db.savePack).mock.calls[0]![0].contentsHash;
    vi.mocked(deps.timeline.entriesFor).mockResolvedValue([
      { status: "ok", step: "bridge_child", at: "2026-11-14T10:02:00Z" },
      { at: "2026-11-14T10:02:00Z", step: "alert_child", status: "ok" },
    ]);
    await buildEvidencePack(deps, input);
    expect(vi.mocked(deps.db.savePack).mock.calls[1]![0].contentsHash).toBe(hash);
  });
  it("does not return an unsigned/unpersisted pack if timeline or receipt writes fail", async () => {
    const { deps } = fixture();
    vi.mocked(deps.db.savePack).mockRejectedValue(new Error("write failed"));
    await expect(buildEvidencePack(deps, input)).rejects.toThrow("write failed");
    vi.mocked(deps.timeline.entriesFor).mockRejectedValue(new Error("timeline unavailable"));
    await expect(buildEvidencePack(deps, input)).rejects.toThrow("timeline unavailable");
  });
  it("fails closed on unavailable/malformed chain hash, missing source events or failed persistence", async () => {
    const { deps, incident } = fixture();
    vi.mocked(deps.timeline.chainHashFor).mockResolvedValue("not-a-hash");
    await expect(buildEvidencePack(deps, input)).rejects.toThrow("Invalid timeline chain hash");
    expect(deps.db.savePack).not.toHaveBeenCalled();
    vi.mocked(deps.timeline.chainHashFor).mockResolvedValue("a".repeat(64));
    incident.events.pop();
    await expect(buildEvidencePack(deps, input)).rejects.toThrow("Evidence incident not found");
  });
});
