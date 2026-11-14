import { afterEach, expect, it, vi } from 'vitest';
import { decryptWebhook } from '../src/lib/webhook-security';
const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../src/lib/database', () => ({ serviceDatabase: () => ({ rpc }) }));
import { eventStore } from '../src/lib/event-store';

const key = 'ab'.repeat(32);
const event = { source: 'whatsapp', id: 'synthetic-event', type: 'message', familyId: 'synthetic-family', personId: 'synthetic-parent-a', payload: { text: 'Synthetic greeting' } };
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
function setup() {
  vi.stubEnv('WEBHOOK_ENCRYPTION_KEY', key);
  vi.stubEnv('IDENTITY_HASH_SECRET', 'synthetic-secret-'.repeat(4));
  rpc.mockResolvedValue({ error: null });
  return eventStore();
}
it('binds resolved person in encrypted envelope and hash despite conflicting payload field', async () => {
  const store = setup();
  await store.ingest({ ...event, payload: { ...event.payload, person_id: 'untrusted' } });
  const args = rpc.mock.calls[0][1];
  const plaintext = JSON.parse(decryptWebhook(args.p_payload_ciphertext, key, `${event.source}:${event.id}`).toString());
  expect(plaintext.person_id).toBe(event.personId);
  expect(args.p_metadata).toEqual({ person_id: event.personId });
  expect(() => decryptWebhook(args.p_payload_ciphertext, key, 'wrong-context')).toThrow();
});
it('changes durable hash after reassignment to another person in the same family', async () => {
  const store = setup();
  await store.ingest(event);
  await store.ingest({ ...event, personId: 'synthetic-parent-b' });
  expect(rpc.mock.calls[0][1].p_payload_hash).not.toBe(rpc.mock.calls[1][1].p_payload_hash);
});
it('reports durable duplicate conflicts without leaking database errors', async () => {
  const store = setup();
  rpc.mockResolvedValue({ error: { code: '23505', message: 'synthetic-private-error' } });
  await expect(store.ingest(event)).rejects.toMatchObject({ message: 'event_id_conflict', status: 409 });
});
