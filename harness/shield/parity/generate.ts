import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildVerdict, mask } from "../../../packages/shield/src/rules";

interface HarnessMessage {
  id: string;
  sender: string;
  body: string;
  label: "scam" | "normal";
  scam_type?: string;
}

const here = dirname(fileURLToPath(import.meta.url));
const messagesPath = resolve(here, "../messages.json");
const casesPath = join(here, "cases.json");

const messages = JSON.parse(readFileSync(messagesPath, "utf8")) as HarnessMessage[];

const cases = messages.map((m) => {
  const verdict = buildVerdict({ text: m.body, sender: m.sender });
  return {
    id: m.id,
    sender: m.sender,
    body: m.body,
    label: m.label,
    level: verdict.level,
    scam_type: verdict.scam_type,
    matched_rule_ids: verdict.checks_fired,
    masked_text: mask(m.body),
  };
});

writeFileSync(casesPath, JSON.stringify(cases, null, 2) + "\n", "utf8");
console.log(`Generated ${cases.length} parity cases -> ${casesPath}`);

