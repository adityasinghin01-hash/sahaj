import { createHash } from "node:crypto";
import { maskPrivate } from "../drills/privacy";
import type { EvidenceDeps, EvidencePack, EvidenceRequest } from "./types";
export * from "./types";
export { createEvidencePg } from "./pg";

/** Lossless encoding avoids accidentally displaying OTP-shaped digit runs in a digest. */
export function encodeChainHash(hex: string): string {
  if (!/^[a-f0-9]{64}$/i.test(hex)) throw new Error("Invalid timeline chain hash");
  return `hex-ap:${[...hex.toLowerCase()].map(n => String.fromCharCode(97 + parseInt(n, 16))).join("")}`;
}
export function decodeChainHash(encoded: string): string {
  if (!/^hex-ap:[a-p]{64}$/.test(encoded)) throw new Error("Invalid encoded chain hash");
  return [...encoded.slice(7)].map(c => (c.charCodeAt(0) - 97).toString(16)).join("");
}
export function evidenceDisplayTime(value: string | Date): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("Invalid evidence time");
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${days[date.getUTCDay()]}, ${pad(date.getUTCDate())}-${months[date.getUTCMonth()]}-${pad(date.getUTCFullYear() % 100)} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} GMT`;
}
const text = (value: unknown) => maskPrivate(String(value));
const order = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

export async function buildEvidencePack(deps: EvidenceDeps, input: EvidenceRequest): Promise<EvidencePack> {
  // Authorization precedes incident, signed timeline and any persistence work.
  if (!await deps.db.isChild(input)) throw new Error("Evidence child access required");
  const incident = await deps.db.getIncident(input);
  if (!incident || incident.familyId !== input.familyId || incident.verdictId !== input.verdictId) throw new Error("Evidence incident not found");
  if (incident.verdict.level !== "red") throw new Error("Evidence red incident required");
  const eventIds = [...new Set(incident.eventIds)].sort(order);
  if (!eventIds.length || eventIds.length !== incident.events.length || eventIds.some(id =>
    incident.events.filter(row => row.id === id && row.event.family_id === input.familyId && row.event.parent_id === incident.parentId).length !== 1)) {
    throw new Error("Evidence incident not found");
  }
  const entries = await deps.timeline.entriesFor(eventIds);
  const chainHash = await deps.timeline.chainHashFor(eventIds);
  const encodedHash = encodeChainHash(chainHash);
  const sortedEntries = entries.map(entry => ({ ...entry, time: evidenceDisplayTime(entry.at) }))
    .sort((a, b) => order(new Date(a.at).toISOString(), new Date(b.at).toISOString()) || order(JSON.stringify([a.step, a.status, a.action ?? "", a.details ?? "", a.money_sent ?? null]),
      JSON.stringify([b.step, b.status, b.action ?? "", b.details ?? "", b.money_sent ?? null])));
  const events = [...incident.events].sort((a, b) => Date.parse(a.event.occurred_at) - Date.parse(b.event.occurred_at) || order(a.id, b.id));
  // This existing server-authored rule is an explicit parent money-sent report;
  // merely offering the helpline is not proof that a transfer happened.
  const voiceMoneySent = incident.verdict.reasons.some(reason => reason.rule_id === "voice.money_sent");
  const moneyReports = [voiceMoneySent ? true : undefined, ...events.map(row => row.event.context.money_sent), ...entries.map(entry => entry.money_sent)];
  const money = moneyReports.includes(true) ? "yes" : moneyReports.includes(false) ? "no" : "unknown; ask Maa";
  const moneyHi = money === "yes" ? "haan" : money === "no" ? "nahi" : "pata nahi; Maa se poochhein";
  const reasonsEn = incident.verdict.reasons.map(reason => text(reason.en)).sort(order).join("; ") || "No reason recorded";
  const reasonsHi = incident.verdict.reasons.map(reason => text(reason.hi)).sort(order).join("; ") || "Kaaran darj nahi";
  const checks = incident.verdict.checks_fired.map(text).sort(order).join(", ") || "none";
  const planned = incident.verdict.actions.map(text).sort(order).join(", ") || "none";
  const eventLines = events.map(({ event }) => {
    const asks = event.context.asks_for ?? event.context.asked_for;
    return `${evidenceDisplayTime(event.occurred_at)} | ${text(event.kind.toUpperCase())} / ${text(event.channel)} | ${text(event.masked_text ?? "No text recorded")}` + (asks === undefined ? "" : ` | Asked: ${text(asks)}`);
  });
  const actionLines = sortedEntries.map(entry => `${entry.time} | ${text(entry.step)} | ${text(entry.status)}`
    + (entry.action ? ` | ${text(entry.action)}` : "") + (entry.details ? ` | ${text(entry.details)}` : ""));
  const number = "number: ask Maa / check her call log";
  const time = evidenceDisplayTime(incident.createdAt);
  // Dynamic fragments are sanitized before adding the fixed public helpline reference.
  const summary_en = ["Sahaj incident evidence (masked)", `Verdict: red / ${text(incident.verdict.scam_type)}; ${time}`,
    `Reasons: ${reasonsEn}`, `Checks: ${checks}`, `Planned actions: ${planned}`,
    "Events (masked):", ...eventLines, "Signed actions (status recorded):", ...(actionLines.length ? actionLines : ["No action entries recorded"]),
    `Money sent? ${money}`, number, "Original message and transaction details: ask Maa; sensitive digits are excluded."].join("\n");
  const summary_hi = ["Sahaj ghatna ka record (niji ank chhupaye gaye hain)", `Faisla: laal / ${text(incident.verdict.scam_type)}; ${time}`,
    `Kaaran: ${reasonsHi}`, `Jaanch: ${checks}`, `Tay kaaryavaahi: ${planned}`, "Ghatnaayein (masked):", ...eventLines,
    "Signed kaaryavaahi aur sthiti:", ...(actionLines.length ? actionLines : ["Kaaryavaahi ka record nahi mila"]), `Paise bheje? ${moneyHi}`,
    "Number: Maa se poochhein / unka call log dekhein.", "Asli message aur len-den ka vivaran Maa se poochhein; niji ank yahan nahi hain."].join("\n");
  const createdAt = deps.clock.now();
  const pack: EvidencePack = {
    summary_en, summary_hi,
    copy_for_1930: `For cybercrime helpline 1930\n${summary_en}\nSigned timeline checkpoint: ${encodedHash}\nReport: https://cybercrime.gov.in`,
    cybercrime_url: "https://cybercrime.gov.in", chain_hash: encodedHash, created_at: evidenceDisplayTime(createdAt),
  };
  // Creation is metadata, so repeated exports of identical content have the same hash.
  const { created_at: _createdAt, ...contents } = pack;
  const contentsHash = createHash("sha256").update(JSON.stringify(contents)).digest("hex");
  await deps.db.savePack({ ...input, contentsHash, chainHash: chainHash.toLowerCase(), createdAt });
  return pack;
}
