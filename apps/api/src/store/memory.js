import { timingSafeEqual } from 'node:crypto';
import { elections, voterRoll, seedAuditEvents } from '../seed/fictional.js';
import { buildNullifierHash, randomHex, sha256Hex } from '../lib/crypto.js';
import { buildGroup } from '../zk/semaphore.js';
import { STORE_SNAPSHOT_VERSION, loadStoreFile, saveStoreFile } from './persistence.js';

/**
 * In-memory store implementing the same interface as the Mongo store.
 * Used for zero-infrastructure local runs and for automated tests.
 * Pass { persistPath } to also snapshot durable state to disk so ballots,
 * passkeys, audit history, and Semaphore groups survive API restarts.
 */
export class MemoryStore {
  constructor({ persistPath = null } = {}) {
    this.persistPath = persistPath;
    this.reset();
    this.#loadPersisted();
  }

  reset() {
    this.elections = new Map(elections.map((e) => [e.id, structuredClone(e)]));
    this.roll = new Map(voterRoll.map((v) => [`${v.voterRef}:${v.electionId}`, { ...v }]));
    // credId -> passkey record (public key + metadata only)
    this.passkeys = new Map();
    // nullifierHash -> ballot
    this.ballots = new Map();
    this.audit = seedAuditEvents();
    // requestId -> ceremony challenge record (single-use, short-lived)
    this.challenges = new Map();
    // sessionId -> { voterRef, electionId, credentialId, csrfToken, createdAt, expiresAt }
    this.sessions = new Map();
    // electionId -> { members: [commitment], snapshots: [{version, root}], version }
    this.zkGroups = new Map();
    // `${voterRef}:${electionId}` -> { voterRef, electionId, commitment, enrolledAt }
    this.zkEnrollments = new Map();
  }

  // -- durability ----------------------------------------------------------
  // Every audit-producing mutation persists (addAudit funnels them all);
  // updatePasskeyCounter persists explicitly. Challenges and sessions are
  // ephemeral by design and never touch disk.
  #persist() {
    if (!this.persistPath) return;
    try {
      saveStoreFile(this.persistPath, {
        version: STORE_SNAPSHOT_VERSION,
        savedAt: new Date().toISOString(),
        passkeys: [...this.passkeys.values()],
        ballots: [...this.ballots.values()],
        audit: this.audit,
        groups: [...this.zkGroups.entries()].map(([electionId, group]) => ({ electionId, ...group })),
        enrollments: [...this.zkEnrollments.values()],
      });
    } catch (err) {
      console.error(`CivicProof: failed to persist store to ${this.persistPath}: ${err.message}`);
    }
  }

  #loadPersisted() {
    const data = loadStoreFile(this.persistPath);
    if (!data) return;
    for (const record of data.passkeys) this.passkeys.set(record.id, record);
    for (const ballot of data.ballots) this.ballots.set(ballot.nullifierHash, ballot);
    if (data.audit.length > 0) this.audit = data.audit;
    for (const group of data.groups ?? []) {
      this.zkGroups.set(group.electionId, {
        members: group.members ?? [],
        snapshots: group.snapshots ?? [],
        version: group.version ?? 0,
      });
    }
    for (const enrollment of data.enrollments ?? []) {
      this.zkEnrollments.set(`${enrollment.voterRef}:${enrollment.electionId}`, enrollment);
    }
  }

  get mode() {
    return 'memory';
  }

  // -- elections -----------------------------------------------------------
  listElections() {
    return [...this.elections.values()].map((e) => ({
      ...e,
      ballotsCast: [...this.ballots.values()].filter((b) => b.electionId === e.id).length,
    }));
  }

  getElection(id) {
    const election = this.elections.get(id);
    if (!election) return null;
    return {
      ...structuredClone(election),
      ballotsCast: [...this.ballots.values()].filter((b) => b.electionId === id).length,
    };
  }

  // -- eligibility roll (fictional voters only) ------------------------------
  getRollEntry(voterRef, electionId) {
    return this.roll.get(`${voterRef}:${electionId}`) ?? null;
  }

  /** PIN check that does not leak the stored PIN through timing or errors. */
  checkRollPin(entry, pin) {
    const a = Buffer.from(sha256Hex(pin), 'hex');
    const b = Buffer.from(sha256Hex(entry.pin), 'hex');
    return timingSafeEqual(a, b);
  }

  // -- passkeys --------------------------------------------------------------
  getPasskeysByVoter(voterRef, electionId) {
    return [...this.passkeys.values()].filter(
      (p) => p.voterRef === voterRef && p.electionId === electionId,
    );
  }

  getPasskey(credId) {
    return this.passkeys.get(credId) ?? null;
  }

  savePasskey({ id, voterRef, electionId, userIdBase64, publicKeyBase64, counter, transports, deviceType, backedUp }) {
    if (this.passkeys.has(id)) {
      const err = new Error('This passkey is already registered.');
      err.status = 409;
      throw err;
    }
    if (this.getPasskeysByVoter(voterRef, electionId).length > 0) {
      const err = new Error('This voter has already registered a passkey for this election.');
      err.status = 409;
      throw err;
    }
    const voterSecret = randomHex(32);
    const record = {
      id,
      voterRef,
      electionId,
      userIdBase64,
      publicKeyBase64,
      counter,
      transports: transports ?? [],
      deviceType: deviceType ?? 'unknown',
      backedUp: backedUp ?? false,
      voterSecret,
      nullifierHash: buildNullifierHash(voterSecret, electionId),
      registeredAt: new Date().toISOString(),
      lastUsedAt: null,
    };
    this.passkeys.set(id, record);
    this.addAudit({
      type: 'voter.registered',
      electionId,
      ref: sha256Hex(id),
      detail: 'Passkey credential registered for an eligible voter (public key only).',
    });
    return record;
  }

  updatePasskeyCounter(id, counter, { deviceType, backedUp } = {}) {
    const record = this.passkeys.get(id);
    if (!record) {
      const err = new Error('Unknown passkey credential.');
      err.status = 404;
      throw err;
    }
    record.counter = counter;
    if (deviceType) record.deviceType = deviceType;
    if (typeof backedUp === 'boolean') record.backedUp = backedUp;
    record.lastUsedAt = new Date().toISOString();
    this.#persist();
    return record;
  }

  // -- WebAuthn ceremony challenges (single-use, short-lived) ------------------
  saveWebAuthnChallenge({ id, challenge, type, voterRef, electionId, allowCredentialIds = [], userIdBase64 = null, ttlMs = 5 * 60 * 1000 }) {
    this.challenges.set(id, {
      id,
      challenge,
      type,
      voterRef,
      electionId,
      allowCredentialIds,
      userIdBase64,
      expiresAt: Date.now() + ttlMs,
    });
  }

  consumeWebAuthnChallenge(id, expectedType) {
    const record = this.challenges.get(id);
    if (!record || record.type !== expectedType) {
      const err = new Error('Invalid or already-used challenge. Start the ceremony again.');
      err.status = 401;
      throw err;
    }
    this.challenges.delete(id); // single-use: consumed even if expired
    if (record.expiresAt < Date.now()) {
      const err = new Error('Challenge expired. Start the ceremony again.');
      err.status = 401;
      throw err;
    }
    return record;
  }

  // -- sessions -----------------------------------------------------------------
  createSession({ voterRef, electionId, credentialId, ttlMs }) {
    const id = randomHex(32);
    const record = {
      id,
      voterRef,
      electionId,
      credentialId,
      csrfToken: randomHex(32),
      createdAt: new Date().toISOString(),
      expiresAt: Date.now() + ttlMs,
    };
    this.sessions.set(id, record);
    return record;
  }

  getSession(id) {
    const session = this.sessions.get(id);
    if (!session) return null;
    if (session.expiresAt < Date.now()) {
      this.sessions.delete(id);
      return null;
    }
    return session;
  }

  destroySession(id) {
    this.sessions.delete(id);
  }

  // -- ballots (ENFORCED one-credential-one-vote) -----------------------------
  // The nullifier is derived server-side from the authenticated passkey record;
  // clients never see or submit it.
  castBallot({ electionId, voterRef, credentialId, ballotCommitment }) {
    const election = this.elections.get(electionId);
    if (!election) {
      const err = new Error('Unknown election.');
      err.status = 404;
      throw err;
    }
    const passkey = this.getPasskey(credentialId);
    if (!passkey || passkey.voterRef !== voterRef || passkey.electionId !== electionId) {
      const err = new Error('Session credential does not match this election.');
      err.status = 403;
      throw err;
    }
    const nullifierHash = passkey.nullifierHash;
    if (election.status !== 'open') {
      this.#auditRejection(electionId, nullifierHash, 'Ballot rejected: election is not open.');
      const err = new Error('Election is not open for voting.');
      err.status = 409;
      throw err;
    }
    if (this.ballots.has(nullifierHash)) {
      this.#auditRejection(electionId, nullifierHash, 'Duplicate ballot rejected (nullifier already recorded).');
      const err = new Error('Duplicate vote rejected: this credential has already voted.');
      err.status = 409;
      throw err;
    }
    const ballot = {
      electionId,
      nullifierHash,
      ballotCommitment,
      castAt: new Date().toISOString(),
    };
    this.ballots.set(nullifierHash, ballot);
    this.addAudit({
      type: 'ballot.cast',
      electionId,
      ref: ballotCommitment,
      detail: 'Ballot commitment recorded (no identity, no plaintext choice).',
    });
    return ballot;
  }

  auditAuthFailure({ electionId, credentialId, detail }) {
    this.addAudit({
      type: 'auth.failed',
      electionId,
      ref: credentialId ? sha256Hex(credentialId) : null,
      detail,
    });
  }

  auditAuthSuccess({ electionId, credentialId }) {
    this.addAudit({
      type: 'auth.success',
      electionId,
      ref: sha256Hex(credentialId),
      detail: 'Passkey authentication succeeded (correlation hash only).',
    });
  }

  // Rejections are audited with a correlation hash, never the raw credential
  // or nullifier, so the log stays joinable without becoming identifying.
  #auditRejection(electionId, nullifierHash, detail) {
    this.addAudit({ type: 'ballot.rejected', electionId, ref: sha256Hex(nullifierHash), detail });
  }

  // -- Semaphore groups (anonymous voting credentials) -------------------------
  // Only identity COMMITMENTS are stored. Private identity secrets must never
  // reach the server; enrollment accepts a commitment string and nothing else.
  enrollCommitment({ electionId, voterRef, commitment }) {
    const election = this.elections.get(electionId);
    if (!election) {
      const err = new Error('Unknown election.');
      err.status = 404;
      throw err;
    }
    if (election.status !== 'open') {
      const err = new Error('Election is not open for enrollment.');
      err.status = 409;
      throw err;
    }
    const key = `${voterRef}:${electionId}`;
    if (this.zkEnrollments.has(key)) {
      const err = new Error('This voter has already enrolled an anonymous credential for this election.');
      err.status = 409;
      throw err;
    }
    const group = this.zkGroups.get(electionId) ?? { members: [], snapshots: [], version: 0 };
    if (group.members.includes(commitment)) {
      const err = new Error('This commitment is already registered for this election.');
      err.status = 409;
      throw err;
    }
    group.members.push(commitment);
    group.version += 1;
    const root = buildGroup(group.members).root.toString();
    group.snapshots.push({ version: group.version, root });
    this.zkGroups.set(electionId, group);
    this.zkEnrollments.set(key, { voterRef, electionId, commitment, enrolledAt: new Date().toISOString() });
    this.addAudit({
      type: 'semaphore.enrolled',
      electionId,
      ref: sha256Hex(commitment),
      detail: `Anonymous voting credential enrolled (group v${group.version}; commitment hash only).`,
    });
    return { version: group.version, root, index: group.members.length - 1 };
  }

  getSemaphoreGroup(electionId) {
    const group = this.zkGroups.get(electionId);
    if (!group) return { electionId, version: 0, root: null, members: [] };
    const latest = group.snapshots[group.snapshots.length - 1];
    return { electionId, version: group.version, root: latest.root, members: [...group.members] };
  }

  /** A proof root is trusted only if the server itself snapshotted it. */
  isApprovedRoot(electionId, root) {
    const group = this.zkGroups.get(electionId);
    return !!group && group.snapshots.some((snapshot) => snapshot.root === root);
  }

  // Atomic check-and-set: synchronous, so no interleaving is possible in Node.
  insertAnonymousBallot({ electionId, nullifier, ballotCommitment }) {
    if (this.ballots.has(nullifier)) {
      this.#auditRejection(electionId, nullifier, 'Duplicate ballot rejected (nullifier already recorded).');
      const err = new Error('Duplicate vote rejected: this credential has already voted.');
      err.status = 409;
      throw err;
    }
    const ballot = {
      electionId,
      nullifierHash: nullifier,
      ballotCommitment,
      castAt: new Date().toISOString(),
      anonymous: true,
    };
    this.ballots.set(nullifier, ballot);
    this.addAudit({
      type: 'ballot.cast',
      electionId,
      ref: ballotCommitment,
      detail: 'Anonymous Semaphore ballot recorded (proof verified, no identity).',
    });
    return ballot;
  }

  auditProofRejection({ electionId, nullifier, detail }) {
    this.addAudit({
      type: 'proof.rejected',
      electionId,
      ref: nullifier ? sha256Hex(String(nullifier)) : null,
      detail,
    });
  }

  auditAnonymousRejection({ electionId, nullifier, detail }) {
    this.#auditRejection(electionId, nullifier, detail);
  }

  // -- audit -----------------------------------------------------------------
  listAudit({ electionId, type, limit = 100 } = {}) {
    return this.audit
      .filter((e) => !electionId || e.electionId === electionId)
      .filter((e) => !type || e.type === type)
      .slice(-limit);
  }

  addAudit({ type, electionId, ref, detail }) {
    const event = {
      seq: this.audit.length + 1,
      ts: new Date().toISOString(),
      type,
      electionId,
      ref,
      detail,
    };
    this.audit.push(event);
    this.#persist();
    return event;
  }
}
