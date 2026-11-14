import type { ScamType } from "@sahaj/shared";
import { RULES, SCRIPT_TYPE_IDS, type ScriptTypeId } from "./config";
import { findLinks, isApk, isShortener, lookAlikeDetail, type FoundLink } from "./links";
import { hasAnyPhrase, matchPhrases, normalizeText } from "./text";

export interface RuleHit {
  /** rule id from rules.json, e.g. "script.kyc_block", "link.shortener", "pattern.P1" */
  rule_id: string;
  /** score contribution (0 for informational hits) */
  weight: number;
  /** matched phrase / domain, never raw numbers */
  detail?: string;
  scam_type?: ScamType;
}

export interface TextScore {
  score: number;
  scam_type: ScamType;
  hits: RuleHit[];
  /** score of the best-matching scam script (before links/signals) */
  type_score: number;
  links: FoundLink[];
  apk: boolean;
  /** true when the text talks about bank / electricity / courier topics (used by P5) */
  topic: boolean;
}

const MAX = RULES.thresholds.max_score;
const TOPIC_WORDS = [...RULES.topic_words.bank, ...RULES.topic_words.electricity, ...RULES.topic_words.courier];

export function clampScore(n: number): number {
  return Math.max(0, Math.min(MAX, Math.round(n)));
}

/** Does the text mention bank / electricity / courier topics? */
export function hasTopicWords(text: string): boolean {
  return hasAnyPhrase(normalizeText(text), TOPIC_WORDS);
}

/** Link-level hits for one message. */
export function linkHits(text: string, links: FoundLink[] = findLinks(text)): RuleHit[] {
  const L = RULES.links;
  const hits: RuleHit[] = [];
  if (links.length > 0) hits.push({ rule_id: L.present.id, weight: L.present.score, detail: links[0]?.host });
  const short = links.find((l) => isShortener(l.host));
  if (short) hits.push({ rule_id: L.shortener.id, weight: L.shortener.score, detail: short.host });
  for (const l of links) {
    const la = lookAlikeDetail(l.host);
    if (la.brand && la.look_alike && !hits.some((h) => h.rule_id === L.look_alike.id)) {
      hits.push({ rule_id: L.look_alike.id, weight: L.look_alike.score, detail: `${l.host} (${la.brand})` });
    }
    if (la.punycode && !hits.some((h) => h.rule_id === L.punycode.id)) {
      hits.push({ rule_id: L.punycode.id, weight: L.punycode.score, detail: l.host });
    }
  }
  if (isApk(text)) hits.push({ rule_id: L.apk.id, weight: L.apk.score, scam_type: "remote_access" });
  return hits;
}

/**
 * Score a message (raw or already masked) against scam scripts, generic signals and link rules.
 * score = best scam-script score + each generic signal once + each link rule once, clamped to [0, max].
 */
export function scoreText(text: string): TextScore {
  const norm = normalizeText(text);
  const hits: RuleHit[] = [];

  let bestType: ScriptTypeId | null = null;
  let typeScore = 0;
  for (const type of SCRIPT_TYPE_IDS) {
    const matches = matchPhrases(norm, RULES.scam_scripts.types[type].phrases, (p) => p.text);
    let sum = 0;
    for (const m of matches) {
      sum += m.item.w;
      hits.push({ rule_id: `script.${type}`, weight: 0, detail: m.phrase, scam_type: type });
    }
    if (sum > typeScore) {
      typeScore = sum;
      bestType = type;
    }
  }
  // Only the best type contributes; record its total on a summary hit.
  if (bestType) hits.push({ rule_id: `script.${bestType}`, weight: typeScore, detail: "total", scam_type: bestType });

  let signalScore = 0;
  let signalType: ScamType | null = null;
  let signalTypeWeight = 0;
  for (const sig of RULES.generic_signals) {
    const m = matchPhrases(norm, sig.phrases, (p) => p)[0];
    if (!m) continue;
    signalScore += sig.score;
    hits.push({ rule_id: sig.id, weight: sig.score, detail: m.phrase, scam_type: sig.scam_type });
    if (sig.scam_type && sig.score > signalTypeWeight) {
      signalType = sig.scam_type;
      signalTypeWeight = sig.score;
    }
  }

  const links = findLinks(text);
  const lHits = linkHits(text, links);
  hits.push(...lHits);
  const linkScore = lHits.reduce((s, h) => s + h.weight, 0);
  const apk = lHits.some((h) => h.rule_id === RULES.links.apk.id);

  let scam_type: ScamType = "unknown";
  if (bestType && typeScore >= RULES.scam_scripts.min_type_score) scam_type = bestType;
  else if (signalType) scam_type = signalType;
  else if (apk) scam_type = "remote_access";

  return {
    score: clampScore(typeScore + signalScore + linkScore),
    scam_type,
    hits,
    type_score: typeScore,
    links,
    apk,
    topic: hasAnyPhrase(norm, TOPIC_WORDS),
  };
}

