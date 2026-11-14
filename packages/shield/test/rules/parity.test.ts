import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { AlertLevel, ScamType } from "@sahaj/shared";
import { buildVerdict, mask } from "../../src/rules";

interface ParityCase {
  id: string;
  sender: string;
  body: string;
  label: "scam" | "normal";
  level: AlertLevel;
  scam_type: ScamType;
  matched_rule_ids: string[];
  masked_text: string;
}

interface HarnessMessage {
  id: string;
  sender: string;
  body: string;
  label: "scam" | "normal";
}

const ROOT = resolve(import.meta.dirname, "../../../..");
const cases = JSON.parse(readFileSync(resolve(ROOT, "harness/shield/parity/cases.json"), "utf8")) as ParityCase[];
const messages = JSON.parse(readFileSync(resolve(ROOT, "harness/shield/messages.json"), "utf8")) as HarnessMessage[];

describe("shield rules parity snapshot (TS engine vs harness/shield/parity/cases.json)", () => {
  it("contains all 60 messages from harness/shield/messages.json in order", () => {
    expect(cases).toHaveLength(60);
    expect(messages).toHaveLength(60);
    expect(cases.map((c) => c.id)).toEqual(messages.map((m) => m.id));
  });

  it("never leaves unmasked 4+ digit runs in masked_text", () => {
    for (const c of cases) {
      expect(c.masked_text.replace(/<1600_NUMBER>/g, ""), c.id).not.toMatch(/[0-9]{4,}/);
    }
  });

  for (const c of cases) {
    it(`${c.id} matches level, scam_type, matched_rule_ids, and masked_text`, () => {
      const verdict = buildVerdict({ text: c.body, sender: c.sender });
      expect(verdict.level).toBe(c.level);
      expect(verdict.scam_type).toBe(c.scam_type);
      expect(verdict.checks_fired).toEqual(c.matched_rule_ids);
      expect(mask(c.body)).toBe(c.masked_text);
    });
  }
});

