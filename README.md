# CivicProof AI

Privacy-preserving digital election **research prototype** for the Meta AI Developer Hackathon.

> **Not production election software.** All voters, elections, and votes are fictional.
> See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the MVP plan and scope rules.

## Monorepo layout

```
apps/api/   Express backend (ES modules) + Mongoose, in-memory fallback
apps/web/   React + Vite + Tailwind + Mantine frontend
docs/       Architecture and implementation plan
```

## Prerequisites

- Node.js 20+

No database required: without `MONGODB_URI` the API uses a seeded in-memory store.

## Run locally

```powershell
# 1. Install dependencies (from the repo root)
npm install

# 2. Start the backend (http://localhost:4000)
npm run dev:api

# 3. In a second terminal, start the frontend (http://localhost:5173)
npm run dev:web
```

Open [http://localhost:5173](http://localhost:5173) in your browser.

Optional: copy `apps/api/.env.example` to `apps/api/.env` to set `PORT`,
`MONGODB_URI`, `CORS_ORIGINS`, or the Muse Spark settings below.

## Try the organizer portal (demo logins)

Three fictional organizer accounts are available for local testing. They are
public on purpose — enable them explicitly and never on shared data:

```powershell
# apps/api/.env
DEMO_ORGANIZERS=true
```

Restart the API (`npm run dev:api`), open
[http://localhost:5173/organizer/login](http://localhost:5173/organizer/login),
and sign in as:

| Username | Password |
|---|---|
| `organizer-1` | `fictional-demo-pass-01` |
| `organizer-2` | `fictional-demo-pass-02` |
| `organizer-3` | `fictional-demo-pass-03` |

Each demo organizer can create draft elections, issue invitations, and run the
full lifecycle. The API refuses to boot with `DEMO_ORGANIZERS=true` in
production (`NODE_ENV=production`), so these credentials can never accidentally
ship on a live deployment. Real organizer onboarding uses the single-use
`ORGANIZER_SETUP_TOKEN` instead (see `.env.example`).

## Deploy to Vercel

One project serves both the SPA and the API (same origin, so `SameSite=Lax`
session cookies work). `vercel.json` builds `apps/web` and rewrites `/api/*`
to the serverless Express adapter in `/api/index.js`; client-side routes fall
back to `/index.html`.

1. Push the repo to GitHub and import it in Vercel (root directory: repository
   root; build settings come from `vercel.json`, no dashboard overrides needed).
2. Create an Atlas cluster + database user, and allowlist `0.0.0.0/0` (Vercel
   egress IPs are dynamic).
3. Set production environment variables in the Vercel dashboard (see table
   below), using the final host you will share — passkeys bind to it.
4. Deploy, then visit `/organizer/login` → First-time setup with your
   `ORGANIZER_SETUP_TOKEN`, create elections, and walk the voter flow once.

| Variable | Required | Notes |
|---|---|---|
| `MONGODB_URI` | Yes | Atlas URI; boot fails closed without it |
| `ORGANIZER_SETUP_TOKEN` | Yes | 32-byte hex; single-use bootstrap |
| `WEBAUTHN_RP_ID` | Yes | Production host, no scheme (e.g. `my-app.vercel.app`) |
| `WEBAUTHN_ORIGIN` | Yes | `https://` + host, must match exactly |
| `COOKIE_SECURE` | Yes | `true` |
| `CORS_ORIGINS` | Yes | `https://` + host |
| `MUSE_SPARK_API_KEY` | No | Without it, integrity runs rules-only |
| `NODE_ENV` | Auto | Vercel sets `production` |

Never set `DEMO_ORGANIZERS` or `STORE_FILE` in production. Expect slow first
requests on cold starts (Atlas connect + proof-artifact fetch); later requests
reuse the warm instance.

## AI integrity assistant (Phase 2)

The Integrity Dashboard combines deterministic rules (always on) with live
interpretation by Meta Muse Spark 1.3 (when configured).

```powershell
# apps/api/.env — key stays server-side; never reaches the frontend or logs
MUSE_SPARK_API_KEY=your-key-here
# Optional: MUSE_SPARK_BASE_URL (default https://api.meta.ai/v1),
# MUSE_SPARK_MODEL (default muse-spark-1.3), MUSE_SPARK_TIMEOUT_MS (default 20000)
```

How it works:

1. `GET /api/ai/integrity` loads audit events and runs deterministic rules for
   duplicate-vote attempts, repeated auth failures, suspicious admin changes,
   and transaction errors.
2. Up to 60 relevant events are sanitized (unknown fields dropped, secret-like
   text redacted) and sent to Muse Spark with a read-only, JSON-only prompt.
3. The model may call one read-only tool, `get_audit_events`, for extra context
   (max 2 rounds). It cannot change votes, voters, eligibility, or results.
4. Every AI claim is validated server-side: unknown event citations are dropped
   with warnings, severities coerced, output length-clamped.
5. `POST /api/ai/ask` answers natural-language questions strictly from the
   audit log, with the same guards.

Real vs simulated:

- Real Meta inference: integrity summaries, findings, and Q&A **only when
  `MUSE_SPARK_API_KEY` is set** (dashboard shows `Live model`).
- Always real (no key needed): deterministic rules, sanitization, validation,
  evidence links.
- Still simulated: voter registration, passkey ceremony, ZK ballot privacy,
  blockchain anchoring.

Costs, failures, limitations:

- Each analysis/Q&A call consumes Muse Spark API usage on your key; empty
  scopes short-circuit without calling the model.
- Timeouts (20s), max 2 retries on 429/5xx only; `GET` degrades to rules-only
  with `aiStatus` set, `POST /ai/ask` returns 503/429/502 with safe messages.
- The model can misread evidence; findings are investigative leads, never
  verdicts — the assistant cannot declare fraud or certify results.
- Audit text is treated as untrusted (prompt-injection defenses in prompts +
  output validation), but no LLM guardrail is absolute; review findings
  against the linked events.

## Passkey authentication (Phase 3)

Voting uses real WebAuthn passkeys via `@simplewebauthn/server` (backend) and
`@simplewebauthn/browser` (frontend). All ceremony cryptography — attestation
and assertion verification, origin, RP ID, signature, user-verification flags,
authenticator counters — is performed by that established library; the
prototype implements no custom authentication cryptography.

How a demo vote works:

1. Pick a fictional voter from the roll shown on the Vote page (e.g.
   `PM-1001` / PIN `4921` for Metro Transit). Only roll members may enrol —
   arbitrary registration cannot grant eligibility.
2. Register a passkey with your platform authenticator (fingerprint/device
   PIN) or a roaming security key. No biometrics are collected or stored;
   security keys with PIN-only user verification work (non-biometric option).
3. Authenticate: the server verifies the signed challenge and issues a
   server-side session (HttpOnly, `SameSite=Lax` cookie, `Secure` in
   production) plus a CSRF token required on ballot submission.
4. Cast one ballot: the server derives the voting nullifier from your passkey
   record, so duplicate votes are rejected and clients never handle nullifiers.

Local development vs production:

- Localhost works out of the box (`WEBAUTHN_RP_ID=localhost`,
  `WEBAUTHN_ORIGIN=http://localhost:5173`) because browsers treat localhost
  as a secure context.
- Production MUST serve the frontend over HTTPS and set
  `WEBAUTHN_ORIGIN=https://<host>`, `WEBAUTHN_RP_ID=<host>`, and
  `COOKIE_SECURE=true` (see `apps/api/.env.example`). WebAuthn does not work
  over insecure origins.

## Anonymous voting with zero-knowledge proofs (Phase 4)

Alongside the session-bound ballot, voters can cast an **anonymous ballot**: a
real Semaphore v4 group-membership proof shows the voter belongs to the
election's enrolled group without revealing which member they are. All proving
and verification is done by the maintained `@semaphore-protocol` packages; the
prototype implements no custom zero-knowledge cryptography.

How it works:

1. After passkey authentication, the browser generates a Semaphore identity
   **client-side**. The secret never leaves the tab; only the public
   commitment is enrolled (one per voter per election, authenticated call).
2. The server appends the commitment to the election group and snapshots a new
   versioned root. Proofs verify against any server-approved root — a
   client-sent root is never trusted.
3. To vote, the browser fetches the public group, generates a membership proof
   bound to the election scope and the ballot commitment, and submits it with
   **no cookies, no session, no CSRF token**.
4. The server checks scope, message binding, and root approval, verifies the
   Groth16 proof with the official library, then atomically records the
   nullifier — a reused nullifier is rejected as a duplicate, exactly once
   even under concurrent submissions.

Client-side secret storage, backup, and recovery:

- The identity backup lives in memory plus `sessionStorage` (tab-scoped, dies
  with the tab). Copy it elsewhere with the in-app backup button if needed.
- There is deliberately **no server-side recovery**: anyone holding a backup
  copy can vote as that identity, and losing every copy loses the vote.
- A production system would need encrypted backups, device-bound storage, and
  a recovery ceremony — none of which exist here.

What is genuinely demonstrated vs what is not:

- Real and tested: anonymous group membership, scope/message binding, unknown
  roots rejected, tampered proofs rejected, one-use nullifiers (atomic,
  restart-durable), no voter linkage in ballots or audit records.
- Still simulated or missing: ballot **content** secrecy (candidate hashes are
  brute-forceable — no tally privacy), a verified election tally (none built),
  blockchain anchoring (nothing on-chain), eligibility (fictional roll).
- Privacy limits: tiny demo groups provide little anonymity (the UI shows the
  set size and warns under 3 members); enrollment timing can correlate voters
  to commitments; this demo has no network-level protections (Tor/VPN/mixnets).

Durability: with MongoDB, ballots, groups, and enrollments persist via unique
indexes. Without MongoDB, set `STORE_FILE` (see `apps/api/.env.example`) to
snapshot the memory store to disk across restarts; sessions and challenges
stay ephemeral either way.

## Organizer-managed testing with MongoDB (Phase 5)

For controlled multi-user testing, organizers manage fictional elections in a
shared MongoDB (Atlas or any replica set) and admit testers via single-use
invitations. The memory store remains for zero-infra demos, but production
boots refuse to start without a reachable MongoDB — never a silent fallback.

Organizer flow (`/organizer` in the UI, `/api/organizer/*` on the API):

1. The deployer sets a one-time `ORGANIZER_SETUP_TOKEN`; the founding organizer
   account is created through `/api/organizer/setup`, which the token then
   unlocks exactly once (atomic consume, constant-time compare).
2. Organizers sign in with a password (scrypt hash, dummy-hash path for unknown
   users — no username oracle) into a hardened `cp_org` session cookie.
3. Organizers create draft elections (title, ballot choices, invitation or
   demo-roll eligibility, and a required voting mode: `standard` or
   `anonymous`), edit drafts, issue expiring single-use invitations, then run
   the lifecycle draft → enrolment → frozen → voting → closed. Drafts are
   organizer-only; the voting mode locks once an election leaves draft, and
   every transition is an atomic conditional write (legacy `open` elections
   from seeds keep working with both ballot paths).
4. Plaintext invitation codes are returned **once at creation**; only SHA-256
   hashes are stored. Unknown, revoked, expired, and mismatched codes all yield
   one uniform 403 (or `{ valid: false }` on the pre-check), under a strict
   per-IP rate limit — no validity oracle.

Voter flow (`/invite` + `/vote`): paste the code, register a personal WebAuthn
passkey, authenticate, then vote — anonymously via the Phase 4 Semaphore flow
(enrol during enrolment, vote once voting opens) or with a standard session
ballot. The server enforces the election's mode: anonymous elections reject
standard ballots, standard elections reject enrolment and proofs, so no voter
can vote twice by switching paths. One enrolment per voter per election, one
credential per voter record, duplicate nullifiers rejected atomically.

Safety properties (all covered by real-MongoDB integration tests, not mocks):

- Required unique indexes are created **and verified at boot**; the API exits
  rather than running without them.
- Invitation redeem + passkey save runs in one replica-set transaction; the
  concurrent-redeem race resolves to exactly one winner.
- Enrolment versioning, freeze gating, and nullifier recording are atomic
  conditional writes; concurrent duplicates collapse to a single accepted ballot.
- Voting mode is server-enforced per election (never UI-only): cross-mode
  submissions are rejected with 409 before any proof work, and the mode cannot
  change after draft.
- The freeze persists the approved group root; frozen elections verify proofs
  only against that root, and late enrolment is rejected by phase.
- Role separation is enforced both ways: voter sessions are rejected on
  organizer routes, and organizer sessions are rejected on voter routes.
- Public APIs (group snapshots, audit, invitation lists) expose no tokens,
  secrets, or voter-to-ballot links.

Deployment notes: Atlas clusters provide the replica set transactions need;
allowlist the API host's IP (a `MongooseServerSelectionError` at boot almost
always means the IP allowlist). Production also needs `WEBAUTHN_ORIGIN` +
`WEBAUTHN_RP_ID` for the real HTTPS host, `COOKIE_SECURE=true`, and a tight
`CORS_ORIGINS`. The in-memory rate limiter is single-process — a shared store
(e.g. Redis) is needed behind multiple API replicas.

Known limits carried forward: small anonymity sets, enrolment-timing
linkability, no tally privacy or verified tally, nothing on-chain. Cross-mode
double voting is now impossible on mode-configured elections (legacy seed
elections without a mode still allow both paths for demo purposes). One human
redeeming two invitations with two different passkeys still yields two voter
records — unpreventable without real identity proofing, which is out of scope
for fictional test data; what IS enforced is one passkey per voter record and
one credential per voter record per election.

## Tests

```powershell
npm test   # backend: organizer/Mongo + Semaphore + WebAuthn + voting + API validation + AI suite (node:test + supertest)
```

Ceremony completion is tested with injected fakes (no authenticator exists in
CI); one test uses the real SimpleWebAuthn option generator, and the running
server's options output is smoke-tested over HTTP. Zero-knowledge tests use
**real proving and verification** (deterministic identities, one shared proof
corpus per run; proving keys download once and cache in the OS temp dir). The
organizer suite (`tests/organizer-mongo.test.js`) runs against **real MongoDB**
(an in-memory replica set with WiredTiger, so transactions behave like Atlas)
and covers bootstrap/login, role escalation, election lifecycle, voting-mode
enforcement, phase gates, invitation uniformity/revocation/races, concurrent
enrolment, freeze with persisted roots, real-proof validation, concurrent
duplicate nullifiers, restart persistence, and cross-election isolation. First
run downloads the MongoDB test binary. To run the same suite against Atlas:
`MONGODB_TEST_URI='<scratch-db-uri>' node --test --test-force-exit tests/organizer-mongo.test.js`
from `apps/api` (scratch database only — it is wiped and dropped). A lighter
connectivity + index check is `node scripts/atlas-verify.mjs`, which never
prints the URI.

## Honest scope labels

- `Enforced` — genuinely checked by the server (WebAuthn verification,
  roll-gated enrolment, one-credential-one-vote, validation, sessions/CSRF).
- `ZK verified` — a real Semaphore membership proof verified server-side.
  Covers *membership and one-use*, not ballot secrecy or tallying.
- `Live model` — real Muse Spark inference (only with an API key configured).
- `Rules only` — deterministic analysis without the model.
- `Simulated` — placeholder logic: ballot content secrecy (candidate hashes
  are brute-forceable), election tallying (none built), blockchain anchoring
  (audit log is server-published, nothing on-chain), eligibility roll
  (fictional).
- `Fictional data` — invented people and elections; nothing real.

This prototype makes no production election-security claims.
