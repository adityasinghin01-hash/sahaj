import { classifyScam } from "./classify_scam";
import { checkMessage } from "./check_message";
import { familyCheck, familyCheckResult } from "./family_check";
import { checkCodeWord } from "./check_code_word";
import { moneySent } from "./money_sent";

/** name → tool, for the `/api/sarvam/tool/[name]` route. */
export const shieldTools = {
  classify_scam: classifyScam,
  check_message: checkMessage,
  family_check: familyCheck,
  family_check_result: familyCheckResult,
  check_code_word: checkCodeWord,
  money_sent: moneySent,
} as const;

export type ShieldToolName = keyof typeof shieldTools;

export function isShieldToolName(name: string): name is ShieldToolName {
  return Object.prototype.hasOwnProperty.call(shieldTools, name);
}

export type { ShieldDeps, ShieldTool, ToolCtx, CreateFamilyCheckInput, FamilyCheckRecord } from "./types";
export { maskDigits } from "./mask";
export { STOP_SCRIPTS, SAFE_FALLBACK_LINE, SAFE_FALLBACK_LINE_ID, type StopScriptId } from "./lines";
export { TOOL_LIMIT_MS, TOOL_TIMEOUT_MS } from "./runtime";
export { classifyScam, checkMessage, familyCheck, familyCheckResult, checkCodeWord, moneySent };
export { escalateFamilyCheck, scheduleCallback } from "./family_check";
