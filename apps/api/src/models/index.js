import mongoose from 'mongoose';

const candidateSchema = new mongoose.Schema(
  { id: String, name: String, party: String },
  { _id: false },
);

export const ElectionModel = mongoose.model(
  'Election',
  new mongoose.Schema({
    _id: String,
    title: String,
    description: String,
    status: { type: String, default: 'open' }, // draft | enrolment | frozen | voting | closed | open (legacy) | certified (seed-only)
    access: { type: String, default: 'roll' }, // roll (fictional PIN roll) | invitation
    votingMode: String, // standard | anonymous. Unset on legacy seeds (both paths allowed).
    startsAt: String,
    endsAt: String,
    candidates: [candidateSchema],
    createdBy: String, // organizer username, or 'seed'
    createdAt: String,
    updatedAt: String,
    groupFrozen: { type: Boolean, default: false },
    frozenAt: String,
    frozenVersion: Number,
    frozenRoot: String, // approved group root persisted at freeze time
  }),
);

// Registered passkey. Stores the PUBLIC key and metadata only — never private
// keys, biometric templates, or images. One record per (voterRef, electionId)
// enforces one credential per eligible voter.
const passkeySchema = new mongoose.Schema({
  _id: String, // base64url credential id
  voterRef: String,
  electionId: String,
  userIdBase64: String, // opaque WebAuthn user handle
  publicKeyBase64: String,
  counter: Number,
  transports: [String],
  deviceType: String,
  backedUp: Boolean,
  voterSecret: String, // server-side only; derives the voting nullifier
  nullifierHash: { type: String, unique: true },
  registeredAt: String,
  lastUsedAt: String,
});
// Atomic one-passkey-per-voter guard (replaces the racy exists-then-create).
passkeySchema.index({ voterRef: 1, electionId: 1 }, { unique: true });
export const PasskeyModel = mongoose.model('Passkey', passkeySchema);

export const BallotModel = mongoose.model(
  'Ballot',
  new mongoose.Schema({
    _id: String, // nullifierHash — uniqueness enforced by the database
    electionId: String,
    ballotCommitment: String,
    castAt: String,
  }),
);

// Semaphore group per election: ordered identity commitments plus every
// approved historical root (versioned snapshots). Proofs verify against any
// approved root, so ballots stay valid as the group grows.
export const SemaphoreGroupModel = mongoose.model(
  'SemaphoreGroup',
  new mongoose.Schema({
    _id: String, // electionId
    members: [String], // identity commitments (decimal strings), insertion order
    snapshots: [{ version: Number, root: String, _id: false }],
    version: { type: Number, default: 0 },
  }),
);

// One Semaphore enrollment per (voter, election). Compound unique indexes make
// duplicate-voter and duplicate-commitment rejection atomic at the database.
const semaphoreEnrollmentSchema = new mongoose.Schema({
  voterRef: String,
  electionId: String,
  commitment: String, // identity commitment only — never private secrets
  enrolledAt: String,
});
semaphoreEnrollmentSchema.index({ voterRef: 1, electionId: 1 }, { unique: true });
semaphoreEnrollmentSchema.index({ electionId: 1, commitment: 1 }, { unique: true });
export const SemaphoreEnrollmentModel = mongoose.model(
  'SemaphoreEnrollment',
  semaphoreEnrollmentSchema,
);

export const AuditEventModel = mongoose.model(
  'AuditEvent',
  new mongoose.Schema({
    seq: Number,
    ts: String,
    type: String,
    electionId: String,
    ref: String,
    detail: String,
  }),
);

// Single-use, short-lived WebAuthn ceremony state.
export const WebAuthnChallengeModel = mongoose.model(
  'WebAuthnChallenge',
  new mongoose.Schema({
    _id: String, // request id (opaque handle; the raw challenge stays inside)
    challenge: String,
    type: String, // 'registration' | 'authentication'
    voterRef: String,
    electionId: String,
    allowCredentialIds: [String],
    userIdBase64: String,
    invitationHash: String, // set for invitation-path registrations (hash only)
    expiresAt: Number,
  }),
);

export const SessionModel = mongoose.model(
  'Session',
  new mongoose.Schema({
    _id: String, // random session id (cookie value)
    role: { type: String, default: 'voter' }, // voter | organizer
    voterRef: String, // voters only
    electionId: String, // voters only
    credentialId: String, // voters only
    organizerId: String, // organizers only
    csrfToken: String,
    createdAt: String,
    expiresAt: Number,
  }),
);

// Organizer accounts. Passwords stored as scrypt hashes only (see lib/password.js).
export const OrganizerModel = mongoose.model(
  'Organizer',
  new mongoose.Schema({
    _id: String, // username slug (unique by _id)
    passwordHash: String,
    createdAt: String,
    createdBy: String, // 'bootstrap' or another organizer's username
  }),
);

// Singleton bootstrap guard: organizer setup consumes {_id:'bootstrap'} once,
// atomically, so concurrent setups cannot create two founding organizers.
export const BootstrapModel = mongoose.model(
  'Bootstrap',
  new mongoose.Schema({
    _id: String,
    consumedAt: String,
  }),
);

// Voter invitations. Only the token HASH is stored; plaintext tokens are shown
// to the organizer exactly once at creation and never again.
const invitationSchema = new mongoose.Schema({
  _id: String, // sha256 hex of the invitation token
  electionId: String,
  voterRef: String, // assigned fictional voter identity, unique per election
  label: String, // organizer note (e.g. seat or cohort); never a real-world ID
  expiresAt: Number, // epoch ms
  redeemedAt: String, // ISO ts once consumed, else null
  createdAt: String,
  createdBy: String, // organizer username
});
invitationSchema.index({ electionId: 1, voterRef: 1 }, { unique: true });
invitationSchema.index({ electionId: 1, redeemedAt: 1 });
export const InvitationModel = mongoose.model('Invitation', invitationSchema);

// Atomic counters (audit seq). findOneAndUpdate+$inc is safe across processes,
// unlike read-max-then-insert.
export const CounterModel = mongoose.model(
  'Counter',
  new mongoose.Schema({
    _id: String,
    value: { type: Number, default: 0 },
  }),
);

// Required unique indexes, verified at boot (fail closed if any is missing).
// Each entry: [model, keyPattern, description].
export const REQUIRED_UNIQUE_INDEXES = [
  [PasskeyModel, { voterRef: 1, electionId: 1 }, 'passkeys(voterRef,electionId)'],
  [PasskeyModel, { nullifierHash: 1 }, 'passkeys(nullifierHash)'],
  [SemaphoreEnrollmentModel, { voterRef: 1, electionId: 1 }, 'semaphoreenrollments(voterRef,electionId)'],
  [SemaphoreEnrollmentModel, { electionId: 1, commitment: 1 }, 'semaphoreenrollments(electionId,commitment)'],
  [InvitationModel, { electionId: 1, voterRef: 1 }, 'invitations(electionId,voterRef)'],
];

/** Create declared indexes, then verify every required unique index exists. */
export async function ensureMongoIndexes() {
  const models = [
    ElectionModel, PasskeyModel, BallotModel, SemaphoreGroupModel,
    SemaphoreEnrollmentModel, AuditEventModel, WebAuthnChallengeModel,
    SessionModel, OrganizerModel, BootstrapModel, InvitationModel, CounterModel,
  ];
  await Promise.all(models.map((model) => model.createIndexes()));
  for (const [model, keys, label] of REQUIRED_UNIQUE_INDEXES) {
    const indexes = await model.collection.listIndexes().toArray();
    const found = indexes.some(
      (index) => index.unique === true && keysMatch(index.key, keys),
    );
    if (!found) throw new Error(`CivicProof: required unique index missing: ${label}`);
  }
}

function keysMatch(actual, expected) {
  const aKeys = Object.keys(actual);
  const eKeys = Object.keys(expected);
  return aKeys.length === eKeys.length && eKeys.every((k) => actual[k] === expected[k]);
}
