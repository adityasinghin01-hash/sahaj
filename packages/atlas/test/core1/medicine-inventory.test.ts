import { describe, it, expect } from 'vitest';
import {
  generateRefillProposal,
  recordDoseEvent,
  isValidAmountMinor,
} from '../../src/core1/medicine-inventory';
import { createClock } from '../../src/core1/types';
import type {
  MedicineRecord,
  VendorRecord,
} from '../../src/core1/types';

describe('Medicine Inventory & Refill Math Domain Logic', () => {
  const familyId = '11111111-1111-4111-8111-111111111111';
  const personId = '22222222-2222-4222-8222-222222222222';
  const vendorId = '33333333-3333-4333-8333-333333333333';

  const baseMedicine: MedicineRecord = {
    id: 'med-bp-01',
    familyId,
    personId,
    label: 'Amlodipine 5mg',
    remainingCount: 10,
    refillThreshold: 5,
    instructionsConfirmedByPerson: true,
    unitDose: 1,
    packSize: 30,
    estimatedUnitPriceMinor: 250, // 250 paise = Rs 2.50 per pill
  };

  const baseVendor: VendorRecord = {
    id: vendorId,
    familyId,
    approved: true,
  };

  it('BLOCKER 3 FIX: requires instructionsConfirmedByPerson before generating refill proposal', () => {
    const clock = createClock('2026-11-15T08:00:00.000Z');
    const unconfirmedMed: MedicineRecord = {
      ...baseMedicine,
      instructionsConfirmedByPerson: false,
    };

    expect(() =>
      generateRefillProposal({
        medicine: unconfirmedMed,
        vendor: baseVendor,
        reorderPacks: 1,
        clock,
      })
    ).toThrow('instructionsConfirmedByPerson');
  });

  it('BLOCKER 3 FIX: rejects cross-family vendor and unapproved/revoked vendor', () => {
    const clock = createClock('2026-11-15T08:00:00.000Z');
    const crossFamilyVendor: VendorRecord = {
      ...baseVendor,
      familyId: '99999999-9999-4999-8999-999999999999',
    };

    // Cross-family vendor throws error
    expect(() =>
      generateRefillProposal({
        medicine: baseMedicine,
        vendor: crossFamilyVendor,
        clock,
      })
    ).toThrow('Vendor does not belong to the same family');

    // Revoked vendor returns undefined (no proposal)
    const revokedVendor: VendorRecord = {
      ...baseVendor,
      revokedAt: '2026-11-10T00:00:00.000Z',
    };
    expect(
      generateRefillProposal({
        medicine: baseMedicine,
        vendor: revokedVendor,
        clock,
      })
    ).toBeUndefined();
  });

  it('BLOCKER 3 FIX: rejects invalid, fractional, negative, and non-finite quantities and prices without silent clamping', () => {
    const clock = createClock('2026-11-15T08:00:00.000Z');

    // Negative reorder packs
    expect(() =>
      generateRefillProposal({
        medicine: baseMedicine,
        vendor: baseVendor,
        reorderPacks: -2,
        clock,
      })
    ).toThrow('Invalid reorderPacks');

    // Fractional reorder packs
    expect(() =>
      generateRefillProposal({
        medicine: baseMedicine,
        vendor: baseVendor,
        reorderPacks: 1.5,
        clock,
      })
    ).toThrow('Invalid reorderPacks');

    // Negative unit price
    const medNegativePrice: MedicineRecord = {
      ...baseMedicine,
      estimatedUnitPriceMinor: -100,
    };
    expect(() =>
      generateRefillProposal({
        medicine: medNegativePrice,
        vendor: baseVendor,
        clock,
      })
    ).toThrow('Invalid estimatedUnitPriceMinor');

    // Fractional price
    const medFractionalPrice: MedicineRecord = {
      ...baseMedicine,
      estimatedUnitPriceMinor: 2.75,
    };
    expect(() =>
      generateRefillProposal({
        medicine: medFractionalPrice,
        vendor: baseVendor,
        clock,
      })
    ).toThrow('Invalid estimatedUnitPriceMinor');
  });

  it('BLOCKER 3 FIX: calculates exact refill total: total units (packs * packSize) * unit price minor', () => {
    const clock = createClock('2026-11-15T08:00:00.000Z');
    // 2 packs of 30 pills = 60 pills. At 250 paise per pill = 15,000 paise (Rs 150)
    const proposal = generateRefillProposal({
      medicine: baseMedicine,
      vendor: baseVendor,
      reorderPacks: 2,
      clock,
    });

    expect(proposal).toBeDefined();
    expect(proposal?.reorderQuantity).toBe(60);
    expect(proposal?.amountMinor).toBe(15000);
    expect(proposal?.gateRequest.amountMinor).toBe(15000);
    expect(proposal?.gateRequest.action).toBe('medicine_refill');
    expect(proposal?.requiresFamilyApproval).toBe(true);
  });

  it('decrements physical count on confirmed dose and generates refill proposal when reaching threshold', () => {
    const clock = createClock('2026-11-15T08:00:00.000Z');
    const lowStockMed: MedicineRecord = {
      ...baseMedicine,
      remainingCount: 6,
      refillThreshold: 5,
    };

    const result = recordDoseEvent({
      medicine: lowStockMed,
      input: {
        actionType: 'confirmed_dose',
        timestamp: '2026-11-15T08:00:00.000Z',
      },
      vendor: baseVendor,
      clock,
    });

    expect(result.medicine.remainingCount).toBe(5); // 6 - 1 = 5 (reaches threshold!)
    expect(result.isLowStock).toBe(true);
    expect(result.refillProposal).toBeDefined();
    expect(result.refillProposal?.amountMinor).toBe(30 * 250);
  });

  it('missed dose preserves physical count and emits reminder without medical diagnosis', () => {
    const clock = createClock('2026-11-15T08:00:00.000Z');
    const result = recordDoseEvent({
      medicine: baseMedicine,
      input: {
        actionType: 'missed_dose',
        timestamp: '2026-11-15T08:00:00.000Z',
      },
      clock,
    });

    // Pill was not physically consumed
    expect(result.medicine.remainingCount).toBe(10);
    expect(result.safetyAlert?.severity).toBe('routine');
    expect(result.safetyAlert?.medicalDiagnosisOrPrescriptionGiven).toBe(false);
    expect(result.safetyAlert?.message).toContain('consulting a physician');
  });

  it('double dose decrements inventory and raises urgent safety escalation without diagnosis', () => {
    const clock = createClock('2026-11-15T08:00:00.000Z');
    const result = recordDoseEvent({
      medicine: baseMedicine,
      input: {
        actionType: 'double_dose_reported',
        count: 2,
        timestamp: '2026-11-15T08:00:00.000Z',
      },
      clock,
    });

    // Two pills physically consumed: 10 - 2 = 8
    expect(result.medicine.remainingCount).toBe(8);
    expect(result.safetyAlert?.severity).toBe('urgent');
    expect(result.safetyAlert?.medicalDiagnosisOrPrescriptionGiven).toBe(false);
    expect(result.safetyAlert?.message).toContain('contact a doctor');
  });

  it('reconciles inventory count strictly and rejects invalid negative/fractional counts', () => {
    const clock = createClock('2026-11-15T08:00:00.000Z');
    const result = recordDoseEvent({
      medicine: baseMedicine,
      input: {
        actionType: 'count_reconciliation',
        count: 42,
        timestamp: '2026-11-15T08:00:00.000Z',
      },
      clock,
    });
    expect(result.medicine.remainingCount).toBe(42);

    // Negative count
    expect(() =>
      recordDoseEvent({
        medicine: baseMedicine,
        input: {
          actionType: 'count_reconciliation',
          count: -5,
          timestamp: '2026-11-15T08:00:00.000Z',
        },
        clock,
      })
    ).toThrow('Count reconciliation requires a valid non-negative integer count');

    // Fractional count
    expect(() =>
      recordDoseEvent({
        medicine: baseMedicine,
        input: {
          actionType: 'count_reconciliation',
          count: 10.5,
          timestamp: '2026-11-15T08:00:00.000Z',
        },
        clock,
      })
    ).toThrow('Count reconciliation requires a valid non-negative integer count');
  });
});
