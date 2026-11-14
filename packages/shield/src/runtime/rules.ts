import { Verdict, type ShieldEvent } from "@sahaj/shared";
import { buildVerdict, findPatterns, findLinks, RULES, type RuleEvent, type RuleCallEvent } from "../rules";
import type { RulesResult } from "../brain/types.js";

const CALL_KINDS = new Set<ShieldEvent["kind"]>(["call_in", "call_out", "call_state"]);
const HOUR_MS = 3_600_000;

function time(value: unknown): string | number | undefined {
  return typeof value === "string" || typeof value === "number" ? value : undefined;
}

function callEvent(event: ShieldEvent): RuleCallEvent | null {
  if (!CALL_KINDS.has(event.kind)) return null;
  const ended = time(event.context.call_ended_at);
  return { kind: "call", at: time(event.context.call_started_at) ?? event.occurred_at,
    caller_type: event.caller_type ?? "unknown",
    ...(ended !== undefined ? { ended_at: ended } : {}),
    direction: event.kind === "call_out" ? "out" : "in" };
}

/** Calls still running at `at` (no end, or ended after it). */
function ongoingAt(calls: RuleCallEvent[], at: string): RuleCallEvent[] {
  const atMs = Date.parse(at);
  return calls.filter(call => call.ended_at === undefined ||
    (typeof call.ended_at === "number" ? call.ended_at : Date.parse(call.ended_at)) >= atMs);
}

/**
 * Phase 2/3 signals arrive in `context`. The phone may send either `installed_hours_ago`
 * or `first_install_ms`; the rules want hours.
 */
function currentContext(event: ShieldEvent): Record<string, unknown> {
  const ctx: Record<string, unknown> = { ...event.context };
  if (event.kind === "install" && typeof ctx.installed_hours_ago !== "number" && typeof ctx.first_install_ms === "number") {
    const hours = (Date.parse(event.occurred_at) - ctx.first_install_ms) / HOUR_MS;
    if (Number.isFinite(hours) && hours >= 0) ctx.installed_hours_ago = hours;
  }
  return ctx;
}

export function evaluateRules(event: ShieldEvent, recent: ShieldEvent[]): RulesResult {
  // Only calls and SMS at/before this event are evidence. Earlier app_open / notification /
  // install events already got their own verdicts, so they must not re-fire on this one.
  const history = recent.filter(item => item.idempotency_key !== event.idempotency_key &&
    Date.parse(item.occurred_at) <= Date.parse(event.occurred_at));
  const historyCalls = history.flatMap(item => callEvent(item) ?? []);
  const historySms: RuleEvent[] = history.flatMap<RuleEvent>(item =>
    item.kind === "sms" && item.masked_text
      ? [{ kind: "sms" as const, at: item.occurred_at, text: item.masked_text, sender_type: item.sender_type }] : []);

  const current = callEvent(event);
  const context = currentContext(event);
  const onUnknownCall = event.context.on_call_with_unsaved === true;
  // For a banking-app open, only calls running at that moment count; with none on record,
  // the phone's own on-call flag decides (the phone does not report clean calls).
  const calls = event.kind === "app_open" ? ongoingAt(historyCalls, event.occurred_at) : historyCalls;
  const events: RuleEvent[] = [...calls, ...historySms];
  // A call event with duration/video/end data is built by buildVerdict from `kind` + `context`;
  // adding it here too would judge the same call twice.
  const callJudgedDirectly = current !== null && ["duration_ms", "video", "call_ended_at", "cancelled"]
    .some(key => event.context[key] !== undefined);
  if (current && !callJudgedDirectly) events.push(current);

  const ended = time(event.context.call_ended_at);
  const result = buildVerdict({
    kind: event.kind,
    text: event.masked_text,
    sender_type: event.sender_type,
    caller_type: onUnknownCall ? "unknown" : (event.caller_type ?? current?.caller_type),
    at: event.occurred_at,
    events,
    context,
    ...(current && ended !== undefined ? { ended_at: ended } : {}),
  });
  if (event.kind === "sms" && event.masked_text) {
    events.push({ kind: "sms", at: event.occurred_at, text: event.masked_text, sender_type: event.sender_type });
  }
  // buildVerdict decides the current event; a pattern counts only if it fired for this event.
  const patterns = findPatterns(events, event.occurred_at)
    .filter(id => result.checks_fired.includes(RULES.patterns[id].id));
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
