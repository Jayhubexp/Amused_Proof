// Port-free end-to-end smoke test: drives the REAL Express app + MemoryStore by
// invoking the app as a (req, res) function with mock objects — no sockets, so
// it runs anywhere (restricted sandboxes, minimal CI). Covers organizer
// bootstrap → login → election → lifecycle → invitations → validate → audit,
// plus auth failure paths. Usage: node scripts/smoke.mjs (exit 0 = pass).
import { Readable } from 'node:stream';

// Env must be set before the app modules below are imported (config is static).
process.env.ORGANIZER_SETUP_TOKEN = 'smoke-setup-token';

const { createApp } = await import('../src/app.js');
const { MemoryStore } = await import('../src/store/memory.js');

const CANDIDATES = [{ name: 'Smoke Alice' }, { name: 'Smoke Bob' }];
const jar = new Map(); // cookie jar: name -> value
let step = '';

function fail(message) {
  throw new Error(`SMOKE FAIL [${step}]: ${message}`);
}

function mockReq({ method, url, body, headers = {} }) {
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
  const req = new Readable({
    read() {
      if (payload) this.push(payload);
      this.push(null);
    },
  });
  // Express re-prototypes req/res, shadowing class methods — so the methods
  // middleware needs (stream reading, header access, events) must be OWN
  // properties bound here.
  for (const m of ['on', 'once', 'removeListener', 'emit', 'read', 'resume', 'pause', 'unshift']) {
    req[m] = req[m].bind(req);
  }
  // Express re-prototypes req under http.IncomingMessage, whose _destroy calls
  // socket.destroy(). The mock owns a trivial teardown instead.
  req._destroy = (err, cb) => cb(err);
  const cookies = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  return Object.assign(req, {
    method,
    url,
    readable: true,
    complete: false,
    headers: {
      ...(payload ? { 'content-type': 'application/json', 'content-length': String(payload.length) } : {}),
      ...(cookies ? { cookie: cookies } : {}),
      ...headers,
    },
    socket: { remoteAddress: '127.0.0.1', encrypted: false },
  });
}

function mockResFactory(onFinish) {
  const res = {
    statusCode: 200,
    headers: {},
    chunks: [],
    finished: false,
    writableEnded: false,
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    getHeader(name) {
      return this.headers[name.toLowerCase()];
    },
    getHeaderNames() {
      return Object.keys(this.headers);
    },
    hasHeader(name) {
      return name.toLowerCase() in this.headers;
    },
    removeHeader(name) {
      delete this.headers[name.toLowerCase()];
    },
    write(chunk) {
      if (typeof chunk === 'string' || Buffer.isBuffer(chunk)) this.chunks.push(Buffer.from(chunk));
      return true;
    },
    end(chunk, encoding, callback) {
      const done = [chunk, encoding, callback].find((a) => typeof a === 'function');
      if (typeof chunk === 'string' || Buffer.isBuffer(chunk)) this.chunks.push(Buffer.from(chunk));
      this.finished = true;
      this.writableEnded = true;
      if (done) done();
      onFinish();
      return this;
    },
    bodyText() {
      return Buffer.concat(this.chunks).toString('utf8');
    },
    // NOTE: named parsedBody (not json) — Express re-prototypes res, so an
    // own `json` would shadow the real res.json and swallow every response.
    parsedBody() {
      try {
        return JSON.parse(this.bodyText());
      } catch {
        return null;
      }
    },
  };
  return res;
}

function collectCookies(res) {
  const setCookie = res.getHeader('set-cookie');
  const lines = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  for (const line of lines) {
    const [pair] = String(line).split(';');
    const eq = pair.indexOf('=');
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}

function call(app, opts) {
  return new Promise((resolve, reject) => {
    const res = mockResFactory(() => {
      collectCookies(res);
      resolve(res);
    });
    try {
      app(mockReq(opts), res, (err) => reject(err ?? new Error('unhandled request (fell through Express stack)')));
    } catch (err) {
      reject(err);
    }
  });
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
  if (![...jar.keys()].some((k) => k === 'cp_org')) fail('missing cp_org cookie');
}

const authed = () => ({ headers: { 'x-csrf-token': csrf } });

step = 'unauthenticated organizer read rejected';
{
  jar.clear();
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
