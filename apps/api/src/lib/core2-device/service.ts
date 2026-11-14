import { randomUUID } from 'node:crypto';
import { Core2Error, type Core2DispatchPort, type TrustedContactRow } from '../core2/contracts';
import { authenticateCore2Actor, assertPlainObject, assertBoundedInt, assertBoolean, parseIdempotencyKey, sha256Hex, hashCanonicalRequest } from '../core2/security';
import type { DeviceDeps, DeviceInput, Handover, PreparedNotice } from './contracts';

type Auth = { bearerToken: string | null; familyIdHeader: string | null; idempotencyKeyHeader: string | null };
export function parseDeviceInput(raw: unknown): DeviceInput {
  const body = assertPlainObject(raw, ['battery_level', 'is_charging', 'sampled_at']);
  if (typeof body.sampled_at !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(body.sampled_at) || !Number.isFinite(Date.parse(body.sampled_at)))
    throw new Core2Error('invalid_request', 400, 'sampled_at must be a UTC timestamp.');
  return {
    battery_level: body.battery_level === null ? null : assertBoundedInt(body.battery_level, 'battery_level', 0, 100),
    is_charging: body.is_charging === null ? null : assertBoolean(body.is_charging, 'is_charging'),
    sampled_at: body.sampled_at,
  };
}
export function createDeviceService(deps: DeviceDeps) {
  const now = deps.now ?? (() => new Date());
  const scale = deps.timerScale ?? 1;
  if (!Number.isFinite(scale) || scale <= 0) throw new Core2Error('unavailable', 503, 'Invalid demo timer scale.');
  const actor = (auth: Auth) => authenticateCore2Actor(deps.auth, deps.repo, auth.bearerToken, auth.familyIdHeader);

  async function handover(job: Handover) {
    const at = now().toISOString();
    const scope = job.sos_id ? 'sos' : 'watch_escalation';
    const contacts = await deps.repo.listActiveTrustedContacts(job.family_id, job.person_id, scope, at);
    const top = contacts.filter((c) => c.state === 'active' && c.approvedAt && c.consentAt && c.consentId && !c.revokedAt && Date.parse(c.effectiveFrom) <= Date.parse(at) && (!c.effectiveUntil || Date.parse(c.effectiveUntil) > Date.parse(at)))
      .sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id))[0];
    const notices: PreparedNotice[] = [];
    // Buffer the existing typed outbox port; the SQL commit persists all commands atomically.
    const buffer: Core2DispatchPort = { async enqueueAuthorized(command) {
      notices.push({ command, recipient: '', statusLabel: '', parent: false });
      return { outboxId: randomUUID(), status: 'pending' };
    } };
    const subject = await deps.repo.getPerson(job.family_id, job.person_id);
    const name = subject?.displayName ?? 'Riya';
    const age = Math.max(0, Math.floor((now().getTime() - Date.parse(job.last_seen_at)) / 60000));
    async function prepare(recipient: string, line: string, parent: boolean, contact?: TrustedContactRow) {
      const gate = await deps.repo.loadGateInput({ familyId: job.family_id, actorPersonId: job.person_id,
        requestId: job.request_id ?? job.id, action: parent ? 'share_data' : 'urgent_responder',
        targetId: recipient, ...(parent ? { consentSubjectId: job.person_id } : {}), now: at });
      const decision = await deps.gate.evaluate(gate);
      if (decision.decision !== 'allow') return;
      const dedupeKey = `core2:device:${job.id}:${recipient}`;
      const payload = { kind: parent ? 'core2.reassurance' : 'core2.device_handover',
        recipient_person_id: recipient, subject_person_id: job.person_id, status_label: line,
        location_included: false, health_included: false, narrative_included: false };
      const encrypted = deps.crypto.encryptPayload(job.family_id, dedupeKey, 'core2-outbox', payload);
      await buffer.enqueueAuthorized({ familyId: job.family_id, actionRequestId: null, kind: payload.kind,
        dedupeKey, payloadCiphertext: encrypted.payloadCiphertext, trustedContactId: contact?.id ?? null,
        watchId: job.watch_id, sosId: job.sos_id });
      Object.assign(notices[notices.length - 1], { recipient, statusLabel: line, parent });
    }
    if (top) {
      await prepare(top.contactPersonId,
        job.reason === 'low_battery'
          ? `${name} ka phone band hone wala hai — last update ${age} min pehle: ${job.watch_id ? 'raste mein' : 'sampark ka anurodh'}`
          : `${name} ke phone se naya update nahi aaya — last update ${age} min pehle: raste mein`, false, top);
    }
    const prefs = await deps.repo.getSharingPreferences(job.family_id, job.person_id);
    if (prefs.shareStatusWithParent) {
      const parents = await deps.repo.listPeopleByRole(job.family_id, 'parent');
      // Queued contact work is not proof that somebody has accepted or made contact.
      const line = job.reason === 'low_battery'
        ? `${name} ka phone charge kam hai; ${notices.length ? 'bharosemand saathi ko sampark ka sandesh bhejne ke liye rakha hai' : 'naye update ka intezar hai'}`
        : `${name} ke phone se naye update ka intezar hai`;
      for (const parent of parents) await prepare(parent.id, line, true);
    }
    await deps.devices.complete(job, {
      familyId: job.family_id, eventId: job.id, dedupeKey: `core2:device:${job.id}`, eventType: 'core2.device.handover',
      entityId: job.watch_id ?? job.sos_id, humanLine: 'Phone update handover recorded calmly.',
      occurredAt: new Date(job.created_at).toISOString(), payload: { reason: job.reason, location_included: false, notices_queued: notices.length },
    }, notices);
  }
  async function tick(familyId?: string, personId?: string) {
    const jobs = await deps.devices.due(180000 * scale, familyId, personId);
    for (const job of jobs) await handover(job);
    return { processed: jobs.length };
  }
  return {
    async get(auth: Auth) {
      const who = await actor(auth);
      return { device_status: await deps.devices.get(who.familyId, who.personId) };
    },
    async post(auth: Auth, raw: unknown) {
      const who = await actor(auth);
      const keyHash = sha256Hex(parseIdempotencyKey(auth.idempotencyKeyHeader));
      const status = parseDeviceInput(raw);
      if (Date.parse(status.sampled_at) > now().getTime() + 300000)
        throw new Core2Error('invalid_request', 400, 'sampled_at is in the future.');
      const requestHash = hashCanonicalRequest(status);
      const eventId = `device:${who.familyId}:${who.personId}:${keyHash}:${requestHash}`;
      const encrypted = deps.crypto.encryptPayload(who.familyId, eventId, 'core2', status as unknown as Record<string, unknown>);
      const rawEvent = await deps.repo.ingestRawEvent({ source: 'core2', providerEventId: eventId,
        eventType: 'core2.device.status', familyId: who.familyId, metadata: { actor_person_id: who.personId }, ...encrypted });
      const result = await deps.devices.report({ familyId: who.familyId, personId: who.personId, keyHash, requestHash, status, rawEventId: rawEvent.rawEventId });
      await tick(who.familyId, who.personId);
      return result;
    },
    tick,
  };
}
