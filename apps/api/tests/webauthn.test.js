import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { MemoryStore } from '../src/store/memory.js';
import { defaultWebAuthnLib } from '../src/auth/webauthn.js';
import { config } from '../src/config.js';

// Fake ceremony cryptography with the same four-function shape as the real
// SimpleWebAuthn binding. Our code's job — challenge handling, expected-value
// wiring, counter persistence, sessions — is what's under test; the library's
// own crypto is trusted, and one test below uses the REAL option generators.
function fakeWebAuthn(overrides = {}) {
  const calls = [];
  return {
    calls,
    async generateRegistrationOptions(opts) {
      calls.push({ fn: 'generateRegistrationOptions', opts });
      return {
        challenge: `fake-reg-challenge-${calls.length}`,
        rp: { name: opts.rpName, id: opts.rpID },
        user: { id: 'fake-user-id', name: opts.userName, displayName: opts.userDisplayName },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
        timeout: 60000,
        attestation: 'none',
      };
    },
    async verifyRegistrationResponse(args) {
      calls.push({ fn: 'verifyRegistrationResponse', args });
      if (overrides.verifyRegistrationResponse) return overrides.verifyRegistrationResponse(args);
      assertValidExpected(args);
      return {
        verified: true,
        registrationInfo: {
          credential: {
            id: overrides.credentialId ?? 'fake-cred-1',
            publicKey: new Uint8Array([1, 2, 3, 4]),
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
      calls.push({ fn: 'generateAuthenticationOptions', opts });
      return {
        challenge: `fake-auth-challenge-${calls.length}`,
        rpId: opts.rpID,
        allowCredentials: opts.allowCredentials,
        timeout: 60000,
        userVerification: 'required',
      };
    },
    async verifyAuthenticationResponse(args) {
      calls.push({ fn: 'verifyAuthenticationResponse', args });
      if (overrides.verifyAuthenticationResponse) return overrides.verifyAuthenticationResponse(args);
      assertValidExpected(args);
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

// The fake behaves like the library: it only verifies when OUR code passes the
// server-configured expected values (never client-supplied ones).
function assertValidExpected(args) {
  assert.equal(args.expectedOrigin, config.webauthnOrigin);
  assert.equal(args.expectedRPID, config.rpId);
  assert.equal(args.requireUserVerification, true);
  assert.ok(typeof args.expectedChallenge === 'string' && args.expectedChallenge.length > 0);
}

let store;

beforeEach(() => {
  store = new MemoryStore();
});

async function registerVoter(app, { voterRef = 'PM-1001', pin = '4921', electionId = 'metro-transit-2026' } = {}) {
  const options = await request(app)
    .post('/api/webauthn/register/options')
    .send({ voterRef, pin, electionId });
  assert.equal(options.status, 201);
  const verify = await request(app)
    .post('/api/webauthn/register/verify')
    .send({ requestId: options.body.requestId, response: { id: 'attestation-object', response: {} } });
  assert.equal(verify.status, 201);
  return verify.body;
}

async function loginVoter(app, { voterRef = 'PM-1001', electionId = 'metro-transit-2026', credentialId = 'fake-cred-1' } = {}) {
  const agent = request.agent(app);
  const options = await agent
    .post('/api/webauthn/auth/options')
    .send({ voterRef, electionId });
  assert.equal(options.status, 200);
  const verify = await agent
    .post('/api/webauthn/auth/verify')
    .send({ requestId: options.body.requestId, response: { id: credentialId, response: {} } });
  assert.equal(verify.status, 200);
  return { agent, csrfToken: verify.body.csrfToken, electionId };
}

test('passkey registration succeeds and persists public key only', async () => {
  const app = createApp(store, { webauthn: fakeWebAuthn() });
  const options = await request(app)
    .post('/api/webauthn/register/options')
    .send({ voterRef: 'PM-1001', pin: '4921', electionId: 'metro-transit-2026' });
  assert.equal(options.status, 201);
  assert.ok(options.body.requestId);
  assert.ok(options.body.options.challenge);

  const verify = await request(app)
    .post('/api/webauthn/register/verify')
    .send({ requestId: options.body.requestId, response: { id: 'x', response: {} } });
  assert.equal(verify.status, 201);
  assert.equal(verify.body.registered, true);

  const passkeys = await store.getPasskeysByVoter('PM-1001', 'metro-transit-2026');
  assert.equal(passkeys.length, 1);
  assert.equal(passkeys[0].id, 'fake-cred-1');
  assert.ok(passkeys[0].publicKeyBase64);
  assert.ok(passkeys[0].nullifierHash);
  // Registration discloses no secrets or nullifiers to the client.
  assert.ok(!JSON.stringify(verify.body).includes('nullifier'));
  assert.ok(!JSON.stringify(verify.body).includes('secret'));
});

test('registration works with the REAL SimpleWebAuthn option generator', async () => {
  // Only verification is faked (no authenticator exists in CI); the options
  // round-trip uses the real library output shape, including its challenge.
  const lib = { ...defaultWebAuthnLib };
  const fake = fakeWebAuthn();
  lib.verifyRegistrationResponse = fake.verifyRegistrationResponse;
  const app = createApp(store, { webauthn: lib });
  const options = await request(app)
    .post('/api/webauthn/register/options')
    .send({ voterRef: 'PM-1002', pin: '7734', electionId: 'metro-transit-2026' });
  assert.equal(options.status, 201);
  assert.match(options.body.options.challenge, /^[A-Za-z0-9_-]+$/);
  assert.equal(options.body.options.rp.id, 'localhost');
  const verifyCall = fake.calls.find((c) => c.fn === 'verifyRegistrationResponse');
  assert.ok(!verifyCall); // not yet called
  const verify = await request(app)
    .post('/api/webauthn/register/verify')
    .send({ requestId: options.body.requestId, response: { id: 'x', response: {} } });
  assert.equal(verify.status, 201);
});

test('registration rejects unknown voters, wrong PINs, duplicates, closed elections', async () => {
  const app = createApp(store, { webauthn: fakeWebAuthn() });
  const unknown = await request(app)
    .post('/api/webauthn/register/options')
    .send({ voterRef: 'PM-9999', pin: '0000', electionId: 'metro-transit-2026' });
  assert.equal(unknown.status, 403);
  const wrongPin = await request(app)
    .post('/api/webauthn/register/options')
    .send({ voterRef: 'PM-1001', pin: '0000', electionId: 'metro-transit-2026' });
  assert.equal(wrongPin.status, 403);
  assert.equal(wrongPin.body.error, unknown.body.error); // no oracle

  await registerVoter(app);
  const duplicate = await request(app)
    .post('/api/webauthn/register/options')
    .send({ voterRef: 'PM-1001', pin: '4921', electionId: 'metro-transit-2026' });
  assert.equal(duplicate.status, 409);

  const closed = await request(app)
    .post('/api/webauthn/register/options')
    .send({ voterRef: 'PM-3001', pin: '9082', electionId: 'library-levy-2025' });
  assert.equal(closed.status, 409);
});

test('authentication succeeds, sets a secure cookie, and bumps the counter', async () => {
  const app = createApp(store, { webauthn: fakeWebAuthn() });
  await registerVoter(app);
  const agent = request.agent(app);
  const options = await agent
    .post('/api/webauthn/auth/options')
    .send({ voterRef: 'PM-1001', electionId: 'metro-transit-2026' });
  assert.equal(options.status, 200);

  const verify = await agent
    .post('/api/webauthn/auth/verify')
    .send({ requestId: options.body.requestId, response: { id: 'fake-cred-1', response: {} } });
  assert.equal(verify.status, 200);
  assert.ok(verify.body.csrfToken);

  const setCookie = verify.headers['set-cookie'].join(';');
  assert.match(setCookie, /cp_session=/);
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Lax/i);

  const passkey = await store.getPasskey('fake-cred-1');
  assert.equal(passkey.counter, 1);
  assert.ok(passkey.lastUsedAt);

  const session = await agent.get('/api/session');
  assert.equal(session.body.authenticated, true);
  assert.equal(session.body.voterRef, 'PM-1001');
});

test('challenge replay is rejected (single-use)', async () => {
  const app = createApp(store, { webauthn: fakeWebAuthn() });
  await registerVoter(app);
  const options = await request(app)
    .post('/api/webauthn/auth/options')
    .send({ voterRef: 'PM-1001', electionId: 'metro-transit-2026' });
  const first = await request(app)
    .post('/api/webauthn/auth/verify')
    .send({ requestId: options.body.requestId, response: { id: 'fake-cred-1', response: {} } });
  assert.equal(first.status, 200);
  const replay = await request(app)
    .post('/api/webauthn/auth/verify')
    .send({ requestId: options.body.requestId, response: { id: 'fake-cred-1', response: {} } });
  assert.equal(replay.status, 401);
  assert.match(replay.body.error, /already-used/);
});

test('expired challenges are rejected', async () => {
  const app = createApp(store, { webauthn: fakeWebAuthn() });
  await store.saveWebAuthnChallenge({
    id: 'expired-request',
    challenge: 'stale',
    type: 'authentication',
    voterRef: 'PM-1001',
    electionId: 'metro-transit-2026',
    allowCredentialIds: ['fake-cred-1'],
    ttlMs: -1000,
  });
  const res = await request(app)
    .post('/api/webauthn/auth/verify')
    .send({ requestId: 'expired-request', response: { id: 'fake-cred-1', response: {} } });
  assert.equal(res.status, 401);
  assert.match(res.body.error, /expired/);
});

test('registration and authentication ceremonies cannot be crossed', async () => {
  const app = createApp(store, { webauthn: fakeWebAuthn() });
  const options = await request(app)
    .post('/api/webauthn/register/options')
    .send({ voterRef: 'PM-1003', pin: '2085', electionId: 'metro-transit-2026' });
  const crossed = await request(app)
    .post('/api/webauthn/auth/verify')
    .send({ requestId: options.body.requestId, response: { id: 'x', response: {} } });
  assert.equal(crossed.status, 401);
});

test('client-supplied origin and RP ID are ignored; config values are enforced', async () => {
  // The fake throws unless OUR code passes the server-configured values, so a
  // 201 here proves client overrides in the body cannot take effect.
  const app = createApp(store, { webauthn: fakeWebAuthn() });
  const options = await request(app)
    .post('/api/webauthn/register/options')
    .send({ voterRef: 'PM-1001', pin: '4921', electionId: 'metro-transit-2026' });
  const verify = await request(app)
    .post('/api/webauthn/register/verify')
    .send({
      requestId: options.body.requestId,
      response: { id: 'x', response: {} },
      expectedOrigin: 'https://evil.test',
      expectedRPID: 'evil.test',
    });
  assert.equal(verify.status, 201);
});

test('failed verification is audited and reveals nothing sensitive', async () => {
  const failing = fakeWebAuthn({
    verifyAuthenticationResponse: async () => { throw new Error('bad signature'); },
  });
  const app = createApp(store, { webauthn: failing });
  // Register through a working fake first (same store).
  const working = createApp(store, { webauthn: fakeWebAuthn() });
  await registerVoter(working);
  const before = (await store.listAudit({ type: 'auth.failed' })).length;

  const options = await request(app)
    .post('/api/webauthn/auth/options')
    .send({ voterRef: 'PM-1001', electionId: 'metro-transit-2026' });
  const res = await request(app)
    .post('/api/webauthn/auth/verify')
    .send({ requestId: options.body.requestId, response: { id: 'fake-cred-1', response: {} } });
  assert.equal(res.status, 401);
  assert.ok(!res.body.error.includes('signature'));
  const after = await store.listAudit({ type: 'auth.failed' });
  assert.equal(after.length, before + 1);
});

test('unknown credential identifiers are rejected', async () => {
  const app = createApp(store, { webauthn: fakeWebAuthn() });
  await registerVoter(app);
  const options = await request(app)
    .post('/api/webauthn/auth/options')
    .send({ voterRef: 'PM-1001', electionId: 'metro-transit-2026' });
  const res = await request(app)
    .post('/api/webauthn/auth/verify')
    .send({ requestId: options.body.requestId, response: { id: 'attacker-cred', response: {} } });
  assert.equal(res.status, 401);
  assert.match(res.body.error, /Unknown passkey/);
});

test('auth options for a voter with no passkey returns 404', async () => {
  const app = createApp(store, { webauthn: fakeWebAuthn() });
  const res = await request(app)
    .post('/api/webauthn/auth/options')
    .send({ voterRef: 'PM-1001', electionId: 'metro-transit-2026' });
  assert.equal(res.status, 404);
});

test('session reflects login state; logout destroys it', async () => {
  const app = createApp(store, { webauthn: fakeWebAuthn() });
  await registerVoter(app);
  const anon = await request(app).get('/api/session');
  assert.equal(anon.body.authenticated, false);

  const { agent } = await loginVoter(app);
  const authed = await agent.get('/api/session');
  assert.equal(authed.body.authenticated, true);

  const logout = await agent.post('/api/logout');
  assert.equal(logout.body.loggedOut, true);
  const after = await agent.get('/api/session');
  assert.equal(after.body.authenticated, false);
});

test('expired sessions are rejected', async () => {
  const app = createApp(store, { webauthn: fakeWebAuthn() });
  await store.savePasskey({
    id: 'seeded-cred', voterRef: 'PM-1001', electionId: 'metro-transit-2026',
    userIdBase64: 'dXNlcg', publicKeyBase64: 'AQID', counter: 0,
  });
  const session = await store.createSession({
    voterRef: 'PM-1001', electionId: 'metro-transit-2026', credentialId: 'seeded-cred', ttlMs: -1000,
  });
  const res = await request(app)
    .get('/api/session')
    .set('Cookie', `cp_session=${session.id}`);
  assert.equal(res.body.authenticated, false);
});

test('ballots require session cookie and CSRF token', async () => {
  const app = createApp(store, { webauthn: fakeWebAuthn() });
  await registerVoter(app);
  const { agent, csrfToken } = await loginVoter(app);
  const body = { electionId: 'metro-transit-2026', ballotCommitment: 'a'.repeat(64) };

  const noCookie = await request(app).post('/api/ballots').send(body);
  assert.equal(noCookie.status, 401);

  const noCsrf = await agent.post('/api/ballots').send(body);
  assert.equal(noCsrf.status, 403);

  const badCsrf = await agent.post('/api/ballots').set('x-csrf-token', 'wrong').send(body);
  assert.equal(badCsrf.status, 403);

  const ok = await agent.post('/api/ballots').set('x-csrf-token', csrfToken).send(body);
  assert.equal(ok.status, 201);

  const crossElection = await agent
    .post('/api/ballots')
    .set('x-csrf-token', csrfToken)
    .send({ electionId: 'harbor-board-2026', ballotCommitment: 'b'.repeat(64) });
  assert.equal(crossElection.status, 403);
});

test('cross-origin POSTs are rejected', async () => {
  const app = createApp(store, { webauthn: fakeWebAuthn() });
  const res = await request(app)
    .post('/api/webauthn/auth/options')
    .set('Origin', 'https://evil.test')
    .send({ voterRef: 'PM-1001', electionId: 'metro-transit-2026' });
  assert.equal(res.status, 403);
});

test('malformed ceremony payloads are rejected with 400', async () => {
  const app = createApp(store, { webauthn: fakeWebAuthn() });
  assert.equal((await request(app).post('/api/webauthn/register/options').send({})).status, 400);
  assert.equal(
    (await request(app).post('/api/webauthn/register/options').send({ voterRef: 'bad!', pin: '4921', electionId: 'metro-transit-2026' })).status,
    400,
  );
  assert.equal(
    (await request(app).post('/api/webauthn/register/verify').send({ requestId: 'x', response: 'nope' })).status,
    400,
  );
  assert.equal(
    (await request(app).post('/api/webauthn/auth/verify').send({ requestId: 'x' })).status,
    400,
  );
});
