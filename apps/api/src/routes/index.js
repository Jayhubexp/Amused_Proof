import { randomBytes } from 'node:crypto';
import { Router } from '../lib/http.js';
import { requireHex64, requireId, requireInvitationToken, requirePin, requireString, requireVoterRef } from '../lib/validate.js';
import { randomHex, sha256Hex } from '../lib/crypto.js';
import { RATE_LIMITS, checkRateLimit, rateLimit } from '../lib/rate-limit.js';
import { config } from '../config.js';
import {
  buildAuthenticationOptions,
  buildRegistrationOptions,
  defaultWebAuthnLib,
  verifyAuthentication,
  verifyRegistration,
} from '../auth/webauthn.js';
import {
  SESSION_COOKIE,
  clearSessionCookie,
  requireCsrf,
  requireSession,
  sessionCookieOptions,
} from '../auth/session.js';
import { analyzeIntegrity, askQuestion } from '../ai/analyze.js';
import { MuseSparkError } from '../ai/muse.js';
import {
  commitmentMessage,
  electionScope,
  validateCommitment,
  validateProofShape,
  verifyMembershipProof,
} from '../zk/semaphore.js';

function clientIp(req) {
  return req.ip ?? req.socket?.remoteAddress ?? 'unknown';
}

// Invitation-path registration options. Unknown, revoked, expired, and
// election-mismatched tokens all yield one uniform 403 (no validity oracle),
// and attempts are strictly rate-limited per IP.
async function registerOptionsForInvitation(req, res, store, webauthn, election, invitationToken) {
  const attempt = await checkRateLimit(`invitation:${clientIp(req)}`, RATE_LIMITS.invitation);
  if (!attempt.allowed) {
    res.setHeader('Retry-After', String(attempt.retryAfterSec));
    return res.status(429).json({ error: 'Too many attempts. Try again later.' });
  }
  if (req.body?.voterRef !== undefined || req.body?.pin !== undefined) {
    return res.status(400).json({ error: 'Provide either an invitation token or voter reference + PIN, not both.' });
  }
  const token = requireInvitationToken(invitationToken);
  const invitation = await store.peekInvitation(token);
  if (!invitation || invitation.electionId !== election.id || (election.access ?? 'roll') !== 'invitation') {
    return res.status(403).json({ error: 'Invalid or expired invitation.' });
  }
  const existing = await store.getPasskeysByVoter(invitation.voterRef, election.id);
  if (existing.length > 0) {
    return res.status(409).json({ error: 'This voter has already registered a passkey for this election.' });
  }
  // Opaque user handle: random bytes, never the voter ref.
  const userIdBytes = randomBytes(32);
  const options = await buildRegistrationOptions(webauthn, {
    rpName: config.rpName,
    rpId: config.rpId,
    userName: invitation.voterRef,
    userDisplayName: invitation.label || 'Invited voter',
    userIdBytes,
    excludeCredentialIds: existing.map((p) => p.id),
  });
  const requestId = randomHex(16);
  await store.saveWebAuthnChallenge({
    id: requestId,
    challenge: options.challenge,
    type: 'registration',
    voterRef: invitation.voterRef,
    electionId: election.id,
    userIdBase64: Buffer.from(userIdBytes).toString('base64url'),
    invitationHash: sha256Hex(token),
  });
  return res.status(201).json({ requestId, options });
}

export function buildRouter(store, { aiClient = null, webauthn = defaultWebAuthnLib } = {}) {
  const router = Router();
  const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

  // Defence in depth for cookie-authenticated mutations: reject cross-origin
  // POSTs outright (in addition to SameSite=Lax cookies and CSRF tokens).
  const allowedOrigins = new Set([...config.corsOrigins, config.webauthnOrigin]);
  router.use((req, res, next) => {
    const origin = req.headers.origin;
    if (req.method === 'POST' && origin && !allowedOrigins.has(origin)) {
      return res.status(403).json({ error: 'Cross-origin request rejected.' });
    }
    next();
  });

  router.get('/health', (req, res) => {
    res.json({ ok: true, store: store.mode, prototype: true });
  });

  // -- elections -------------------------------------------------------------
  router.get('/elections', asyncHandler(async (req, res) => {
    res.json({ elections: await store.listElections() });
  }));

  router.get('/elections/:id', asyncHandler(async (req, res) => {
    const election = await store.getElection(requireId(req.params.id, 'election id'));
    if (!election) return res.status(404).json({ error: 'Unknown election.' });
    res.json({ election });
  }));

  // -- WebAuthn passkey registration (eligibility-gated) -----------------------
  // Two eligibility paths: fictional-roll PIN (legacy demo elections) or a
  // single-use organizer invitation. Never both in one request.
  router.post('/webauthn/register/options', rateLimit(RATE_LIMITS.registration), asyncHandler(async (req, res) => {
    const electionId = requireId(req.body?.electionId, 'election id');
    const election = await store.getElection(electionId);
    if (!election) return res.status(404).json({ error: 'Unknown election.' });
    // Passkey registration is allowed in any live phase (legacy open included).
    if (!['open', 'enrolment', 'frozen', 'voting'].includes(election.status)) {
      return res.status(409).json({ error: 'Election is not open for registration.' });
    }
    const invitationToken = req.body?.invitationToken;
    if (invitationToken !== undefined && invitationToken !== '') {
      return registerOptionsForInvitation(req, res, store, webauthn, election, invitationToken);
    }
    // The roll path is closed on invitation-access elections.
    if ((election.access ?? 'roll') !== 'roll') {
      return res.status(403).json({ error: 'This election requires an invitation to register.' });
    }
    const voterRef = requireVoterRef(req.body?.voterRef);
    const pin = requirePin(req.body?.pin);
    // Only voters on the fictional roll, with the matching demo PIN, may
    // register. Wrong ref and wrong PIN give the same answer (no oracle).
    const entry = await store.getRollEntry(voterRef, electionId);
    if (!entry || !store.checkRollPin(entry, pin)) {
      return res.status(403).json({ error: 'Invalid voter reference or PIN.' });
    }
    const existing = await store.getPasskeysByVoter(voterRef, electionId);
    if (existing.length > 0) {
      return res.status(409).json({ error: 'This voter has already registered a passkey for this election.' });
    }
    // Opaque user handle: random bytes, never the voter ref.
    const userIdBytes = randomBytes(32);
    const options = await buildRegistrationOptions(webauthn, {
      rpName: config.rpName,
      rpId: config.rpId,
      userName: voterRef,
      userDisplayName: entry.displayName,
      userIdBytes,
      excludeCredentialIds: existing.map((p) => p.id),
    });
    const requestId = randomHex(16);
    await store.saveWebAuthnChallenge({
      id: requestId,
      challenge: options.challenge,
      type: 'registration',
      voterRef,
      electionId,
      userIdBase64: Buffer.from(userIdBytes).toString('base64url'),
    });
    res.status(201).json({ requestId, options });
  }));

  router.post('/webauthn/register/verify', asyncHandler(async (req, res) => {
    const requestId = requireString(req.body?.requestId, 'request id', { max: 120 });
    const response = req.body?.response;
    if (!response || typeof response !== 'object' || Array.isArray(response)) {
      return res.status(400).json({ error: 'Invalid attestation response: expected an object.' });
    }
    const ceremony = await store.consumeWebAuthnChallenge(requestId, 'registration');
    let info;
    try {
      info = await verifyRegistration(webauthn, {
        response,
        expectedChallenge: ceremony.challenge,
        rpId: config.rpId,
        origin: config.webauthnOrigin,
      });
    } catch (err) {
      await store.auditAuthFailure({
        electionId: ceremony.electionId,
        credentialId: typeof response.id === 'string' ? response.id : null,
        detail: 'Passkey registration failed verification.',
      });
      throw err;
    }
    const credential = info.credential;
    const passkey = {
      id: credential.id,
      voterRef: ceremony.voterRef,
      electionId: ceremony.electionId,
      userIdBase64: ceremony.userIdBase64,
      publicKeyBase64: Buffer.from(credential.publicKey).toString('base64'),
      counter: credential.counter,
      transports: response.response?.transports ?? credential.transports ?? [],
      deviceType: info.credentialDeviceType,
      backedUp: info.credentialBackedUp,
    };
    if (ceremony.invitationHash) {
      // Atomic redeem-and-save: a token consumed between options and verify
      // surfaces the same uniform 403 as an unknown token (thrown by store).
      await store.registerInvitedPasskey({ tokenHash: ceremony.invitationHash, passkey });
    } else {
      await store.savePasskey(passkey);
    }
    res.status(201).json({
      registered: true,
      voterRef: ceremony.voterRef,
      electionId: ceremony.electionId,
    });
  }));

  // Invitation pre-check for the redeem UI. 200 with { valid: false } for
  // every failure mode — no status-code oracle between unknown, revoked,
  // expired, and mismatched tokens. Redemption itself happens atomically
  // inside register/verify, so there is deliberately no separate redeem
  // endpoint whose window could be raced.
  router.post('/invitations/validate', asyncHandler(async (req, res) => {
    const attempt = await checkRateLimit(`invitation:${clientIp(req)}`, RATE_LIMITS.invitation);
    if (!attempt.allowed) {
      res.setHeader('Retry-After', String(attempt.retryAfterSec));
      return res.status(429).json({ error: 'Too many attempts. Try again later.' });
    }
    let invitation = null;
    try {
      invitation = await store.peekInvitation(requireInvitationToken(req.body?.invitationToken));
    } catch {
      invitation = null;
    }
    const election = invitation ? await store.getElection(invitation.electionId) : null;
    const expectedElection = req.body?.electionId;
    const valid = Boolean(
      invitation
      && election
      && ['open', 'enrolment', 'frozen', 'voting'].includes(election.status)
      && (election.access ?? 'roll') === 'invitation'
      && (expectedElection === undefined || expectedElection === election.id),
    );
    if (!valid) return res.json({ valid: false });
    res.json({ valid: true, election: { id: election.id, title: election.title } });
  }));

  // -- WebAuthn passkey authentication -----------------------------------------
  router.post('/webauthn/auth/options', asyncHandler(async (req, res) => {
    const electionId = requireId(req.body?.electionId, 'election id');
    const voterRef = requireVoterRef(req.body?.voterRef);
    const passkeys = await store.getPasskeysByVoter(voterRef, electionId);
    if (passkeys.length === 0) {
      return res.status(404).json({ error: 'No passkey registered for this voter in this election.' });
    }
    const options = await buildAuthenticationOptions(webauthn, {
      rpId: config.rpId,
      allowCredentials: passkeys.map((p) => ({ id: p.id, transports: p.transports })),
    });
    const requestId = randomHex(16);
    await store.saveWebAuthnChallenge({
      id: requestId,
      challenge: options.challenge,
      type: 'authentication',
      voterRef,
      electionId,
      allowCredentialIds: passkeys.map((p) => p.id),
    });
    res.json({ requestId, options });
  }));

  router.post('/webauthn/auth/verify', asyncHandler(async (req, res) => {
    const requestId = requireString(req.body?.requestId, 'request id', { max: 120 });
    const response = req.body?.response;
    if (!response || typeof response !== 'object' || Array.isArray(response)) {
      return res.status(400).json({ error: 'Invalid assertion response: expected an object.' });
    }
    const ceremony = await store.consumeWebAuthnChallenge(requestId, 'authentication');
    // The asserted credential must be one this ceremony offered.
    const credId = typeof response.id === 'string' ? response.id : null;
    if (!credId || !ceremony.allowCredentialIds.includes(credId)) {
      await store.auditAuthFailure({
        electionId: ceremony.electionId,
        credentialId: credId,
        detail: 'Passkey authentication rejected: unknown credential identifier.',
      });
      return res.status(401).json({ error: 'Unknown passkey credential identifier.' });
    }
    const passkey = await store.getPasskey(credId);
    if (!passkey || passkey.voterRef !== ceremony.voterRef) {
      await store.auditAuthFailure({
        electionId: ceremony.electionId,
        credentialId: credId,
        detail: 'Passkey authentication rejected: credential not bound to this voter.',
      });
      return res.status(401).json({ error: 'Passkey authentication failed verification.' });
    }
    let info;
    try {
      info = await verifyAuthentication(webauthn, {
        response,
        expectedChallenge: ceremony.challenge,
        rpId: config.rpId,
        origin: config.webauthnOrigin,
        credential: {
          id: passkey.id,
          publicKey: Uint8Array.from(Buffer.from(passkey.publicKeyBase64, 'base64')),
          counter: passkey.counter,
          transports: passkey.transports,
        },
      });
    } catch (err) {
      await store.auditAuthFailure({
        electionId: ceremony.electionId,
        credentialId: credId,
        detail: 'Passkey authentication failed verification.',
      });
      throw err;
    }
    await store.updatePasskeyCounter(credId, info.newCounter, {
      deviceType: info.credentialDeviceType,
      backedUp: info.credentialBackedUp,
    });
    await store.auditAuthSuccess({ electionId: ceremony.electionId, credentialId: credId });
    const session = await store.createSession({
      voterRef: ceremony.voterRef,
      electionId: ceremony.electionId,
      credentialId: credId,
      ttlMs: config.sessionTtlMs,
    });
    res.cookie(SESSION_COOKIE, session.id, sessionCookieOptions(config));
    res.json({ csrfToken: session.csrfToken, voterRef: session.voterRef, electionId: session.electionId });
  }));

  // -- sessions ------------------------------------------------------------------
  router.get('/session', asyncHandler(async (req, res) => {
    const id = req.cookies?.[SESSION_COOKIE];
    const session = typeof id === 'string' ? await store.getSession(id) : null;
    if (!session) return res.json({ authenticated: false });
    res.json({ authenticated: true, voterRef: session.voterRef, electionId: session.electionId });
  }));

  router.post('/logout', asyncHandler(async (req, res) => {
    const id = req.cookies?.[SESSION_COOKIE];
    if (typeof id === 'string') await store.destroySession(id);
    clearSessionCookie(res, config);
    res.json({ loggedOut: true });
  }));

  // -- ballots (ENFORCED one-credential-one-vote, session-bound) ------------------
  // The voter authenticates with a passkey; the server derives the nullifier
  // from the session's passkey record. Clients never handle nullifiers.
  router.post('/ballots', asyncHandler(async (req, res) => {
    const session = await requireSession(store, req);
    requireCsrf(session, req);
    const electionId = requireId(req.body?.electionId, 'election id');
    const ballotCommitment = requireHex64(req.body?.ballotCommitment, 'ballot commitment');
    if (session.electionId !== electionId) {
      return res.status(403).json({ error: 'Session is not valid for this election.' });
    }
    const ballot = await store.castBallot({
      electionId,
      voterRef: session.voterRef,
      credentialId: session.credentialId,
      ballotCommitment,
    });
    res.status(201).json({ ballot, enforced: 'one-credential-one-vote' });
  }));

  // -- Semaphore anonymous credentials -----------------------------------------
  // Enrollment is authenticated (proves eligibility); submission is anonymous
  // (proves group membership). The two are deliberately separate calls.

  // Authenticated: bind one identity commitment to one eligible voter.
  // Only the commitment is accepted — private secrets must never be sent.
  router.post('/semaphore/enroll', asyncHandler(async (req, res) => {
    const session = await requireSession(store, req);
    requireCsrf(session, req);
    const electionId = requireId(req.body?.electionId, 'election id');
    if (session.electionId !== electionId) {
      return res.status(403).json({ error: 'Session is not valid for this election.' });
    }
    const commitment = validateCommitment(req.body?.commitment);
    const result = await store.enrollCommitment({
      electionId,
      voterRef: session.voterRef,
      commitment,
    });
    res.status(201).json({ enrolled: true, electionId, ...result });
  }));

  // Public: the server-approved group snapshot clients prove against.
  router.get('/semaphore/group/:electionId', asyncHandler(async (req, res) => {
    const electionId = requireId(req.params.electionId, 'election id');
    const election = await store.getElection(electionId);
    if (!election) return res.status(404).json({ error: 'Unknown election.' });
    const group = await store.getSemaphoreGroup(electionId);
    res.json({ ...group, scope: electionScope(electionId) });
  }));

  // Anonymous: submit a ballot with a Semaphore membership proof. No session,
  // no cookies, no CSRF token by design — identity-bearing state would defeat
  // the anonymity this endpoint exists to provide. (Same-origin POST
  // enforcement still applies via the middleware above.)
  router.post('/ballots/anonymous', rateLimit(RATE_LIMITS.anonymous), asyncHandler(async (req, res) => {
    const electionId = requireId(req.body?.electionId, 'election id');
    const ballotCommitment = requireHex64(req.body?.ballotCommitment, 'ballot commitment');
    const proof = validateProofShape(req.body?.proof);
    const election = await store.getElection(electionId);
    if (!election) return res.status(404).json({ error: 'Unknown election.' });
    if (election.status !== 'open' && election.status !== 'voting') {
      await store.auditAnonymousRejection({
        electionId,
        nullifier: proof.nullifier,
        detail: 'Ballot rejected: election is not open.',
      });
      return res.status(409).json({ error: 'Election is not open for voting.' });
    }
    // Mode gate before any proof work: standard elections never verify proofs.
    if (election.votingMode === 'standard') {
      await store.auditAnonymousRejection({
        electionId,
        nullifier: proof.nullifier,
        detail: 'Ballot rejected: election accepts standard ballots only.',
      });
      return res.status(409).json({ error: 'This election accepts standard ballots only.' });
    }
    // Cheap server-side binding checks first; the SNARK verification last.
    if (proof.scope !== electionScope(electionId)) {
      await store.auditProofRejection({
        electionId,
        nullifier: proof.nullifier,
        detail: 'Anonymous ballot rejected: proof scope is not this election.',
      });
      return res.status(401).json({ error: 'Proof scope does not match this election.' });
    }
    if (proof.message !== commitmentMessage(ballotCommitment)) {
      await store.auditProofRejection({
        electionId,
        nullifier: proof.nullifier,
        detail: 'Anonymous ballot rejected: ballot commitment does not match proof message.',
      });
      return res.status(401).json({ error: 'Ballot commitment does not match the proof.' });
    }
    if (!(await store.isApprovedRoot(electionId, proof.merkleTreeRoot))) {
      await store.auditProofRejection({
        electionId,
        nullifier: proof.nullifier,
        detail: 'Anonymous ballot rejected: unknown group root.',
      });
      return res.status(401).json({ error: 'Proof group root is not approved for this election.' });
    }
    if (!(await verifyMembershipProof(proof))) {
      await store.auditProofRejection({
        electionId,
        nullifier: proof.nullifier,
        detail: 'Anonymous ballot rejected: invalid membership proof.',
      });
      return res.status(401).json({ error: 'Membership proof failed verification.' });
    }
    const ballot = await store.insertAnonymousBallot({
      electionId,
      nullifier: proof.nullifier,
      ballotCommitment,
    });
    res.status(201).json({ ballot, verified: true, enforced: 'one-credential-one-vote' });
  }));

  // -- public audit ------------------------------------------------------------
  router.get('/audit', asyncHandler(async (req, res) => {
    const { electionId, type } = req.query;
    const limit = Math.min(Math.max(Number(req.query.limit ?? 100) || 100, 1), 500);
    if (electionId !== undefined) requireId(electionId, 'election id');
    if (type !== undefined) requireString(type, 'event type', { max: 40 });
    res.json({ events: await store.listAudit({ electionId, type, limit }) });
  }));

  // -- read-only AI integrity assistant (deterministic rules + Muse Spark) ----
  // GET always answers 200: AI failures degrade to rules-only with aiStatus set.
  router.get('/ai/integrity', asyncHandler(async (req, res) => {
    const electionId = req.query.electionId;
    if (electionId !== undefined) requireId(electionId, 'election id');
    res.json(await analyzeIntegrity(store, aiClient, { electionId: electionId ?? null }));
  }));

  // Natural-language questions answered strictly from the audit log.
  router.post('/ai/ask', asyncHandler(async (req, res) => {
    const electionId = req.body?.electionId ?? null;
    if (electionId !== null) requireId(electionId, 'election id');
    const question = requireString(req.body?.question, 'question', { max: 500 });
    if (!aiClient) {
      return res.status(503).json({
        error:
          'AI assistant is unavailable: MUSE_SPARK_API_KEY is not configured. ' +
          'Deterministic rule findings remain available via GET /api/ai/integrity.',
      });
    }
    try {
      res.json({
        ...(await askQuestion(store, aiClient, { electionId, question })),
        readOnly: true,
      });
    } catch (err) {
      if (err instanceof MuseSparkError) {
        return res
          .status(err.code === 'rate_limited' ? 429 : 502)
          .json({ error: err.message });
      }
      throw err;
    }
  }));

  return router;
}
