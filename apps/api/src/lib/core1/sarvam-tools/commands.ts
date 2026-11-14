import { recordDoseEvent } from '../../../../../../packages/atlas/src/core1/medicine-inventory';
import type { MedicineRecord } from '../../../../../../packages/atlas/src/core1/types';
import { clockAt } from '../wiring-common';
import type { SarvamPorts, ToolContext, ToolInput, ToolName, ToolResult } from './handler';

type Command = (ctx: ToolContext, input: ToolInput, key: string) => Promise<void>;
export interface CommandDeps {
  assertParent(ctx: ToolContext): Promise<void>;
  runOnce(tool: ToolName, ctx: ToolContext, input: ToolInput, key: string, work: () => Promise<ToolResult>): Promise<ToolResult>;
  urgentCommand(ctx: ToolContext, input: ToolInput, key: string): Promise<ToolResult>;
  openIncident(ctx: ToolContext): Promise<ToolResult>;
  sendTranscript(ctx: ToolContext, transcript: string, label: string, key: string): Promise<void>;
  truthLine(ctx: ToolContext, input: ToolInput): Promise<ToolResult>;
  familyCheck(ctx: ToolContext, input: { claimed_name: string; asked_for: string }, key: string): Promise<ToolResult>;
  recordConsent: Command;
  reschedule: Command;
  markPrivate: Command;
  cancelPermission: Command;
  getMedicine(ctx: ToolContext, medicineId: string): Promise<MedicineRecord | null>;
  setMedicineCount(ctx: ToolContext, medicineId: string, count: number, key: string): Promise<void>;
  proposeRefill(ctx: ToolContext, medicineId: string, vendorId: string | undefined, key: string): Promise<void>;
  responderCommand(tool: 'accept_incident' | 'decline_incident', ctx: ToolContext, input: ToolInput, key: string): Promise<void>;
  audit(tool: ToolName, ctx: ToolContext, key: string): Promise<void>;
  now(): Date;
}

export function createCommandPorts(deps: CommandDeps): SarvamPorts {
  return {
    assertParent: deps.assertParent,
    execute(tool, ctx, input, key) {
      // Live reads must not cache an earlier "pending"/"safe" answer for the call.
      if (tool === 'check_status') return deps.openIncident(ctx).then(async result => { await deps.audit(tool, ctx, key); return result; });
      if (tool === 'child_status') return deps.truthLine(ctx, input);
      return deps.runOnce(tool, ctx, input, key, async () => {
        let result: ToolResult = { status: 'saved' };
        switch (tool) {
          case 'raise_urgent': result = await deps.urgentCommand(ctx, input, key); break;
          case 'leave_message': await deps.sendTranscript(ctx, String(input.transcript), "AI transcript of Maa's words", key); result = { status: 'queued' }; break;
          case 'child_scam_check': result = await deps.familyCheck(ctx, { claimed_name: 'Riya', asked_for: String(input.asked_for) }, key); break;
          case 'record_consent': await deps.recordConsent(ctx, input, key); break;
          case 'reschedule': await deps.reschedule(ctx, input, key); break;
          case 'mark_private': await deps.markPrivate(ctx, input, key); break;
          case 'cancel_permission': await deps.cancelPermission(ctx, input, key); break;
          case 'medicine_count': {
            const medicine = await deps.getMedicine(ctx, String(input.medicine_id));
            if (!medicine || medicine.familyId !== ctx.familyId || medicine.personId !== ctx.parentId) throw new Error('medicine_not_owned');
            const reconciled = recordDoseEvent({ medicine, input: { actionType: 'count_reconciliation', count: Number(input.count), timestamp: deps.now().toISOString() }, clock: clockAt(deps.now()) });
            await deps.setMedicineCount(ctx, medicine.id, reconciled.medicine.remainingCount, key);
            if (reconciled.isLowStock) await deps.proposeRefill(ctx, medicine.id, typeof input.vendor_id === 'string' ? input.vendor_id : undefined, key);
            result = { status: 'saved', remaining_count: reconciled.medicine.remainingCount, refill_proposed: reconciled.isLowStock };
            break;
          }
          case 'accept_incident':
          case 'decline_incident': await deps.responderCommand(tool, ctx, input, key); result = { status: 'queued' }; break;
        }
        await deps.audit(tool, ctx, key);
        return result;
      });
    },
  };
}
