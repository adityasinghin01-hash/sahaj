import { createHash } from "node:crypto";
import { maskPrivate } from "../drills/privacy";
import type { EvidenceDeps, EvidenceIncident, EvidencePack, EvidenceRequest, EvidenceVerification } from "./types";
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

/** Receipt ids are UUIDs (hex digits); the pack shows them letters-only, like the chain hash. */
export function encodePackRef(id: string): string {
  const hex = id.replace(/-/g, "").toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(hex)) throw new Error("Invalid evidence pack id");
  return `ref-ap:${[...hex].map(n => String.fromCharCode(97 + parseInt(n, 16))).join("")}`;
}
export function decodePackRef(ref: string): string {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref)) return ref.toLowerCase();
  if (!/^ref-ap:[a-p]{32}$/.test(ref)) throw new Error("Invalid evidence pack id");
  const hex = [...ref.slice(7)].map(c => (c.charCodeAt(0) - 97).toString(16)).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Pack fields covered by the contents hash (everything except export metadata and child-only originals). */
type EvidenceContents = Omit<EvidencePack, "created_at" | "pack_ref" | "child_only" | "copy_for_1930_full">;
export function evidenceContentsHash(contents: EvidenceContents): string {
  return createHash("sha256").update(JSON.stringify(contents)).digest("hex");
}

async function loadIncident(deps: EvidenceDeps, familyId: string, verdictId: string) {
  const incident = await deps.db.getIncident({ familyId, verdictId });
  if (!incident || incident.familyId !== familyId || incident.verdictId !== verdictId) throw new Error("Evidence incident not found");
  if (incident.verdict.level !== "red") throw new Error("Evidence red incident required");
  const eventIds = [...new Set(incident.eventIds)].sort(order);
  if (!eventIds.length || eventIds.length !== incident.events.length || eventIds.some(id =>
    incident.events.filter(row => row.id === id && row.event.family_id === familyId && row.event.parent_id === incident.parentId).length !== 1)) {
    throw new Error("Evidence incident not found");
  }
  return { incident, eventIds };
}

async function composeContents(deps: EvidenceDeps, incident: EvidenceIncident, eventIds: string[]) {
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
  const reasonsEnList = incident.verdict.reasons.map(reason => text(reason.en)).sort(order);
  const reasonsEn = reasonsEnList.join("; ") || "No reason recorded";
  const reasonsHi = incident.verdict.reasons.map(reason => text(reason.hi)).sort(order).join("; ") || "Kaaran darj nahi";
  const checksList = incident.verdict.checks_fired.map(text).sort(order);
  const checks = checksList.join(", ") || "none";
  const plannedList = incident.verdict.actions.map(text).sort(order);
  const planned = plannedList.join(", ") || "none";
  const structuredEvents = events.map(({ event }) => {
    const asks = event.context.asks_for ?? event.context.asked_for;
    return { time: evidenceDisplayTime(event.occurred_at), kind: text(event.kind.toUpperCase()), channel: text(event.channel),
      text: text(event.masked_text ?? "No text recorded"), asked: asks === undefined ? null : text(asks) };
  });
  const eventLines = structuredEvents.map(event => `${event.time} | ${event.kind} / ${event.channel} | ${event.text}`
    + (event.asked === null ? "" : ` | Asked: ${event.asked}`));
  const actionLines = sortedEntries.map(entry => `${entry.time} | ${text(entry.step)} | ${text(entry.status)}`
    + (entry.action ? ` | ${text(entry.action)}` : "") + (entry.details ? ` | ${text(entry.details)}` : ""));
  const askedFor = [...new Set(structuredEvents.flatMap(event => event.asked === null ? [] : [event.asked]))].sort(order);
  const number = "number: ask Maa / check her call log";
  const time = evidenceDisplayTime(incident.createdAt);
  // Dynamic fragments are sanitized before adding the fixed public helpline reference.
  const summary_en = ["Sahaj incident evidence (masked)", `Verdict: red / ${text(incident.verdict.scam_type)}; ${time}`,
    `Reasons: ${reasonsEn}`, `Checks: ${checks}`, `Planned actions: ${planned}`,
    "Events (masked):", ...eventLines, "Signed actions (status recorded):", ...(actionLines.length ? actionLines : ["No action entries recorded"]),
    `What was asked: ${askedFor.join("; ") || "not recorded; ask Maa"}`,
    `Money sent? ${money}`, number, "Original message and transaction details: ask Maa; sensitive digits are excluded."].join("\n");
  const summary_hi = ["Sahaj ghatna ka record (niji ank chhupaye gaye hain)", `Faisla: laal / ${text(incident.verdict.scam_type)}; ${time}`,
    `Kaaran: ${reasonsHi}`, `Jaanch: ${checks}`, `Tay kaaryavaahi: ${planned}`, "Ghatnaayein (masked):", ...eventLines,
    "Signed kaaryavaahi aur sthiti:", ...(actionLines.length ? actionLines : ["Kaaryavaahi ka record nahi mila"]),
    `Kya maanga gaya: ${askedFor.join("; ") || "darj nahi; Maa se poochhein"}`, `Paise bheje? ${moneyHi}`,
    "Number: Maa se poochhein / unka call log dekhein.", "Asli message aur len-den ka vivaran Maa se poochhein; niji ank yahan nahi hain."].join("\n");
  const contents: EvidenceContents = {
    summary_en, summary_hi,
    copy_for_1930: `For cybercrime helpline 1930\n${summary_en}\nSigned timeline checkpoint: ${encodedHash}\nReport: https://cybercrime.gov.in`,
    cybercrime_url: "https://cybercrime.gov.in", chain_hash: encodedHash,
    verdict: { level: "red", scam_type: text(incident.verdict.scam_type), reasons_en: reasonsEnList, checks: checksList, planned_actions: plannedList, time },
    events: structuredEvents,
    actions: sortedEntries.map(entry => ({ time: entry.time, step: text(entry.step), status: text(entry.status), action: entry.action ? text(entry.action) : null })),
    asked_for: askedFor,
    money_sent: money === "unknown; ask Maa" ? "unknown" : money,
  };
  return { contents, chainHash: chainHash.toLowerCase() };
}

export async function buildEvidencePack(deps: EvidenceDeps, input: EvidenceRequest): Promise<EvidencePack> {
  // Authorization precedes incident, signed timeline and any persistence work.
  if (!await deps.db.isChild(input)) throw new Error("Evidence child access required");
  const { incident, eventIds } = await loadIncident(deps, input.familyId, input.verdictId);
  const { contents, chainHash } = await composeContents(deps, incident, eventIds);
  // Child-only originals: read after the child check, never stored, never hashed.
  let childOnly: EvidencePack["child_only"] = null;
  if (deps.sensitive) {
    const originals = await deps.sensitive.forIncident({ familyId: input.familyId, parentId: incident.parentId, verdictId: input.verdictId, eventIds });
    if (originals && (originals.numbers.length || originals.messages.length)) {
      childOnly = { numbers: originals.numbers.map(n => String(n).slice(0, 64)).slice(0, 20), messages: originals.messages.map(m => String(m).slice(0, 4000)).slice(0, 20) };
    }
  }
  const createdAt = deps.clock.now();
  // Creation is metadata, so repeated exports of identical content have the same hash.
  const contentsHash = evidenceContentsHash(contents);
  const saved = await deps.db.savePack({ ...input, contentsHash, chainHash, createdAt });
  const pack: EvidencePack = { ...contents, created_at: evidenceDisplayTime(createdAt),
    ...(saved && saved.id ? { pack_ref: encodePackRef(saved.id) } : {}),
    child_only: childOnly,
    copy_for_1930_full: childOnly ? [contents.copy_for_1930,
      `Suspect number(s): ${childOnly.numbers.join(", ") || "ask Maa"}`,
      ...childOnly.messages.map(message => `Original message: ${message}`)].join("\n") : null };
  return pack;
}

/**
 * Recomputes a stored receipt: rebuilds the contents from the current incident and signed timeline
 * and compares the contents hash and the chain checkpoint. Authorization of the caller is the host's.
 */
export async function verifyEvidencePack(deps: EvidenceDeps, input: { familyId: string; packId: string }): Promise<EvidenceVerification> {
  if (!deps.db.getPack) throw new Error("Evidence receipts not readable");
  const packId = decodePackRef(input.packId);
  const receipt = await deps.db.getPack({ familyId: input.familyId, packId });
  if (!receipt || receipt.familyId !== input.familyId) throw new Error("Evidence pack not found");
  const { incident, eventIds } = await loadIncident(deps, input.familyId, receipt.verdictId);
  const { contents, chainHash } = await composeContents(deps, incident, eventIds);
  const contentsMatch = evidenceContentsHash(contents) === receipt.contentsHash;
  const chainMatch = chainHash === receipt.chainHash.toLowerCase();
  return { ok: contentsMatch && chainMatch, contents_match: contentsMatch, chain_match: chainMatch,
    pack_id: receipt.id, verdict_id: receipt.verdictId };
}
