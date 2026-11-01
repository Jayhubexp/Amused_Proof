import { timingSafeEqual } from 'node:crypto';
import mongoose from 'mongoose';
import {
  AuditEventModel,
  BallotModel,
  BootstrapModel,
  CounterModel,
  ElectionModel,
  InvitationModel,
  OrganizerModel,
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

  static async connect(uri, { serverSelectionTimeoutMS = 10000 } = {}) {
    await mongoose.connect(uri, { serverSelectionTimeoutMS });
  }

  static async disconnect() {
    await mongoose.disconnect();
  }

  /** Seed fictional data on first run only. Never reseeds over real rows. */
  async ensureSeeded() {
    const count = await ElectionModel.countDocuments();
    if (count === 0) {
      await ElectionModel.insertMany(elections.map((e) => ({ ...e, _id: e.id })));
      await AuditEventModel.insertMany(seedAuditEvents());
    }
    // Idempotent: keep the audit counter at or above the highest stored seq,
    // including pre-counter databases being upgraded in place.
    const max = await AuditEventModel.findOne().sort({ seq: -1 }).lean();
    await CounterModel.findOneAndUpdate(
      { _id: 'auditSeq' },
      { $max: { value: max?.seq ?? 0 } },
      { upsert: true },
    );
  }

  // Drafts are organizer-only; the public list excludes them by default.
  async listElections({ includeDrafts = false } = {}) {
    const filter = includeDrafts ? {} : { status: { $ne: 'draft' } };
    const rows = await ElectionModel.find(filter).lean();
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
    return {
      access: 'roll',
      groupFrozen: false,
      ...rest,
      id: _id,
      ballotsCast,
    };
  }

  async createElection({ id, title, description, candidates, startsAt, endsAt, access, votingMode, createdBy }) {
    const now = new Date().toISOString();
    try {
      await ElectionModel.create({
        _id: id,
        title,
        description: description ?? '',
        status: 'draft',
        access,
        votingMode,
        startsAt: startsAt ?? now,
        endsAt: endsAt ?? now,
        candidates,
        createdBy,
        createdAt: now,
        updatedAt: now,
        groupFrozen: false,
      });
    } catch (err) {
      if (err?.code === 11000) {
        const dup = new Error('An election with this id already exists.');
        dup.status = 409;
        throw dup;
      }
      throw err;
    }
    await this.addAudit({
      type: 'admin.updated',
      electionId: id,
      ref: null,
      detail: `Draft election "${title}" created by organizer.`,
    });
    return this.getElection(id);
  }

  async updateElection(id, { title, description, candidates, startsAt, endsAt, access, votingMode }) {
    const election = await ElectionModel.findById(id).lean();
    if (!election) {
      const err = new Error('Unknown election.');
      err.status = 404;
      throw err;
    }
    if (election.status !== 'draft') {
      const err = new Error('Only draft elections can be edited.');
      err.status = 409;
      throw err;
    }
    const update = { updatedAt: new Date().toISOString() };
    if (title !== undefined) update.title = title;
    if (description !== undefined) update.description = description;
    if (candidates !== undefined) update.candidates = candidates;
    if (startsAt !== undefined) update.startsAt = startsAt;
    if (endsAt !== undefined) update.endsAt = endsAt;
    if (access !== undefined) update.access = access;
    if (votingMode !== undefined) update.votingMode = votingMode;
    await ElectionModel.updateOne({ _id: id }, { $set: update });
    await this.addAudit({
      type: 'admin.updated',
      electionId: id,
      ref: null,
      detail: `Draft election "${update.title ?? election.title}" edited by organizer.`,
    });
    return this.getElection(id);
  }

  async transitionElection(id, toStatus) {
    // Conditional update: the transition itself is atomic; only one writer can
    // move an election forward, so double-transition races collapse to a
    // single winner. Lifecycle: draft → enrolment → frozen → voting → closed,
    // plus legacy draft → open → closed. Enrolment → frozen goes through
    // freezeGroup (validates + persists the approved root), never here.
    const allowedFrom = {
      open: ['draft'],
      enrolment: ['draft'],
      voting: ['frozen'],
      closed: ['open', 'enrolment', 'frozen', 'voting'],
    }[toStatus] ?? null;
    if (!allowedFrom) {
      const err = new Error(`Cannot transition election to ${toStatus}.`);
      err.status = 409;
      throw err;
    }
    const election = await ElectionModel.findOneAndUpdate(
      { _id: id, status: { $in: allowedFrom } },
      { $set: { status: toStatus, updatedAt: new Date().toISOString() } },
      { new: true },
    ).lean();
    if (!election) {
      const exists = await ElectionModel.exists({ _id: id });
      const err = new Error(
        exists ? `Cannot transition election to ${toStatus} from its current status.` : 'Unknown election.',
      );
      err.status = exists ? 409 : 404;
      throw err;
    }
    if ((toStatus === 'open' || toStatus === 'enrolment') && (!election.candidates || election.candidates.length < 2)) {
      await ElectionModel.updateOne({ _id: id, status: toStatus }, { $set: { status: 'draft' } });
      const err = new Error('An election needs at least 2 ballot choices before opening.');
      err.status = 409;
      throw err;
    }
    const details = {
      open: `Election "${election.title}" opened for credential holders.`,
      enrolment: `Election "${election.title}" opened for enrollment.`,
      voting: `Election "${election.title}" opened for voting.`,
      closed: `Election "${election.title}" closed by organizer.`,
    };
    await this.addAudit({
      type: toStatus === 'open' || toStatus === 'voting' ? 'election.opened' : 'admin.updated',
      electionId: id,
      ref: null,
      detail: details[toStatus],
    });
    return this.getElection(id);
  }

  async deleteElection(id) {
    // Conditional delete: only drafts disappear (drafts can hold no ballots or
    // passkeys, since every write path requires status open).
    const election = await ElectionModel.findById(id).lean();
    if (!election) {
      const err = new Error('Unknown election.');
      err.status = 404;
      throw err;
    }
    if (election.status !== 'draft') {
      const err = new Error('Only draft elections can be deleted.');
      err.status = 409;
      throw err;
    }
    await InvitationModel.deleteMany({ electionId: id });
    await ElectionModel.deleteOne({ _id: id, status: 'draft' });
    await this.addAudit({
      type: 'admin.updated',
      electionId: id,
      ref: null,
      detail: `Draft election "${election.title}" deleted by organizer.`,
    });
  }

  async freezeGroup(electionId) {
    const election = await ElectionModel.findById(electionId).lean();
    if (!election) {
      const err = new Error('Unknown election.');
      err.status = 404;
      throw err;
    }
    if (election.status !== 'open' && election.status !== 'enrolment') {
      const err = new Error('Only open or enrolling elections can freeze enrollment.');
      err.status = 409;
      throw err;
    }
    if (election.groupFrozen) {
      const err = new Error('Enrollment is already frozen for this election.');
      err.status = 409;
      throw err;
    }
    const group = await SemaphoreGroupModel.findById(electionId).lean();
    // Standard-mode elections have no Semaphore group; freezing is a phase
    // marker for them. Anonymous elections must have enrolled someone.
    if (election.votingMode !== 'standard' && (!group || group.members.length === 0)) {
      const err = new Error('Cannot freeze an empty group: enroll at least one credential first.');
      err.status = 409;
      throw err;
    }
    const latest = group?.snapshots[group.snapshots.length - 1];
    // Conditional set: concurrent freeze attempts collapse; the flag and the
    // enrolment → frozen move are monotonic and atomic.
    const updated = await ElectionModel.findOneAndUpdate(
      { _id: electionId, groupFrozen: { $ne: true } },
      {
        $set: {
          groupFrozen: true,
          frozenAt: new Date().toISOString(),
          frozenVersion: group?.version ?? 0,
          frozenRoot: latest?.root ?? null,
          ...(election.status === 'enrolment' ? { status: 'frozen' } : {}),
          updatedAt: new Date().toISOString(),
        },
      },
      { new: true },
    ).lean();
    if (!updated) {
      const err = new Error('Enrollment is already frozen for this election.');
      err.status = 409;
      throw err;
    }
    await this.addAudit({
      type: 'admin.updated',
      electionId,
      ref: latest?.root ?? null,
      detail: `Anonymous enrollment frozen at group v${group?.version ?? 0} by organizer (irreversible).`,
    });
    return this.getElection(electionId);
  }

  async electionStats(electionId) {
    const [ballotsCast, passkeys, invitationsIssued, invitationsRedeemed, group] = await Promise.all([
      BallotModel.countDocuments({ electionId }),
      PasskeyModel.countDocuments({ electionId }),
      InvitationModel.countDocuments({ electionId }),
      InvitationModel.countDocuments({ electionId, redeemedAt: { $ne: null } }),
      SemaphoreGroupModel.findById(electionId).lean(),
    ]);
    return {
      electionId,
      ballotsCast,
      passkeys,
      invitationsIssued,
      invitationsRedeemed,
      groupVersion: group?.version ?? 0,
    };
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

  // Create-then-catch on unique indexes: atomic across processes, unlike
  // exists-then-create. Preserves the exact legacy error messages.
  async savePasskey({ id, voterRef, electionId, userIdBase64, publicKeyBase64, counter, transports, deviceType, backedUp }, { session } = {}) {
    const voterSecret = randomHex(32);
    let record;
    try {
      [record] = await PasskeyModel.create(
        [{
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
        }],
        { session },
      );
    } catch (err) {
      if (err?.code === 11000) {
        const dup = new Error(
          err.keyPattern && 'voterRef' in err.keyPattern
            ? 'This voter has already registered a passkey for this election.'
            : 'This passkey is already registered.',
        );
        dup.status = 409;
        throw dup;
      }
      throw err;
    }
    await this.addAudit(
      {
        type: 'voter.registered',
        electionId,
        ref: sha256Hex(id),
        detail: 'Passkey credential registered for an eligible voter (public key only).',
      },
      { session },
    );
    const plain = record.toObject ? record.toObject() : record;
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
  async saveWebAuthnChallenge({ id, challenge, type, voterRef, electionId, allowCredentialIds = [], userIdBase64 = null, invitationHash = null, ttlMs = 5 * 60 * 1000 }) {
    await WebAuthnChallengeModel.create({
      _id: id,
      challenge,
      type,
      voterRef,
      electionId,
      allowCredentialIds,
      userIdBase64,
      invitationHash,
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
  async createSession({ voterRef, electionId, credentialId, role = 'voter', organizerId, ttlMs }) {
    const record = await SessionModel.create({
      _id: randomHex(32),
      role,
      voterRef,
      electionId,
      credentialId,
      organizerId,
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
    if (election.status !== 'open' && election.status !== 'voting') {
      await this.#auditRejection(electionId, nullifierHash, 'Ballot rejected: election is not open.');
      const err = new Error('Election is not open for voting.');
      err.status = 409;
      throw err;
    }
    if (election.votingMode === 'anonymous') {
      await this.#auditRejection(electionId, nullifierHash, 'Ballot rejected: election accepts anonymous ballots only.');
      const err = new Error('This election accepts anonymous ballots only.');
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

  // -- transactions ------------------------------------------------------------------
  // Multi-document writes run inside replica-set transactions (Atlas and the
  // integration-test replset both provide them), so group enrollment and
  // versioning stay correct across concurrent processes. withTransaction
  // retries transient errors; duplicate-key aborts surface as-is.
  async #withTransaction(fn) {
    const session = await mongoose.startSession();
    try {
      let result;
      await session.withTransaction(
        async () => {
          result = await fn(session);
        },
        { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } },
      );
      return result;
    } finally {
      await session.endSession();
    }
  }

  // -- organizers --------------------------------------------------------------
  // Atomic single-use bootstrap: exactly one caller can consume the singleton,
  // even under concurrency (upsert race collapses to 11000 → unavailable).
  async consumeBootstrap() {
    const unavailable = () => {
      const err = new Error('Organizer setup is unavailable.');
      err.status = 403;
      return err;
    };
    try {
      const doc = await BootstrapModel.findOneAndUpdate(
        { _id: 'bootstrap', consumedAt: null },
        {
          $setOnInsert: { _id: 'bootstrap' },
          $set: { consumedAt: new Date().toISOString() },
        },
        { upsert: true, new: true },
      ).lean();
      if (!doc) throw unavailable();
    } catch (err) {
      if (err?.code === 11000 || err?.status === 403) throw unavailable();
      throw err;
    }
  }

  async createOrganizer({ username, passwordHash, createdBy }) {
    try {
      const record = await OrganizerModel.create({
        _id: username,
        passwordHash,
        createdAt: new Date().toISOString(),
        createdBy,
      });
      const plain = record.toObject();
      return { username: plain._id, createdAt: plain.createdAt };
    } catch (err) {
      if (err?.code === 11000) {
        const dup = new Error('Organizer username is taken.');
        dup.status = 409;
        throw dup;
      }
      throw err;
    }
  }

  async getOrganizer(username) {
    const row = await OrganizerModel.findById(username).lean();
    if (!row) return null;
    return { username: row._id, passwordHash: row.passwordHash, createdAt: row.createdAt };
  }

  // -- invitations ---------------------------------------------------------------
  async createInvitations({ electionId, count, expiresAt, label, createdBy }) {
    const election = await ElectionModel.findById(electionId).lean();
    if (!election) {
      const err = new Error('Unknown election.');
      err.status = 404;
      throw err;
    }
    const now = new Date().toISOString();
    const issued = [];
    for (let i = 0; i < count; i += 1) {
      let record = null;
      for (let attempt = 0; attempt < 5 && !record; attempt += 1) {
        const token = `inv_${randomHex(24)}`;
        try {
          [record] = await InvitationModel.create([
            {
              _id: sha256Hex(token),
              electionId,
              voterRef: `INV-${randomHex(4).toUpperCase()}`,
              label: label ?? '',
              expiresAt,
              redeemedAt: null,
              createdAt: now,
              createdBy,
            },
          ]);
          issued.push({ token, voterRef: record.voterRef, expiresAt: new Date(expiresAt).toISOString() });
        } catch (err) {
          if (err?.code !== 11000) throw err;
          record = null; // hash or voterRef collision: regenerate
        }
      }
      if (!record) {
        const err = new Error('Could not mint a unique invitation. Try again.');
        err.status = 503;
        throw err;
      }
    }
    await this.addAudit({
      type: 'admin.updated',
      electionId,
      ref: null,
      detail: `${count} voter invitation(s) issued by organizer (hashes only).`,
    });
    return issued;
  }

  async listInvitations(electionId) {
    // Plaintext tokens are NEVER returned here — only at creation time.
    const rows = await InvitationModel.find({ electionId }).lean();
    return rows.map((inv) => ({
      tokenHash: inv._id,
      voterRef: inv.voterRef,
      label: inv.label,
      expiresAt: new Date(inv.expiresAt).toISOString(),
      redeemedAt: inv.redeemedAt,
      createdAt: inv.createdAt,
    }));
  }

  async revokeInvitation(tokenHash) {
    const invitation = await InvitationModel.findById(tokenHash).lean();
    if (!invitation) {
      const err = new Error('Unknown invitation.');
      err.status = 404;
      throw err;
    }
    if (invitation.redeemedAt) {
      const err = new Error('Redeemed invitations cannot be revoked.');
      err.status = 409;
      throw err;
    }
    await InvitationModel.deleteOne({ _id: tokenHash, redeemedAt: null });
    await this.addAudit({
      type: 'admin.updated',
      electionId: invitation.electionId,
      ref: null,
      detail: 'Voter invitation revoked by organizer before redemption.',
    });
  }

  async peekInvitation(token) {
    const invitation = await InvitationModel.findById(sha256Hex(token)).lean();
    if (!invitation || invitation.redeemedAt || invitation.expiresAt < Date.now()) return null;
    return invitation;
  }

  // Atomic single-use redemption: the conditional update is the entire guard.
  async redeemInvitation(token) {
    return InvitationModel.findOneAndUpdate(
      { _id: sha256Hex(token), redeemedAt: null, expiresAt: { $gt: Date.now() } },
      { $set: { redeemedAt: new Date().toISOString() } },
      { new: true },
    ).lean();
  }

  // Invitation redemption + passkey binding in one transaction: either both
  // land or neither does, so a crash cannot strand a redeemed invitation
  // without its credential (or vice versa).
  async registerInvitedPasskey({ token, tokenHash, passkey }) {
    const hash = tokenHash ?? sha256Hex(token);
    return this.#withTransaction(async (session) => {
      const invitation = await InvitationModel.findOneAndUpdate(
        { _id: hash, redeemedAt: null, expiresAt: { $gt: Date.now() } },
        { $set: { redeemedAt: new Date().toISOString() } },
        { new: true, session },
      ).lean();
      if (!invitation) {
        const err = new Error('Invalid or expired invitation.');
        err.status = 403;
        throw err;
      }
      return this.savePasskey({ ...passkey, voterRef: invitation.voterRef }, { session });
    });
  }

  // -- Semaphore groups (anonymous voting credentials) ---------------------------
  // Enrollment, group append, version bump, and audit land in one transaction:
  // concurrent enrollments serialize on the group document instead of
  // silently forking member lists or snapshot versions.
  async enrollCommitment({ electionId, voterRef, commitment }) {
    return this.#withTransaction(async (session) => {
      const election = await ElectionModel.findById(electionId, null, { session }).lean();
      if (!election) {
        const err = new Error('Unknown election.');
        err.status = 404;
        throw err;
      }
      if (election.status !== 'open' && election.status !== 'enrolment') {
        const err = new Error('Election is not open for enrollment.');
        err.status = 409;
        throw err;
      }
      if (election.votingMode === 'standard') {
        const err = new Error('This election accepts standard ballots only.');
        err.status = 409;
        throw err;
      }
      if (election.groupFrozen) {
        const err = new Error('Anonymous enrollment is frozen for this election.');
        err.status = 409;
        throw err;
      }
      try {
        await SemaphoreEnrollmentModel.create(
          [{ voterRef, electionId, commitment, enrolledAt: new Date().toISOString() }],
          { session },
        );
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
      const doc = await SemaphoreGroupModel.findById(electionId, null, { session }).lean();
      const members = [...(doc?.members ?? []), commitment];
      const version = (doc?.version ?? 0) + 1;
      const root = buildGroup(members).root.toString();
      await SemaphoreGroupModel.findByIdAndUpdate(
        electionId,
        {
          $set: { members, version },
          $push: { snapshots: { version, root } },
        },
        { upsert: true, session },
      );
      await this.addAudit(
        {
          type: 'semaphore.enrolled',
          electionId,
          ref: sha256Hex(commitment),
          detail: `Anonymous voting credential enrolled (group v${version}; commitment hash only).`,
        },
        { session },
      );
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
    const election = await ElectionModel.findById(electionId).lean();
    // Once frozen, only the persisted freeze-time root verifies — no other
    // snapshot, even a server-made one, is accepted for voting.
    if (election?.groupFrozen && election.frozenRoot) return root === election.frozenRoot;
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

  // Atomic seq via $inc counter (safe across processes), optionally inside a
  // caller-provided transaction session. The counter starts after any seeded
  // events (see ensureSeeded), so live seqs never collide with seeds.
  async addAudit({ type, electionId, ref, detail }, { session } = {}) {
    const counter = await CounterModel.findOneAndUpdate(
      { _id: 'auditSeq' },
      { $inc: { value: 1 } },
      { upsert: true, new: true, session },
    );
    const [event] = await AuditEventModel.create(
      [{ seq: counter.value, ts: new Date().toISOString(), type, electionId, ref, detail }],
      { session },
    );
    return event.toObject();
  }
}
