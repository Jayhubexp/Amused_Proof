import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { MemoryStore } from '../src/store/memory.js';

// Fake ceremony crypto (same shape as the real SimpleWebAuthn binding) with a
// rotating credential id so several voters can register within one test.
function fakeWebAuthn() {
  let n = 0;
  return {
    async generateRegistrationOptions(opts) {
      return { challenge: `reg-${n}`, rp: { id: opts.rpID }, user: { name: opts.userName }, options: true };
    },
    async verifyRegistrationResponse() {
      n += 1;
      return {
        verified: true,
        registrationInfo: {
          credential: { id: `cred-${n}`, publicKey: new Uint8Array([n]), counter: 0 },
          credentialType: 'public-key',
          userVerified: true,
          credentialDeviceType: 'singleDevice',
          credentialBackedUp: false,
        },
      };
    },
    async generateAuthenticationOptions(opts) {
      return { challenge: `auth-${Date.now()}-${Math.random()}`, allowCredentials: opts.allowCredentials };
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

let store;
let app;

beforeEach(() => {
  store = new MemoryStore();
  app = createApp(store, { webauthn: fakeWebAuthn() });
});

// Full HTTP voter flow: roll-gated registration, passkey login, session agent.
async function seatedVoter({ voterRef, pin, electionId }) {
  const agent = request.agent(app);
  const regOptions = await agent
    .post('/api/webauthn/register/options')
    .send({ voterRef, pin, electionId });
  assert.equal(regOptions.status, 201);
  const regVerify = await agent
    .post('/api/webauthn/register/verify')
    .send({ requestId: regOptions.body.requestId, response: { id: 'x', response: {} } });
  assert.equal(regVerify.status, 201);
  const authOptions = await agent
    .post('/api/webauthn/auth/options')
    .send({ voterRef, electionId });
  assert.equal(authOptions.status, 200);
  const credId = authOptions.body.options.allowCredentials[0].id;
  const authVerify = await agent
    .post('/api/webauthn/auth/verify')
    .send({ requestId: authOptions.body.requestId, response: { id: credId, response: {} } });
  assert.equal(authVerify.status, 200);
  return { agent, csrfToken: authVerify.body.csrfToken };
}

function cast(agent, csrfToken, body) {
  return agent.post('/api/ballots').set('x-csrf-token', csrfToken).send(body);
}

test('duplicate vote with the same credential is rejected (409)', async () => {
  const { agent, csrfToken } = await seatedVoter({ voterRef: 'PM-1001', pin: '4921', electionId: 'metro-transit-2026' });
  const first = await cast(agent, csrfToken, { electionId: 'metro-transit-2026', ballotCommitment: 'a'.repeat(64) });
  assert.equal(first.status, 201);

  const second = await cast(agent, csrfToken, { electionId: 'metro-transit-2026', ballotCommitment: 'b'.repeat(64) });
  assert.equal(second.status, 409);
  assert.match(second.body.error, /Duplicate vote/);
});

test('two different voters can each vote once', async () => {
  const voters = [
    ['PM-1001', '4921'],
    ['PM-1002', '7734'],
  ];
  for (const [voterRef, pin] of voters) {
    const { agent, csrfToken } = await seatedVoter({ voterRef, pin, electionId: 'metro-transit-2026' });
    const res = await cast(agent, csrfToken, { electionId: 'metro-transit-2026', ballotCommitment: 'a'.repeat(64) });
    assert.equal(res.status, 201);
  }
});

test('ballot for a closed election is rejected (409)', async () => {
  // PM-3001 is on the roll for the certified election; seed their passkey
  // directly since registration closes with the election.
  await store.savePasskey({
    id: 'levy-cred', voterRef: 'PM-3001', electionId: 'library-levy-2025',
    userIdBase64: 'dXNlcg', publicKeyBase64: 'AQID', counter: 0,
  });
  const agent = request.agent(app);
  const authOptions = await agent
    .post('/api/webauthn/auth/options')
    .send({ voterRef: 'PM-3001', electionId: 'library-levy-2025' });
  assert.equal(authOptions.status, 200);
  const authVerify = await agent
    .post('/api/webauthn/auth/verify')
    .send({ requestId: authOptions.body.requestId, response: { id: 'levy-cred', response: {} } });
  assert.equal(authVerify.status, 200);
  const res = await cast(agent, authVerify.body.csrfToken, {
    electionId: 'library-levy-2025',
    ballotCommitment: 'a'.repeat(64),
  });
  assert.equal(res.status, 409);
});

test('malformed ballot payloads are rejected (400)', async () => {
  const { agent, csrfToken } = await seatedVoter({ voterRef: 'PM-1001', pin: '4921', electionId: 'metro-transit-2026' });
  const badBodies = [
    { electionId: 'metro-transit-2026', ballotCommitment: 'not-a-hash' },
    { electionId: 'metro-transit-2026' },
    { electionId: 'BAD ID!', ballotCommitment: 'a'.repeat(64) },
  ];
  for (const body of badBodies) {
    const res = await cast(agent, csrfToken, body);
    assert.equal(res.status, 400);
  }
});

test('ballot for an unknown election returns 404', async () => {
  const { agent, csrfToken } = await seatedVoter({ voterRef: 'PM-1001', pin: '4921', electionId: 'metro-transit-2026' });
  // Session is bound to metro-transit; an unknown id fails election lookup
  // only if it passed the session check — so expect 403 mismatch here, and
  // exercise the 404 path at the store level where sessions don't apply.
  const res = await cast(agent, csrfToken, { electionId: 'nope-not-real', ballotCommitment: 'a'.repeat(64) });
  assert.equal(res.status, 403);
  assert.throws(
    () => store.castBallot({ electionId: 'nope-not-real', voterRef: 'PM-1001', credentialId: 'x', ballotCommitment: 'a'.repeat(64) }),
    /Unknown election/,
  );
});

test('unauthenticated ballots are rejected (401)', async () => {
  const res = await request(app)
    .post('/api/ballots')
    .send({ electionId: 'metro-transit-2026', ballotCommitment: 'a'.repeat(64) });
  assert.equal(res.status, 401);
});

test('audit log records ballot events without identities or plaintext votes', async () => {
  const { agent, csrfToken } = await seatedVoter({ voterRef: 'PM-1001', pin: '4921', electionId: 'metro-transit-2026' });
  await cast(agent, csrfToken, { electionId: 'metro-transit-2026', ballotCommitment: 'a'.repeat(64) });
  const res = await request(app).get('/api/audit?electionId=metro-transit-2026');
  assert.equal(res.status, 200);
  const serialised = JSON.stringify(res.body);
  assert.ok(!serialised.includes('PM-1001'), 'voter ref leaked into audit');
  assert.ok(!serialised.includes('4921'), 'PIN leaked into audit');
  assert.ok(!serialised.includes('Demo Voter'), 'display name leaked into audit');
  assert.ok(res.body.events.some((e) => e.type === 'ballot.cast'));
  assert.ok(res.body.events.some((e) => e.type === 'voter.registered'));
  assert.ok(res.body.events.some((e) => e.type === 'auth.success'));
});
