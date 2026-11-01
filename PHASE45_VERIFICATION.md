# Phase 4.5 Verification Report

Scope: finalize and verify cross-mode double-vote prevention, the election
lifecycle, MongoDB behaviour, and browser readiness. No blockchain work, no
unrelated redesigns. All elections and voters remain fictional; this is a
research prototype, not election infrastructure.

## 1. Status summary

| Priority | Item | Status |
|---|---|---|
| P1 | Backend suite + build | Code complete; **execution blocked in this sandbox** (see §2) |
| P2 | Server-enforced voting mode | Implemented + tested |
| P3 | Draft → Enrolment → Frozen → Voting → Closed | Implemented + tested |
| P4 | Atlas verification | Script delivered; live check **requires user run** (allowlist) |
| P5 | Browser E2E | UI updated; manual script below (**requires user run**) |
| P6 | Security review + docs | Done (this file, README, ARCHITECTURE) |

"Tested" above means integration tests were written against the new contracts.
Only the user-terminal runs in §2 and §5 can confirm them green.

## 2. Actual test results (Priority 1)

### 2.1 What was observed here

- `npm test` from the repo root: **cannot execute in this sandbox**. Every
  backend test needs a socket bind (supertest's ephemeral server,
  mongodb-memory-server's port probe) and the sandbox denies all binds:
  `Error: listen EACCES: permission denied 127.0.0.1`. Observed repeatedly,
  including after the Phase 4.5 edits. This is an environment limitation, not
  a code result — and it affects the pre-existing suites identically.
- `node --check`: passes on every edited backend file and the atlas script.
- `npm run build -w apps/web`: **passes** (observed 26.5s; only the
  pre-existing >500 kB chunk warning from the Semaphore/Recharts bundles).

### 2.2 Last user-terminal run (before Phase 4.5)

83 tests: **67 pass / 16 fail**, all 16 in `organizer-mongo.test.js`, all 64
pre-existing green. Diagnosed honestly (no assertion-weakening): 1 real app
bug (empty invitation label rejected — fixed in `routes/organizer.js`) and 3
test-helper mistakes (short usernames, 1-candidate PATCH, malformed fake
tokens — fixed in the test file). The rerun was still pending when Phase 4.5
work started.

### 2.3 Current suite (needs a user rerun)

90 tests total: 64 pre-existing (untouched assertions) + 26 in
`organizer-mongo.test.js` (19 existing + 7 new: mode-required/locked,
cross-mode bypass ×3, legacy grandfathering, one-credential-per-record,
standard flow, full lifecycle chain, illegal transitions, standard freeze +
strict frozen root). The `createElection` helper now sets
`votingMode: 'anonymous'` (new required field); the lifecycle test additionally
covers mode-required-at-creation and draft-only mode changes.

Run from the repo root and paste the tail:

```powershell
npm test
```

Expected: 90/90. If anything fails, paste the failing assertion output — the
contracts changed deliberately (required mode, new phases), so report first,
fix second.

## 3. What was implemented (Priorities 2–3)

### Voting mode (P2)

- `votingMode: 'standard' | 'anonymous'` is **required** when creating an
  election (`POST /api/organizer/elections`), editable while drafting, and
  locked afterwards (the draft-only `updateElection` gate covers it; verified
  by test).
- Enforcement is in the stores AND the routes, never in UI visibility:
  - Standard ballots (`castBallot`, both stores): reject `anonymous` mode
    with 409 `This election accepts anonymous ballots only.` (audited).
  - Enrolment (`enrollCommitment`, both stores): rejects `standard` mode
    with 409 `This election accepts standard ballots only.`
  - Anonymous submission (route, before scope/root/SNARK work): rejects
    `standard` mode with 409 + audited rejection.
- One credential, one voter record: credential ids are globally unique, so the
  same passkey redeeming a second invitation for an election fails 409 at
  `savePasskey` (new test pins this). One passkey per (voter, election) and
  one enrolment per (voter, election) were already unique-index enforced.
- Legacy seed elections have no mode and allow both paths (grandfathered so
  existing demos and the 64 pre-existing tests keep working; pinned by the
  legacy test, documented in README/ARCHITECTURE).

### Lifecycle (P3)

- New chain `draft → enrolment → frozen → voting → closed` via
  `POST …/start-enrolment`, `…/freeze`, `…/start-voting`, `…/close`, all atomic
  conditional writes. Legacy `draft → open → closed` is preserved for seeds
  and older tests. Closing is allowed from any live phase as an organizer
  abort; drafts are deleted, never closed. `enrolment → frozen` is possible
  only through `freezeGroup`, which validates and persists the root.
- Phase gates (both stores + routes):
  - Passkey registration: any live phase (`open/enrolment/frozen/voting`).
  - Semaphore enrolment: `open` or `enrolment` only, plus mode + freeze gates.
  - Ballots (both paths): `open` or `voting` only, plus mode gates.
- Freeze persists `frozenRoot`/`frozenVersion`/`frozenAt`; frozen elections
  verify proofs **only against the persisted root** (a server-made older
  snapshot is rejected — pinned by test). Anonymous elections cannot freeze an
  empty group; standard elections freeze as a phase marker with no group.
- UI (`/organizer`, `/organizer/elections/:id`): mode selector (locked after
  draft), per-phase action buttons, mode column. Voter pages list live phases;
  the vote page suggests the configured ballot path but the server decides.

## 4. MongoDB verification (Priority 4)

### Observed here

- `MONGODB_URI` **is set** in `apps/api/.env` (presence confirmed without
  printing it).
- `node scripts/atlas-verify.mjs` (new, committed): FAILS from here with
  `MongooseServerSelectionError: Could not connect to any servers … IP that
  isn't whitelisted` — the Atlas-side allowlist (and/or sandbox egress) blocks
  this machine, exactly as in the previous phase. The script itself behaves
  correctly: clean error, exit 1, no secrets printed.

### User runs required

From `apps/api` on an allowlisted network:

```powershell
node scripts/atlas-verify.mjs
```

Expected: `ATLAS_VERIFY: PASS` (connect, ping, server/replica-set info,
required unique indexes created + verified, scratch write/read/delete).

Full concurrency suite against Atlas (same 26 integration tests — invitation
redemption races, concurrent enrolment, concurrent duplicate nullifiers,
restart recovery — against real Atlas instead of the in-memory replset):

```powershell
$env:MONGODB_TEST_URI='<Atlas URI with a SCRATCH database name>'
node --test --test-force-exit tests/organizer-mongo.test.js
```

The URI **must** point at a scratch database: every collection is wiped per
test and the database is dropped at the end. Atlas free/shared tiers are
replica sets, so transactions work.

### Fail-closed behaviour (unchanged, re-verified by reading)

- `MONGODB_URI` set but unreachable → API exits 1, never in-memory fallback.
- `NODE_ENV=production` without `MONGODB_URI` → exits 1.
- Required unique indexes created AND verified at boot; missing index → exit 1.

## 5. Browser end-to-end script (Priority 5 — user run)

Prerequisites: `npm run dev:api` (terminal 1, MongoDB or memory), `npm run
dev:web` (terminal 2), two browser profiles (organizer + voter), WebAuthn
capable browser on localhost.

1. **Organizer setup/login.** Profile A → `/organizer/login` → First-time
   setup with `ORGANIZER_SETUP_TOKEN` → sign in → dashboard.
2. **Create anonymous election.** New election → title, 2+ choices,
   Invitation + Anonymous mode → Create draft → Manage → copy the election id.
3. **Invitations.** Manage → Issue 2 codes (72h) → **copy both now** (shown
   once) → confirm the list shows hashes/voters only.
4. **Start enrolment.** Start enrolment → status `enrolment`.
5. **Voter passkeys.** Profile B → `/invite` → paste code 1 → Check →
   Register passkey (platform authenticator or security key) → Authenticate →
   Continue to voting (lands on `/vote` with election + voter prefilled).
   Repeat in a third profile/incognito with code 2.
6. **Enrol.** Each voter: Continue to authentication → Ballot → Anonymous
   tab → create identity → Enrol commitment (succeeds in `enrolment`).
7. **Freeze.** Profile A → Manage → Freeze group → status `frozen`,
   frozen root shown. Negative: a third invited voter can still register a
   passkey but Enrol is rejected 409.
8. **Open voting.** Open voting → status `voting`. Each voter: Prove &
   submit → receipt with nullifier. Negative: re-submitting the same proof is
   rejected as a duplicate (409); check `/audit?election=<id>` for
   `ballot.cast` + `ballot.rejected` with hashed refs only.
9. **Close.** Close election → status `closed`. Negative: further ballots,
   enrolments, and registrations are rejected; mode cannot be edited.
10. **Integrity.** `/integrity` still loads; with `MUSE_SPARK_API_KEY` set it
    shows live-model analysis of the new events, otherwise rules-only.

## 6. Security review (Priority 6)

- Anonymous submission sends **no cookies**: `apiPostAnon`/`apiGetAnon` omit
  credentials, group fetch is anonymous, and the route never reads sessions.
  Enrolment stays authenticated by design (it proves eligibility).
- Public audit carries hashes (credential ids, nullifiers) or public values
  (commitments, roots) — no voter refs, tokens, or secrets. The same
  credential hash links its own registration/authentication events by design
  (needed for failure analysis); it is not reversible to a voter.
- Setup token is env-only, constant-time compared, atomically single-use.
- Organizer passwords: scrypt with dummy-hash path (no username oracle).
- Rate limits: strict buckets for setup/login/invitations; the limiter is
  single-process (documented — needs Redis for multi-replica deployments).
- Muse Spark integration untouched; integrity analysis remains read-only.
- No full-ballot-secrecy or verified-tally claims anywhere; fictional-data
  labels present on all new pages; README/ARCHITECTURE updated.

## 7. Outstanding risks

1. **No green test run observed yet** for the 90-test suite (sandbox blocks
   binds; user rerun pending). One deliberate contract change (required
   `votingMode`) touched the shared test helper — low risk, but unverified.
2. **Atlas unverified live** (IP allowlist from here). The Atlas test path
   (`atlas-verify.mjs`, `MONGODB_TEST_URI` suite) is delivered but not yet run.
3. **Browser E2E not run** (no browser here). The API-level E2E is covered by
   integration tests; the manual script above is the remaining proof.
4. Accepted design residuals: legacy seeds allow both ballot paths; one human
   with two codes + two passkeys gets two voter records (no identity proofing
   by design); enrol-vs-freeze same-instant race can only cause a clearly
   audited rejection, never a double vote.

## 8. Deployment readiness

Ready to deploy as a research prototype **after** the three user runs above
pass (suite 90/90, `ATLAS_VERIFY: PASS`, browser script complete). Production
checklist: Atlas URI + IP allowlist, `ORGANIZER_SETUP_TOKEN` set once then
used, `WEBAUTHN_ORIGIN`/`WEBAUTHN_RP_ID` on the HTTPS host,
`COOKIE_SECURE=true`, tight `CORS_ORIGINS`, `NODE_ENV=production`, single API
replica (or Redis-backed rate limiting). Not approved for real elections.
