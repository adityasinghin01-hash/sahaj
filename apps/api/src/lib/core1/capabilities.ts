/**
 * Access control and role/circle capability checking for Core 1 commands.
 *
 * Implements:
 * - Strict role restrictions
 * - Circle capability verification: depends on live circle record/permission, NOT role alone
 * - Missing or revoked circle records fail closed (Blocker 5 fix)
 */

import { Core1CommandError } from './errors';
import type { CommandType, FamilyMembership, CircleRecord } from './types';

export function assertCommandCapability(
  command: CommandType,
  membership: FamilyMembership,
  circleRecord: CircleRecord | null,
  targetPersonId?: string
): void {
  const role = membership.role;

  // 1. Adult child has broad management capability within own family
  if (role === 'child') {
    return;
  }

  // 2. Parent member can manage voice messages and self-actions
  if (role === 'parent') {
    if (command === 'voice_message') {
      return;
    }
    if (command === 'check_in' && (!targetPersonId || targetPersonId === membership.personId)) {
      return;
    }
    if (command === 'urgent_help') {
      return;
    }
    if (command === 'refill_proposal') {
      return;
    }
    throw new Core1CommandError(`parent_role_unauthorized_for_${command}`, 403);
  }

  // 3. Circle member capability MUST depend on live linked circle record (Blocker 5 fix)
  if (role === 'circle') {
    if (!circleRecord) {
      throw new Core1CommandError('circle_record_missing_fail_closed', 403);
    }

    if (!circleRecord.active) {
      throw new Core1CommandError('circle_member_inactive', 403);
    }

    if (circleRecord.revokedAt) {
      throw new Core1CommandError('circle_member_revoked', 403);
    }

    if (!circleRecord.consentAt) {
      throw new Core1CommandError('circle_member_missing_consent', 403);
    }

    // Active circle member is authorized for urgent help and voice messages
    if (command === 'urgent_help' || command === 'voice_message') {
      return;
    }

    throw new Core1CommandError(`circle_role_unauthorized_for_${command}`, 403);
  }

  // Unknown role fails closed
  throw new Core1CommandError('unrecognized_role_fail_closed', 403);
}
