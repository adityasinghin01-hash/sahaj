import { describe, expect, it, vi } from 'vitest';
import { createCommandPorts, type CommandDeps } from '@/lib/core1/sarvam-tools/commands';
import type { ToolContext } from '@/lib/core1/sarvam-tools/handler';

const ctx: ToolContext = { familyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', parentId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' };
const id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
function fixture() {
  const deps: CommandDeps = {
    assertParent: vi.fn().mockResolvedValue(undefined),
    runOnce: vi.fn(async (_tool, _ctx, _input, _key, work) => work()),
    urgentCommand: vi.fn().mockResolvedValue({ status: 'queued' }),
    openIncident: vi.fn().mockResolvedValue({ status: 'accepted', responder_name: 'Sharma uncle', eta_minutes: 4 }),
    sendTranscript: vi.fn().mockResolvedValue(undefined),
    truthLine: vi.fn().mockResolvedValue({ status: 'safe' }),
    familyCheck: vi.fn().mockResolvedValue({ status: 'checking', check_id: id }),
    recordConsent: vi.fn().mockResolvedValue(undefined),
    reschedule: vi.fn().mockResolvedValue(undefined),
    markPrivate: vi.fn().mockResolvedValue(undefined),
    cancelPermission: vi.fn().mockResolvedValue(undefined),
    getMedicine: vi.fn().mockResolvedValue({ id, familyId: ctx.familyId, personId: ctx.parentId,
      label: 'Dawa', remainingCount: 12, refillThreshold: 3, instructionsConfirmedByPerson: true, unitDose: 1, packSize: 10 }),
    setMedicineCount: vi.fn().mockResolvedValue(undefined),
    proposeRefill: vi.fn().mockResolvedValue(undefined),
    responderCommand: vi.fn().mockResolvedValue(undefined),
    audit: vi.fn().mockResolvedValue(undefined), now: () => new Date('2026-11-15T00:00:00Z'),
  };
  return { deps, ports: createCommandPorts(deps) };
}
describe('Sarvam command wiring', () => {
  it('calls the imported urgent command rather than returning fabricated acceptance', async () => {
    const { deps, ports } = fixture();
    expect(await ports.execute('raise_urgent', ctx, { said: 'Gir gayi', severity: 'critical' }, 'turn-urgent')).toEqual({ status: 'queued' });
    expect(deps.urgentCommand).toHaveBeenCalledWith(ctx, { said: 'Gir gayi', severity: 'critical' }, 'turn-urgent');
  });
  it('reads the open incident and genuine ETA', async () => {
    const { ports } = fixture();
    expect(await ports.execute('check_status', ctx, {}, 'turn-status')).toMatchObject({ status: 'accepted', eta_minutes: 4 });
  });
  it('sends a labeled transcript, never a voice recording', async () => {
    const { deps, ports } = fixture();
    await ports.execute('leave_message', ctx, { transcript: 'Riya ghar aa jao' }, 'turn-message');
    expect(deps.sendTranscript).toHaveBeenCalledWith(ctx, 'Riya ghar aa jao', "AI transcript of Maa's words", 'turn-message');
  });
  it('reuses the Core 2 truth service', async () => {
    const { deps, ports } = fixture();
    expect(await ports.execute('child_status', ctx, {}, 'turn-truth')).toEqual({ status: 'safe' });
    expect(deps.truthLine).toHaveBeenCalledWith(ctx, {});
  });
  it('asks Shield to check Riya without confirming or denying the claim', async () => {
    const { deps, ports } = fixture();
    expect(await ports.execute('child_scam_check', ctx, { asked_for: 'paise' }, 'turn-scam')).toMatchObject({ status: 'checking' });
    expect(deps.familyCheck).toHaveBeenCalledWith(ctx, { claimed_name: 'Riya', asked_for: 'paise' }, 'turn-scam');
  });
  it.each(['record_consent', 'reschedule', 'mark_private', 'cancel_permission'] as const)('calls matching %s command', async tool => {
    const { deps, ports } = fixture();
    const input = { call_id: id };
    await ports.execute(tool, ctx, input, 'turn-command');
    const method = { record_consent: deps.recordConsent, reschedule: deps.reschedule, mark_private: deps.markPrivate, cancel_permission: deps.cancelPermission }[tool];
    expect(method).toHaveBeenCalledWith(ctx, input, 'turn-command');
    expect(deps.audit).toHaveBeenCalled();
  });
  it('reconciles an absolute spoken count with the inventory domain', async () => {
    const { deps, ports } = fixture();
    expect(await ports.execute('medicine_count', ctx, { medicine_id: id, count: 6 }, 'turn-count')).toEqual({ status: 'saved', remaining_count: 6, refill_proposed: false });
    expect(deps.setMedicineCount).toHaveBeenCalledWith(ctx, id, 6, 'turn-count');
    expect(deps.proposeRefill).not.toHaveBeenCalled();
  });
  it.each([0, 3])('uses the existing gated refill path at low stock %s', async count => {
    const { deps, ports } = fixture();
    expect(await ports.execute('medicine_count', ctx, { medicine_id: id, count, vendor_id: id }, 'turn-low')).toMatchObject({ remaining_count: count, refill_proposed: true });
    expect(deps.proposeRefill).toHaveBeenCalledWith(ctx, id, id, 'turn-low');
  });
  it('refuses another parent’s medicine before mutating it', async () => {
    const { deps, ports } = fixture();
    vi.mocked(deps.getMedicine).mockResolvedValue({ id, familyId: ctx.familyId, personId: id, label: 'Dawa', remainingCount: 12, refillThreshold: 3, instructionsConfirmedByPerson: true, unitDose: 1, packSize: 10 });
    await expect(ports.execute('medicine_count', ctx, { medicine_id: id, count: 6 }, 'turn-count')).rejects.toThrow();
    expect(deps.setMedicineCount).not.toHaveBeenCalled();
  });
  it('does not bypass the refill gate if it fails', async () => {
    const { deps, ports } = fixture(); vi.mocked(deps.proposeRefill).mockRejectedValue(new Error('gate unavailable'));
    await expect(ports.execute('medicine_count', ctx, { medicine_id: id, count: 2, vendor_id: id }, 'turn-low')).rejects.toThrow();
  });
  it.each(['accept_incident', 'decline_incident'] as const)('queues %s through existing proof-aware command', async tool => {
    const { deps, ports } = fixture();
    await ports.execute(tool, ctx, {}, 'turn-responder');
    expect(deps.responderCommand).toHaveBeenCalledWith(tool, ctx, {}, 'turn-responder');
  });
});
