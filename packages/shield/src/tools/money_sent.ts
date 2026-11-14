import { z } from "zod";
import { maskDigits } from "./mask";
import { STOP_SCRIPTS } from "./lines";
import { alertChild, background, defineTool, makeVerdict, safeSign } from "./runtime";

export const MoneySentInput = z.object({
  amount_said: z.string().max(200).optional(),
  how: z.string().max(200).optional(),
});

export interface MoneySentOutput {
  level: "red";
  line_id: 7;
  line_hi: string;
}

const OUTPUT: MoneySentOutput = { level: "red", line_id: 7, line_hi: STOP_SCRIPTS[7] };

export const moneySent = defineTool({
  name: "money_sent",
  description: "Maa says money already went: tell her to call 1930, alert the child (red, offer 1930) and start the circle chain.",
  input: MoneySentInput,
  // Line 7 is already the right thing to say even if the side effects time out.
  fallback: (): MoneySentOutput => ({ ...OUTPUT }),
  async handler(deps, ctx, input): Promise<MoneySentOutput> {
    const amount = input.amount_said ? maskDigits(input.amount_said) : null;
    const how = input.how ? maskDigits(input.how) : null;
    const reason = "voice_report:money_sent";

    await safeSign(deps, {
      familyId: ctx.familyId,
      type: "shield.voice.money_sent",
      line: "Maa says money has already been sent. Told her to call 1930.",
      data: { line_id: 7, amount_said: amount, how },
    });

    await alertChild(
      deps,
      ctx,
      makeVerdict({
        level: "red",
        scam_type: "unknown",
        rule_id: "voice.money_sent",
        hi: "Maa ne bataya ki paise chale gaye hain. Abhi 1930 par shikayat karein.",
        en: `Maa says money has been sent${how ? ` (${how})` : ""}${amount ? `, amount: ${amount}` : ""}. Report on 1930 now.`,
        actions: ["speak_clip", "alert_child", "circle_chain", "offer_1930"],
      }),
    );

    // Started, not awaited to completion: the chain rings people one by one.
    background(deps, ctx, "circle_chain", () =>
      deps.atlas.startCircleChain({ familyId: ctx.familyId, parentId: ctx.parentId, reason }),
    );

    return { ...OUTPUT };
  },
});
