/**
 * Fixed lines Aasha Didi speaks. Ids 1–9 match the recorded clips (Core 3 stop scripts).
 * Rules for every line: Sahaj never asks for money or an OTP, and never speaks as a family member.
 * Nothing an AI generates is ever spoken; tools only pick from these lines.
 */
export const STOP_SCRIPTS = {
  1: "Ruk jaiye ji. Ye fraud ho sakta hai. Kisi ko paise ya OTP mat dijiye, aur ye phone kaat dijiye.",
  2: "OTP kisi ko mat bataiye ji. Bank, police ya company kabhi OTP nahi maangte.",
  3: "Ek minute rukiye ji. Is number par baat karne se pehle hum check kar lete hain.",
  4: "Police kabhi video call par arrest nahi karti ji. Ye fraud hai, phone kaat dijiye.",
  5: "Koi file ya app mat kholiye ji. Ye fraud ho sakta hai.",
  6: "Kya aapne kisi ko OTP bataya hai ji? Bataya ho toh koi baat nahi, hum abhi madad karte hain.",
  7: "Paise chale gaye hain toh abhi 1930 par call kijiye. Riya ko sab bhej diya hai.",
  8: "Ek minute rukiye ji, main aapke ghar walon se pooch rahi hoon.",
  9: "Ye sirf abhyaas tha ji. Aapne bilkul sahi kiya.",
} as const;

export type StopScriptId = keyof typeof STOP_SCRIPTS;

/** Spoken on timeout or internal error: the general stop line. */
export const SAFE_FALLBACK_LINE_ID = 1 as const;
export const SAFE_FALLBACK_LINE = STOP_SCRIPTS[SAFE_FALLBACK_LINE_ID];

export const LINES = {
  familyCheckAsking: (name: string) => `Ek minute rukiye ji, main ${name} se pooch rahi hoon.`,
  familyCheckUnknown: "Ek minute rukiye ji, main aapke bete/beti se pooch rahi hoon. Tab tak paise mat bhejiye.",
  familyConfirmed: (name: string) => `Haan, ye ${name} hi the.`,
  familyDenied: (name: string) => `Ye ${name} nahi the. Paise mat bhejiye.`,
  familyPending: "Abhi pooch rahi hoon ji, thoda rukiye. Tab tak paise mat bhejiye.",
  familyNoAnswer: "Abhi jawab nahi aaya ji. Jab tak pakka na ho, paise mat bhejiye. Main aapko wapas call karungi.",
  familyNotFound: "Main ye pakka nahi kar paayi ji. Abhi paise mat bhejiye.",
  callbackDefault: "Namaste ji, main Aasha Didi bol rahi hoon. Abhi tak pakka nahi hua hai, isliye kisi ko paise mat bhejiye.",
  codeWordWrong: "Ye code word galat hai. Ye fraud ho sakta hai.",
  messageYellow: "Is message ka jawab mat dijiye ji, aur kisi link par click mat kijiye. Main ghar walon se check karwa rahi hoon.",
  messageGreen: "Ye message theek lag raha hai ji. Phir bhi kisi ko OTP mat bataiye.",
  classifyGreen: "Isme abhi koi khatra nahi dikh raha ji. Phir bhi kisi ko OTP ya paise mat dijiye.",
} as const;

/** Generic name used when we do not know who the family member is. */
export const GENERIC_FAMILY = "aapke ghar wale";
