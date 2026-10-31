import { timingSafeEqual } from 'node:crypto';
import mongoose from 'mongoose';
import {
  AuditEventModel,
  BallotModel,
  ElectionModel,
  PasskeyModel,
  SemaphoreEnrollmentModel,
  SemaphoreGroupModel,
  SessionModel,
  WebAuthnChallengeModel,
} from '../models/index.js';
import { elections, voterRoll, seedAuditEvents } from '../seed/fictional.js';
import { buildNullifierHash, randomHex, sha256Hex } from '../lib/crypto.js';
import { buildGroup } from '../zk/semaphore.js';

/** MongoDB-backed store with the same interface as MemoryStore. */
export class MongoStore {
  get mode() {
    return 'mongo';
  }

  static async connect(uri) {
    await mongoose.connect(uri);
  }

  /** Seed fictional data on first run only. Never reseeds over real rows. */
  async ensureSeeded() {
    const count = await ElectionModel.countDocuments();
    if (count > 0) return;
    await ElectionModel.insertMany(elections.map((e) => ({ ...e, _id: e.id })));
    await AuditEventModel.insertMany(seedAuditEvents());
  }

  async listElections() {
    const rows = await ElectionModel.find().lean();
    return Promise.all(rows.map((e) => this.#withCount(e)));
  }

  async getElection(id) {
    const row = await ElectionModel.findById(id).lean();
    if (!row) return null;
    return this.#withCount(row);
  }

  async #withCount(row) {
    const ballotsCast = await BallotModel.countDocuments({ electionId: row._id });
    const { _id, ...rest } = row;
    return { ...rest, id: _id, ballotsCast };
  }

  // -- eligibility roll (fictional voters only; PINs are demo-only) ------------
  getRollEntry(voterRef, electionId) {
    return voterRoll.find((v) => v.voterRef === voterRef && v.electionId === electionId) ?? null;
  }

  checkRollPin(entry, pin) {
    const a = Buffer.from(sha256Hex(pin), 'hex');
    const b = Buffer.from(sha256Hex(entry.pin), 'hex');
    return timingSafeEqual(a, b);
  }

  // -- passkeys ------------------------------------------------------------------
  async getPasskeysByVoter(voterRef, electionId) {
    const rows = await PasskeyModel.find({ voterRef, electionId }).lean();
    return rows.map((row) => ({ ...row, id: row._id }));
  }

  async getPasskey(credId) {
    const row = await PasskeyModel.findById(credId).lean();
    if (!row) return null;
    return { ...row, id: row._id };
  }

  async savePasskey({ id, voterRef, electionId, userIdBase64, publicKeyBase64, counter, transports, deviceType, backedUp }) {
    if (await PasskeyModel.exists({ _id: id })) {
      const err = new Error('This passkey is already registered.');
      err.status = 409;
      throw err;
    }
    if (await PasskeyModel.exists({ voterRef, electionId })) {
      const err = new Error('This voter has already registered a passkey for this election.');
      err.status = 409;
      throw err;
    }
    const voterSecret = randomHex(32);
    const record = await PasskeyModel.create({
      _id: id,
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
    });
    await this.addAudit({
      type: 'voter.registered',
      electionId,
      ref: sha256Hex(id),
      detail: 'Passkey credential registered for an eligible voter (public key only).',
    });
    const plain = record.toObject();
    return { ...plain, id: plain._id };
  }

  async updatePasskeyCounter(id, counter, { deviceType, backedUp } = {}) {
    const update = { counter, lastUsedAt: new Date().toISOString() };
    if (deviceType) update.deviceType = deviceType;
    if (typeof backedUp === 'boolean') update.backedUp = backedUp;
    const row = await PasskeyModel.findByIdAndUpdate(id, update, { new: true }).lean();
    if (!row) {
      const err = new Error('Unknown passkey credential.');
      err.status = 404;
      throw err;
    }
    return { ...row, id: row._id };
  }

  // -- WebAuthn ceremony challenges (single-use, short-lived) ----------------------
  async saveWebAuthnChallenge({ id, challenge, type, voterRef, electionId, allowCredentialIds = [], userIdBase64 = null, ttlMs = 5 * 60 * 1000 }) {
    await WebAuthnChallengeModel.create({
      _id: id,
      challenge,
      type,
      voterRef,
      electionId,
      allowCredentialIds,
      userIdBase64,
      expiresAt: Date.now() + ttlMs,
    });
  }

  async consumeWebAuthnChallenge(id, expectedType) {
    const record = await WebAuthnChallengeModel.findByIdAndDelete(id).lean();
    if (!record || record.type !== expectedType) {
      const err = new Error('Invalid or already-used challenge. Start the ceremony again.');
      err.status = 401;
      throw err;
    }
    if (record.expiresAt < Date.now()) {
      const err = new Error('Challenge expired. Start the ceremony again.');
      err.status = 401;
      throw err;
    }
    return record;
  }

  // -- sessions -----------------------------------------------------------------------
  async createSession({ voterRef, electionId, credentialId, ttlMs }) {
    const record = await SessionModel.create({
      _id: randomHex(32),
      voterRef,
      electionId,
      credentialId,
      csrfToken: randomHex(32),
      createdAt: new Date().toISOString(),
      expiresAt: Date.now() + ttlMs,
    });
    const plain = record.toObject();
    return { ...plain, id: plain._id };
  }

  async getSession(id) {
    const row = await SessionModel.findById(id).lean();
    if (!row) return null;
    if (row.expiresAt < Date.now()) {
      await SessionModel.deleteOne({ _id: id });
      return null;
    }
    return { ...row, id: row._id };
  }

  async destroySession(id) {
    await SessionModel.deleteOne({ _id: id });
  }

  // -- ballots (ENFORCED one-credential-one-vote) ---------------------------------------
  async castBallot({ electionId, voterRef, credentialId, ballotCommitment }) {
    const election = await ElectionModel.findById(electionId).lean();
    if (!election) {
      const err = new Error('Unknown election.');
      err.status = 404;
      throw err;
    }
    const passkey = await this.getPasskey(credentialId);
    if (!passkey || passkey.voterRef !== voterRef || passkey.electionId !== electionId) {
      const err = new Error('Session credential does not match this election.');
      err.status = 403;
      throw err;
    }
    const nullifierHash = passkey.nullifierHash;
    if (election.status !== 'open') {
      await this.#auditRejection(electionId, nullifierHash, 'Ballot rejected: election is not open.');
      const err = new Error('Election is not open for voting.');
      err.status = 409;
      throw err;
    }
    try {
      await BallotModel.create({
        _id: nullifierHash,
        electionId,
        ballotCommitment,
        castAt: new Date().toISOString(),
      });
    } catch {
      await this.#auditRejection(electionId, nullifierHash, 'Duplicate ballot rejected (nullifier already recorded).');
      const err = new Error('Duplicate vote rejected: this credential has already voted.');
      err.status = 409;
      throw err;
    }
    await this.addAudit({
      type: 'ballot.cast',
      electionId,
      ref: ballotCommitment,
      detail: 'Ballot commitment recorded (no identity, no plaintext choice).',
    });
    return { electionId, nullifierHash, ballotCommitment };
  }

  async auditAuthFailure({ electionId, credentialId, detail }) {
    await this.addAudit({
      type: 'auth.failed',
      electionId,
      ref: credentialId ? sha256Hex(credentialId) : null,
      detail,
    });
  }

  async auditAuthSuccess({ electionId, credentialId }) {
    await this.addAudit({
      type: 'auth.success',
      electionId,
      ref: sha256Hex(credentialId),
      detail: 'Passkey authentication succeeded (correlation hash only).',
    });
  }

  async #auditRejection(electionId, nullifierHash, detail) {
    await this.addAudit({ type: 'ballot.rejected', electionId, ref: sha256Hex(nullifierHash), detail });
  }

  // -- Semaphore groups (anonymous voting credentials) ---------------------------
  // Serialize enrollments per election within this process; the unique indexes
  // on enrollments remain the backstop. Multi-process deployments would need a
  // transaction here instead (documented limitation).
  #withEnrollLock(electionId, fn) {
    this.enrollLocks ??= new Map();
    const previous = this.enrollLocks.get(electionId) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    this.enrollLocks.set(electionId, next.catch(() => {}));
    return next;
  }

  async enrollCommitment({ electionId, voterRef, commitment }) {
    return this.#withEnrollLock(electionId, async () => {
      const election = await ElectionModel.findById(electionId).lean();
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
      try {
        await SemaphoreEnrollmentModel.create({
          voterRef,
          electionId,
          commitment,
          enrolledAt: new Date().toISOString(),
        });
      } catch (err) {
        if (err?.code === 11000) {
          const dupVoter = err.keyPattern && 'voterRef' in err.keyPattern;
          const dup = new Error(
            dupVoter
              ? 'This voter has already enrolled an anonymous credential for this election.'
              : 'This commitment is already registered for this election.',
          );
          dup.status = 409;
          throw dup;
        }
        throw err;
      }
      const doc = await SemaphoreGroupModel.findById(electionId).lean();
      const members = [...(doc?.members ?? []), commitment];
      const version = (doc?.version ?? 0) + 1;
      const root = buildGroup(members).root.toString();
      await SemaphoreGroupModel.findByIdAndUpdate(
        electionId,
        {
          $set: { members, version },
          $push: { snapshots: { version, root } },
        },
        { upsert: true },
      );
      await this.addAudit({
        type: 'semaphore.enrolled',
        electionId,
        ref: sha256Hex(commitment),
        detail: `Anonymous voting credential enrolled (group v${version}; commitment hash only).`,
      });
      return { version, root, index: members.length - 1 };
    });
  }

  async getSemaphoreGroup(electionId) {
    const doc = await SemaphoreGroupModel.findById(electionId).lean();
    if (!doc) return { electionId, version: 0, root: null, members: [] };
    const latest = doc.snapshots[doc.snapshots.length - 1];
    return { electionId, version: doc.version, root: latest.root, members: [...doc.members] };
  }

  /** A proof root is trusted only if the server itself snapshotted it. */
  async isApprovedRoot(electionId, root) {
    const doc = await SemaphoreGroupModel.findById(electionId).lean();
    return !!doc && doc.snapshots.some((snapshot) => snapshot.root === root);
  }

  // Atomic via the Ballot unique _id index: concurrent inserts of the same
  // nullifier collapse to exactly one winner, on any process count.
  async insertAnonymousBallot({ electionId, nullifier, ballotCommitment }) {
    try {
      await BallotModel.create({
        _id: nullifier,
        electionId,
        ballotCommitment,
        castAt: new Date().toISOString(),
      });
    } catch {
      await this.#auditRejection(electionId, nullifier, 'Duplicate ballot rejected (nullifier already recorded).');
      const err = new Error('Duplicate vote rejected: this credential has already voted.');
      err.status = 409;
      throw err;
    }
    await this.addAudit({
      type: 'ballot.cast',
      electionId,
      ref: ballotCommitment,
      detail: 'Anonymous Semaphore ballot recorded (proof verified, no identity).',
    });
    return { electionId, nullifierHash: nullifier, ballotCommitment };
  }

  async auditProofRejection({ electionId, nullifier, detail }) {
    await this.addAudit({
      type: 'proof.rejected',
      electionId,
      ref: nullifier ? sha256Hex(String(nullifier)) : null,
      detail,
    });
  }

  async auditAnonymousRejection({ electionId, nullifier, detail }) {
    await this.#auditRejection(electionId, nullifier, detail);
  }

  async listAudit({ electionId, type, limit = 100 } = {}) {
    const filter = {};
    if (electionId) filter.electionId = electionId;
    if (type) filter.type = type;
    return AuditEventModel.find(filter).sort({ seq: 1 }).limit(limit).lean();
  }

  async addAudit({ type, electionId, ref, detail }) {
    const last = await AuditEventModel.findOne().sort({ seq: -1 }).lean();
    const event = await AuditEventModel.create({
      seq: (last?.seq ?? 0) + 1,
      ts: new Date().toISOString(),
      type,
      electionId,
      ref,
      detail,
    });
    return event.toObject();
  }
}
