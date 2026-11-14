import { randomInt } from "node:crypto";
import type { Core2TimelinePort } from "@/lib/core2/contracts";
import {
  checkCodeWord,
  constantTimeEqual,
  normalizeCodeWord,
  sha256Hex,
} from "../../../../../packages/shield/src/tools/check_code_word";
import type { ShieldDeps } from "../../../../../packages/shield/src/tools/types";
import { PROOF_WORD_BANK, type ProofAnyPhoneRepo } from "./contracts";

export { constantTimeEqual, normalizeCodeWord, sha256Hex };

const ROTATION_BANK = [
  ...PROOF_WORD_BANK.map((w) => w.word),
  "morningsun",
  "chandi",
  "tulsi",
  "belpatra",
  "kaveri",
  "himachal",
] as const;

function buildShieldDepsForCodeWord(input: {
  proofRepo: ProofAnyPhoneRepo;
  timeline: Core2TimelinePort;
  uuid: () => string;
  now: () => Date;
  onAlertChild?: (verdict: unknown) => Promise<void> | void;
}): ShieldDeps {
  return {
    llm: {
      async understand() {
        return { ok: false, reason: "unused_in_code_word" };
      },
    },
    rules: {
      scoreText() {
        return { level: "green", scam_type: "none", hits: [] };
      },
    },
    whatsapp: {
      async sendFamilyCheckCard() {},
    },
    calls: {
      async startResponderCall() {},
      async startCallback() {},
    },
    atlas: {
      async bridgeChild() {},
      async startCircleChain() {},
      async alertChild(alertInput) {
        if (input.onAlertChild) {
          await input.onAlertChild(alertInput.verdict);
        }
      },
    },
    db: {
      async createFamilyCheck() {
        return { id: input.uuid() };
      },
      async getFamilyCheck() {
        return null;
      },
      async findPersonByName() {
        return null;
      },
      async getCodeWordHash(familyId: string) {
        return input.proofRepo.getCodeWordHash(familyId);
      },
    },
    async sign(event) {
      await input.timeline.append({
        familyId: event.familyId,
        eventId: input.uuid(),
        dedupeKey: `shield:${event.type}:${input.uuid()}`,
        eventType: event.type,
        entityId: null,
        humanLine: event.line,
        occurredAt: input.now().toISOString(),
        payload: event.data ?? {},
      });
    },
    clock: {
      now: input.now,
    },
  };
}

/**
 * Verifies a spoken family code word using the canonical Shield `check_code_word` tool
 * and `public.shield_family_security` store — one code word system across Shield and Core 2.
 */
export async function verifyShieldCodeWord(input: {
  familyId: string;
  parentId: string;
  saidCodeWord: string;
  proofRepo: ProofAnyPhoneRepo;
  timeline: Core2TimelinePort;
  uuid: () => string;
  now: () => Date;
}): Promise<{ ok: boolean }> {
  const deps = buildShieldDepsForCodeWord({
    proofRepo: input.proofRepo,
    timeline: input.timeline,
    uuid: input.uuid,
    now: input.now,
  });

  const out = await checkCodeWord.run(
    deps,
    { familyId: input.familyId, parentId: input.parentId },
    { heard: input.saidCodeWord },
  );
  return { ok: out.ok };
}

/**
 * Rotates the Shield family code word immediately after a successful single-use any-phone call
 * so the used word can never be replayed. Never logs or returns the raw word or hash.
 */
export async function rotateShieldCodeWordAfterUse(input: {
  familyId: string;
  usedWord: string;
  proofRepo: ProofAnyPhoneRepo;
  randomIndex?: (maxExclusive: number) => number;
}): Promise<{ rotated: true }> {
  const usedNormalized = normalizeCodeWord(input.usedWord);
  const usedHash = await sha256Hex(usedNormalized);
  const currentHash = await input.proofRepo.getCodeWordHash(input.familyId);

  const pickIndex = input.randomIndex ?? ((max) => randomInt(max));
  const candidates = ROTATION_BANK.filter((w) => normalizeCodeWord(w) !== usedNormalized);
  const chosenWord = candidates[pickIndex(candidates.length)] ?? "tulsi";
  const suffix = pickIndex(90) + 10;
  const rotatedPhrase = `${chosenWord} ${suffix}`;
  let nextHash = await sha256Hex(normalizeCodeWord(rotatedPhrase));

  if (nextHash === usedHash || (currentHash && constantTimeEqual(nextHash, currentHash))) {
    nextHash = await sha256Hex(normalizeCodeWord(`${chosenWord} ${suffix + 17}`));
  }

  await input.proofRepo.rotateCodeWordHash(input.familyId, nextHash);
  return { rotated: true };
}
