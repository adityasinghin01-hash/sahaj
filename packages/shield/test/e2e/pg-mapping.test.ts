import { describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { createShieldRuntimePg } from "../../src/runtime/pg";

describe("runtime Postgres row mapping (offline)", () => {
  it("reloads persisted JSON events with UTC offsets, null optionals and numeric confidence", async () => {
    // to_jsonb(e) has string timestamps (+00:00), unlike direct postgres.js Date columns.
    const id = crypto.randomUUID(), familyId = crypto.randomUUID(), parentId = crypto.randomUUID();
    const event = { idempotency_key: crypto.randomUUID(), family_id: familyId, parent_id: parentId,
      channel: "keypad_voice", kind: "voice_report", occurred_at: "2026-11-14T10:00:00+00:00",
      device_id: null, masked_text: null, sender_type: null, caller_type: null, local_level: null,
      context: {}, matched_rules: [], link_domains: [] };
    const row = { id, family_id: familyId, parent_id: parentId, person_id: parentId, event,
      level: "red", scam_type: "family_in_trouble", reasons: [{ rule_id: "voice.family_check.denied", hi: "Nahi the.", en: "Not them." }],
      confidence: "1.0", checks_fired: [], models_agreed: [], ai_used: false, actions: ["alert_child"] };
    // This test proves decoding only, not SQL execution. Real SQL is selected by DATABASE_URL.
    const query = (async () => [row]) as unknown as Sql;
    const record = await createShieldRuntimePg(query).brain.getVerdict(id);
    expect(record).toMatchObject({ id, event: { occurred_at: "2026-11-14T10:00:00.000Z" }, verdict: { confidence: 1 } });
    expect(record!.event.device_id).toBeUndefined();
    expect(record!.event.masked_text).toBeUndefined();
  });
});
