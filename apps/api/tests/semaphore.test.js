// NOTE: real proving leaves snark worker MessagePorts open, so the runner must
// use --test-force-exit (see package.json); verified to preserve exit codes.
import test, { before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { Identity } from '@semaphore-protocol/identity';
import { Group } from '@semaphore-protocol/group';
import { generateProof } from '@semaphore-protocol/proof';
import { createApp } from '../src/app.js';
import { MemoryStore } from '../src/store/memory.js';
import { commitmentMessage, electionScope } from '../src/zk/semaphore.js';

// Deterministic test identities: same commitments on every run, so one shared
// corpus of REAL library-generated proofs verifies against every fresh store
// seeded with the same members in the same order.
const MEMBERS = ['civicproof-test-member-1', 'civicproof-test-member-2', 'civicproof-test-member-3']
  .map((seed) => new Identity(seed));
const ATTACKER = new Identity('civicproof-test-attacker');
const MEMBER_COMMITMENTS = MEMBERS.map((identity) => identity.commitment.toString());

const ELECTION = 'metro-transit-2026';
const OTHER_ELECTION = 'harbor-board-2026';
const COMMITMENT_A = 'a'.repeat(64);
const COMMITMENT_B = 'b'.repeat(64);

let corpus = null;

// Built once: 4 real generateProof calls (artifact download amortised here).
async function buildCorpus() {
  if (corpus) return corpus;
  const group = new Group(MEMBER_COMMITMENTS.map(BigInt));
  const scopeA = electionScope(ELECTION);
  const scopeB = electionScope(OTHER_ELECTION);
  const messageA = commitmentMessage(COMMITMENT_A);
  const messageB = commitmentMessage(COMMITMENT_B);
  const attackerGroup = new Group([ATTACKER.commitment]);
  const [validProof, member1Proof, scopeBProof, attackerProof] = await Promise.all([
    generateProof(MEMBERS[0], group, messageA, scopeA),
    generateProof(MEMBERS[1], group, messageB, scopeA),
    generateProof(MEMBERS[0], group, messageA, scopeB),
    generateProof(ATTACKER, attackerGroup, messageA, scopeA),
  ]);
  const tampered = structuredClone(validProof);
  const point = tampered.points[0];
  tampered.points[0] = point.slice(0, -1) + (point.endsWith('0') ? '1' : '0');
  corpus = { group, scopeA, scopeB, messageA, validProof, member1Proof, scopeBProof, attackerProof, tampered };
  return corpus;
}

function seedGroup(store, electionId = ELECTION, count = 3) {
  const refs = ['PM-1001', 'PM-1002', 'PM-1003'];
  for (let i = 0; i < count; i += 1) {
    store.enrollCommitment({ electionId, voterRef: refs[i], commitment: MEMBER_COMMITMENTS[i] });
  }
}

async function authedAgent(app, store, { voterRef = 'PM-1001', electionId = ELECTION } = {}) {
  await store.savePasskey({
    id: `cred-${voterRef}`, voterRef, electionId,
    userIdBase64: 'dXNlcg', publicKeyBase64: 'AQID', counter: 1,
  });
  const session = await store.createSession({
    voterRef, electionId, credentialId: `cred-${voterRef}`, ttlMs: 3600000,
  });
  const agent = request.agent(app);
  await agent.jar.setCookie(`cp_session=${session.id}`);
  return { agent, csrfToken: session.csrfToken };
}

function submitAnonymous(app, body, headers = {}) {
  // Deliberately NOT an agent: no cookies are stored or sent.
  return request(app).post('/api/ballots/anonymous').set(headers).send(body);
}

let store;

before(async () => {
  await buildCorpus();
});

beforeEach(() => {
  store = new MemoryStore();
});

// -- enrollment ---------------------------------------------------------------
test('enrollment binds one commitment per eligible voter with versioned snapshots', async () => {
  const app = createApp(store, { aiClient: null });
  const { agent, csrfToken } = await authedAgent(app, store);
  const headers = { 'x-csrf-token': csrfToken };

  const first = await agent.post('/api/semaphore/enroll').set(headers).send({
    electionId: ELECTION, commitment: MEMBER_COMMITMENTS[0],
  });
  assert.equal(first.status, 201);
  assert.equal(first.body.version, 1);
  assert.equal(first.body.index, 0);
  assert.ok(first.body.root);

  const { agent: agent2, csrfToken: csrf2 } = await authedAgent(app, store, { voterRef: 'PM-1002' });
  const second = await agent2.post('/api/semaphore/enroll').set(headers).set({ 'x-csrf-token': csrf2 }).send({
    electionId: ELECTION, commitment: MEMBER_COMMITMENTS[1],
  });
  assert.equal(second.status, 201);
  assert.equal(second.body.version, 2);
  assert.notEqual(second.body.root, first.body.root);

  // Group endpoint serves the approved snapshot; root cross-checked by
  // rebuilding a real Group client-side from the served members.
  const groupRes = await request(app).get(`/api/semaphore/group/${ELECTION}`);
  assert.equal(groupRes.status, 200);
  assert.deepEqual(groupRes.body.members, [MEMBER_COMMITMENTS[0], MEMBER_COMMITMENTS[1]]);
  assert.equal(groupRes.body.scope, electionScope(ELECTION));
  const rebuilt = new Group(groupRes.body.members.map(BigInt));
  assert.equal(rebuilt.root.toString(), groupRes.body.root);
});

test('enrollment enforces auth, eligibility, and uniqueness', async () => {
  const app = createApp(store, { aiClient: null });
  const body = { electionId: ELECTION, commitment: MEMBER_COMMITMENTS[0] };

  assert.equal((await request(app).post('/api/semaphore/enroll').send(body)).status, 401);

  const { agent, csrfToken } = await authedAgent(app, store);
  const headers = { 'x-csrf-token': csrfToken };
  assert.equal((await agent.post('/api/semaphore/enroll').send(body)).status, 403); // no CSRF
  assert.equal(
    (await agent.post('/api/semaphore/enroll').set(headers).send({ ...body, electionId: OTHER_ELECTION })).status,
    403, // session bound to a different election
  );
  assert.equal((await agent.post('/api/semaphore/enroll').set(headers).send(body)).status, 201);
  assert.equal((await agent.post('/api/semaphore/enroll').set(headers).send(body)).status, 409); // same voter
  const { agent: agent2, csrfToken: csrf2 } = await authedAgent(app, store, { voterRef: 'PM-1002' });
  assert.equal(
    (await agent2.post('/api/semaphore/enroll').set({ 'x-csrf-token': csrf2 }).send(body)).status,
    409, // same commitment, different voter
  );
  assert.equal(
    (await agent.post('/api/semaphore/enroll').set(headers).send({ ...body, commitment: 'not-a-number' })).status,
    400,
  );
});

test('enrollment is closed with the election; unknown elections 404', async () => {
  const app = createApp(store, { aiClient: null });
  const { agent, csrfToken } = await authedAgent(app, store, { voterRef: 'PM-3001', electionId: 'library-levy-2025' });
  const res = await agent.post('/api/semaphore/enroll').set({ 'x-csrf-token': csrfToken }).send({
    electionId: 'library-levy-2025', commitment: MEMBER_COMMITMENTS[0],
  });
  assert.equal(res.status, 409);
  assert.equal((await request(app).get('/api/semaphore/group/does-not-exist')).status, 404);
  const empty = await request(app).get(`/api/semaphore/group/${ELECTION}`);
  assert.deepEqual(empty.body.members, []);
  assert.equal(empty.body.version, 0);
  assert.equal(empty.body.root, null);
});

// -- anonymous submission -------------------------------------------------------
test('valid group member proof is accepted anonymously', async () => {
  const app = createApp(store, { aiClient: null });
  seedGroup(store);
  const res = await submitAnonymous(app, {
    electionId: ELECTION, ballotCommitment: COMMITMENT_A, proof: corpus.validProof,
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.verified, true);
  assert.equal(res.body.ballot.nullifierHash, corpus.validProof.nullifier);
  assert.equal(res.body.ballot.ballotCommitment, COMMITMENT_A);

  const serialised = JSON.stringify(res.body);
  assert.ok(!serialised.includes('PM-'), 'voter ref leaked into response');
  const events = await store.listAudit({ electionId: ELECTION, type: 'ballot.cast' });
  assert.equal(events.length, 1);
  assert.match(events[0].detail, /Anonymous Semaphore ballot/);
  assert.ok(!JSON.stringify(events).includes('PM-'), 'voter ref leaked into audit');
});

test('second member votes with a distinct nullifier', async () => {
  const app = createApp(store, { aiClient: null });
  seedGroup(store);
  const first = await submitAnonymous(app, {
    electionId: ELECTION, ballotCommitment: COMMITMENT_A, proof: corpus.validProof,
  });
  const second = await submitAnonymous(app, {
    electionId: ELECTION, ballotCommitment: COMMITMENT_B, proof: corpus.member1Proof,
  });
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.notEqual(first.body.ballot.nullifierHash, second.body.ballot.nullifierHash);
});

test('non-member proof over an unknown root is rejected', async () => {
  const app = createApp(store, { aiClient: null });
  seedGroup(store);
  // Attacker proof is a GENUINE valid SNARK — over the attacker's own group.
  // It must still fail: the root was never approved by this server.
  const res = await submitAnonymous(app, {
    electionId: ELECTION, ballotCommitment: COMMITMENT_A, proof: corpus.attackerProof,
  });
  assert.equal(res.status, 401);
  assert.match(res.body.error, /not approved/);
  const events = await store.listAudit({ electionId: ELECTION, type: 'proof.rejected' });
  assert.equal(events.length, 1);
  assert.match(events[0].detail, /unknown group root/);
});

test('tampered proof fails verification', async () => {
  const app = createApp(store, { aiClient: null });
  seedGroup(store);
  const res = await submitAnonymous(app, {
    electionId: ELECTION, ballotCommitment: COMMITMENT_A, proof: corpus.tampered,
  });
  assert.equal(res.status, 401);
  assert.match(res.body.error, /failed verification/);
});

test('wrong election scope is rejected', async () => {
  const app = createApp(store, { aiClient: null });
  seedGroup(store);
  const res = await submitAnonymous(app, {
    electionId: ELECTION, ballotCommitment: COMMITMENT_A, proof: corpus.scopeBProof,
  });
  assert.equal(res.status, 401);
  assert.match(res.body.error, /scope/);
});

test('modified ballot commitment breaks the message binding', async () => {
  const app = createApp(store, { aiClient: null });
  seedGroup(store);
  // Proof binds COMMITMENT_A; submitting it with COMMITMENT_B must fail.
  const res = await submitAnonymous(app, {
    electionId: ELECTION, ballotCommitment: COMMITMENT_B, proof: corpus.validProof,
  });
  assert.equal(res.status, 401);
  assert.match(res.body.error, /does not match the proof/);
});

test('reused nullifier is rejected as a duplicate', async () => {
  const app = createApp(store, { aiClient: null });
  seedGroup(store);
  const body = { electionId: ELECTION, ballotCommitment: COMMITMENT_A, proof: corpus.validProof };
  assert.equal((await submitAnonymous(app, body)).status, 201);
  const replay = await submitAnonymous(app, body);
  assert.equal(replay.status, 409);
  assert.match(replay.body.error, /Duplicate vote/);
  const events = await store.listAudit({ electionId: ELECTION, type: 'ballot.rejected' });
  assert.ok(events.some((e) => /duplicate/i.test(e.detail)));
});

test('concurrent duplicate submissions collapse to exactly one ballot', async () => {
  const app = createApp(store, { aiClient: null });
  seedGroup(store);
  const body = { electionId: ELECTION, ballotCommitment: COMMITMENT_A, proof: corpus.validProof };
  const results = await Promise.all([submitAnonymous(app, body), submitAnonymous(app, body)]);
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
  assert.equal((await store.listAudit({ electionId: ELECTION, type: 'ballot.cast' })).length, 1);
});

test('malformed proofs are rejected with 400 and never 500', async () => {
  const app = createApp(store, { aiClient: null });
  seedGroup(store);
  const before = (await store.listAudit({ electionId: ELECTION })).length;
  const malformed = [
    null,
    'not-an-object',
    {},
    { ...corpus.validProof, points: corpus.validProof.points.slice(0, 4) },
    { ...corpus.validProof, merkleTreeDepth: 0 },
    { ...corpus.validProof, merkleTreeDepth: 99 },
    { ...corpus.validProof, scope: 'not-a-number' },
    { ...corpus.validProof, nullifier: '-5' },
  ];
  for (const proof of malformed) {
    const res = await submitAnonymous(app, { electionId: ELECTION, ballotCommitment: COMMITMENT_A, proof });
    assert.equal(res.status, 400);
  }
  // Malformed input is a client error, not an audited verification failure.
  assert.equal((await store.listAudit({ electionId: ELECTION })).length, before);
});

test('anonymous endpoint ignores identity-bearing state', async () => {
  const app = createApp(store, { aiClient: null });
  seedGroup(store);
  const res = await submitAnonymous(
    app,
    { electionId: ELECTION, ballotCommitment: COMMITMENT_A, proof: corpus.validProof },
    { Cookie: 'cp_session=bogus-session-value' },
  );
  assert.equal(res.status, 201);
  assert.ok(!('set-cookie' in res.headers), 'anonymous response must not set cookies');
  const ballot = store.ballots.get(corpus.validProof.nullifier);
  assert.deepEqual(Object.keys(ballot).sort(), ['anonymous', 'ballotCommitment', 'castAt', 'electionId', 'nullifierHash']);
});

test('private identity secrets are never accepted, stored, or echoed', async () => {
  const app = createApp(store, { aiClient: null });
  const { agent, csrfToken } = await authedAgent(app, store);
  const secretMarker = 'LEAK-PROBE-trapdoor-nullifier-secret';
  const res = await agent.post('/api/semaphore/enroll').set({ 'x-csrf-token': csrfToken }).send({
    electionId: ELECTION,
    commitment: MEMBER_COMMITMENTS[0],
    privateKey: secretMarker,
    secretScalar: secretMarker,
    trapdoor: secretMarker,
  });
  assert.equal(res.status, 201);
  assert.ok(!JSON.stringify(res.body).includes(secretMarker));

  const stored = JSON.stringify({
    group: await store.getSemaphoreGroup(ELECTION),
    enrollments: [...store.zkEnrollments.values()],
    audit: await store.listAudit({ electionId: ELECTION }),
  });
  assert.ok(!stored.includes(secretMarker), 'injected secret field was persisted');
  for (const identity of [...MEMBERS, ATTACKER]) {
    assert.ok(!stored.includes(identity.export()), 'identity export material persisted');
  }
  // Commitments are public by design — but must differ from any secret.
  assert.ok(!MEMBER_COMMITMENTS[0].includes(secretMarker));
});

test('duplicate-nullifier rejection survives an API restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'civicproof-zk-'));
  const persistPath = path.join(dir, 'store.json');
  try {
    const store1 = new MemoryStore({ persistPath });
    seedGroup(store1);
    const app1 = createApp(store1, { aiClient: null });
    const body = { electionId: ELECTION, ballotCommitment: COMMITMENT_A, proof: corpus.validProof };
    assert.equal((await submitAnonymous(app1, body)).status, 201);

    // "Restart": a brand-new store instance over the same snapshot file.
    const store2 = new MemoryStore({ persistPath });
    const app2 = createApp(store2, { aiClient: null });
    const group = await store2.getSemaphoreGroup(ELECTION);
    assert.equal(group.version, 3);
    assert.deepEqual(group.members, MEMBER_COMMITMENTS);
    assert.equal((await submitAnonymous(app2, body)).status, 409);
    // And the restored group still accepts a genuinely new member proof.
    const fresh = await submitAnonymous(app2, {
      electionId: ELECTION, ballotCommitment: COMMITMENT_B, proof: corpus.member1Proof,
    });
    assert.equal(fresh.status, 201);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('proof failures feed the invalid-proofs integrity rule with real seqs', async () => {
  const app = createApp(store, { aiClient: null });
  seedGroup(store);
  await submitAnonymous(app, {
    electionId: ELECTION, ballotCommitment: COMMITMENT_A, proof: corpus.attackerProof,
  });
  await submitAnonymous(app, {
    electionId: ELECTION, ballotCommitment: COMMITMENT_A, proof: corpus.tampered,
  });
  const res = await request(app).get(`/api/ai/integrity?electionId=${ELECTION}`);
  const finding = res.body.ruleFindings.find((f) => f.ruleId === 'invalid-proofs');
  assert.ok(finding);
  assert.equal(finding.severity, 'medium');
  const seqs = new Set((await store.listAudit({ electionId: ELECTION })).map((e) => e.seq));
  for (const seq of finding.eventSeqs) assert.ok(seqs.has(seq), `unknown seq ${seq}`);
  assert.ok(!JSON.stringify(finding).includes('PM-'), 'voter ref leaked into finding');
});
