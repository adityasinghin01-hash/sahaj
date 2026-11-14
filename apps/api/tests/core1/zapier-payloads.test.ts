import { describe, expect, it } from 'vitest';
import {
  buildZapierZ1Body,
  buildZapierZ5Body,
  nextIstReminderAt,
  postZapierHook,
  toIstIso,
  type ZapierZ1RefillPayload,
  type ZapierZ5ReminderPayload,
} from '@/lib/core1/zapier';
import {
  executeWeeklyFamilyReportZapierGet,
  type FamilyReportStore,
  type WeeklyReportDbFacts,
} from '@/lib/core1/family-report-service';

// K-ZAP: payload shapes must match the field tokens saved in teammate Aditya's Zaps.
const FAMILY = '11111111-1111-4111-8111-111111111111';
const PERMISSION = '77777777-7777-4777-8777-777777777777';
const HASH = 'ab'.repeat(16) + '0123456789012345'.repeat(2); // 64 hex incl. a long digit run

const z1: ZapierZ1RefillPayload = {
  schema: 'sahaj.zapier.z1.v1', event: 'refill.authorized', familyId: FAMILY,
  personId: '22222222-2222-4222-8222-222222222222', medicineId: '33333333-3333-4333-8333-333333333333',
  vendorId: '44444444-4444-4444-8444-444444444444', actionRequestId: '55555555-5555-4555-8555-555555555555',
  errandId: '66666666-6666-4666-8666-666666666666', medicineLabel: 'Metformin, 12 MG Road, call 9000000001',
  reorderPacks: 1, amountMinor: 35050, status: 'authorized', occurredAt: '2026-11-15T06:00:00.000Z',
  permissionId: PERMISSION, chainHash: HASH,
};

const z5: ZapierZ5ReminderPayload = {
  schema: 'sahaj.zapier.z5.v1', event: 'reminder.refill_due', familyId: FAMILY,
  personId: '22222222-2222-4222-8222-222222222222', entityId: '33333333-3333-4333-8333-333333333333',
  label: 'Metformin at 12 MG Road, OTP 482910', dueAt: '2026-11-16T04:30:00.000Z',
  summary: 'Low stock (2 remaining) — call +91 90000 00001', occurredAt: '2026-11-15T06:00:00.000Z',
};

const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+05:30$/;

describe('K-ZAP Z1 errand ledger body', () => {
  it('carries the seven Hook fields the Sheets step reads, with correct types', () => {
    const body = buildZapierZ1Body(z1)!;
    expect(body).toMatchObject({
      occurred_at: '2026-11-15T11:30:00+05:30',
      errand_type: 'medicine_refill',
      vendor_label: 'Approved vendor',
      amount_inr: 350.5,
      permission_ref: PERMISSION,
      decision: 'approved',
      chain_hash: HASH,
      // back-compat with the Zap's original sample
      event_date: '2026-11-15', errand: 'Medicine refill', vendor: 'Approved vendor', permission_id: PERMISSION,
    });
    expect(typeof body.amount_inr).toBe('number');
    expect(body.occurred_at).toMatch(ISO_WITH_OFFSET);
  });

  it('marks approval requests and drops invalid refs instead of passing them through', () => {
    const body = buildZapierZ1Body({ ...z1, event: 'refill.approval_requested', status: 'awaiting_approval',
      permissionId: 'perm 12', chainHash: 'DEMO_NOT_A_REAL_SIGNATURE' })!;
    expect(body.decision).toBe('awaiting_approval');
    expect(body.permission_ref).toBeNull();
    expect(body.chain_hash).toBeNull();
    expect(buildZapierZ1Body({ ...z1, occurredAt: 'not-a-date' })).toBeNull();
  });

  it('sends no phone, OTP, address or free-form medicine label over the hook', async () => {
    let sent = '';
    const out = await postZapierHook({ hook: 'ZAPIER_HOOK_Z1', env: { ZAPIER_HOOK_Z1: 'https://hooks.example/z1' },
      payload: { ...z1, phone: '9000000001', address: '12 MG Road', location: { lat: 28 } } as ZapierZ1RefillPayload,
      audit: async () => {}, fetchImpl: async (_u, init) => { sent = String(init.body); return new Response('', { status: 200 }); } });
    expect(out.sent).toBe(true);
    expect(sent).not.toMatch(/9000000001|MG Road|Metformin|"(lat|location|address|phone)"/);
    expect(JSON.parse(sent).chain_hash).toBe(HASH); // not mangled by prose redaction
  });
});

describe('K-ZAP Z5 reminder body', () => {
  it('carries title, description, +05:30 start/end and numeric reminder minutes', () => {
    const body = buildZapierZ5Body(z5)!;
    expect(body).toMatchObject({
      title: 'Medicine refill due',
      start_at: '2026-11-16T10:00:00+05:30',
      end_at: '2026-11-16T10:15:00+05:30',
      reminder_minutes_before: 60,
    });
    expect(typeof body.description).toBe('string');
    expect(typeof body.reminder_minutes_before).toBe('number');
    expect(JSON.stringify(body)).not.toMatch(/482910|90000|MG Road|Metformin/);
  });

  it('schedules refill-due reminders for 10:00 IST the next day', () => {
    expect(nextIstReminderAt('2026-11-15T06:00:00.000Z')).toBe('2026-11-16T04:30:00.000Z');
    // 23:00 IST on the 15th is already the 15th locally; next day is the 16th.
    expect(nextIstReminderAt('2026-11-15T17:30:00.000Z')).toBe('2026-11-16T04:30:00.000Z');
    // 00:30 IST on the 16th (still the 15th in UTC) -> the 17th.
    expect(nextIstReminderAt('2026-11-15T19:00:00.000Z')).toBe('2026-11-17T04:30:00.000Z');
    expect(toIstIso('2026-11-16T04:30:00.000Z')).toBe('2026-11-16T10:00:00+05:30');
  });
});

describe('K-ZAP Z2 weekly report GET', () => {
  const facts: WeeklyReportDbFacts = {
    calls: [
      { id: 'c1', status: 'completed', createdAt: '2026-11-10T08:00:00.000Z' },
      { id: 'c2', status: 'failed', createdAt: '2026-11-11T08:00:00.000Z' },
    ],
    incidents: [{ id: 'i1', state: 'closed', severity: 'urgent', createdAt: '2026-11-11T10:00:00.000Z' }],
    refills: [{ id: 'r1', status: 'executed', createdAt: '2026-11-12T11:00:00.000Z' }],
    nudges: [],
    shieldEventsCount: 2,
    timelineRecords: [{ id: 't1', familyId: FAMILY, source: 'timeline', eventType: 'check_in.completed',
      createdAt: '2026-11-10T08:05:00.000Z',
      contentPreview: 'Meena Maa completed check-in (mood: calm · medicines: taken) call +919000000011' }],
  };
  const store: FamilyReportStore = {
    familyExists: async (id) => id === FAMILY,
    loadWeeklyFacts: async () => facts,
    getParentDisplayName: async () => 'Meena Maa 9000000011',
  };
  const KEYS = ['week_start', 'week_end', 'parent_name', 'checkin_summary', 'mood_summary',
    'medicine_summary', 'errand_summary', 'alert_summary', 'weekly_summary'];

  it('returns the nine Docs template fields as top-level plain strings', async () => {
    const res = await executeWeeklyFamilyReportZapierGet(
      new Request(`http://localhost/api/core1/family-report/weekly?familyId=${FAMILY}&periodEnd=2026-11-15T14:30:00.000Z`,
        { headers: { 'x-sahaj-zap-secret': 's3cret-value' } }),
      { store, env: { ZAPIER_REPORT_SECRET: 's3cret-value' } },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    for (const key of KEYS) {
      expect(typeof body[key], key).toBe('string');
      expect(body[key].length, key).toBeGreaterThan(0);
      expect(body[key], key).not.toMatch(/\n|\d{4,}(?!-\d{2}-\d{2}T)|<PHONE>/);
    }
    expect(body.week_start).toBe('2026-11-08T20:00:00+05:30');
    expect(body.week_end).toBe('2026-11-15T20:00:00+05:30');
    expect(body.parent_name).toBe('Meena Maa');
    expect(body.checkin_summary).toBe('1 of 2 check-in calls completed.');
    expect(body.mood_summary).toBe('Mood noted on 1 check-in: calm.');
    expect(body.medicine_summary).toBe('Medicines discussed on 1 check-in: taken.');
    expect(body.errand_summary).toBe('1 medicine refill: 1 completed, 0 in progress.');
    expect(body.alert_summary).toBe('1 urgent alert (1 resolved), 0 missed-call nudges, 2 scam warnings.');
    expect(JSON.stringify(KEYS.map((k) => body[k]))).not.toContain('9000000011');
  });

  it('still requires x-sahaj-zap-secret', async () => {
    const res = await executeWeeklyFamilyReportZapierGet(
      new Request(`http://localhost/api/core1/family-report/weekly?familyId=${FAMILY}`),
      { store, env: { ZAPIER_REPORT_SECRET: 's3cret-value' } },
    );
    expect(res.status).toBe(401);
  });
});
