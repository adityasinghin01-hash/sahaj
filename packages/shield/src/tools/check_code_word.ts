import { z } from "zod";
import { LINES, SAFE_FALLBACK_LINE } from "./lines";
import { alertChild, defineTool, makeVerdict, safeSign } from "./runtime";

export const CheckCodeWordInput = z.object({ heard: z.string().max(200) });

export type CheckCodeWordOutput = { ok: true } | { ok: false; level: "red"; line_hi: string };

/** trim, lowercase, collapse whitespace (NFC first so the same word typed two ways hashes the same). */
export function normalizeCodeWord(word: string): string {
  return word.normalize("NFC").trim().toLowerCase().replace(/\s+/g, " ");
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time string compare: runtime depends only on the (fixed, 64-char) expected length. */
export function constantTimeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < b.length; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export const checkCodeWord = defineTool({
  name: "check_code_word",
  description: "Check the family code word a caller gave. The word never leaves this function; only its hash is compared.",
  input: CheckCodeWordInput,
  fallback: (): CheckCodeWordOutput => ({ ok: false, level: "red", line_hi: SAFE_FALLBACK_LINE }),
  async handler(deps, ctx, input): Promise<CheckCodeWordOutput> {
    const heard = normalizeCodeWord(input.heard);
    const stored = await deps.db.getCodeWordHash(ctx.familyId);
    const heardHash = await sha256Hex(heard);
    const ok = heard.length > 0 && stored !== null && constantTimeEqual(heardHash, stored.trim().toLowerCase());

    await safeSign(deps, {
      familyId: ctx.familyId,
      type: "shield.voice.check_code_word",
      line: ok ? "Caller gave the right family code word." : "Caller gave a wrong or no family code word.",
      // Never log the heard word or any hash.
      data: { ok, code_word_set: stored !== null },
    });

    if (ok) return { ok: true };

    await alertChild(
      deps,
      ctx,
      makeVerdict({
        level: "red",
        scam_type: "family_in_trouble",
        rule_id: "voice.code_word.wrong",
        hi: "Maa ko call karne wale ne galat code word bataya.",
        en: "The caller gave Maa a wrong family code word.",
        actions: ["speak_clip", "alert_child"],
      }),
    );
    return { ok: false, level: "red", line_hi: LINES.codeWordWrong };
  },
});
