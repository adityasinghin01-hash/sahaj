import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCore2, newCore2Key } from '../lib/core2';
const id = '10000000-0000-4000-8000-000000000001';
const session = { url: 'https://synthetic.example', token: 'test.token.signature', familyId: id };
afterEach(() => vi.unstubAllGlobals());
describe('Core 2 transport contract', () => {
  it('sends bearer and family on bounded reads, without a write key', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ watches: [], next_cursor: null })));
    vi.stubGlobal('fetch', fetcher);
    await createCore2(session).watches({ limit: 50, cursor: 'time+id' });
    expect(fetcher.mock.calls[0]![0]).toBe(
      'https://synthetic.example/api/core2/watches?limit=50&cursor=time%2Bid'
    );
    expect(fetcher.mock.calls[0]![1].headers).toEqual({
      Authorization: 'Bearer test.token.signature',
      'X-Sahaj-Family-Id': id,
    });
  });
  it('keeps the exact key and payload when retrying a lost response', async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new Error('lost'))
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            sos: {
              id,
              version: 1,
              status: 'queued',
              responder_accepted: false,
              delivery_status: 'queued',
            },
          })
        )
      );
    vi.stubGlobal('fetch', fetcher);
    const api = createCore2(session),
      key = newCore2Key(),
      body = { countdown_seconds: 10 };
    await expect(api.startSos(body, key)).rejects.toThrow();
    await api.startSos(body, key);
    const [firstUrl, { signal: _firstSignal, ...first }] = fetcher.mock.calls[0]!;
    const [retryUrl, { signal: _retrySignal, ...retry }] = fetcher.mock.calls[1]!;
    expect([firstUrl, first]).toEqual([retryUrl, retry]);
    expect(fetcher.mock.calls[1]![1].headers['Idempotency-Key']).toBe(key);
  });
  it.each([401, 403, 409, 503])(
    'surfaces HTTP %i without success or demo fallback',
    async (status) => {
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValue(
            new Response(JSON.stringify({ error: 'storage_unavailable' }), { status })
          )
      );
      await expect(createCore2(session).watches()).rejects.toMatchObject({
        status,
        code: 'storage_unavailable',
      });
    }
  );
  it('rejects unreadable and malformed success responses', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response('bad'))
      .mockResolvedValueOnce(new Response('{}'));
    vi.stubGlobal('fetch', fetcher);
    await expect(createCore2(session).watches()).rejects.toThrow();
    await expect(createCore2(session).sos(id)).rejects.toThrow();
  });
  it('rejects invalid bounds, unknown body fields and missing idempotency before fetch', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const api = createCore2(session);
    await expect(api.watches({ limit: 51 })).rejects.toThrow();
    await expect(
      api.startWatch(
        {
          eta_minutes: 30,
          timezone: 'Asia/Kolkata',
          from_label: 'Office',
          to_label: 'Home',
          familyId: id,
        } as any,
        'key'
      )
    ).rejects.toThrow();
    await expect(api.startSos({}, '')).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('all Core 2 routes', () => {
  const at = '2026-11-15T00:00:00.000Z';
  const sos = {
    id,
    version: 2,
    status: 'safe',
    responder_accepted: false,
    delivery_status: 'none',
  };
  const watch = {
    id,
    version: 2,
    state: 'safe',
    deadline_at: at,
    grace_until: at,
    timezone: 'Asia/Kolkata',
  };
  const contact = {
    id,
    subject_person_id: id,
    contact_person_id: id,
    display_name: 'Synthetic contact',
    rank: 1,
    scopes: ['sos'],
    state: 'active',
    effective_from: at,
    effective_until: null,
    revoked_at: null,
    version: 2,
  };
  const preferences = {
    share_status_with_parent: true,
    allow_location_share: false,
    allow_health_share: false,
    allow_narrative_share: false,
  };
  const reassurance = { id, kind: 'im_safe', status: 'queued', delivery_verified: false };
  const cases: [
    string,
    string,
    (api: ReturnType<typeof createCore2>) => Promise<unknown>,
    unknown,
  ][] = [
    ['GET', 'sos?limit=20', (a) => a.sosList({ limit: 20 }), { sos: [] }],
    ['GET', `sos/${id}`, (a) => a.sos(id), { sos }],
    ['POST', 'sos', (a) => a.startSos({ countdown_seconds: 10 }, 'key'), { sos }],
    [
      'POST',
      `sos/${id}/cancel`,
      (a) => a.cancelSos(id, { reason: 'im_safe', expected_version: 1 }, 'key'),
      { sos },
    ],
    ['GET', 'watches', (a) => a.watches(), { watches: [] }],
    ['GET', `watches/${id}`, (a) => a.watch(id), { watch }],
    [
      'POST',
      'watches',
      (a) =>
        a.startWatch(
          { eta_minutes: 30, timezone: 'Asia/Kolkata', from_label: 'Office', to_label: 'Home' },
          'key'
        ),
      { watch },
    ],
    [
      'POST',
      `watches/${id}/extend`,
      (a) => a.extendWatch(id, { add_minutes: 15, expected_version: 1 }, 'key'),
      { watch },
    ],
    [
      'POST',
      `watches/${id}/cancel`,
      (a) => a.cancelWatch(id, { expected_version: 1 }, 'key'),
      { watch },
    ],
    [
      'POST',
      `watches/${id}/safe`,
      (a) => a.safeWatch(id, { expected_version: 1 }, 'key'),
      { watch },
    ],
    ['GET', 'trusted-contacts', (a) => a.contacts(), { contacts: [] }],
    [
      'POST',
      'trusted-contacts',
      (a) => a.inviteContact({ contact_person_id: id, rank: 1, scopes: ['sos'] }, 'key'),
      { contact },
    ],
    [
      'PATCH',
      `trusted-contacts/${id}`,
      (a) =>
        a.updateContact(id, { rank: 2, scopes: ['watch_escalation'], expected_version: 1 }, 'key'),
      { contact },
    ],
    ['POST', `trusted-contacts/${id}/approve`, (a) => a.approveContact(id, {}, 'key'), { contact }],
    [
      'POST',
      `trusted-contacts/${id}/revoke`,
      (a) => a.revokeContact(id, { expected_version: 1 }, 'key'),
      { contact },
    ],
    ['GET', 'reassurance', (a) => a.reassurance(), { reassurance: [] }],
    [
      'POST',
      'reassurance',
      (a) => a.sendReassurance({ kind: 'im_safe', recipient_person_ids: [id] }, 'key'),
      { reassurance },
    ],
    ['GET', 'reassurance/preferences', (a) => a.preferences(), { preferences }],
    [
      'PUT',
      'reassurance/preferences',
      (a) => a.savePreferences(preferences, 'key'),
      { preferences },
    ],
  ];
  it.each(cases)('%s %s', async (method, path, invoke, response) => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(response)));
    vi.stubGlobal('fetch', fetcher);
    await invoke(createCore2(session));
    expect(fetcher.mock.calls[0]![0]).toBe(`https://synthetic.example/api/core2/${path}`);
    const options = fetcher.mock.calls[0]![1];
    expect(options.method).toBe(method);
    expect(options.headers.Authorization).toBe('Bearer test.token.signature');
    expect(options.headers['X-Sahaj-Family-Id']).toBe(id);
    expect(options.headers['Idempotency-Key']).toBe(method === 'GET' ? undefined : 'key');
    if (method !== 'GET') {
      const body = JSON.parse(options.body);
      expect(body).not.toHaveProperty('family_id');
      expect(body).not.toHaveProperty('actorId');
      expect(body).not.toHaveProperty('approved');
    }
  });
});

it('normalizes the bare safe watch DTO described in section 2.2', async () => {
  const at = '2026-11-15T00:00:00.000Z';
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            id,
            version: 1,
            state: 'active',
            deadline_at: at,
            grace_until: at,
            timezone: 'Asia/Kolkata',
          })
        )
      )
  );
  expect(
    (
      await createCore2(session).startWatch(
        { eta_minutes: 30, timezone: 'Asia/Kolkata', from_label: 'Office', to_label: 'Home' },
        'bare-watch'
      )
    ).watch.state
  ).toBe('active');
});
