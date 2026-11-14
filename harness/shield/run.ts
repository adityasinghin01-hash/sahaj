import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildVerdict,
  findPatterns,
  type RuleCallEvent,
  type RuleEvent,
  type RuleSmsEvent,
} from "../../packages/shield/src/rules";

interface HarnessMessage {
  id: string;
  sender: string;
  body: string;
  label: "scam" | "normal";
  scam_type?: string;
}

interface RawSeqEvent {
  kind: string;
  at: number;
  ended_at?: number;
  number?: string;
  saved_contact?: boolean;
  direction?: "in" | "out";
  sender?: string;
  text?: string;
  package?: string;
  video?: boolean;
}

interface HarnessSequence {
  id: string;
  name: string;
  events: RawSeqEvent[];
  expect: {
    level: "green" | "yellow" | "red";
    pattern: string | null;
  };
}

const dir = dirname(fileURLToPath(import.meta.url));
const messages = JSON.parse(readFileSync(join(dir, "messages.json"), "utf8")) as HarnessMessage[];
const sequences = JSON.parse(readFileSync(join(dir, "sequences.json"), "utf8")) as HarnessSequence[];

const messageResults = messages.map((m) => {
  const verdict = buildVerdict({ text: m.body, sender: m.sender });
  const flagged = verdict.level !== "green";
  const ok = m.label === "scam" ? flagged : !flagged;
  return {
    id: m.id,
    label: m.label,
    expected_scam_type: m.scam_type ?? null,
    actual_level: verdict.level,
    actual_scam_type: verdict.scam_type,
    score: verdict.score,
    needs_ai: verdict.needs_ai,
    checks_fired: verdict.checks_fired,
    ok,
  };
});

const scamTotal = messageResults.filter((r) => r.label === "scam").length;
const scamCaught = messageResults.filter((r) => r.label === "scam" && r.ok).length;
const scamCaughtRed = messageResults.filter((r) => r.label === "scam" && r.actual_level === "red").length;
const scamCaughtYellow = messageResults.filter((r) => r.label === "scam" && r.actual_level === "yellow").length;
const scamMissed = messageResults.filter((r) => r.label === "scam" && !r.ok);

const normalTotal = messageResults.filter((r) => r.label === "normal").length;
const falseAlarms = messageResults.filter((r) => r.label === "normal" && !r.ok);

function toRuleEvents(raw: RawSeqEvent[]): RuleEvent[] {
  const out: RuleEvent[] = [];
  for (const e of raw) {
    if (e.kind === "call") {
      const callEvt: RuleCallEvent = {
        kind: "call",
        at: e.at,
        ended_at: e.ended_at,
        number: e.number,
        saved_contact: e.saved_contact,
        direction: e.direction,
      };
      out.push(callEvt);
    } else if (e.kind === "sms" && typeof e.text === "string") {
      const smsEvt: RuleSmsEvent = {
        kind: "sms",
        at: e.at,
        sender: e.sender,
        text: e.text,
      };
      out.push(smsEvt);
    }
  }
  return out;
}

const sequenceResults = sequences.map((seq) => {
  const ruleEvents = toRuleEvents(seq.events);
  const patterns = findPatterns(ruleEvents);

  // Evaluate the final SMS (or final call if no SMS exists) with prior events as context.
  const lastSmsIdx = [...ruleEvents].map((e, i) => (e.kind === "sms" ? i : -1)).filter((i) => i >= 0).pop();
  let verdict;
  if (lastSmsIdx !== undefined) {
    const sms = ruleEvents[lastSmsIdx] as RuleSmsEvent;
    const prior = ruleEvents.slice(0, lastSmsIdx);
    verdict = buildVerdict({
      text: sms.text,
      sender: sms.sender,
      sender_saved: sms.sender_saved,
      at: sms.at,
      events: prior,
    });
  } else {
    const lastCall = [...ruleEvents].reverse().find((e): e is RuleCallEvent => e.kind === "call");
    verdict = buildVerdict({
      caller: lastCall?.number,
      caller_saved: lastCall?.saved_contact,
      at: lastCall?.at,
      events: ruleEvents,
    });
  }

  const levelOk = verdict.level === seq.expect.level;
  const patternOk = seq.expect.pattern === null
    ? patterns.length === 0
    : patterns.includes(seq.expect.pattern as "P1" | "P5");
  const ok = levelOk && patternOk;

  return {
    id: seq.id,
    name: seq.name,
    expect: seq.expect,
    actual_level: verdict.level,
    actual_patterns: patterns,
    checks_fired: verdict.checks_fired,
    ok,
  };
});

const sequencesRight = sequenceResults.filter((r) => r.ok).length;

const results = {
  summary: {
    scam_caught: scamCaught,
    scam_total: scamTotal,
    scam_caught_red: scamCaughtRed,
    scam_caught_yellow: scamCaughtYellow,
    false_alarms: falseAlarms.length,
    normal_total: normalTotal,
    sequences_right: sequencesRight,
    sequences_total: sequenceResults.length,
  },
  missed_scams: scamMissed,
  false_alarm_details: falseAlarms,
  missed_sequences: sequenceResults.filter((r) => !r.ok),
  messages: messageResults,
  sequences: sequenceResults,
};

writeFileSync(join(dir, "results.json"), JSON.stringify(results, null, 2) + "\n", "utf8");
console.log(
  `Scam caught: ${scamCaught}/${scamTotal} · False alarms: ${falseAlarms.length}/${normalTotal} · Sequences right: ${sequencesRight}/${sequenceResults.length}`,
);

