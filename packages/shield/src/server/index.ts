export { handleShieldEvent, hasUnmaskedDigits, SHIELD_EVENT_MAX_BODY_BYTES } from "./event";
export {
  createPairingCode,
  handleShieldPair,
  randomSixDigitCode,
  ShieldPairRequest,
  PAIRING_CODE_TTL_MS,
  PAIRING_MAX_ACTIVE_CODES,
  PAIRING_MAX_FAILURES,
  PAIRING_FAILURE_WINDOW_MS,
  PAIRING_LOCK_MS,
  PAIRING_GENERIC_ERROR,
  type CreatePairingCodeResult,
} from "./pairing";
export { deriveDeviceSecret, signShieldBody } from "./crypto";
export type {
  ShieldServerDeps,
  ShieldServerDb,
  ShieldDeviceRow,
  NewShieldDevice,
  NewShieldEventRow,
  NewPairingCode,
  ShieldProtections,
} from "./types";
