/** Playwright tool runner: evaluate this async function against the local exported web build.
 * All server responses below are synthetic fixtures; this is not provider/DB acceptance.
 */
async (page) => {
  const base = 'http://127.0.0.1:8767';
  const id = '10000000-0000-4000-8000-000000000001';
  const at = '2026-11-15T20:00:00.000Z';
  const calls = [],
    checks = [];
  const state = {
    sos: null,
    watch: null,
    contacts: [],
    reassurance: [],
    preferences: {
      share_status_with_parent: true,
      allow_location_share: false,
      allow_health_share: false,
      allow_narrative_share: false,
    },
    loseSos: true,
    failWatches: false,
  };
  const check = (name, condition) => {
    if (!condition) throw new Error(name);
    checks.push(name);
  };
  const button = (name) => page.getByRole('button', { name, exact: true });
  const text = () => page.locator('body').innerText();
  await page.unrouteAll({ behavior: 'wait' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(base);
  await page.evaluate(
    ({ base }) =>
      localStorage.setItem(
        'sahaj.lab.session.v1',
        JSON.stringify({ url: base, token: 'test.token.signature' })
      ),
    { base }
  );
  await page.route('**/api/app/**', (route) =>
    route.fulfill({ status: 503, json: { error: 'not_under_test' } })
  );
  await page.route('**/api/core2/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace('/api/core2/', '');
    const method = request.method(),
      body = request.postDataJSON();
    calls.push({ path, method, body, headers: request.headers() });
    const ok = (data) => route.fulfill({ json: data, status: method === 'GET' ? 200 : 202 });
    if (method === 'GET') {
      if (path === 'sos') return ok({ sos: state.sos ? [state.sos] : [] });
      if (path.startsWith('sos/')) return ok({ sos: state.sos });
      if (path === 'watches')
        return state.failWatches
          ? route.fulfill({ status: 503, json: { error: 'storage_unavailable' } })
          : ok({ watches: state.watch ? [state.watch] : [] });
      if (path.startsWith('watches/')) return ok({ watch: state.watch });
      if (path === 'trusted-contacts') return ok({ contacts: state.contacts });
      if (path === 'reassurance') return ok({ reassurance: state.reassurance });
      if (path === 'reassurance/preferences') return ok({ preferences: state.preferences });
    }
    if (path === 'sos' && method === 'POST') {
      if (!state.sos)
        state.sos = {
          id,
          version: 1,
          status: 'queued',
          delivery_status: 'queued',
          responder_accepted: false,
          countdown_until: null,
        };
      if (state.loseSos) {
        state.loseSos = false;
        return route.abort('failed');
      }
      return ok({ sos: state.sos, idempotent_replay: true });
    }
    if (path === `sos/${id}/cancel`) {
      state.sos = {
        ...state.sos,
        version: state.sos.version + 1,
        status: body.reason === 'im_safe' ? 'safe' : 'cancelled',
        responder_accepted: false,
      };
      return ok({ sos: state.sos });
    }
    if (path === 'watches' && method === 'POST') {
      state.watch = {
        id,
        version: 1,
        state: 'active',
        deadline_at: at,
        grace_until: at,
        timezone: body.timezone,
      };
      return ok({ watch: state.watch });
    }
    if (path === `watches/${id}/extend`) {
      state.watch = {
        ...state.watch,
        version: state.watch.version + 1,
        deadline_at: '2026-11-15T20:15:00.000Z',
      };
      return ok({ watch: state.watch });
    }
    if (path === `watches/${id}/safe` || path === `watches/${id}/cancel`) {
      state.watch = {
        ...state.watch,
        version: state.watch.version + 1,
        state: path.endsWith('/safe') ? 'safe' : 'cancelled',
      };
      return ok({ watch: state.watch });
    }
    if (path === 'reassurance' && method === 'POST') {
      const row = {
        id,
        kind: body.kind,
        status: 'queued',
        delivery_verified: false,
        created_at: at,
      };
      state.reassurance = [row];
      return ok({ reassurance: row });
    }
    if (path === 'trusted-contacts' && method === 'POST') {
      const contact = {
        id,
        subject_person_id: id,
        contact_person_id: body.contact_person_id,
        display_name: 'Synthetic contact',
        rank: body.rank,
        scopes: body.scopes,
        state: 'invited',
        effective_from: at,
        effective_until: null,
        revoked_at: null,
        version: 1,
      };
      state.contacts = [contact];
      return ok({ contact });
    }
    if (path === `trusted-contacts/${id}/approve`)
      return route.fulfill({ status: 403, json: { error: 'forbidden' } });
    if (path === `trusted-contacts/${id}` && method === 'PATCH') {
      state.contacts[0] = { ...state.contacts[0], ...body, version: state.contacts[0].version + 1 };
      return ok({ contact: state.contacts[0] });
    }
    if (path === `trusted-contacts/${id}/revoke`) {
      state.contacts[0] = {
        ...state.contacts[0],
        state: 'revoked',
        revoked_at: at,
        version: state.contacts[0].version + 1,
      };
      return ok({ contact: state.contacts[0] });
    }
    if (path === 'reassurance/preferences' && method === 'PUT') {
      state.preferences = body;
      return ok({ preferences: body });
    }
    return route.fulfill({ status: 404, json: { error: 'unimplemented_fixture' } });
  });
  async function home() {
    await page.goto(base);
    await button('SOS').waitFor();
  }
  await home();
  await button('SOS').click();
  await button('Request SOS').waitFor();
  check(
    'live empty SOS has no synthetic contact',
    (await text()).includes('No records yet.') && !(await text()).includes('Priya')
  );
  await button('Request SOS').click();
  check('SOS needs confirmation before POST', !calls.some((c) => c.method === 'POST'));
  await button('Cancel').click();
  check('confirmation cancellation sends nothing', !calls.some((c) => c.method === 'POST'));
  await button('Request SOS').click();
  await button('Confirm SOS').click();
  await button('Retry').waitFor();
  check(
    'lost SOS response shows error without fake acceptance',
    (await text()).includes('Request failed.') && !(await text()).includes('is coming')
  );
  await button('Retry').click();
  await page.getByText('SOS requested · waiting for response', { exact: true }).waitFor();
  const sosWrites = calls.filter((c) => c.path === 'sos' && c.method === 'POST');
  check(
    'retry retains payload and idempotency key',
    sosWrites.length === 2 &&
      sosWrites[0].headers['idempotency-key'] === sosWrites[1].headers['idempotency-key'] &&
      JSON.stringify(sosWrites[0].body) === JSON.stringify(sosWrites[1].body)
  );
  check(
    'queued SOS does not imply responder acceptance',
    !(await text()).includes('A responder has accepted')
  );
  state.sos = { ...state.sos, version: 2, responder_accepted: true };
  await button('Refresh').last().click();
  await page.getByText('A responder has accepted your request.', { exact: true }).first().waitFor();
  check(
    'verified responder flag controls acceptance copy',
    (await text()).includes('A responder has accepted')
  );
  await button("I'm safe").click();
  await page.getByText('Safe · recorded by server', { exact: true }).first().waitFor();
  check(
    'SOS safe mutation binds server version',
    calls.some(
      (c) =>
        c.path.endsWith('/cancel') && c.body.reason === 'im_safe' && c.body.expected_version === 2
    )
  );
  await home();
  await button('Going home').click();
  await button('New watch').waitFor();
  await button('New watch').click();
  await page.getByLabel('From', { exact: true }).fill('Office');
  await page.getByLabel('Destination', { exact: true }).fill('Home');
  await button('Start watch').click();
  await button('+15 min').waitFor();
  check(
    'watch start sends destination and ETA without demo route',
    calls.some(
      (c) =>
        c.path === 'watches' &&
        c.method === 'POST' &&
        c.body.eta_minutes === 30 &&
        c.body.from_label === 'Office' &&
        c.body.to_label === 'Home'
    )
  );
  await button('+15 min').click();
  await page.getByText('Server record saved.', { exact: true }).waitFor();
  check(
    'watch extend sends 15 minutes and current version',
    calls.some(
      (c) =>
        c.path.endsWith('/extend') && c.body.add_minutes === 15 && c.body.expected_version === 1
    )
  );
  state.watch = { ...state.watch, state: 'checking_in', version: 3 };
  await button('Refresh').last().click();
  await page.getByText('Checking in', { exact: true }).waitFor();
  check('watch check-in state comes from server', (await text()).includes('Checking in'));
  await button("I'm safe").click();
  await page.getByText('Safe · recorded by server', { exact: true }).waitFor();
  check(
    'watch safe binds latest server version',
    calls.some((c) => c.path.endsWith('/safe') && c.body.expected_version === 3)
  );
  await home();
  await button('Going home').click();
  await page.getByRole('button', { name: /^Safe · recorded/ }).waitFor();
  await page.getByRole('button', { name: /^Safe · recorded/ }).click();
  await button('New watch').waitFor();
  await button('New watch').click();
  await page.getByLabel('From', { exact: true }).fill('Office');
  await page.getByLabel('Destination', { exact: true }).fill('Home');
  await button('Start watch').click();
  await button('+15 min').waitFor();
  await button('Cancel').click();
  await page.getByText('Cancelled', { exact: true }).waitFor();
  check('watch cancel displays confirmed terminal state', state.watch.state === 'cancelled');
  await home();
  await button("I'm safe · Maa's truth line").click();
  await page.getByLabel('Recipient person IDs (comma-separated UUIDs)', { exact: true }).fill(id);
  await button('Send update').click();
  await page.getByText('Queued · delivery pending', { exact: true }).waitFor();
  check(
    'reassurance stays queued without heard claim',
    (await text()).includes('Delivery unverified · hearing is not confirmed') &&
      !(await text()).includes('Maa heard')
  );
  check(
    'unavailable recording is explicitly explained',
    (await text()).includes('Voice recording upload is not connected')
  );
  state.reassurance[0] = { ...state.reassurance[0], status: 'delivered', delivery_verified: true };
  await button('Refresh').click();
  await page.getByText('Delivery verified · hearing is not confirmed', { exact: true }).waitFor();
  check(
    'verified delivery remains distinct from heard proof',
    (await text()).includes('Delivery verified · hearing is not confirmed')
  );
  await home();
  await button('Trusted contacts').click();
  await button('Invite a trusted contact').waitFor();
  await button('Invite a trusted contact').click();
  await page
    .getByLabel('Contact person ID (existing family member UUID)', { exact: true })
    .fill(id);
  await button('Invite a trusted contact').click();
  await page.getByText('Invited · not active', { exact: true }).waitFor();
  check('invitation does not silently activate contact', state.contacts[0].state === 'invited');
  await home();
  await button('Trusted contacts').click();
  await button('I am this contact · approve and consent').waitFor();
  await button('I am this contact · approve and consent').click();
  await button('Retry').waitFor();
  check(
    'contact approval denial is visible and stays invited',
    (await text()).includes('403: forbidden') && state.contacts[0].state === 'invited'
  );
  await button('Edit and try again').click();
  await page.getByLabel('Contact order (1–20)', { exact: true }).fill('2');
  await button('Save order and scopes').click();
  await page.getByLabel('Contact order (1–20)', { exact: true }).waitFor();
  await page.waitForFunction(() => document.body.innerText.includes('Synthetic contact'));
  check(
    'contact rank update uses PATCH and version',
    calls.some(
      (c) =>
        c.path === `trusted-contacts/${id}` &&
        c.method === 'PATCH' &&
        c.body.rank === 2 &&
        c.body.expected_version === 1
    )
  );
  await button('Revoke contact').click();
  await page.getByText('Revoked', { exact: true }).waitFor();
  check('revocation uses confirmed server state', state.contacts[0].state === 'revoked');
  await button('Sharing preferences').click();
  await button('Allow location sharing').waitFor();
  check(
    'private sharing defaults remain off',
    !state.preferences.allow_location_share &&
      !state.preferences.allow_health_share &&
      !state.preferences.allow_narrative_share
  );
  await button('Allow location sharing').click();
  await button('Save sharing preferences').click();
  await page.getByText('Server record saved.', { exact: true }).waitFor();
  check(
    'preference save uses PUT and complete booleans',
    calls.some(
      (c) =>
        c.path === 'reassurance/preferences' &&
        c.method === 'PUT' &&
        c.body.allow_location_share === true &&
        c.body.allow_health_share === false
    )
  );
  await button('हिन्दी').click();
  await button('साझा करने की अनुमति सुरक्षित करें').waitFor();
  check(
    'Hindi toggle translates new screen strings',
    (await text()).includes('जानकारी साझा करने की अनुमति')
  );
  await button('English').click();
  await page
    .getByLabel('Family ID (optional UUID; required for multiple families)', { exact: true })
    .last()
    .fill(id);
  await button('Use this family').click();
  await button('Save sharing preferences').waitFor();
  await button('Refresh').click();
  await button('Save sharing preferences').waitFor();
  check(
    'family choice is persisted and sent on reads',
    calls.some((c) => c.headers['x-sahaj-family-id'] === id) &&
      (await page.evaluate(
        () => JSON.parse(localStorage.getItem('sahaj.lab.session.v1')).familyId
      )) === id
  );
  await button('Use labelled demo').click();
  const before = calls.length;
  await page.waitForTimeout(200);
  check(
    'explicit demo is labelled and makes no Core 2 calls',
    (await text()).includes('Demo · synthetic data') && calls.length === before
  );
  await button('Use live server').click();
  await button('Save sharing preferences').waitFor();
  await home();
  state.failWatches = true;
  await button('Going home').click();
  await button('Retry').waitFor();
  check(
    '503 read error has Retry and no synthetic fallback',
    (await text()).includes('503: storage_unavailable') && !(await text()).includes('Koramangala')
  );
  state.failWatches = false;
  await button('Retry').click();
  await page.getByRole('button', { name: /^Cancelled/ }).waitFor();
  check('read retry recovers live records', (await text()).includes('Cancelled'));
  check(
    '390px viewport has no horizontal overflow',
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)
  );
  return { passed: checks.length, checks, requests: calls.length };
};
