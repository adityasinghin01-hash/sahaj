import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildVerdict,
  findPatterns,
  mask,
  type CallerType,
  type RuleAppOpenEvent,
  type RuleCallEvent,
  type RuleEvent,
  type RuleInstallEvent,
  type RuleNotificationEvent,
  type RuleSmsEvent,
  type SenderType,
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
  caller_type?: CallerType;
  saved_contact?: boolean;
  direction?: "in" | "out";
  sender?: string;
  sender_type?: SenderType;
  sender_saved?: boolean;
  text?: string;
  package?: string;
  video?: boolean;
  source?: string;
  whatsapp_call_unsaved?: boolean;
  call_seconds?: number;
  duration_ms?: number;
  attachment_apk?: boolean;
  cancelled?: boolean;
  on_call_with_unsaved?: boolean;
  installer?: string;
  installed_hours_ago?: number;
  is_system?: boolean;
  local_level?: "green" | "yellow" | "red";
  matched_rules?: string[];
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

function hasUnmaskedDigitRun(masked: string): boolean {
  const withoutAllowedTokens = masked.replace(/<1600_NUMBER>/g, "");
  return /\d{4,}/.test(withoutAllowedTokens);
}

const messageResults = messages.map((m) => {
  const verdict = buildVerdict({ text: m.body, sender: m.sender });
  const maskedText = mask(m.body);
  const maskingOk = !hasUnmaskedDigitRun(maskedText);
  const flagged = verdict.level !== "green";
  const labelOk = m.label === "scam" ? flagged : !flagged;
  const ok = labelOk && maskingOk;
  return {
    id: m.id,
    label: m.label,
    expected_scam_type: m.scam_type ?? null,
    actual_level: verdict.level,
    actual_scam_type: verdict.scam_type,
    score: verdict.score,
    needs_ai: verdict.needs_ai,
    checks_fired: verdict.checks_fired,
    masking_ok: maskingOk,
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
const maskingViolations = messageResults.filter((r) => !r.masking_ok);

function toRuleEvents(raw: RawSeqEvent[]): RuleEvent[] {
  const out: RuleEvent[] = [];
  for (const e of raw) {
    if (e.kind === "call") {
      const callEvt: RuleCallEvent = {
        kind: "call",
        at: e.at,
        ended_at: e.ended_at,
        number: e.number,
        caller_type: e.caller_type,
        saved_contact: e.saved_contact,
        direction: e.direction,
        video: e.video,
        source: e.source,
        whatsapp_call_unsaved: e.whatsapp_call_unsaved,
        duration_ms: e.duration_ms,
        cancelled: e.cancelled,
      };
      out.push(callEvt);
    } else if (e.kind === "sms" && typeof e.text === "string") {
      const smsEvt: RuleSmsEvent = {
        kind: "sms",
        at: e.at,
        sender: e.sender,
        sender_type: e.sender_type,
        sender_saved: e.sender_saved,
        text: e.text,
      };
      out.push(smsEvt);
    } else if (e.kind === "app_open") {
      const appEvt: RuleAppOpenEvent = {
        kind: "app_open",
        at: e.at,
        package: e.package,
        on_call_with_unsaved: e.on_call_with_unsaved,
        saved_contact: e.saved_contact,
        caller_type: e.caller_type,
      };
      out.push(appEvt);
    } else if (e.kind === "notification") {
      const notifEvt: RuleNotificationEvent = {
        kind: "notification",
        at: e.at,
        source: e.source,
        whatsapp_call_unsaved: e.whatsapp_call_unsaved,
        call_seconds: e.call_seconds,
        attachment_apk: e.attachment_apk,
        cancelled: e.cancelled,
        ended_at: e.ended_at,
        saved_contact: e.saved_contact,
        caller_type: e.caller_type,
        text: e.text,
      };
      out.push(notifEvt);
    } else if (e.kind === "install") {
      const instEvt: RuleInstallEvent = {
        kind: "install",
        at: e.at,
        package: e.package,
        installer: e.installer,
        installed_hours_ago: e.installed_hours_ago,
        is_system: e.is_system,
      };
      out.push(instEvt);
    }
  }
  return out;
}

const sequenceResults = sequences.map((seq) => {
  const ruleEvents = toRuleEvents(seq.events);
  const lastRaw = seq.events[seq.events.length - 1];
  const evalAt = lastRaw?.at;
  const patterns = findPatterns(ruleEvents, evalAt);

  // Evaluate the final SMS (or final event context if no SMS exists).
  const lastSmsIdx = [...ruleEvents].map((e, i) => (e.kind === "sms" ? i : -1)).filter((i) => i >= 0).pop();
  let verdict;
  if (lastSmsIdx !== undefined) {
    const sms = ruleEvents[lastSmsIdx] as RuleSmsEvent;
    const prior = ruleEvents.slice(0, lastSmsIdx);
    verdict = buildVerdict({
      text: sms.text,
      sender: sms.sender,
      sender_type: sms.sender_type,
      sender_saved: sms.sender_saved,
      at: sms.at,
      events: prior,
      local_level: lastRaw?.local_level,
      matched_rules: lastRaw?.matched_rules,
    });
  } else {
    const lastCall = [...ruleEvents].reverse().find((e): e is RuleCallEvent => e.kind === "call");
    verdict = buildVerdict({
      caller: lastCall?.number,
      caller_type: lastCall?.caller_type,
      caller_saved: lastCall?.saved_contact,
      at: evalAt,
      events: ruleEvents,
      local_level: lastRaw?.local_level,
      matched_rules: lastRaw?.matched_rules,
    });
  }

  const levelOk = verdict.level === seq.expect.level;
  const patternOk = seq.expect.pattern === null
    ? patterns.length === 0
    : patterns.includes(seq.expect.pattern as (typeof patterns)[number]);
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
  mode: "rules_only",
  ai_eval: { executed: false, reason: "Offline rules-only harness (no live or paid AI calls)" },
  summary: {
    scam_caught: scamCaught,
    scam_total: scamTotal,
    scam_caught_red: scamCaughtRed,
    scam_caught_yellow: scamCaughtYellow,
    false_alarms: falseAlarms.length,
    normal_total: normalTotal,
    masking_violations: maskingViolations.length,
    sequences_right: sequencesRight,
    sequences_total: sequenceResults.length,
  },
  missed_scams: scamMissed,
  false_alarm_details: falseAlarms,
  masking_violation_details: maskingViolations,
  missed_sequences: sequenceResults.filter((r) => !r.ok),
  messages: messageResults,
  sequences: sequenceResults,
};

writeFileSync(join(dir, "results.json"), JSON.stringify(results, null, 2) + "\n", "utf8");
console.log(
  `[rules-only] Scam caught: ${scamCaught}/${scamTotal} · False alarms: ${falseAlarms.length}/${normalTotal} · Masking leaks: ${maskingViolations.length}/${messages.length} · Sequences right: ${sequencesRight}/${sequenceResults.length}`,
);
for (const s of sequenceResults) {
  console.log(
    `  ${s.ok ? "PASS" : "FAIL"} ${s.id}: ${s.name} -> level=${s.actual_level} (expect=${s.expect.level}), patterns=[${s.actual_patterns.join(",")}] (expect=${s.expect.pattern ?? "none"})`,
  );
}

if (
  scamCaught < scamTotal ||
  falseAlarms.length > 0 ||
  maskingViolations.length > 0 ||
  sequencesRight < sequenceResults.length
) {
  process.exitCode = 1;
}

