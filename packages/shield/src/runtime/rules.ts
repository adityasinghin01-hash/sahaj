import { Verdict, type ShieldEvent } from "@sahaj/shared";
import { buildVerdict, findPatterns, findLinks, RULES, type RuleEvent, type RuleCallEvent } from "../rules";
import type { RulesResult } from "../brain/types.js";

function callEvent(event: ShieldEvent): RuleCallEvent | null {
  if (!["call_in", "call_out", "call_state"].includes(event.kind)) return null;
  const ended = event.context.call_ended_at;
  const started = event.context.call_started_at;
  return { kind: "call", at: typeof started === "string" || typeof started === "number" ? started : event.occurred_at,
    caller_type: event.caller_type ?? "unknown",
    ...(typeof ended === "string" || typeof ended === "number" ? { ended_at: ended } : {}),
    direction: event.kind === "call_out" ? "out" : "in" };
}

export function evaluateRules(event: ShieldEvent, recent: ShieldEvent[]): RulesResult {
  // Only calls at/before this event can be evidence for this event's patterns.
  const history = recent.filter(item => item.idempotency_key !== event.idempotency_key &&
    Date.parse(item.occurred_at) <= Date.parse(event.occurred_at));
  const events: RuleEvent[] = history.flatMap<RuleEvent>(item => {
    const call = callEvent(item);
    if (call) return [call];
    return item.kind === "sms" && item.masked_text
      ? [{ kind: "sms" as const, at: item.occurred_at, text: item.masked_text, sender_type: item.sender_type }] : [];
  });
  const current = callEvent(event);
  if (current) events.push(current);
  const onUnknownCall = event.context.on_call_with_unsaved === true;
  const result = buildVerdict({ text: event.masked_text, sender_type: event.sender_type,
    caller_type: onUnknownCall ? "unknown" : current?.caller_type,
    at: event.occurred_at, events });
  if (event.kind === "sms" && event.masked_text) {
    events.push({ kind: "sms", at: event.occurred_at, text: event.masked_text, sender_type: event.sender_type });
  }
  // buildVerdict decides the current event; historical pattern hits are informational only.
  const patterns = findPatterns(events).filter(id => (id === "P1" || id === "P5") && result.checks_fired.includes(RULES.patterns[id].id));
  return { verdict: Verdict.parse({ ...result, checks_fired: [...new Set([...result.checks_fired, ...patterns])] }),
    needs_ai: result.needs_ai,
    links: findLinks(event.masked_text ?? "").map(link => ({
      url: /^https?:\/\//i.test(link.url) ? link.url : `https://${link.url}`, domain: link.host,
    })) };
}

export function scoreVoiceText(text: string) {
  // check_message encodes the sender as this fixed prefix; preserve that evidence.
  const kind = /^from:(unknown_number|bank_name|saved|not_sure)\b/.exec(text)?.[1];
  const sender = { unknown_number: "mobile_10", bank_name: "business_header", saved: "saved_contact", not_sure: "unknown" } as const;
  const result = buildVerdict({ text, sender_type: kind ? sender[kind as keyof typeof sender] : undefined });
  return { level: result.level, scam_type: result.scam_type, hits: result.checks_fired };
}
