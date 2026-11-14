/**
 * Medicine inventory and refill mathematics domain logic.
 *
 * Implements:
 * - Confirmed dose/count inputs with strict input validation
 * - Absolute rejection of invalid, negative, fractional, or non-finite doses, quantities, and prices
 * - Mandatory verification of instructionsConfirmedByPerson and matching vendor family
 * - Missed and double dose handling strictly without diagnosing or prescribing treatment
 * - Exact integer minor units arithmetic (e.g. paise) for refill proposals
 * - Vendor, amount, and item constraints compatible with Cedar GateRequest
 * - Absolute prohibition on automatic payments: proposals require affirmative family approval
 * - Deterministic identifier generation for re-evaluation stability
 */

import type { GateRequest } from '@sahaj/gate';
import { deriveDeterministicId } from './types';
import type {
  MedicineRecord,
  VendorRecord,
  DoseInput,
  MedicineOperationResult,
  RefillProposalIntent,
  Clock,
} from './types';

/**
 * Validates that an amount is a strictly safe, non-negative integer minor unit (e.g. paise/cents).
 * Rejects fractional, negative, NaN, or non-finite numbers.
 */
export function isValidAmountMinor(amount: unknown): amount is number {
  return typeof amount === 'number' && Number.isSafeInteger(amount) && amount >= 0;
}

/**
 * Validates that a quantity is a strictly safe, positive integer.
 * Rejects negative, fractional, zero, NaN, or non-finite numbers.
 */
export function isStrictPositiveInteger(val: unknown): val is number {
  return typeof val === 'number' && Number.isSafeInteger(val) && val > 0;
}

/**
 * Validates that a count is a strictly safe, non-negative integer.
 */
export function isStrictNonNegativeInteger(val: unknown): val is number {
  return typeof val === 'number' && Number.isSafeInteger(val) && val >= 0;
}

export interface RefillProposalParams {
  medicine: MedicineRecord;
  vendor: VendorRecord;
  reorderPacks?: number;
  clock: Clock;
}

/**
 * Generates a refill proposal for low-stock medicine.
 *
 * Requirements:
 * - Medicine instructions must be confirmed by the person (`instructionsConfirmedByPerson === true`).
 * - Vendor must belong to the same family as the medicine (`vendor.familyId === medicine.familyId`).
 * - Vendor must be approved and not revoked.
 * - Quantities and prices must be strictly safe non-negative integers; never silently clamped.
 * - Action is strictly 'medicine_refill', never 'payment'.
 * - Must require affirmative family approval (no autonomous payments).
 */
export function generateRefillProposal(params: RefillProposalParams): RefillProposalIntent | undefined {
  const { medicine, vendor, clock } = params;
  const reorderPacks = params.reorderPacks ?? 1;

  // 1. Guard instructions confirmation
  if (!medicine.instructionsConfirmedByPerson) {
    throw new Error('Medicine refill proposal requires instructionsConfirmedByPerson to be true');
  }

  // 2. Guard vendor matching family
  if (vendor.familyId !== medicine.familyId) {
    throw new Error('Vendor does not belong to the same family as medicine');
  }

  // 3. Guard vendor approval
  if (!vendor.approved || vendor.revokedAt) {
    return undefined;
  }

  // 4. Validate quantities strictly without silent clamping or flooring
  if (!isStrictPositiveInteger(reorderPacks)) {
    throw new Error(`Invalid reorderPacks: must be a positive integer, received ${reorderPacks}`);
  }

  if (!isStrictPositiveInteger(medicine.packSize)) {
    throw new Error(`Invalid medicine packSize: must be a positive integer, received ${medicine.packSize}`);
  }

  const reorderQuantity = reorderPacks * medicine.packSize;
  const unitPriceMinor = medicine.estimatedUnitPriceMinor ?? 0;

  if (!isValidAmountMinor(unitPriceMinor)) {
    throw new Error(`Invalid estimatedUnitPriceMinor: must be a non-negative integer minor unit, received ${unitPriceMinor}`);
  }

  // Total calculation: total reorder units (pills/items) * unit price minor
  const totalAmountMinor = reorderQuantity * unitPriceMinor;
  if (!isValidAmountMinor(totalAmountMinor)) {
    throw new Error(`Total refill amount overflow: ${totalAmountMinor}`);
  }

  // 5. Build Cedar-compliant GateRequest with deterministic ID
  const gateRequestId = deriveDeterministicId(
    `refill:${medicine.familyId}:${medicine.id}:${vendor.id}`,
    clock.nowIso()
  );

  const gateRequest: GateRequest = {
    id: gateRequestId,
    familyId: medicine.familyId,
    action: 'medicine_refill',
    amountMinor: totalAmountMinor,
    vendorId: vendor.id,
    itemIds: [medicine.id],
    targetId: medicine.personId,
  };

  // Verify that prohibited actions are never attached
  if ((gateRequest.action as string) === 'payment' || (gateRequest.action as string) === 'medical_diagnosis') {
    throw new Error('Security violation: Refill proposal cannot initiate payments or diagnosis');
  }

  return {
    familyId: medicine.familyId,
    medicineId: medicine.id,
    personId: medicine.personId,
    vendorId: vendor.id,
    itemIds: [medicine.id],
    reorderQuantity,
    amountMinor: totalAmountMinor,
    proposedAt: clock.nowIso(),
    requiresFamilyApproval: true,
    gateRequest,
  };
}

export interface RecordDoseParams {
  medicine: MedicineRecord;
  input: DoseInput;
  vendor?: VendorRecord;
  reorderPacks?: number;
  clock: Clock;
}

/**
 * Records a dose or inventory reconciliation and determines whether refill proposals
 * or safety notifications should be issued.
 *
 * Safety Mandate:
 * - Under NO circumstances will medical diagnosis or prescription be given.
 * - Missed doses do not decrement physical inventory and issue non-prescriptive reminders.
 * - Double doses accurately decrement physical pills and issue safety escalation to family/doctor.
 * - Rejects fractional, negative, NaN, or non-finite counts without silent clamping.
 */
export function recordDoseEvent(params: RecordDoseParams): MedicineOperationResult {
  const { medicine, input, vendor, reorderPacks, clock } = params;

  // Validate medicine baseline
  if (!isStrictNonNegativeInteger(medicine.remainingCount)) {
    throw new Error(`Invalid medicine remainingCount: ${medicine.remainingCount}`);
  }
  if (!isStrictNonNegativeInteger(medicine.refillThreshold)) {
    throw new Error(`Invalid medicine refillThreshold: ${medicine.refillThreshold}`);
  }
  if (!isStrictPositiveInteger(medicine.unitDose)) {
    throw new Error(`Invalid medicine unitDose: ${medicine.unitDose}`);
  }

  let newRemainingCount = medicine.remainingCount;
  let safetyAlert: MedicineOperationResult['safetyAlert'] = undefined;

  switch (input.actionType) {
    case 'confirmed_dose': {
      let countTaken: number;
      if (input.count !== undefined) {
        if (!isStrictPositiveInteger(input.count)) {
          throw new Error(`Invalid confirmed dose count: must be a positive integer, received ${input.count}`);
        }
        countTaken = input.count;
      } else {
        countTaken = medicine.unitDose;
      }

      newRemainingCount = Math.max(0, medicine.remainingCount - countTaken);
      break;
    }

    case 'missed_dose': {
      // Physical pill remains in container; do NOT decrement inventory.
      // Do NOT diagnose or prescribe extra doses.
      safetyAlert = {
        severity: 'routine',
        message: 'Scheduled dose was marked as missed. Do not take extra doses without consulting a physician.',
        notifyFamily: true,
        medicalDiagnosisOrPrescriptionGiven: false,
      };
      break;
    }

    case 'double_dose_reported': {
      // Actual pills taken: decrement inventory by count taken (default 2 * unitDose)
      let countTaken: number;
      if (input.count !== undefined) {
        if (!isStrictPositiveInteger(input.count) || input.count < 2) {
          throw new Error(`Invalid double dose count: must be an integer >= 2, received ${input.count}`);
        }
        countTaken = input.count;
      } else {
        countTaken = medicine.unitDose * 2;
      }

      newRemainingCount = Math.max(0, medicine.remainingCount - countTaken);

      // Issue critical safety notice WITHOUT diagnosing or prescribing treatments
      safetyAlert = {
        severity: 'urgent',
        message: 'A double dose was reported. Please contact a doctor, pharmacist, or local emergency helpline if the person feels unwell. Do not administer additional medicine or home remedies.',
        notifyFamily: true,
        medicalDiagnosisOrPrescriptionGiven: false,
      };
      break;
    }

    case 'count_reconciliation': {
      if (input.count === undefined || !isStrictNonNegativeInteger(input.count)) {
        throw new Error(`Count reconciliation requires a valid non-negative integer count, received ${input.count}`);
      }
      newRemainingCount = input.count;
      break;
    }

    default: {
      throw new Error(`Unknown dose action type: ${(input as { actionType: string }).actionType}`);
    }
  }

  const updatedMedicine: MedicineRecord = {
    ...medicine,
    remainingCount: newRemainingCount,
  };

  const isLowStock = newRemainingCount <= medicine.refillThreshold;

  let refillProposal: RefillProposalIntent | undefined;
  if (isLowStock && vendor && medicine.instructionsConfirmedByPerson) {
    refillProposal = generateRefillProposal({
      medicine: updatedMedicine,
      vendor,
      reorderPacks,
      clock,
    });
  }

  return {
    medicine: updatedMedicine,
    actionTaken: input.actionType,
    isLowStock,
    refillProposal,
    safetyAlert,
  };
}
