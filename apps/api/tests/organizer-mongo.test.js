// Organizer + invitation + Semaphore flows against REAL MongoDB (in-memory
// replica set with WiredTiger, so multi-document transactions behave like
// Atlas; set MONGODB_TEST_URI to a scratch database to run against Atlas
// itself instead). Covers role escalation, unauthorized writes, invitation reuse,
// invalid passkeys, concurrent enrolment, anonymous proof validation,
// concurrent duplicate nullifiers, restart persistence, and cross-election
// isolation. NOTE: real proving keeps snark workers alive; the suite runs
// with --test-force-exit (see package.json).
import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import mongoose from 'mongoose';
import request from 'supertest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Identity } from '@semaphore-protocol/identity';
import { Group } from '@semaphore-protocol/group';
import { generateProof } from '@semaphore-protocol/proof';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { MongoStore } from '../src/store/mongo.js';
import { REQUIRED_UNIQUE_INDEXES, ensureMongoIndexes } from '../src/models/index.js';
import { demoOrganizers } from '../src/seed/fictional.js';
import { seedDemoOrganizers } from '../src/seed/demo-organizers.js';
import { configureRateLimitStore, memoryRateLimitStore, resetRateLimits } from '../src/lib/rate-limit.js';
import { MongoRateLimitStore } from '../src/lib/rate-limit-mongo.js';
import { RateLimitModel } from '../src/models/index.js';
import { commitmentMessage, electionScope } from '../src/zk/semaphore.js';

const SETUP_TOKEN = 'integration-test-setup-token';
const ORG_PASSWORD = 'correct horse battery staple 01';
const CANDIDATES = [{ name: 'Alice Aardvark' }, { name: 'Bob Badger' }];

// Well-formed but unissued token (matches inv_ + 48 hex).
const fakeToken = (ch) => `inv_${ch.repeat(48).slice(0, 48)}`;

let replset;
let mongoUri;
let store;
let app;

// Fake ceremony crypto with the same four-function shape as the
// SimpleWebAuthn binding; each registration mints a distinct credential id.
function fakeWebAuthn(overrides = {}) {
  let nextCred = 0;
  return {
    async generateRegistrationOptions(opts) {
      nextCred += 1;
      return {
        challenge: `mongo-fake-reg-${nextCred}-${Date.now()}`,
        rp: { name: opts.rpName, id: opts.rpID },
        user: { id: 'fake-user-id', name: opts.userName, displayName: opts.userDisplayName },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
        timeout: 60000,
        attestation: 'none',
      };
    },
    async verifyRegistrationResponse(args) {
      if (overrides.verifyRegistrationResponse) return overrides.verifyRegistrationResponse(args);
      return {
        verified: true,
        registrationInfo: {
          credential: {
            id: overrides.fixedCredentialId ?? `mongo-fake-cred-${nextCred}`,
            publicKey: new Uint8Array([9, 8, 7, 6]),
            counter: 0,
          },
          credentialType: 'public-key',
          userVerified: true,
          credentialDeviceType: 'singleDevice',
          credentialBackedUp: false,
        },
      };
    },
    async generateAuthenticationOptions(opts) {
      return {
        challenge: `mongo-fake-auth-${Date.now()}-${Math.random()}`,
        rpId: opts.rpID,
        allowCredentials: opts.allowCredentials,
        timeout: 60000,
        userVerification: 'required',
      };
    },
    async verifyAuthenticationResponse(args) {
      return {
        verified: true,
        authenticationInfo: {
          credentialID: args.response.id,
          newCounter: args.credential.counter + 1,
          userVerified: true,
          credentialDeviceType: 'singleDevice',
          credentialBackedUp: false,
        },
      };
    },
  };
}

before(async () => {
  config.organizerSetupToken = SETUP_TOKEN;
  // MONGODB_TEST_URI (optional): run this whole suite against a REAL external
  // MongoDB (e.g. Atlas) instead of the in-memory replica set. It MUST point
  // at a scratch database — every collection is wiped before each test, and
  // the database is dropped afterwards.
  if (process.env.MONGODB_TEST_URI) {
    mongoUri = process.env.MONGODB_TEST_URI;
    await MongoStore.connect(mongoUri);
  } else {
    replset = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
    mongoUri = replset.getUri('civicproof-test');
    await MongoStore.connect(mongoUri);
  }
  await ensureMongoIndexes(); // boot contract: required unique indexes verified
  store = new MongoStore();
  await store.ensureSeeded();
});

after(async () => {
  if (!replset && process.env.MONGODB_TEST_URI) {
    await mongoose.connection.db.dropDatabase().catch(() => {});
  }
  await MongoStore.disconnect().catch(() => {});
  await replset?.stop?.().catch(() => {});
});

beforeEach(async () => {
  resetRateLimits();
  for (const name of mongoose.modelNames()) {
    await mongoose.models[name].deleteMany({});
  }
  await store.ensureSeeded();
  app = createApp(store, { aiClient: null, webauthn: fakeWebAuthn() });
});

// -- helpers -----------------------------------------------------------------

async function setupOrganizer(username = 'organizer-1', password = ORG_PASSWORD, token = SETUP_TOKEN) {
  return request(app).post('/api/organizer/setup').send({ token, username, password });
}

async function loginOrganizer(username = 'organizer-1', password = ORG_PASSWORD) {
  const agent = request.agent(app);
  const res = await agent.post('/api/organizer/login').send({ username, password });
  assert.equal(res.status, 200);
  return { agent, csrfToken: res.body.csrfToken, setCookie: res.headers['set-cookie'] };
}

async function createElection(agent, csrf, overrides = {}) {
  const res = await agent
    .post('/api/organizer/elections')
    .set('x-csrf-token', csrf)
    .send({ title: 'Fictional Test Election', candidates: CANDIDATES, votingMode: 'anonymous', ...overrides });
  assert.equal(res.status, 201);
  return res.body.election;
}

async function openElection(agent, csrf, electionId) {
  const res = await agent.post(`/api/organizer/elections/${electionId}/open`).set('x-csrf-token', csrf).send();
  assert.equal(res.status, 200);
  return res.body.election;
}

async function transition(agent, csrf, electionId, action) {
  return agent.post(`/api/organizer/elections/${electionId}/${action}`).set('x-csrf-token', csrf).send();
}

async function castStandard(agent, csrf, { electionId, choice = 'choice-a' }) {
  const ballotCommitment = createHash('sha256').update(`${choice}:${csrf}:${electionId}`).digest('hex');
  return agent.post('/api/ballots').set('x-csrf-token', csrf).send({ electionId, ballotCommitment });
}

async function registerRoll({ voterRef, pin, electionId }) {
  const options = await request(app)
    .post('/api/webauthn/register/options')
    .send({ voterRef, pin, electionId });
  assert.equal(options.status, 201);
  const verify = await request(app)
    .post('/api/webauthn/register/verify')
    .send({ requestId: options.body.requestId, response: { id: 'attestation', response: {} } });
  assert.equal(verify.status, 201);
  return verify.body;
}

async function inviteVoters(agent, csrf, electionId, { count = 1, expiresInHours = 72, label = '' } = {}) {
  const res = await agent
    .post(`/api/organizer/elections/${electionId}/invitations`)
    .set('x-csrf-token', csrf)
    .send({ count, expiresInHours, label });
  assert.equal(res.status, 201);
  return res.body.invitations;
}

async function registerInvited({ token, electionId }) {
  const options = await request(app)
    .post('/api/webauthn/register/options')
    .send({ invitationToken: token, electionId });
  assert.equal(options.status, 201);
  const verify = await request(app)
    .post('/api/webauthn/register/verify')
    .send({ requestId: options.body.requestId, response: { id: 'attestation', response: {} } });
  assert.equal(verify.status, 201);
  return verify.body;
}

async function loginVoter({ voterRef, electionId }) {
  const agent = request.agent(app);
  const options = await agent.post('/api/webauthn/auth/options').send({ voterRef, electionId });
  assert.equal(options.status, 200);
  const [passkey] = await store.getPasskeysByVoter(voterRef, electionId);
  assert.ok(passkey, 'expected a persisted passkey for the voter');
  const verify = await agent
    .post('/api/webauthn/auth/verify')
    .send({ requestId: options.body.requestId, response: { id: passkey.id, response: {} } });
  assert.equal(verify.status, 200);
  return { agent, csrfToken: verify.body.csrfToken };
}

async function enrollVoter(agent, csrf, { electionId, commitment }) {
  return agent.post('/api/semaphore/enroll').set('x-csrf-token', csrf).send({ electionId, commitment });
}

function submitAnonymous(body) {
  // Deliberately NOT an agent: no cookies are stored or sent.
  return request(app).post('/api/ballots/anonymous').send(body);
}

// Full voter onboarding for one invitation: register passkey, authenticate,
// enrol a Semaphore commitment. Returns the client-side identity (private
// material never leaves this test process — mirroring the browser).
async function onboardVoter(invitation, electionId, seed) {
  const { voterRef } = await registerInvited({ token: invitation.token, electionId });
  const { agent, csrfToken } = await loginVoter({ voterRef, electionId });
  const identity = new Identity(seed);
  const enrolled = await enrollVoter(agent, csrfToken, {
    electionId,
    commitment: identity.commitment.toString(),
  });
  assert.equal(enrolled.status, 201);
  return { voterRef, identity };
}

async function freshElectionWithInvites(count = 1) {
  assert.equal((await setupOrganizer()).status, 201);
  const { agent, csrfToken } = await loginOrganizer();
  const election = await createElection(agent, csrfToken);
  await openElection(agent, csrfToken, election.id);
  const invitations = count > 0 ? await inviteVoters(agent, csrfToken, election.id, { count }) : [];
  return { agent, csrfToken, election, invitations };
}

// -- bootstrap & login --------------------------------------------------------

test('demo organizer seed enables README login on MongoDB', async () => {
  await seedDemoOrganizers(store);
  await seedDemoOrganizers(store); // reseed is idempotent
  for (const { username, password } of demoOrganizers) {
    const res = await request(app).post('/api/organizer/login').send({ username, password });
    assert.equal(res.status, 200);
    assert.ok(res.body.csrfToken);
  }
});

test('bootstrap creates the founding organizer exactly once', async () => {
  const first = await setupOrganizer();
  assert.equal(first.status, 201);
  assert.equal(first.body.username, 'organizer-1');
  assert.ok(!JSON.stringify(first.body).includes('password'));

  // Even the valid token is uniformly rejected after consumption.
  const second = await setupOrganizer('organizer-2');
  assert.equal(second.status, 403);
  assert.equal(second.body.error, 'Organizer setup is unavailable.');
  assert.equal(await store.getOrganizer('organizer-2'), null);
});

test('bootstrap rejects bad tokens uniformly and is rate-limited', async () => {
  const statuses = [];
  statuses.push((await setupOrganizer('org-a1', ORG_PASSWORD, 'wrong-token')).status);
  statuses.push((await setupOrganizer('org-a2', ORG_PASSWORD, 'wrong-token')).status);
  statuses.push((await setupOrganizer()).status); // valid token still works
  statuses.push((await setupOrganizer('org-a3')).status); // consumed
  statuses.push((await setupOrganizer('org-a4')).status); // consumed
  statuses.push((await setupOrganizer('org-a5')).status); // over the limit
  assert.deepEqual(statuses, [403, 403, 201, 403, 403, 429]);
  const bodies = await Promise.all(
    [1, 2].map(() => request(app).post('/api/organizer/setup').send({ token: 'x', username: 'u', password: ORG_PASSWORD })),
  );
  assert.ok(bodies.every((r) => r.status === 429)); // bucket stays exhausted
});

test('organizer login sets a hardened cookie; failures are uniform and rate-limited', async () => {
  assert.equal((await setupOrganizer()).status, 201);
  const { setCookie } = await loginOrganizer();
  const cookie = (setCookie ?? []).join(';');
  assert.match(cookie, /cp_org=/);
  assert.match(cookie, /httponly/i);
  assert.match(cookie, /samesite=lax/i);

  const wrong = await request(app).post('/api/organizer/login').send({ username: 'organizer-1', password: 'wrong password here!' });
  const unknown = await request(app).post('/api/organizer/login').send({ username: 'nobody-here', password: 'wrong password here!' });
  assert.equal(wrong.status, 401);
  assert.equal(unknown.status, 401);
  assert.equal(wrong.body.error, unknown.body.error); // no username oracle

  for (let i = 0; i < 7; i += 1) {
    await request(app).post('/api/organizer/login').send({ username: 'organizer-1', password: 'wrong password here!' });
  }
  const limited = await request(app).post('/api/organizer/login').send({ username: 'organizer-1', password: ORG_PASSWORD });
  assert.equal(limited.status, 429);
  assert.ok(limited.headers['retry-after']);
});

// -- authorization ------------------------------------------------------------

test('voter sessions cannot reach organizer APIs; organizer sessions cannot vote', async () => {
  const { agent: orgAgent, csrfToken: orgCsrf, election, invitations } = await freshElectionWithInvites(1);
  const { voterRef } = await registerInvited({ token: invitations[0].token, electionId: election.id });
  const { agent: voterAgent, csrfToken: voterCsrf } = await loginVoter({ voterRef, electionId: election.id });

  // Voter session on organizer routes: no cp_org cookie -> 401.
  assert.equal((await voterAgent.post('/api/organizer/elections').send({})).status, 401);
  assert.equal((await voterAgent.get('/api/organizer/elections')).status, 401);
  assert.equal(
    (await voterAgent.post(`/api/organizer/elections/${election.id}/invitations`).send({ count: 1 })).status,
    401,
  );

  // Organizer session id planted as a voter session cookie: rejected by role.
  const secondLogin = await request(app)
    .post('/api/organizer/login')
    .send({ username: 'organizer-1', password: ORG_PASSWORD });
  assert.equal(secondLogin.status, 200);
  const orgSessionId = /cp_org=([^;]+)/.exec((secondLogin.headers['set-cookie'] ?? []).join(';'))[1];
  const smuggled = request.agent(app);
  await smuggled.jar.setCookie(`cp_session=${orgSessionId}`);
  const smuggledEnroll = await smuggled
    .post('/api/semaphore/enroll')
    .set('x-csrf-token', secondLogin.body.csrfToken)
    .send({ electionId: election.id, commitment: '12345' });
  assert.equal(smuggledEnroll.status, 401);

  // Authenticated organizer mutations still require the CSRF token.
  const noCsrf = await orgAgent.post('/api/organizer/elections').send({ title: 'x', candidates: CANDIDATES });
  assert.equal(noCsrf.status, 403);

  // Fully unauthenticated election creation is rejected.
  const anon = await request(app)
    .post('/api/organizer/elections')
    .send({ title: 'Stolen election', candidates: CANDIDATES });
  assert.equal(anon.status, 401);
});

// -- elections ----------------------------------------------------------------

test('organizer draft lifecycle: create, edit, open, close, delete drafts only', async () => {
  assert.equal((await setupOrganizer()).status, 201);
  const { agent, csrfToken } = await loginOrganizer();
  const headers = { 'x-csrf-token': csrfToken };

  // Voting mode is required at creation.
  const noMode = await agent
    .post('/api/organizer/elections')
    .set(headers)
    .send({ title: 'No mode', candidates: CANDIDATES });
  assert.equal(noMode.status, 400);
  const badMode = await agent
    .post('/api/organizer/elections')
    .set(headers)
    .send({ title: 'Bad mode', candidates: CANDIDATES, votingMode: 'telepathic' });
  assert.equal(badMode.status, 400);

  const draft = await createElection(agent, csrfToken, { id: 'test-lifecycle-1' });
  assert.equal(draft.status, 'draft');
  assert.equal(draft.access, 'invitation'); // default for new elections
  assert.equal(draft.votingMode, 'anonymous');
  assert.deepEqual(draft.candidates.map((c) => c.name), ['Alice Aardvark', 'Bob Badger']);
  assert.ok(draft.candidates.every((c) => c.id));

  // Drafts are hidden from the public list but visible to organizers.
  const pub = await request(app).get('/api/elections');
  assert.ok(pub.body.elections.every((e) => e.id !== draft.id));
  const org = await agent.get('/api/organizer/elections');
  assert.ok(org.body.elections.some((e) => e.id === draft.id && e.stats));

  const patched = await agent
    .patch(`/api/organizer/elections/${draft.id}`)
    .set(headers)
    .send({ title: 'Renamed Election', candidates: [{ name: 'Solo Candidate' }, { name: 'Other Candidate' }] });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.election.title, 'Renamed Election');
  assert.equal(patched.body.election.candidates.length, 2);

  // Voting mode may change while drafting...
  const modeChange = await agent
    .patch(`/api/organizer/elections/${draft.id}`)
    .set(headers)
    .send({ votingMode: 'standard' });
  assert.equal(modeChange.status, 200);
  assert.equal(modeChange.body.election.votingMode, 'standard');

  await openElection(agent, csrfToken, draft.id);
  assert.equal((await agent.patch(`/api/organizer/elections/${draft.id}`).set(headers).send({ title: 'x' })).status, 409);
  // ...but is locked once the election leaves draft.
  assert.equal(
    (await agent.patch(`/api/organizer/elections/${draft.id}`).set(headers).send({ votingMode: 'anonymous' })).status,
    409,
  );
  assert.equal((await agent.post(`/api/organizer/elections/${draft.id}/open`).set(headers).send()).status, 409);
  assert.equal((await agent.delete(`/api/organizer/elections/${draft.id}`).set(headers)).status, 409);

  const closed = await agent.post(`/api/organizer/elections/${draft.id}/close`).set(headers).send();
  assert.equal(closed.status, 200);
  assert.equal(closed.body.election.status, 'closed');
  assert.equal((await agent.post(`/api/organizer/elections/${draft.id}/open`).set(headers).send()).status, 409);

  const disposable = await createElection(agent, csrfToken, { id: 'test-lifecycle-2' });
  assert.equal((await agent.delete(`/api/organizer/elections/${disposable.id}`).set(headers)).status, 200);
  assert.equal((await agent.get('/api/organizer/elections')).body.elections.some((e) => e.id === disposable.id), false);
});

// -- invitations ---------------------------------------------------------------

test('invitations validate, list hashes only, revoke, and fail uniformly', async () => {
  const { agent, csrfToken, election } = await freshElectionWithInvites(0);
  const headers = { 'x-csrf-token': csrfToken };
  const invitations = await inviteVoters(agent, csrfToken, election.id, { count: 2, label: 'precinct-7' });
  assert.equal(invitations.length, 2);
  assert.notEqual(invitations[0].token, invitations[1].token);
  assert.match(invitations[0].token, /^inv_[0-9a-f]{48}$/);

  const valid = await request(app)
    .post('/api/invitations/validate')
    .send({ invitationToken: invitations[0].token, electionId: election.id });
  assert.deepEqual(valid.body, { valid: true, election: { id: election.id, title: election.title } });

  // Organizer listing exposes hashes, never plaintext tokens.
  const list = await agent.get(`/api/organizer/elections/${election.id}/invitations`);
  assert.equal(list.status, 200);
  assert.equal(list.body.invitations.length, 2);
  const listJson = JSON.stringify(list.body);
  assert.ok(!listJson.includes(invitations[0].token));
  assert.ok(list.body.invitations.every((inv) => /^[0-9a-f]{64}$/.test(inv.tokenHash)));

  // Revoke the second invitation; redeemed-state read back through the API.
  const revokedHash = list.body.invitations.find((inv) => inv.voterRef === invitations[1].voterRef).tokenHash;
  assert.equal(
    (await agent.delete(`/api/organizer/elections/${election.id}/invitations/${revokedHash}`).set(headers)).status,
    200,
  );

  // Expired invitation, minted directly at the store (the API clamps to >= 1h).
  const [expired] = await store.createInvitations({
    electionId: election.id,
    count: 1,
    expiresAt: Date.now() - 1000,
    label: '',
    createdBy: 'organizer-1',
  });

  // Every failure mode: uniform 403 on the registration path...
  for (const token of [fakeToken('ab'), invitations[1].token, expired.token]) {
    const res = await request(app)
      .post('/api/webauthn/register/options')
      .send({ invitationToken: token, electionId: election.id });
    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'Invalid or expired invitation.');
  }
  // ...and { valid: false } on the pre-check path (no status oracle at all).
  for (const token of [fakeToken('cd'), invitations[1].token, expired.token, 'not-a-token']) {
    const res = await request(app).post('/api/invitations/validate').send({ invitationToken: token });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { valid: false });
  }
});

test('invitation redemption is single-use under a concurrent race', async () => {
  const { election, invitations } = await freshElectionWithInvites(1);
  const token = invitations[0].token;

  // Two ceremonies opened before either redeems: both succeed (peek is free).
  const first = await request(app)
    .post('/api/webauthn/register/options')
    .send({ invitationToken: token, electionId: election.id });
  const second = await request(app)
    .post('/api/webauthn/register/options')
    .send({ invitationToken: token, electionId: election.id });
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);

  const results = await Promise.all([
    request(app).post('/api/webauthn/register/verify').send({ requestId: first.body.requestId, response: { id: 'a', response: {} } }),
    request(app).post('/api/webauthn/register/verify').send({ requestId: second.body.requestId, response: { id: 'b', response: {} } }),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 403]);
  assert.equal(results.find((r) => r.status === 403).body.error, 'Invalid or expired invitation.');

  const passkeys = await store.getPasskeysByVoter(invitations[0].voterRef, election.id);
  assert.equal(passkeys.length, 1);
});

test('invitation attempts are rate-limited without leaking validity', async () => {
  const { election } = await freshElectionWithInvites(0);
  for (let i = 0; i < 30; i += 1) {
    const res = await request(app).post('/api/invitations/validate').send({ invitationToken: fakeToken('ef') });
    assert.equal(res.status, 200);
  }
  const limited = await request(app).post('/api/invitations/validate').send({ invitationToken: fakeToken('ef') });
  assert.equal(limited.status, 429);
  // Same uniform 403 budget shared with the registration path.
  const viaRegister = await request(app)
    .post('/api/webauthn/register/options')
    .send({ invitationToken: fakeToken('ef'), electionId: election.id });
  assert.equal(viaRegister.status, 429);
});

test('Mongo rate-limit buckets persist across store instances (serverless-safe)', async () => {
  // Simulates two serverless function instances sharing one MongoDB: buckets
  // recorded through one store instance are enforced through another.
  const key = `probe:${Date.now()}`;
  const window = { windowMs: 60000, max: 3 };
  const first = new MongoRateLimitStore();
  const second = new MongoRateLimitStore();
  assert.equal((await first.check(key, window)).allowed, true);
  assert.equal((await first.check(key, window)).allowed, true);
  assert.equal((await second.check(key, window)).allowed, true);
  const blocked = await second.check(key, window);
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterSec >= 1);
  assert.ok(await RateLimitModel.findById(key).lean());

  // The wired middleware path also honors the Mongo store end to end.
  configureRateLimitStore(new MongoRateLimitStore());
  try {
    for (let i = 0; i < 30; i += 1) {
      const res = await request(app).post('/api/invitations/validate').send({ invitationToken: fakeToken('aa') });
      assert.equal(res.status, 200);
    }
    assert.equal(
      (await request(app).post('/api/invitations/validate').send({ invitationToken: fakeToken('aa') })).status,
      429,
    );
  } finally {
    // Restore the shared instance (not a fresh one) so the file's
    // resetRateLimits() isolation keeps working for later tests.
    configureRateLimitStore(memoryRateLimitStore);
  }
});

// -- registration ---------------------------------------------------------------

test('registration rejects mixed eligibility, roll bypass, and bad attestations', async () => {
  const { election, invitations } = await freshElectionWithInvites(1);

  // PIN material mixed with a token is rejected before any token check.
  const mixed = await request(app)
    .post('/api/webauthn/register/options')
    .send({ invitationToken: invitations[0].token, electionId: election.id, voterRef: 'PM-1001', pin: '4921' });
  assert.equal(mixed.status, 400);

  // Roll credentials cannot bypass invitation gating.
  const bypass = await request(app)
    .post('/api/webauthn/register/options')
    .send({ voterRef: 'PM-1001', pin: '4921', electionId: election.id });
  assert.equal(bypass.status, 403);
  assert.equal(bypass.body.error, 'This election requires an invitation to register.');

  // Unknown ceremony handle.
  const unknown = await request(app)
    .post('/api/webauthn/register/verify')
    .send({ requestId: 'no-such-ceremony', response: { id: 'x', response: {} } });
  assert.equal(unknown.status, 401);

  // Failed attestation verification persists nothing and keeps the token live.
  const failingApp = createApp(store, {
    aiClient: null,
    webauthn: fakeWebAuthn({ verifyRegistrationResponse: async () => ({ verified: false }) }),
  });
  const options = await request(failingApp)
    .post('/api/webauthn/register/options')
    .send({ invitationToken: invitations[0].token, electionId: election.id });
  assert.equal(options.status, 201);
  const verify = await request(failingApp)
    .post('/api/webauthn/register/verify')
    .send({ requestId: options.body.requestId, response: { id: 'x', response: {} } });
  assert.equal(verify.status, 401);
  assert.equal((await store.getPasskeysByVoter(invitations[0].voterRef, election.id)).length, 0);
  const stillValid = await request(app).post('/api/invitations/validate').send({ invitationToken: invitations[0].token });
  assert.equal(stillValid.body.valid, true);
});

// -- enrollment ------------------------------------------------------------------

test('enrollment binds one commitment per voter and rejects duplicate commitments', async () => {
  const { election, invitations } = await freshElectionWithInvites(2);
  const first = await onboardVoter(invitations[0], election.id, 'mongo-enroll-1');
  const { voterRef } = await registerInvited({ token: invitations[1].token, electionId: election.id });
  const { agent, csrfToken } = await loginVoter({ voterRef, electionId: election.id });

  // Same voter, second commitment -> rejected.
  const { agent: agent1, csrfToken: csrf1 } = await loginVoter({ voterRef: first.voterRef, electionId: election.id });
  const again = await enrollVoter(agent1, csrf1, {
    electionId: election.id,
    commitment: new Identity('mongo-enroll-1b').commitment.toString(),
  });
  assert.equal(again.status, 409);

  // Same commitment, different voter -> rejected.
  const stolen = await enrollVoter(agent, csrfToken, {
    electionId: election.id,
    commitment: first.identity.commitment.toString(),
  });
  assert.equal(stolen.status, 409);

  // Session bound to another election cannot enrol here.
  const cross = await enrollVoter(agent, csrfToken, {
    electionId: 'metro-transit-2026',
    commitment: new Identity('mongo-enroll-x').commitment.toString(),
  });
  assert.equal(cross.status, 403);
});

test('concurrent enrollments all succeed with unique versions', async () => {
  const COUNT = 5;
  const { election, invitations } = await freshElectionWithInvites(COUNT);
  const onboarded = [];
  for (let i = 0; i < COUNT; i += 1) {
    const { voterRef } = await registerInvited({ token: invitations[i].token, electionId: election.id });
    const { agent, csrfToken } = await loginVoter({ voterRef, electionId: election.id });
    onboarded.push({ agent, csrfToken, identity: new Identity(`mongo-concurrent-${i}`) });
  }
  const results = await Promise.all(
    onboarded.map(({ agent, csrfToken, identity }) =>
      enrollVoter(agent, csrfToken, { electionId: election.id, commitment: identity.commitment.toString() })),
  );
  assert.ok(results.every((r) => r.status === 201));
  assert.deepEqual(results.map((r) => r.body.version).sort((a, b) => a - b), [1, 2, 3, 4, 5]);

  const group = await request(app).get(`/api/semaphore/group/${election.id}`);
  assert.equal(group.body.members.length, COUNT);
  const rebuilt = new Group(group.body.members.map(BigInt));
  assert.equal(rebuilt.root.toString(), group.body.root);
});

test('freeze locks enrollment: empty, double-freeze, and post-freeze enroll fail', async () => {
  const { agent, csrfToken, election, invitations } = await freshElectionWithInvites(2);
  const headers = { 'x-csrf-token': csrfToken };

  // Empty group cannot be frozen.
  assert.equal((await agent.post(`/api/organizer/elections/${election.id}/freeze`).set(headers).send()).status, 409);

  const { identity } = await onboardVoter(invitations[0], election.id, 'mongo-freeze-1');
  const frozen = await agent.post(`/api/organizer/elections/${election.id}/freeze`).set(headers).send();
  assert.equal(frozen.status, 200);
  assert.equal(frozen.body.election.groupFrozen, true);
  assert.equal((await agent.post(`/api/organizer/elections/${election.id}/freeze`).set(headers).send()).status, 409);

  // Post-freeze enrollment is rejected, even for a fresh eligible voter.
  const { voterRef } = await registerInvited({ token: invitations[1].token, electionId: election.id });
  const second = await loginVoter({ voterRef, electionId: election.id });
  const late = await enrollVoter(second.agent, second.csrfToken, {
    electionId: election.id,
    commitment: new Identity('mongo-freeze-2').commitment.toString(),
  });
  assert.equal(late.status, 409);

  // Voting with a pre-freeze enrollment still works: freeze gates enrolment, not ballots.
  const groupRes = await request(app).get(`/api/semaphore/group/${election.id}`);
  const group = new Group(groupRes.body.members.map(BigInt));
  const ballotCommitment = 'c'.repeat(64);
  const proof = await generateProof(identity, group, commitmentMessage(ballotCommitment), electionScope(election.id));
  const ballot = await submitAnonymous({ electionId: election.id, ballotCommitment, proof });
  assert.equal(ballot.status, 201);
});

// -- anonymous proofs ---------------------------------------------------------------

test('anonymous ballots verify real proofs and reject tampered, scoped, and rooted forgeries', async () => {
  const { election, invitations } = await freshElectionWithInvites(1);
  const { identity } = await onboardVoter(invitations[0], election.id, 'mongo-proof-1');
  const groupRes = await request(app).get(`/api/semaphore/group/${election.id}`);
  const group = new Group(groupRes.body.members.map(BigInt));
  const ballotCommitment = 'd'.repeat(64);
  const proof = await generateProof(identity, group, commitmentMessage(ballotCommitment), electionScope(election.id));

  // Wrong scope: the same proof submitted for another election.
  const scoped = await submitAnonymous({ electionId: 'metro-transit-2026', ballotCommitment, proof });
  assert.equal(scoped.status, 401);

  // Unknown root: root replaced before submission (root check fires first).
  const rooted = structuredClone(proof);
  rooted.merkleTreeRoot = '12345';
  const unknownRoot = await submitAnonymous({ electionId: election.id, ballotCommitment, proof: rooted });
  assert.equal(unknownRoot.status, 401);
  assert.match(unknownRoot.body.error, /root/i);

  // Tampered proof points: fails SNARK verification.
  const tampered = structuredClone(proof);
  const point = tampered.points[0];
  tampered.points[0] = point.slice(0, -1) + (point.endsWith('0') ? '1' : '0');
  const badProof = await submitAnonymous({ electionId: election.id, ballotCommitment, proof: tampered });
  assert.equal(badProof.status, 401);
  assert.match(badProof.body.error, /verification/i);

  // Modified ballot commitment: message binding check fires.
  const swapped = await submitAnonymous({ electionId: election.id, ballotCommitment: 'e'.repeat(64), proof });
  assert.equal(swapped.status, 401);

  // The valid proof is still accepted afterwards (rejections consumed nothing).
  const good = await submitAnonymous({ electionId: election.id, ballotCommitment, proof });
  assert.equal(good.status, 201);
  assert.equal(good.body.verified, true);

  // Rejections left sanitized audit evidence (nullifier + reason, no identity).
  const audit = await request(app).get(`/api/audit?electionId=${election.id}&limit=100`);
  const details = audit.body.events.map((e) => e.detail).join('\n');
  assert.match(details, /scope|root|verification|commitment/i);
  assert.ok(!JSON.stringify(audit.body).includes(invitations[0].token));
});

test('concurrent duplicate nullifiers: exactly one ballot is accepted', async () => {
  const { election, invitations } = await freshElectionWithInvites(1);
  const { identity } = await onboardVoter(invitations[0], election.id, 'mongo-dupe-1');
  const groupRes = await request(app).get(`/api/semaphore/group/${election.id}`);
  const group = new Group(groupRes.body.members.map(BigInt));
  const ballotCommitment = 'f'.repeat(64);
  const proof = await generateProof(identity, group, commitmentMessage(ballotCommitment), electionScope(election.id));
  const body = { electionId: election.id, ballotCommitment, proof };

  const results = await Promise.all(Array.from({ length: 8 }, () => submitAnonymous(body)));
  const accepted = results.filter((r) => r.status === 201);
  const rejected = results.filter((r) => r.status === 409);
  assert.equal(accepted.length, 1);
  assert.equal(rejected.length, 7);

  const ballots = await mongoose.models.Ballot.find({ electionId: election.id }).lean();
  assert.equal(ballots.length, 1);
});

// -- restart persistence ------------------------------------------------------------

test('restart: enrollments, ballots, and redemptions survive reconnect + new store', async () => {
  const { election, invitations } = await freshElectionWithInvites(1);
  const { voterRef, identity } = await onboardVoter(invitations[0], election.id, 'mongo-restart-1');
  const groupRes = await request(app).get(`/api/semaphore/group/${election.id}`);
  const group = new Group(groupRes.body.members.map(BigInt));
  const ballotCommitment = '1'.repeat(64);
  const proof = await generateProof(identity, group, commitmentMessage(ballotCommitment), electionScope(election.id));
  assert.equal((await submitAnonymous({ electionId: election.id, ballotCommitment, proof })).status, 201);

  // Simulate an API restart: drop the connection, reconnect, new store + app.
  await MongoStore.disconnect();
  await MongoStore.connect(mongoUri);
  await ensureMongoIndexes();
  store = new MongoStore();
  app = createApp(store, { aiClient: null, webauthn: fakeWebAuthn() });

  // Passkeys persisted: the voter can authenticate without re-registering.
  const { agent, csrfToken } = await loginVoter({ voterRef, electionId: election.id });
  // Enrollment persisted: re-enrolling the same voter conflicts.
  const reenroll = await enrollVoter(agent, csrfToken, {
    electionId: election.id,
    commitment: new Identity('mongo-restart-2').commitment.toString(),
  });
  assert.equal(reenroll.status, 409);
  // Nullifier persisted: the same ballot is still a duplicate.
  assert.equal((await submitAnonymous({ electionId: election.id, ballotCommitment, proof })).status, 409);
  // Redemption persisted: the used token stays dead.
  const recheck = await request(app).post('/api/invitations/validate').send({ invitationToken: invitations[0].token });
  assert.deepEqual(recheck.body, { valid: false });
  // Group snapshot persisted: same root and members.
  const regroup = await request(app).get(`/api/semaphore/group/${election.id}`);
  assert.equal(regroup.body.root, groupRes.body.root);
  assert.deepEqual(regroup.body.members, groupRes.body.members);
});

// -- cross-election isolation ----------------------------------------------------------

test('commitments, proofs, and nullifiers are scoped to one election', async () => {
  assert.equal((await setupOrganizer()).status, 201);
  const { agent, csrfToken } = await loginOrganizer();
  const electionA = await createElection(agent, csrfToken, { id: 'test-iso-a' });
  const electionB = await createElection(agent, csrfToken, { id: 'test-iso-b' });
  await openElection(agent, csrfToken, electionA.id);
  await openElection(agent, csrfToken, electionB.id);
  const [inviteA] = await inviteVoters(agent, csrfToken, electionA.id, { count: 1 });
  const [inviteB] = await inviteVoters(agent, csrfToken, electionB.id, { count: 1 });

  const { identity } = await onboardVoter(inviteA, electionA.id, 'mongo-iso-1');
  const commitment = identity.commitment.toString();

  // Same commitment string is enrollable in election B (uniqueness is per-election).
  const { voterRef: refB } = await registerInvited({ token: inviteB.token, electionId: electionB.id });
  const loginB = await loginVoter({ voterRef: refB, electionId: electionB.id });
  assert.equal((await enrollVoter(loginB.agent, loginB.csrfToken, { electionId: electionB.id, commitment })).status, 201);

  // Election A proof is rejected for B (scope binding), then accepted for A.
  const groupA = await request(app).get(`/api/semaphore/group/${electionA.id}`);
  const proof = await generateProof(
    identity,
    new Group(groupA.body.members.map(BigInt)),
    commitmentMessage('2'.repeat(64)),
    electionScope(electionA.id),
  );
  assert.equal((await submitAnonymous({ electionId: electionB.id, ballotCommitment: '2'.repeat(64), proof })).status, 401);
  assert.equal((await submitAnonymous({ electionId: electionA.id, ballotCommitment: '2'.repeat(64), proof })).status, 201);

  // Invitation from A is not valid for B.
  const [inviteA2] = await inviteVoters(agent, csrfToken, electionA.id, { count: 1 });
  const mismatch = await request(app)
    .post('/api/webauthn/register/options')
    .send({ invitationToken: inviteA2.token, electionId: electionB.id });
  assert.equal(mismatch.status, 403);
});

// -- leakage & indexes --------------------------------------------------------------------

test('public APIs expose no tokens, secrets, or voter-to-ballot links', async () => {
  const { agent, csrfToken, election, invitations } = await freshElectionWithInvites(1);
  const token = invitations[0].token;
  const { voterRef, identity } = await onboardVoter(invitations[0], election.id, 'mongo-leak-1');
  const groupRes = await request(app).get(`/api/semaphore/group/${election.id}`);
  const group = new Group(groupRes.body.members.map(BigInt));
  const proof = await generateProof(identity, group, commitmentMessage('3'.repeat(64)), electionScope(election.id));
  assert.equal((await submitAnonymous({ electionId: election.id, ballotCommitment: '3'.repeat(64), proof })).status, 201);

  // Group snapshot: commitments only.
  assert.ok(!JSON.stringify(groupRes.body).includes(voterRef));
  // Public audit: no token, no voter ref on anonymous ballots.
  const audit = await request(app).get(`/api/audit?electionId=${election.id}&limit=200`);
  const auditJson = JSON.stringify(audit.body);
  assert.ok(!auditJson.includes(token));
  assert.ok(!auditJson.includes(voterRef));
  assert.ok(!auditJson.toLowerCase().includes('secret'));
  assert.ok(!auditJson.includes('passwordHash'));
  // Anonymous ballot rows carry nullifier + commitment, never identity.
  const ballots = await mongoose.models.Ballot.find({ electionId: election.id }).lean();
  assert.equal(ballots.length, 1);
  assert.ok(ballots[0].nullifier && ballots[0].ballotCommitment && ballots[0].electionId);
  for (const forbidden of ['voterRef', 'credentialId', 'sessionId', 'identity', 'token', 'tokenHash']) {
    assert.ok(!(forbidden in ballots[0]), `ballot row must not contain ${forbidden}`);
  }
});

test('required unique indexes exist on the live database', async () => {
  assert.ok(REQUIRED_UNIQUE_INDEXES.length >= 5);
  for (const [model, keys, label] of REQUIRED_UNIQUE_INDEXES) {
    const indexes = await model.collection.listIndexes().toArray();
    const found = indexes.some(
      (index) => index.unique === true && JSON.stringify(index.key) === JSON.stringify(keys),
    );
    assert.ok(found, `missing unique index: ${label}`);
  }
  // Behavioural proof: the same voter cannot hold two passkeys in one election.
  const { election, invitations } = await freshElectionWithInvites(2);
  await registerInvited({ token: invitations[0].token, electionId: election.id });
  await assert.rejects(
    store.savePasskey({
      id: 'another-cred-id',
      voterRef: invitations[0].voterRef,
      electionId: election.id,
      userIdBase64: 'dXNlcg',
      publicKeyBase64: 'AQID',
      counter: 0,
    }),
    /already registered/,
  );
});

// -- end-to-end -------------------------------------------------------------------------------

test('end-to-end organizer-to-voter flow with stats and audit trail', async () => {
  assert.equal((await setupOrganizer()).status, 201);
  const { agent, csrfToken } = await loginOrganizer();
  const headers = { 'x-csrf-token': csrfToken };

  const election = await createElection(agent, csrfToken, { title: 'E2E Fictional Election' });
  await openElection(agent, csrfToken, election.id);
  const invitations = await inviteVoters(agent, csrfToken, election.id, { count: 2 });

  const voters = [];
  for (let i = 0; i < 2; i += 1) {
    voters.push(await onboardVoter(invitations[i], election.id, `mongo-e2e-${i}`));
  }
  await agent.post(`/api/organizer/elections/${election.id}/freeze`).set(headers).send();

  const groupRes = await request(app).get(`/api/semaphore/group/${election.id}`);
  const group = new Group(groupRes.body.members.map(BigInt));
  for (let i = 0; i < 2; i += 1) {
    const ballotCommitment = String(i + 4).repeat(64);
    const proof = await generateProof(voters[i].identity, group, commitmentMessage(ballotCommitment), electionScope(election.id));
    assert.equal((await submitAnonymous({ electionId: election.id, ballotCommitment, proof })).status, 201);
  }
  await agent.post(`/api/organizer/elections/${election.id}/close`).set(headers).send();

  const org = await agent.get('/api/organizer/elections');
  const row = org.body.elections.find((e) => e.id === election.id);
  assert.equal(row.stats.ballotsCast, 2);
  assert.equal(row.stats.passkeys, 2);
  assert.equal(row.stats.invitationsIssued, 2);
  assert.equal(row.stats.invitationsRedeemed, 2);
  assert.equal(row.stats.groupVersion, 2);
  assert.equal(row.status, 'closed');

  const audit = await request(app).get(`/api/audit?electionId=${election.id}&limit=200`);
  const types = new Set(audit.body.events.map((e) => e.type));
  assert.ok(types.has('admin.updated'));
  assert.ok(types.has('ballot.cast'));
});

// -- voting mode enforcement ----------------------------------------------------------

test('anonymous elections reject standard ballots; standard elections reject enrolment and proofs', async () => {
  assert.equal((await setupOrganizer()).status, 201);
  const { agent, csrfToken } = await loginOrganizer();
  const anon = await createElection(agent, csrfToken, { id: 'test-mode-anon', votingMode: 'anonymous' });
  const std = await createElection(agent, csrfToken, { id: 'test-mode-std', votingMode: 'standard' });
  await openElection(agent, csrfToken, anon.id);
  await openElection(agent, csrfToken, std.id);
  const [inviteA] = await inviteVoters(agent, csrfToken, anon.id, { count: 1 });
  const [inviteB] = await inviteVoters(agent, csrfToken, std.id, { count: 1 });

  const { identity } = await onboardVoter(inviteA, anon.id, 'mongo-mode-1');
  const { voterRef: refB } = await registerInvited({ token: inviteB.token, electionId: std.id });
  const loginB = await loginVoter({ voterRef: refB, electionId: std.id });

  // Cross-mode bypass attempt 1: standard ballot on an anonymous election.
  const { agent: agentA, csrfToken: csrfA } = await loginVoter({
    voterRef: (await store.getPasskeysByVoter(inviteA.voterRef, anon.id))[0].voterRef,
    electionId: anon.id,
  });
  const smuggled = await castStandard(agentA, csrfA, { electionId: anon.id });
  assert.equal(smuggled.status, 409);
  assert.equal(smuggled.body.error, 'This election accepts anonymous ballots only.');

  // Cross-mode bypass attempt 2: enrolment on a standard election.
  const enrolled = await enrollVoter(loginB.agent, loginB.csrfToken, {
    electionId: std.id,
    commitment: new Identity('mongo-mode-2').commitment.toString(),
  });
  assert.equal(enrolled.status, 409);
  assert.equal(enrolled.body.error, 'This election accepts standard ballots only.');

  // Cross-mode bypass attempt 3: anonymous proof on a standard election. The
  // mode gate fires before scope/root/SNARK checks, so any shape-valid proof
  // is rejected for mode — including a genuine proof from another election.
  const groupA = await request(app).get(`/api/semaphore/group/${anon.id}`);
  const proof = await generateProof(
    identity,
    new Group(groupA.body.members.map(BigInt)),
    commitmentMessage('7'.repeat(64)),
    electionScope(anon.id),
  );
  const forged = await submitAnonymous({ electionId: std.id, ballotCommitment: '7'.repeat(64), proof });
  assert.equal(forged.status, 409);
  assert.equal(forged.body.error, 'This election accepts standard ballots only.');

  // ...while the same proof is accepted by its own anonymous election.
  assert.equal((await submitAnonymous({ electionId: anon.id, ballotCommitment: '7'.repeat(64), proof })).status, 201);
});

test('legacy elections without a mode allow both ballot paths', async () => {
  // Seed elections predate voting modes and are grandfathered: both paths
  // stay open so existing demos keep working. New elections must choose.
  await registerRoll({ voterRef: 'PM-1001', pin: '4921', electionId: 'metro-transit-2026' });
  const { agent, csrfToken } = await loginVoter({ voterRef: 'PM-1001', electionId: 'metro-transit-2026' });
  assert.equal((await castStandard(agent, csrfToken, { electionId: 'metro-transit-2026' })).status, 201);

  const identity = new Identity('mongo-legacy-1');
  assert.equal(
    (await enrollVoter(agent, csrfToken, {
      electionId: 'metro-transit-2026',
      commitment: identity.commitment.toString(),
    })).status,
    201,
  );
  const group = await request(app).get('/api/semaphore/group/metro-transit-2026');
  const proof = await generateProof(
    identity,
    new Group(group.body.members.map(BigInt)),
    commitmentMessage('8'.repeat(64)),
    electionScope('metro-transit-2026'),
  );
  assert.equal(
    (await submitAnonymous({ electionId: 'metro-transit-2026', ballotCommitment: '8'.repeat(64), proof })).status,
    201,
  );
});

test('one credential cannot back two voter records in an election', async () => {
  const { election, invitations } = await freshElectionWithInvites(2);
  // Pin the fake authenticator to a single credential id: the same physical
  // passkey attempting to redeem a second invitation for the same election.
  app = createApp(store, { aiClient: null, webauthn: fakeWebAuthn({ fixedCredentialId: 'dup-cred-1' }) });
  await registerInvited({ token: invitations[0].token, electionId: election.id });

  const options = await request(app)
    .post('/api/webauthn/register/options')
    .send({ invitationToken: invitations[1].token, electionId: election.id });
  assert.equal(options.status, 201);
  const verify = await request(app)
    .post('/api/webauthn/register/verify')
    .send({ requestId: options.body.requestId, response: { id: 'attestation', response: {} } });
  assert.equal(verify.status, 409);
  assert.match(verify.body.error, /already registered/);
  assert.equal((await store.getPasskeysByVoter(invitations[1].voterRef, election.id)).length, 0);
  // And the credential still belongs to exactly one voter record.
  assert.equal((await store.getPasskeysByVoter(invitations[0].voterRef, election.id)).length, 1);
});

test('standard elections support the full standard voting flow', async () => {
  assert.equal((await setupOrganizer()).status, 201);
  const { agent, csrfToken } = await loginOrganizer();
  const election = await createElection(agent, csrfToken, { votingMode: 'standard' });
  await openElection(agent, csrfToken, election.id);
  const [invitation] = await inviteVoters(agent, csrfToken, election.id, { count: 1 });
  const { voterRef } = await registerInvited({ token: invitation.token, electionId: election.id });
  const { agent: voterAgent, csrfToken: voterCsrf } = await loginVoter({ voterRef, electionId: election.id });

  const first = await castStandard(voterAgent, voterCsrf, { electionId: election.id });
  assert.equal(first.status, 201);
  assert.ok(first.body.ballot.nullifierHash);
  const second = await castStandard(voterAgent, voterCsrf, { electionId: election.id });
  assert.equal(second.status, 409);

  const audit = await request(app).get(`/api/audit?electionId=${election.id}&type=ballot.cast&limit=10`);
  assert.equal(audit.body.events.length, 1);
});

// -- lifecycle ------------------------------------------------------------------------------

test('lifecycle: draft → enrolment → frozen → voting → closed with phase gates', async () => {
  assert.equal((await setupOrganizer()).status, 201);
  const { agent, csrfToken } = await loginOrganizer();
  const election = await createElection(agent, csrfToken, { id: 'test-lifecycle-5' });

  // Registration is closed while drafting.
  const [draftInvite] = await inviteVoters(agent, csrfToken, election.id, { count: 1 });
  assert.equal(
    (await request(app).post('/api/invitations/validate').send({ invitationToken: draftInvite.token })).body.valid,
    false,
  );

  assert.equal((await transition(agent, csrfToken, election.id, 'start-enrolment')).status, 200);
  const invitations = await inviteVoters(agent, csrfToken, election.id, { count: 2 });
  const voters = [];
  for (let i = 0; i < 2; i += 1) {
    voters.push(await onboardVoter(invitations[i], election.id, `mongo-life-${i}`));
  }

  const frozen = await transition(agent, csrfToken, election.id, 'freeze');
  assert.equal(frozen.status, 200);
  assert.equal(frozen.body.election.status, 'frozen');
  // The approved group root is persisted on the election at freeze time.
  const group = await request(app).get(`/api/semaphore/group/${election.id}`);
  assert.ok(frozen.body.election.frozenRoot);
  assert.equal(frozen.body.election.frozenRoot, group.body.root);

  // Late enrolment is rejected after the freeze.
  const { voterRef: lateRef } = await registerInvited({ token: draftInvite.token, electionId: election.id });
  const late = await loginVoter({ voterRef: lateRef, electionId: election.id });
  assert.equal(
    (await enrollVoter(late.agent, late.csrfToken, {
      electionId: election.id,
      commitment: new Identity('mongo-life-late').commitment.toString(),
    })).status,
    409,
  );

  assert.equal((await transition(agent, csrfToken, election.id, 'start-voting')).status, 200);
  const members = new Group(group.body.members.map(BigInt));
  for (let i = 0; i < 2; i += 1) {
    const ballotCommitment = String(9 - i).repeat(64);
    const proof = await generateProof(
      voters[i].identity,
      members,
      commitmentMessage(ballotCommitment),
      electionScope(election.id),
    );
    assert.equal((await submitAnonymous({ electionId: election.id, ballotCommitment, proof })).status, 201);
  }

  assert.equal((await transition(agent, csrfToken, election.id, 'close')).status, 200);
  // Closed elections reject everything.
  const proof = await generateProof(
    voters[0].identity,
    members,
    commitmentMessage('0'.repeat(64)),
    electionScope(election.id),
  );
  assert.equal((await submitAnonymous({ electionId: election.id, ballotCommitment: '0'.repeat(64), proof })).status, 409);
  assert.equal(
    (await enrollVoter(late.agent, late.csrfToken, {
      electionId: election.id,
      commitment: new Identity('mongo-life-x').commitment.toString(),
    })).status,
    409,
  );
});

test('lifecycle rejects illegal transitions and out-of-phase operations', async () => {
  assert.equal((await setupOrganizer()).status, 201);
  const { agent, csrfToken } = await loginOrganizer();
  const election = await createElection(agent, csrfToken, { id: 'test-lifecycle-x' });

  // Draft: only enrolment/open may follow; drafts are deleted, never closed.
  assert.equal((await transition(agent, csrfToken, election.id, 'start-voting')).status, 409);
  assert.equal((await transition(agent, csrfToken, election.id, 'close')).status, 409);
  assert.equal((await transition(agent, csrfToken, election.id, 'freeze')).status, 409);

  assert.equal((await transition(agent, csrfToken, election.id, 'start-enrolment')).status, 200);
  assert.equal((await transition(agent, csrfToken, election.id, 'start-enrolment')).status, 409);
  // Voting must not start before the freeze.
  assert.equal((await transition(agent, csrfToken, election.id, 'start-voting')).status, 409);

  const [invitation] = await inviteVoters(agent, csrfToken, election.id, { count: 1 });
  const { voterRef, identity } = await onboardVoter(invitation, election.id, 'mongo-phase-1');

  // Ballots are rejected during enrolment, before voting opens.
  const { agent: voterAgent, csrfToken: voterCsrf } = await loginVoter({ voterRef, electionId: election.id });
  const early = await castStandard(voterAgent, voterCsrf, { electionId: election.id });
  assert.equal(early.status, 409);
  assert.equal(early.body.error, 'Election is not open for voting.');
  const group = await request(app).get(`/api/semaphore/group/${election.id}`);
  const earlyProof = await generateProof(
    identity,
    new Group(group.body.members.map(BigInt)),
    commitmentMessage('a1'.repeat(32)),
    electionScope(election.id),
  );
  const earlyAnon = await submitAnonymous({
    electionId: election.id,
    ballotCommitment: 'a1'.repeat(32),
    proof: earlyProof,
  });
  assert.equal(earlyAnon.status, 409);
  assert.equal(earlyAnon.body.error, 'Election is not open for voting.');

  assert.equal((await transition(agent, csrfToken, election.id, 'freeze')).status, 200);
  assert.equal((await transition(agent, csrfToken, election.id, 'freeze')).status, 409);
  assert.equal((await transition(agent, csrfToken, election.id, 'start-voting')).status, 200);
  // Enrolment is closed once voting starts.
  assert.equal(
    (await enrollVoter(voterAgent, voterCsrf, {
      electionId: election.id,
      commitment: new Identity('mongo-phase-2').commitment.toString(),
    })).status,
    409,
  );

  assert.equal((await transition(agent, csrfToken, election.id, 'close')).status, 200);
  // Closed is terminal.
  assert.equal((await transition(agent, csrfToken, election.id, 'start-voting')).status, 409);
  assert.equal((await transition(agent, csrfToken, election.id, 'freeze')).status, 409);
  assert.equal((await transition(agent, csrfToken, election.id, 'close')).status, 409);
});

test('standard elections freeze without a group; frozen elections verify only the frozen root', async () => {
  assert.equal((await setupOrganizer()).status, 201);
  const { agent, csrfToken } = await loginOrganizer();

  // Standard mode: freeze is a phase marker, no group required.
  const std = await createElection(agent, csrfToken, { id: 'test-std-freeze', votingMode: 'standard' });
  await transition(agent, csrfToken, std.id, 'start-enrolment');
  const stdFrozen = await transition(agent, csrfToken, std.id, 'freeze');
  assert.equal(stdFrozen.status, 200);
  assert.equal(stdFrozen.body.election.status, 'frozen');
  assert.equal((await transition(agent, csrfToken, std.id, 'start-voting')).status, 200);
  const [stdInvite] = await inviteVoters(agent, csrfToken, std.id, { count: 1 });
  const { voterRef: stdRef } = await registerInvited({ token: stdInvite.token, electionId: std.id });
  const stdLogin = await loginVoter({ voterRef: stdRef, electionId: std.id });
  assert.equal((await castStandard(stdLogin.agent, stdLogin.csrfToken, { electionId: std.id })).status, 201);

  // Anonymous mode: after the freeze, only the persisted frozen root verifies.
  const anon = await createElection(agent, csrfToken, { id: 'test-anon-root', votingMode: 'anonymous' });
  await transition(agent, csrfToken, anon.id, 'start-enrolment');
  const anonInvites = await inviteVoters(agent, csrfToken, anon.id, { count: 2 });
  const first = await onboardVoter(anonInvites[0], anon.id, 'mongo-root-1');
  await onboardVoter(anonInvites[1], anon.id, 'mongo-root-2');
  await transition(agent, csrfToken, anon.id, 'freeze');
  await transition(agent, csrfToken, anon.id, 'start-voting');

  const full = await request(app).get(`/api/semaphore/group/${anon.id}`);
  // Proof against the v1 root (member 1 alone): server-made snapshot, but not
  // the frozen root — rejected.
  const staleProof = await generateProof(
    first.identity,
    new Group([BigInt(first.identity.commitment.toString())]),
    commitmentMessage('b2'.repeat(32)),
    electionScope(anon.id),
  );
  const stale = await submitAnonymous({
    electionId: anon.id,
    ballotCommitment: 'b2'.repeat(32),
    proof: staleProof,
  });
  assert.equal(stale.status, 401);
  assert.match(stale.body.error, /root/i);

  // Proof against the frozen root: accepted.
  const freshProof = await generateProof(
    first.identity,
    new Group(full.body.members.map(BigInt)),
    commitmentMessage('c3'.repeat(32)),
    electionScope(anon.id),
  );
  assert.equal(
    (await submitAnonymous({ electionId: anon.id, ballotCommitment: 'c3'.repeat(32), proof: freshProof })).status,
    201,
  );
});
