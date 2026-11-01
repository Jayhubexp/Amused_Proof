// Port-free end-to-end smoke test: drives the REAL Express app + MemoryStore by
// invoking the app as a (req, res) function with mock objects — no sockets, so
// it runs anywhere (restricted sandboxes, minimal CI). Covers organizer
// bootstrap → login → election → lifecycle → invitations → validate → audit,
// plus auth failure paths. Usage: node scripts/smoke.mjs (exit 0 = pass).

// Env must be set before the app modules below are imported (config is static).
process.env.ORGANIZER_SETUP_TOKEN = 'smoke-setup-token';

const { createApp } = await import('../src/app.js');
const { MemoryStore } = await import('../src/store/memory.js');
const { call, clearCookies } = await import('./mock-http.mjs');

const CANDIDATES = [{ name: 'Smoke Alice' }, { name: 'Smoke Bob' }];
let step = '';

function fail(message) {
  throw new Error(`SMOKE FAIL [${step}]: ${message}`);
}

function expectStatus(res, want) {
  if (res.statusCode !== want) {
    fail(`expected ${want}, got ${res.statusCode} — ${res.bodyText().slice(0, 200)}`);
  }
}

const app = createApp(new MemoryStore(), { aiClient: null });

step = 'health';
{
  const res = await call(app, { method: 'GET', url: '/api/health' });
  expectStatus(res, 200);
  if (res.parsedBody()?.store !== 'memory') fail('expected memory store mode');
}

step = 'setup rejects bad token';
{
  const res = await call(app, {
    method: 'POST',
    url: '/api/organizer/setup',
    body: { token: 'wrong', username: 'organizer-1', password: 'fictional-demo-pass-01' },
  });
  expectStatus(res, 403);
}

step = 'setup accepts valid token once';
{
  const first = await call(app, {
    method: 'POST',
    url: '/api/organizer/setup',
    body: { token: 'smoke-setup-token', username: 'organizer-1', password: 'fictional-demo-pass-01' },
  });
  expectStatus(first, 201);
  const second = await call(app, {
    method: 'POST',
    url: '/api/organizer/setup',
    body: { token: 'smoke-setup-token', username: 'organizer-2', password: 'fictional-demo-pass-02' },
  });
  expectStatus(second, 403);
}

step = 'login rejects bad password';
{
  const res = await call(app, {
    method: 'POST',
    url: '/api/organizer/login',
    body: { username: 'organizer-1', password: 'wrong password!!' },
  });
  expectStatus(res, 401);
}

let csrf = '';
step = 'login succeeds and sets cookie';
{
  const res = await call(app, {
    method: 'POST',
    url: '/api/organizer/login',
    body: { username: 'organizer-1', password: 'fictional-demo-pass-01' },
  });
  expectStatus(res, 200);
  csrf = res.parsedBody()?.csrfToken;
  if (!csrf) fail('missing csrfToken');
}

const authed = () => ({ headers: { 'x-csrf-token': csrf } });

step = 'unauthenticated organizer read rejected';
{
  clearCookies();
  const res = await call(app, { method: 'GET', url: '/api/organizer/elections' });
  expectStatus(res, 401);
  const relogin = await call(app, {
    method: 'POST',
    url: '/api/organizer/login',
    body: { username: 'organizer-1', password: 'fictional-demo-pass-01' },
  });
  expectStatus(relogin, 200);
  csrf = relogin.parsedBody().csrfToken;
}

step = 'create election requires voting mode';
{
  const res = await call(app, {
    method: 'POST',
    url: '/api/organizer/elections',
    body: { title: 'Smoke Election', candidates: CANDIDATES },
    ...authed(),
  });
  expectStatus(res, 400);
}

let electionId = '';
step = 'create + lifecycle + invitations';
{
  const created = await call(app, {
    method: 'POST',
    url: '/api/organizer/elections',
    body: { title: 'Smoke Election', candidates: CANDIDATES, votingMode: 'anonymous' },
    ...authed(),
  });
  expectStatus(created, 201);
  electionId = created.parsedBody().election.id;

  const skip = await call(app, {
    method: 'POST',
    url: `/api/organizer/elections/${electionId}/start-voting`,
    body: {},
    ...authed(),
  });
  expectStatus(skip, 409); // cannot skip enrolment/freeze

  expectStatus(
    await call(app, {
      method: 'POST',
      url: `/api/organizer/elections/${electionId}/start-enrolment`,
      body: {},
      ...authed(),
    }),
    200,
  );

  const invited = await call(app, {
    method: 'POST',
    url: `/api/organizer/elections/${electionId}/invitations`,
    body: { count: 2, expiresInHours: 24, label: 'smoke' },
    ...authed(),
  });
  expectStatus(invited, 201);
  const [firstInvite] = invited.parsedBody().invitations;
  if (!firstInvite?.token) fail('missing invitation token');

  const listed = await call(app, { method: 'GET', url: `/api/organizer/elections/${electionId}/invitations` });
  expectStatus(listed, 200);
  if (JSON.stringify(listed.parsedBody()).includes(firstInvite.token)) fail('plaintext token leaked in list');

  const valid = await call(app, {
    method: 'POST',
    url: '/api/invitations/validate',
    body: { invitationToken: firstInvite.token },
  });
  expectStatus(valid, 200);
  if (valid.parsedBody()?.valid !== true) fail('fresh invitation should validate');
}

step = 'public reads + audit trail';
{
  const elections = await call(app, { method: 'GET', url: '/api/elections' });
  expectStatus(elections, 200);
  if (!elections.parsedBody().elections.some((e) => e.id === electionId)) fail('election missing from public list');

  const audit = await call(app, { method: 'GET', url: `/api/audit?electionId=${electionId}&limit=50` });
  expectStatus(audit, 200);
  if (!audit.parsedBody().events.length) fail('expected audit events');
}

step = 'unknown route is JSON 404';
{
  const res = await call(app, { method: 'GET', url: '/api/nope' });
  expectStatus(res, 404);
}

console.log('SMOKE PASS: organizer bootstrap → election → lifecycle → invitations → audit (+ failure paths).');
