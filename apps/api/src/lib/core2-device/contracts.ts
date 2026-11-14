import type { Core2Deps, EnqueueOutboxRequest, Core2TimelineAppendInput } from '../core2/contracts';

export interface DeviceInput {
  battery_level: number | null;
  is_charging: boolean | null;
  sampled_at: string;
}
export interface DeviceState extends DeviceInput {
  family_id: string;
  person_id: string;
  heartbeat_at: string;
}
export interface Handover {
  id: string;
  family_id: string;
  person_id: string;
  watch_id: string | null;
  sos_id: string | null;
  request_id: string | null;
  reason: 'low_battery' | 'stale_heartbeat';
  last_seen_at: string;
  created_at: string;
}
export interface PreparedNotice {
  command: EnqueueOutboxRequest;
  recipient: string;
  statusLabel: string;
  parent: boolean;
}
export interface DeviceStore {
  get(familyId: string, personId: string): Promise<DeviceState | null>;
  report(input: { familyId: string; personId: string; keyHash: string; requestHash: string; status: DeviceInput; rawEventId: string }): Promise<{ device_status: DeviceState; idempotent_replay: boolean }>;
  /** Includes never-seen phones, using watch creation as their initial heartbeat. */
  due(staleMs: number, familyId?: string, personId?: string): Promise<Handover[]>;
  /** Atomic: locks watch/contact, appends signed timeline, enqueues, then completes work. */
  complete(job: Handover, timeline: Core2TimelineAppendInput, notices: PreparedNotice[]): Promise<void>;
}
export type DeviceDeps = Core2Deps & { devices: DeviceStore; timerScale?: number };
