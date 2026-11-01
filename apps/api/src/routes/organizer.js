import { timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { config } from '../config.js';
import {
  requireAccessMode,
  requireCandidates,
  requireId,
  requireInt,
  requireIsoDate,
  requirePassword,
  requireString,
  requireUsername,
  requireVotingMode,
} from '../lib/validate.js';
import { hashPassword, verifyPassword } from '../lib/password.js';
import { randomHex, sha256Hex } from '../lib/crypto.js';
import {
  ORGANIZER_COOKIE,
  clearOrganizerCookie,
  requireCsrf,
  requireOrganizer,
  sessionCookieOptions,
} from '../auth/session.js';
import { RATE_LIMITS, rateLimit } from '../lib/rate-limit.js';

// Organizer APIs: fictional-election management for controlled testing.
// Every route requires an organizer session; every mutation additionally
// requires the session CSRF token. Voter sessions are never accepted here.

function assignCandidateIds(candidates) {
  const seen = new Set();
  return candidates.map((candidate, index) => {
    const base =
      candidate.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40) || `choice-${index + 1}`;
    let id = base;
    let n = 2;
    while (seen.has(id)) id = `${base}-${n++}`;
    seen.add(id);
    return { id, name: candidate.name, party: candidate.party };
  });
}

function setupTokensMatch(presented) {
  if (!config.organizerSetupToken || typeof presented !== 'string') return false;
  const a = Buffer.from(sha256Hex(presented), 'hex');
  const b = Buffer.from(sha256Hex(config.organizerSetupToken), 'hex');
  return timingSafeEqual(a, b);
}

export function buildOrganizerRouter(store) {
  const router = Router();
  const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
  // Same defence-in-depth POST origin check as the voter router.
  const allowedOrigins = new Set([...config.corsOrigins, config.webauthnOrigin]);
  router.use((req, res, next) => {
    const origin = req.headers.origin;
    if ((req.method === 'POST' || req.method === 'PATCH' || req.method === 'DELETE') && origin && !allowedOrigins.has(origin)) {
      return res.status(403).json({ error: 'Cross-origin request rejected.' });
    }
    next();
  });
  // Mutations: organizer session + CSRF. Reads: session only.
  const authed = (fn) => asyncHandler(async (req, res) => fn(req, res, await requireOrganizer(store, req)));
  const authedMutation = (fn) =>
    asyncHandler(async (req, res) => {
      const session = await requireOrganizer(store, req);
      requireCsrf(session, req);
      return fn(req, res, session);
    });

  // -- bootstrap + auth ------------------------------------------------------
  // Single-use founding-organizer setup. Uniform 403 for every failure mode
  // (unset token, bad token, already consumed): no setup-state oracle.
  router.post(
    '/setup',
    rateLimit(RATE_LIMITS.organizerSetup),
    asyncHandler(async (req, res) => {
      const token = req.body?.token;
      const username = requireUsername(req.body?.username);
      const password = requirePassword(req.body?.password);
      if (!setupTokensMatch(token)) {
        return res.status(403).json({ error: 'Organizer setup is unavailable.' });
      }
      try {
        await store.consumeBootstrap();
      } catch {
        return res.status(403).json({ error: 'Organizer setup is unavailable.' });
      }
      const organizer = await store.createOrganizer({
        username,
        passwordHash: await hashPassword(password),
        createdBy: 'bootstrap',
      });
      res.status(201).json(organizer);
    }),
  );

  router.post(
    '/login',
    rateLimit(RATE_LIMITS.organizerAuth),
    asyncHandler(async (req, res) => {
      const username = requireUsername(req.body?.username);
      const password = requirePassword(req.body?.password);
      // verifyPassword always runs the KDF (dummy hash for unknown users),
      // so timing reveals nothing about username validity.
      const organizer = await store.getOrganizer(username);
      const ok = await verifyPassword(password, organizer?.passwordHash ?? null);
      if (!organizer || !ok) {
        return res.status(401).json({ error: 'Invalid organizer credentials.' });
      }
      const session = await store.createSession({
        role: 'organizer',
        organizerId: username,
        ttlMs: config.organizerSessionTtlMs,
      });
      res.cookie(
        ORGANIZER_COOKIE,
        session.id,
        sessionCookieOptions(config, { cookieMaxAge: config.organizerSessionTtlMs }),
      );
      res.json({ csrfToken: session.csrfToken, organizerId: username });
    }),
  );

  router.post('/logout', asyncHandler(async (req, res) => {
    const id = req.cookies?.[ORGANIZER_COOKIE];
    if (typeof id === 'string') await store.destroySession(id);
    clearOrganizerCookie(res, config);
    res.json({ loggedOut: true });
  }));

  router.get('/session', asyncHandler(async (req, res) => {
    const id = req.cookies?.[ORGANIZER_COOKIE];
    const session = typeof id === 'string' ? await store.getSession(id) : null;
    if (!session || session.role !== 'organizer') return res.json({ authenticated: false });
    res.json({ authenticated: true, organizerId: session.organizerId });
  }));

  router.post('/organizers', authedMutation(async (req, res, session) => {
    const username = requireUsername(req.body?.username);
    const password = requirePassword(req.body?.password);
    const organizer = await store.createOrganizer({
      username,
      passwordHash: await hashPassword(password),
      createdBy: session.organizerId,
    });
    res.status(201).json(organizer);
  }));

  // -- elections ----------------------------------------------------------------
  router.get('/elections', authed(async (req, res) => {
    const elections = await store.listElections({ includeDrafts: true });
    const withStats = await Promise.all(
      elections.map(async (election) => ({
        ...election,
        stats: await store.electionStats(election.id),
      })),
    );
    res.json({ elections: withStats });
  }));

  router.post('/elections', authedMutation(async (req, res, session) => {
    const title = requireString(req.body?.title, 'title', { max: 160 });
    const description = req.body?.description === undefined
      ? ''
      : requireString(req.body.description, 'description', { max: 2000 });
    const candidates = assignCandidateIds(requireCandidates(req.body?.candidates));
    const startsAt = req.body?.startsAt === undefined ? undefined : requireIsoDate(req.body.startsAt, 'startsAt');
    const endsAt = req.body?.endsAt === undefined ? undefined : requireIsoDate(req.body.endsAt, 'endsAt');
    const access = req.body?.access === undefined ? 'invitation' : requireAccessMode(req.body.access);
    const votingMode = requireVotingMode(req.body?.votingMode);
    let id = req.body?.id === undefined ? null : requireId(req.body.id, 'election id');
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const candidate = id ?? `election-${randomHex(4)}`;
      try {
        const election = await store.createElection({
          id: candidate,
          title,
          description,
          candidates,
          startsAt,
          endsAt,
          access,
          votingMode,
          createdBy: session.organizerId,
        });
        return res.status(201).json({ election });
      } catch (err) {
        if (id || err?.status !== 409) throw err;
        // Generated-id collision: retry with a fresh id.
      }
    }
    res.status(503).json({ error: 'Could not mint a unique election id. Try again.' });
  }));

  router.patch('/elections/:id', authedMutation(async (req, res) => {
    const id = requireId(req.params.id, 'election id');
    const patch = {};
    if (req.body?.title !== undefined) patch.title = requireString(req.body.title, 'title', { max: 160 });
    if (req.body?.description !== undefined) {
      patch.description = requireString(req.body.description, 'description', { max: 2000 });
    }
    if (req.body?.candidates !== undefined) {
      patch.candidates = assignCandidateIds(requireCandidates(req.body.candidates));
    }
    if (req.body?.startsAt !== undefined) patch.startsAt = requireIsoDate(req.body.startsAt, 'startsAt');
    if (req.body?.endsAt !== undefined) patch.endsAt = requireIsoDate(req.body.endsAt, 'endsAt');
    if (req.body?.access !== undefined) patch.access = requireAccessMode(req.body.access);
    if (req.body?.votingMode !== undefined) patch.votingMode = requireVotingMode(req.body.votingMode);
    res.json({ election: await store.updateElection(id, patch) });
  }));

  router.delete('/elections/:id', authedMutation(async (req, res) => {
    await store.deleteElection(requireId(req.params.id, 'election id'));
    res.json({ deleted: true });
  }));

  router.post('/elections/:id/open', authedMutation(async (req, res) => {
    res.json({ election: await store.transitionElection(requireId(req.params.id, 'election id'), 'open') });
  }));

  router.post('/elections/:id/start-enrolment', authedMutation(async (req, res) => {
    res.json({ election: await store.transitionElection(requireId(req.params.id, 'election id'), 'enrolment') });
  }));

  router.post('/elections/:id/start-voting', authedMutation(async (req, res) => {
    res.json({ election: await store.transitionElection(requireId(req.params.id, 'election id'), 'voting') });
  }));

  router.post('/elections/:id/close', authedMutation(async (req, res) => {
    res.json({ election: await store.transitionElection(requireId(req.params.id, 'election id'), 'closed') });
  }));

  router.post('/elections/:id/freeze', authedMutation(async (req, res) => {
    res.json({ election: await store.freezeGroup(requireId(req.params.id, 'election id')) });
  }));

  // -- invitations ---------------------------------------------------------------
  router.post('/elections/:id/invitations', authedMutation(async (req, res, session) => {
    const electionId = requireId(req.params.id, 'election id');
    const count = req.body?.count === undefined ? 1 : requireInt(req.body.count, 'count', { min: 1, max: 50 });
    const expiresInHours = req.body?.expiresInHours === undefined
      ? 72
      : requireInt(req.body.expiresInHours, 'expiresInHours', { min: 1, max: 720 });
    // Label is optional: missing or empty means "no label".
    const rawLabel = req.body?.label;
    const label = rawLabel === undefined || rawLabel === '' ? '' : requireString(rawLabel, 'label', { max: 120 });
    const invitations = await store.createInvitations({
      electionId,
      count,
      expiresAt: Date.now() + expiresInHours * 3600 * 1000,
      label,
      createdBy: session.organizerId,
    });
    // Plaintext tokens are returned HERE ONLY. Afterwards only hashes exist.
    res.status(201).json({ invitations });
  }));

  router.get('/elections/:id/invitations', authed(async (req, res) => {
    const electionId = requireId(req.params.id, 'election id');
    const election = await store.getElection(electionId);
    if (!election) return res.status(404).json({ error: 'Unknown election.' });
    res.json({ invitations: await store.listInvitations(electionId) });
  }));

  router.delete('/elections/:id/invitations/:tokenHash', authedMutation(async (req, res) => {
    const tokenHash = requireString(req.params.tokenHash, 'token hash', { min: 64, max: 64 });
    if (!/^[0-9a-f]{64}$/.test(tokenHash)) {
      return res.status(400).json({ error: 'Invalid token hash: expected 64 hex characters.' });
    }
    await store.revokeInvitation(tokenHash.toLowerCase());
    res.json({ revoked: true });
  }));

  return router;
}
