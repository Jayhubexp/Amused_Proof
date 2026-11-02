// Election types: candidate elections, referendums (Yes/No), and general
// polls. Covers validator behaviour per type, organizer create/patch flows,
// user-friendly validation messages, legacy backward compatibility, and
// end-to-end voting consistency on party-free elections. MemoryStore +
// supertest only (no network, no database); the Mongo suite exercises the
// same API shape against a real database.
import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import request from 'supertest';
import { Identity } from '@semaphore-protocol/identity';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { MemoryStore } from '../src/store/memory.js';
import { requireCandidates, requireElectionType } from '../src/lib/validate.js';
import { resetRateLimits } from '../src/lib/rate-limit.js';

const SETUP_TOKEN = 'election-types-setup-token';
const ORG_PASSWORD = 'correct horse battery staple 02';

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
          credential: { id: `type-cred-${n}`, publicKey: new Uint8Array([n]), counter: 0 },
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
let previousSetupToken;

before(() => {
  previousSetupToken = config.organizerSetupToken;
  config.organizerSetupToken = SETUP_TOKEN;
});

after(() => {
  config.organizerSetupToken = previousSetupToken;
});

beforeEach(() => {
  resetRateLimits();
  store = new MemoryStore();
  app = createApp(store, { aiClient: null, webauthn: fakeWebAuthn() });
});

async function loginOrganizer(username = 'type-organizer') {
  const agent = request.agent(app);
  const setup = await agent.post('/api/organizer/setup').send({ token: SETUP_TOKEN, username, password: ORG_PASSWORD });
  assert.equal(setup.status, 201);
  const login = await agent.post('/api/organizer/login').send({ username, password: ORG_PASSWORD });
  assert.equal(login.status, 200);
  return { agent, csrfToken: login.body.csrfToken };
}

function postElection(agent, csrf, body) {
  return agent.post('/api/organizer/elections').set('x-csrf-token', csrf).send(body);
}

async function inviteVoter(agent, csrf, electionId) {
  const res = await agent
    .post(`/api/organizer/elections/${electionId}/invitations`)
    .set('x-csrf-token', csrf)
    .send({ count: 1, expiresInHours: 72 });
  assert.equal(res.status, 201);
  return res.body.invitations[0];
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

// -- validator unit tests ----------------------------------------------------

test('election type validator accepts candidate, referendum, and poll', () => {
  assert.equal(requireElectionType('candidate'), 'candidate');
  assert.equal(requireElectionType('referendum'), 'referendum');
  assert.equal(requireElectionType('poll'), 'poll');
  assert.throws(() => requireElectionType('primary'), /candidate.*referendum.*poll/);
  assert.throws(() => requireElectionType(undefined), /candidate.*referendum.*poll/);
});

test('candidate choices keep party optional and omit blank parties', () => {
  const out = requireCandidates(
    [{ name: 'Amara Okafor', party: 'Harbor Alliance' }, { name: 'Luis Reyes' }, { name: 'Priya N.', party: '' }],
    'candidates',
    { electionType: 'candidate' },
  );
  assert.deepEqual(out, [
    { name: 'Amara Okafor', party: 'Harbor Alliance' },
    { name: 'Luis Reyes' },
    { name: 'Priya N.' },
  ]);
});

test('legacy stored choices with parties still validate', () => {
  const out = requireCandidates([
    { id: 'yes-fund', name: 'Yes — approve funding', party: 'Measure' },
    { id: 'no-fund', name: 'No — reject funding', party: 'Measure' },
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].party, 'Measure');
});

test('blank choice names fail with a user-friendly message', () => {
  assert.throws(
    () => requireCandidates([{ name: 'Fine' }, { name: '   ' }]),
    (err) => err.status === 400 && err.message === 'Choice 2 needs a name.',
  );
  assert.throws(
    () => requireCandidates([{ name: 'Fine' }]),
    (err) => err.status === 400 && /at least two ballot choices/.test(err.message),
  );
});

test('referendum choices require exactly two options and no party', () => {
  const out = requireCandidates([{ name: 'Yes' }, { name: 'No' }], 'candidates', { electionType: 'referendum' });
  assert.deepEqual(out, [{ name: 'Yes' }, { name: 'No' }]);
  assert.throws(
    () => requireCandidates([{ name: 'Yes' }, { name: 'No' }, { name: 'Maybe' }], 'candidates', { electionType: 'referendum' }),
    (err) => err.status === 400 && /exactly two options/.test(err.message),
  );
});

test('poll choices accept 2-20 party-free options', () => {
  const out = requireCandidates(
    [{ name: 'Option A' }, { name: 'Option B' }, { name: 'Option C' }],
    'candidates',
    { electionType: 'poll' },
  );
  assert.equal(out.length, 3);
  assert.ok(out.every((c) => c.party === undefined));
});

// -- organizer routes --------------------------------------------------------

test('organizer creates a candidate election with parties', async () => {
  const { agent, csrfToken } = await loginOrganizer();
  const res = await postElection(agent, csrfToken, {
    title: 'Board Seat',
    electionType: 'candidate',
    candidates: [
      { name: 'Amara Okafor', party: 'Harbor Alliance' },
      { name: 'Luis Reyes', party: 'Shoreline Independents' },
    ],
    votingMode: 'standard',
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.election.electionType, 'candidate');
  assert.deepEqual(res.body.election.candidates.map((c) => c.party), ['Harbor Alliance', 'Shoreline Independents']);
  assert.ok(res.body.election.candidates.every((c) => c.id));
});

test('organizer creates a referendum and a poll without parties', async () => {
  const { agent, csrfToken } = await loginOrganizer();
  const referendum = await postElection(agent, csrfToken, {
    title: 'Night-bus funding',
    electionType: 'referendum',
    candidates: [{ name: 'Yes' }, { name: 'No' }],
    votingMode: 'anonymous',
  });
  assert.equal(referendum.status, 201);
  assert.equal(referendum.body.election.electionType, 'referendum');

  const poll = await postElection(agent, csrfToken, {
    title: 'Park design',
    electionType: 'poll',
    candidates: [{ name: 'Meadow' }, { name: 'Plaza' }, { name: 'Garden' }],
    votingMode: 'standard',
  });
  assert.equal(poll.status, 201);
  assert.equal(poll.body.election.electionType, 'poll');
  assert.equal(poll.body.election.candidates.length, 3);
});

test('omitted election type defaults to candidate', async () => {
  const { agent, csrfToken } = await loginOrganizer();
  const res = await postElection(agent, csrfToken, {
    title: 'Legacy-shaped request',
    candidates: [{ name: 'A' }, { name: 'B' }],
    votingMode: 'standard',
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.election.electionType, 'candidate');
});

test('creation rejects bad ballots with user-friendly errors, not field paths', async () => {
  const { agent, csrfToken } = await loginOrganizer();
  const threeWayReferendum = await postElection(agent, csrfToken, {
    title: 'Bad referendum',
    electionType: 'referendum',
    candidates: [{ name: 'Yes' }, { name: 'No' }, { name: 'Maybe' }],
    votingMode: 'standard',
  });
  assert.equal(threeWayReferendum.status, 400);
  assert.match(threeWayReferendum.body.error, /exactly two options/);
  assert.doesNotMatch(threeWayReferendum.body.error, /candidates\[\d+\]/);

  const nameless = await postElection(agent, csrfToken, {
    title: 'Nameless choice',
    electionType: 'poll',
    candidates: [{ name: 'Fine' }, { name: '' }],
    votingMode: 'standard',
  });
  assert.equal(nameless.status, 400);
  assert.equal(nameless.body.error, 'Choice 2 needs a name.');
});

test('empty-string party is accepted and omitted (reported bug)', async () => {
  const { agent, csrfToken } = await loginOrganizer();
  const res = await postElection(agent, csrfToken, {
    title: 'No-party race',
    electionType: 'candidate',
    candidates: [
      { name: 'Amara Okafor', party: '' },
      { name: 'Luis Reyes', party: '' },
    ],
    votingMode: 'standard',
  });
  assert.equal(res.status, 201);
  assert.ok(res.body.election.candidates.every((c) => c.party === undefined));
});

test('election type is editable in draft and locked afterwards', async () => {
  const { agent, csrfToken } = await loginOrganizer();
  const created = await postElection(agent, csrfToken, {
    title: 'Retyped election',
    electionType: 'candidate',
    candidates: [{ name: 'A' }, { name: 'B' }],
    votingMode: 'standard',
  });
  assert.equal(created.status, 201);
  const id = created.body.election.id;

  const patch = await agent
    .patch(`/api/organizer/elections/${id}`)
    .set('x-csrf-token', csrfToken)
    .send({ electionType: 'poll' });
  assert.equal(patch.status, 200);
  assert.equal(patch.body.election.electionType, 'poll');

  const open = await agent.post(`/api/organizer/elections/${id}/open`).set('x-csrf-token', csrfToken).send();
  assert.equal(open.status, 200);

  const relock = await agent
    .patch(`/api/organizer/elections/${id}`)
    .set('x-csrf-token', csrfToken)
    .send({ electionType: 'candidate' });
  assert.equal(relock.status, 409);
});

test('retyping to referendum validates the stored choices', async () => {
  const { agent, csrfToken } = await loginOrganizer();
  const created = await postElection(agent, csrfToken, {
    title: 'Three-way draft',
    electionType: 'poll',
    candidates: [{ name: 'A' }, { name: 'B' }, { name: 'C' }],
    votingMode: 'standard',
  });
  assert.equal(created.status, 201);
  const id = created.body.election.id;

  const retype = await agent
    .patch(`/api/organizer/elections/${id}`)
    .set('x-csrf-token', csrfToken)
    .send({ electionType: 'referendum' });
  assert.equal(retype.status, 400);
  assert.match(retype.body.error, /exactly two options/);
});

test('legacy elections read as candidate type with parties intact', async () => {
  const list = await request(app).get('/api/elections');
  assert.equal(list.status, 200);
  const metro = list.body.elections.find((e) => e.id === 'metro-transit-2026');
  assert.equal(metro.electionType, 'candidate');
  assert.deepEqual(metro.candidates.map((c) => c.party), ['Measure', 'Measure']);

  const detail = await request(app).get('/api/elections/harbor-board-2026');
  assert.equal(detail.status, 200);
  assert.equal(detail.body.election.electionType, 'candidate');
  assert.equal(detail.body.election.candidates.length, 3);
});

// -- voting consistency ------------------------------------------------------

test('standard ballot works end-to-end on a party-free poll', async () => {
  const { agent: org, csrfToken: orgCsrf } = await loginOrganizer();
  const created = await postElection(org, orgCsrf, {
    title: 'Park design poll',
    electionType: 'poll',
    candidates: [{ name: 'Meadow' }, { name: 'Plaza' }],
    votingMode: 'standard',
  });
  assert.equal(created.status, 201);
  const electionId = created.body.election.id;
  const [firstChoice] = created.body.election.candidates;

  const open = await org.post(`/api/organizer/elections/${electionId}/open`).set('x-csrf-token', orgCsrf).send();
  assert.equal(open.status, 200);

  // Choice ids are stable between the create response and public reads.
  const detail = await request(app).get(`/api/elections/${electionId}`);
  assert.deepEqual(detail.body.election.candidates.map((c) => c.id), created.body.election.candidates.map((c) => c.id));

  const invitation = await inviteVoter(org, orgCsrf, electionId);
  await registerInvited({ token: invitation.token, electionId });
  const { agent: voter, csrfToken: voterCsrf } = await loginVoter({ voterRef: invitation.voterRef, electionId });

  const ballotCommitment = createHash('sha256').update(`${firstChoice.id}:${voterCsrf}:${electionId}`).digest('hex');
  const cast = await voter.post('/api/ballots').set('x-csrf-token', voterCsrf).send({ electionId, ballotCommitment });
  assert.equal(cast.status, 201);

  const duplicate = await voter.post('/api/ballots').set('x-csrf-token', voterCsrf).send({ electionId, ballotCommitment });
  assert.equal(duplicate.status, 409);
});

test('Semaphore enrollment works on an anonymous referendum', async () => {
  const { agent: org, csrfToken: orgCsrf } = await loginOrganizer();
  const created = await postElection(org, orgCsrf, {
    title: 'Transit referendum',
    electionType: 'referendum',
    candidates: [{ name: 'Yes' }, { name: 'No' }],
    votingMode: 'anonymous',
  });
  assert.equal(created.status, 201);
  const electionId = created.body.election.id;

  const enrolment = await org.post(`/api/organizer/elections/${electionId}/start-enrolment`).set('x-csrf-token', orgCsrf).send();
  assert.equal(enrolment.status, 200);

  const invitation = await inviteVoter(org, orgCsrf, electionId);
  await registerInvited({ token: invitation.token, electionId });
  const { agent: voter, csrfToken: voterCsrf } = await loginVoter({ voterRef: invitation.voterRef, electionId });

  const identity = new Identity();
  const enroll = await voter
    .post('/api/semaphore/enroll')
    .set('x-csrf-token', voterCsrf)
    .send({ electionId, commitment: identity.commitment.toString() });
  assert.equal(enroll.status, 201);
  assert.equal(enroll.body.enrolled, true);
});
