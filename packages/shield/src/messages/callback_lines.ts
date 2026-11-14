/**
 * Lines Aasha Didi speaks when she calls Maa back after a family check (job
 * `shield.family_check.callback`). Same rules as tools/lines.ts: never ask for money or an OTP,
 * never speak as a family member, and nothing AI-generated is spoken.
 */
const GREETING = "Namaste ji, main Aasha Didi bol rahi hoon.";

export const CALLBACK_LINES = {
  confirmed: (name: string) => `${GREETING} Haan, ye ${name} hi the.`,
  denied: (name: string) => `${GREETING} Ye ${name} nahi the. Paise bilkul mat bhejiye.`,
  /** Still pending at 2 min. With a child name this is the exact card line. */
  noAnswer: (childName: string | null) =>
    `Abhi pata nahi chala. Paise bilkul mat bhejiye. ${childName ?? "Aapke ghar walon"} ko bata diya hai.`,
} as const;
