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
    status: { type: String, default: 'open' },
    startsAt: String,
    endsAt: String,
    candidates: [candidateSchema],
  }),
);

// Registered passkey. Stores the PUBLIC key and metadata only — never private
// keys, biometric templates, or images. One record per (voterRef, electionId)
// enforces one credential per eligible voter.
export const PasskeyModel = mongoose.model(
  'Passkey',
  new mongoose.Schema({
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
  }),
);

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
    expiresAt: Number,
  }),
);

export const SessionModel = mongoose.model(
  'Session',
  new mongoose.Schema({
    _id: String, // random session id (cookie value)
    voterRef: String,
    electionId: String,
    credentialId: String,
    csrfToken: String,
    createdAt: String,
    expiresAt: Number,
  }),
);
