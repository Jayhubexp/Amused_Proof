# CivicProof AI — MVP Architecture & Implementation Plan

Research prototype for the Meta AI Developer Hackathon. NOT production election software.

## 1. Goal

Demonstrate a privacy-preserving digital election UX: fictional voters register,
authenticate with a simulated passkey, cast one private ballot each, and anyone can
inspect a public audit trail. A read-only AI assistant explains audit evidence.

## 2. Non-negotiable scope rules

- Fictional data only (`seed/` fixtures, clearly labelled).
- No facial biometrics collected or stored, ever.
- No voter identities or plaintext votes on-chain; chain carries only
  `electionId`, `ballotCommitment` (hash), and `nullifierHash`.
- Zero-knowledge proofs use the maintained `@semaphore-protocol` packages only.
  Proven properties are membership, election-scope/message binding, and
  nullifier one-use — never ballot secrecy or tally correctness, which remain
  unimplemented.
- No custom cryptography. Hashing via Node `crypto` (SHA-256) for commitments;
  real zero-knowledge proofs deferred to established libraries (e.g. `snarkjs` /
  Semaphore-style nullifiers) in a later phase — current nullifier check is a
  **server-side duplicate guard, labelled SIMULATED**, not a ZK proof.
- AI (Meta Muse Spark 1.3) is read-only: explains audit logs, never decides vote
  validity, never writes ballots.
- Every UI surface that is mocked carries an explicit `SIMULATED` badge; only
  genuinely enforced checks (server-side one-credential-one-vote, input
  validation) are labelled `ENFORCED`.

## 3. Monorepo layout

```
civicproof-ai/
  package.json                 # npm workspaces: apps/*, contracts
  docs/ARCHITECTURE.md         # this file
  apps/api/                    # Express (ESM) + Mongoose
    src/
      index.js                 # bootstrap (DB or memory store)
      app.js                   # Express app factory (testable)
      config.js                # env handling, no secrets in code
      routes/                  # health, elections, webauthn, session, ballots, semaphore, audit, ai
      models/                  # Mongoose schemas (Election, Passkey, Ballot, AuditEvent, SemaphoreGroup, ...)
      store/                   # storage interface: mongo.js + memory.js (+ file snapshots)
      seed/                    # fictional elections, voter roll, audit events
      lib/                     # hashing, nullifiers, validation helpers
      ai/                      # Muse Spark client, rules, sanitize, schema, prompts, orchestrator
      auth/                    # SimpleWebAuthn service binding + session/cookie/CSRF helpers
      zk/                      # Semaphore scope/message binding + verification wrapper
    tests/                     # node:test + supertest (ballots, api, ai, webauthn, semaphore)
  apps/web/                    # React + Vite + Tailwind + Mantine
    src/
      pages/                   # Landing, Dashboard, Voting, AuditExplorer, Integrity
      components/              # badges, layout, anonymous ballot
      lib/api.js               # API client (+ fixture fallback, cookies, CSRF, anon variants)
      lib/semaphore.js         # client-side identities, proving, tab-scoped backup
      fixtures/                # fictional data fallback when API offline
  contracts/                   # Hardhat + Solidity (future phase; anchor only)
```

## 4. API design (v1, all JSON)

| Method | Path                              | Purpose |
|--------|-----------------------------------|---------|
| GET    | /api/health                       | liveness + store mode (`mongo`/`memory`) |
| GET    | /api/elections                    | list fictional elections |
| GET    | /api/elections/:id                | election detail + candidates |
| POST   | /api/webauthn/register/options  | roll-gated passkey registration options |
| POST   | /api/webauthn/register/verify   | verify attestation -> persist public key |
| POST   | /api/webauthn/auth/options      | passkey authentication options |
| POST   | /api/webauthn/auth/verify       | verify assertion -> session cookie + CSRF |
| GET    | /api/session                    | current session state |
| POST   | /api/logout                     | destroy session, clear cookie |
| POST   | /api/ballots                      | cast ballot (ENFORCED: session-bound, 1 credential -> 1 vote) |
| POST   | /api/semaphore/enroll             | enroll identity commitment (session-bound, 1 per voter) |
| GET    | /api/semaphore/group/:electionId  | public group snapshot (members, root, version, scope) |
| POST   | /api/ballots/anonymous            | cast ballot with ZK proof (ENFORCED: anonymous, 1 nullifier -> 1 vote) |
| GET    | /api/audit                        | public audit events (no identities) |
| GET    | /api/ai/integrity                 | rules + Muse Spark analysis (degrades to rules-only) |
| POST   | /api/ai/ask                       | NL questions from audit log (503 without API key) |

Ballot request: `{ electionId, ballotCommitment }` + session cookie +
`X-CSRF-Token` header. Server derives the nullifier from the session's passkey
record and rejects unauthenticated (401), CSRF/election mismatch (403), and
duplicate `nullifierHash` (409). No plaintext choice is accepted or stored.
Ceremony challenges are single-use, 5-minute, type-bound; verification (origin,
RP ID, signature, UV, counter) is done by `@simplewebauthn/server`.

Anonymous ballot request: `{ electionId, ballotCommitment, proof }` with no
cookies or CSRF token. Server checks election scope, recomputes the expected
message from the commitment, requires a server-approved group root, verifies
the Semaphore proof with the official library, then atomically records the
nullifier — rejecting wrong scope, altered messages, unknown roots, invalid
proofs (401, audited as `proof.rejected`), and reused nullifiers (409).

## 5. Data model

- **Election**: id, title, description, status (`draft` → `enrolment` →
  `frozen` → `voting` → `closed`, plus legacy `open`; atomic conditional
  transitions), access (`roll` | `invitation`), votingMode (`standard` |
  `anonymous`, required at creation, locked after draft; unset on legacy
  seeds, which allow both paths), dates, candidates[{id, name, party}],
  createdBy organizer, groupFrozen flag + frozenAt/frozenVersion/frozenRoot
  (approved root persisted at freeze; frozen elections verify only it).
  Drafts are organizer-only; edits/deletes are drafts-only.
- **VoterRoll** (seed, fictional): voterRef, electionId, displayName, demo PIN.
  Roll-access elections only; PINs are demo-only.
- **Organizer**: username (unique), scrypt password hash, createdAt/createdBy.
  No public signup: founding account via single-use setup token, further
  accounts created by signed-in organizers. Three public demo logins exist for
  local testing only, gated on explicit `DEMO_ORGANIZERS=true` and blocked in
  production by `validateConfig` at boot.
- **Bootstrap**: single-row single-use setup-token consumption marker.
- **Invitation**: tokenHash (SHA-256, id), electionId, voterRef (`INV-…`),
  label, expiresAt, redeemedAt, createdBy. Plaintext codes exist only in the
  creation response; unique (electionId, voterRef).
- **Passkey**: credential id, voterRef, electionId, opaque user handle, PUBLIC
  key + counter + transports + device metadata, server-side voter secret,
  nullifierHash. One per (voter, election) via unique index. Never private
  keys or biometrics.
- **WebAuthnChallenge**: request id, challenge, ceremony type, voter/election,
  allow-list, optional invitationHash (invitation-path registrations), expiry.
  Single-use, 5-minute, type-bound.
- **Session**: random id (cookie value), role (`voter` | `organizer`),
  voterRef/electionId/credentialId (voters) or organizerId (organizers), CSRF
  token, expiry. Server-side only. Roles are rejected cross-wise.
- **Counter**: named atomic counters (audit `seq` via `$inc`).
- **Ballot**: electionId, nullifierHash (unique), ballotCommitment, castAt.
  No voter reference stored alongside. Anonymous ballots add `anonymous: true`.
- **SemaphoreGroup**: per election, ordered member commitments plus versioned
  `{version, root}` snapshots. Proofs verify against any approved snapshot.
- **SemaphoreEnrollment**: one commitment per (voterRef, electionId); unique
  indexes enforce one-voter-one-commitment atomically.
- **AuditEvent**: seq, ts, type, electionId, ref hash, detail (public-safe).
  Types: `election.opened`, `voter.registered`, `auth.success`, `ballot.cast`,
  `ballot.rejected` (runtime rejections + fictional incidents), `proof.rejected`
  (anonymous proof failures with reason codes), `semaphore.enrolled`,
  `auth.failed`, `admin.updated`, `transaction.error`, `tally.checkpoint`.
  Refs are correlation hashes, never raw credentials or nullifiers.

Storage: Mongoose when `MONGODB_URI` is set, otherwise an in-memory store with the
same interface so the prototype and tests run with zero infrastructure. The
memory store optionally snapshots durable state (passkeys, ballots, audit,
Semaphore groups) to `STORE_FILE` so it survives restarts; sessions and
challenges stay ephemeral either way. When MongoDB is configured but
unreachable the API refuses to boot (exit 1) rather than silently falling back
to memory for voting storage; `NODE_ENV=production` requires `MONGODB_URI`.
Required unique indexes (passkeys, enrollments, invitations) are created AND
verified at boot — fail closed if any is missing. MongoDB enrolment,
versioning, freeze, invitation redeem, and nullifier writes use replica-set
transactions or atomic conditional updates (Atlas provides replica sets).

## 6. Frontend pages (MVP)

1. **Landing** — what CivicProof is, prototype disclaimer, Verified-vs-Simulated panel.
2. **Election Dashboard** — fictional elections, status, access badges, turnout
   (from audit counts), plus a signed-in "your eligible election" card.
3. **Voting Interface** — eligibility (fictional roll + PIN, or invitation gate
   linking to redemption), real WebAuthn passkey registration/authentication
   (`@simplewebauthn/browser`), then a standard session ballot or an anonymous
   Semaphore ballot (client-side identity, commitment enrollment, in-browser
   proving, anonymous submission with accept/duplicate/failure states and
   audit-evidence links).
4. **Audit Explorer** — public event table, filter by election/type, hash display.
5. **Integrity Dashboard** — read-only AI explanation panel: deterministic rule
   findings plus Muse Spark interpretation when `MUSE_SPARK_API_KEY` is set,
   evidence links into the audit explorer, and a Q&A box. Labelled `Live model`
   or `Rules only` accordingly.
6. **Invite redemption** — paste a single-use code, register a personal passkey,
   authenticate, continue to voting. Invitation approval is organizer-managed
   testing access, not identity verification.
7. **Organizer portal** — sign-in + one-time setup; dashboard with per-election
   stats and open/close actions; create/edit drafts; issue (codes shown once),
   list (hashes only), and revoke invitations; freeze groups; delete drafts.

Mobile-first, responsive; Mantine components + Tailwind utilities.

## 7. Phased delivery

- **Phase 1 (done)**: monorepo, API + seed + tests, 4 pages + AI stub,
  local run verified, docs.
- **Phase 2 (done — this increment)**: AI Election Integrity Assistant: Muse
  Spark 1.3 client (`openai` SDK against `https://api.meta.ai/v1`), deterministic
  rules, sanitization, output validation, read-only tool use, upgraded Integrity
  Dashboard, fictional incident seeds, mocked AI test suite.
- **Phase 3 (done — this increment)**: real WebAuthn passkeys
  (`@simplewebauthn/server` + `@simplewebauthn/browser`): roll-gated enrolment,
  verified ceremonies (origin/RP ID/signature/UV/counter), single-use
  challenges, HttpOnly sessions + CSRF, session-bound ballots, 16-test
  WebAuthn suite.
- **Phase 4 (done — this increment)**: Semaphore v4 anonymous voting:
  client-side identities, commitment enrollment after roll eligibility,
  versioned group snapshots, election-scope/message-bound membership proofs
  generated in-browser, server-side verification with the official library,
  session-free anonymous submission, atomic restart-durable nullifiers, AI
  coverage of proof failures, 16-test real-proving suite.
- **Phase 5 (done — this increment)**: organizer-managed multi-user testing on
  MongoDB: scrypt organizer auth with single-use setup bootstrap, draft/open/
  closed lifecycle, expiring single-use hash-stored invitations with uniform
  failure responses, invitation-gated passkey registration, explicit group
  freeze, fail-closed boot with verified unique indexes, replica-set
  transactions for redeem/enrol/versioning, strict rate limits, organizer
  portal + invite UI, 19-test real-MongoDB integration suite.
- **Phase 4.5 (done — this increment)**: cross-mode double-vote prevention and
  lifecycle hardening: required server-enforced votingMode per election (mode
  mismatch rejected 409 before any proof work; locked after draft),
  draft → enrolment → frozen → voting → closed with phase-gated registration /
  enrolment / ballots, persisted frozen roots with strict post-freeze root
  verification, one-credential-per-voter-record enforcement, Atlas verification
  script + Atlas-capable integration suite, lifecycle UI, verification report.
- **Phase 6**: `contracts/` anchor on testnet via Hardhat/ethers, ballot
  secrecy + verifiable tally research, further hardening review.

## 8. Threat-model notes (prototype)

- Trusts the server for eligibility and nullifier uniqueness (centralised).
- Passkeys are real WebAuthn (SimpleWebAuthn v14): phishing-resistant
  ceremony with origin/RP ID/signature/UV/counter verification, single-use
  5-minute challenges, and allow-listed credential ids. UV is required; PIN
  satisfies it, so security keys are a non-biometric option.
- Sessions are server-side random ids in HttpOnly SameSite=Lax cookies
  (Secure in production) + per-session CSRF tokens + same-origin POST
  enforcement. Demo PINs and the fictional roll are NOT real identity proof.
- Anonymous ballots prove group membership with real Semaphore proofs, but
  ballot CONTENT secrecy is SIMULATED: commitments are salted hashes,
  brute-forceable over small candidate sets, and no tally is built or verified.
- Identity secrets live client-side (memory + tab-scoped sessionStorage) with
  no recovery: backup theft enables impersonation, total loss loses the vote.
- Small demo groups give little anonymity (warned under 3 members); enrollment
  timing can link voters to commitments; no network-level protections exist.
- Semaphore trust assumptions apply: Groth16 trusted setup, proving-key
  distribution, and correct circuit implementation in the library.
- MongoDB enrollment, group versioning, freeze, invitation redemption, and
  nullifier recording are transaction-safe / atomic conditional writes, proven
  by concurrent integration tests; the memory store stays single-process.
- Organizer passwords use scrypt (Node built-in) with a dummy-hash path for
  unknown users; setup token is single-use with constant-time compare; voter
  and organizer sessions are rejected on each other's routes. Invitation codes
  are 192-bit bearer secrets with uniform failure responses and strict
  per-IP rate limiting — but the limiter is in-memory and single-process, so
  multi-replica deployments need a shared store (e.g. Redis).
- Voting mode is enforced server-side (stores + routes), never by hiding UI:
  anonymous elections reject standard ballots, standard elections reject
  enrolment and proofs. Legacy seed elections without a mode still allow both
  paths (documented demo grandfathering, covered by a test).
- Public audit refs are hashes (credential ids, nullifiers) or public values
  (commitments, roots) — never voter refs, tokens, or secrets. The same
  credential hash appears in its registration and authentication events, which
  links those two events to each other by design (needed for failure-rate
  analysis); it reveals nothing about the voter.
- Microscopic race accepted: an enrolment landing in the same instant as a
  freeze could miss the persisted root and have its later ballot rejected with
  a clear audit trail. It cannot double-vote or corrupt the group; the voter
  re-enrols only if never enrolled (voter-level uniqueness still holds).
- Blockchain anchoring is NOT implemented: the audit log is server-published.
- Audit log carries correlation hashes only; ballots store no voter reference.
- Secrets live only in `.env` (git-ignored); `.env.example` documents keys.
- Localhost RP config is development-only; production requires https origin,
  matching RP ID, and `COOKIE_SECURE=true`.
- AI assistant is read-only by construction: prompts forbid verdicts, the only
  tool reads audit events (bounded rounds, re-validated args), and outputs are
  schema-validated with citations cross-checked against real event seqs.
- Audit text and user questions are untrusted input: injection-defense prompts,
  input redaction/length caps, and fail-closed error handling. No LLM guardrail
  is absolute — findings are investigative leads, not verdicts.
- Model failures degrade: analysis falls back to rules-only, Q&A returns
  503/429/502 with safe messages. Timeout 20s, max 2 retries on 429/408/5xx.
