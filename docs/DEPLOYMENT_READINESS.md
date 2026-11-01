# Deployment Readiness Report (Vercel Services)

Date: 2026-11-01. Scope: Vercel Services deployment of the existing monorepo.
No election security guarantees changed; no unrelated features added.

## Verdict: READY TO DEPLOY, with first-deploy verifications below

No blocking incompatibility was found between Vercel Functions and the
backend. Every serverless gap found during the audit is fixed in-repo. Three
items can only be confirmed from a real deploy + user-terminal test run and
are listed as first-deploy verifications, not blockers.

## What was researched (official Vercel docs)

- Vercel Services is the current multi-application model: per-service
  `root` + framework config in root `vercel.json`, Framework Preset
  **Services** in the dashboard, services addressed as rewrite destinations
  (`{ "service": "<name>" }`). The old `experimentalServices` key must not
  be used. Top-level `buildCommand`/`outputDirectory`/`functions` keys are
  invalid in Services mode — all moved into services.
  ([Services](https://vercel.com/docs/services),
  [config reference](https://vercel.com/docs/services/config-reference),
  [routing](https://vercel.com/docs/services/routing))
- A service receives the **original request path**, so `/api/organizer/login`
  reaches Express intact and the existing `/api` mounts work with zero route
  changes.
- The `express` framework slug accepts a Node entrypoint file that
  default-exports the app; the app becomes a single Function on Fluid
  compute. Standard bundle limit is 250 MB.
  ([Express on Vercel](https://vercel.com/docs/frameworks/backend/express))
- React Router refresh works via a service-level `/(.*) → /index.html`
  rewrite inside `web` (static files take precedence, so `/assets/*` is
  unaffected — the standard SPA recipe).

## Changes made for deployment

- `vercel.json`: rewritten to the Services model (`web` + `api` services,
  top-level rewrites, per-service SPA fallback, per-service `devCommand`).
  `installCommand` deliberately unset (Vercel monorepo-aware default; root
  `package-lock.json` is committed for reproducible installs). Removed the
  earlier single-function `/api/index.js` adapter — superseded.
- `apps/api/src/index.js`: dual-purpose entrypoint. `node src/index.js`
  still runs the standalone server (local `dev`/`start` untouched); Vercel
  imports the module and serves the default-exported Express app after the
  identical fail-closed boot (config validation → Mongo connect → index
  verification → seeding). CLI keeps exit-code failures; imported mode
  throws so the cold instance fails loudly instead of serving half-booted.
- `apps/api/src/lib/rate-limit.js` + new `rate-limit-mongo.js`: pluggable
  backing store; production boot installs the Mongo store (TTL-reaped
  buckets shared across instances). Limiter outages fail open with a log
  line (abuse friction must not convert an outage into a DoS). New
  integration test proves cross-instance enforcement.
- `apps/api/scripts/smoke.mjs` (new): port-free E2E (real Express app +
  MemoryStore, mock req/res): health → setup ×3 → login ×3 → cookie auth →
  rejection paths → election CRUD → lifecycle gates → invitations →
  hashes-only list → validate → public reads → audit → 404. **Observed:
  SMOKE PASS.**
- Docs: `docs/VERCEL.md` (setup + full env table, no secrets),
  `docs/DEPLOYMENT_READINESS.md` (this file); README deploy section updated
  to the Services model.

## Audit results (serverless compatibility)

| State | Verdict |
|---|---|
| Voter/organizer sessions | MongoDB-backed (`SessionModel`), verified in code |
| WebAuthn challenges | MongoDB-backed, atomic single-use consume (`findByIdAndDelete`) |
| Elections/invitations/passkeys/ballots/groups/counters | MongoDB-backed, transactional/atomic as before |
| Rate limits | **Was in-memory (gap) → now Mongo-backed in production** |
| No-fallback guarantee | `MONGODB_URI` missing/unreachable in production → boot fails; verified in `index.js` |
| WebAuthn origin/RP | Env-driven (`WEBAUTHN_ORIGIN`/`WEBAUTHN_RP_ID`); no code default touches prod |
| Cookies/CSRF/same-origin | `Secure`+HttpOnly+`SameSite=Lax`, CSRF on mutations, single-origin serving via Services rewrites |
| Muse Spark key | Server-side only (`apps/api`); frontend has no `VITE_*` secrets (verified by search) |
| Semaphore verify | Embedded verification key + pure `groth16.verify` — **no downloads, no filesystem, no network** on the server path (proven by reading the installed `@semaphore-protocol/proof` + `@zk-kit/artifacts` code; artifact CDN/`tmpdir` use is proving-only, i.e. browsers) |
| Bundle size | Heaviest prod deps ≈ 25 MB total (snarkjs 11.4 MB largest) vs 250 MB limit — ~10× headroom |
| Workspace resolution | npm workspaces + committed root lockfile; services share the root install; no cross-workspace imports in either app |

## Verification actually observed here

- `node apps/api/scripts/smoke.mjs`: **PASS** (exit 0), full organizer→audit flow.
- `node --check`: passes on every touched file; `vercel.json` parses.
- `npm run build -w apps/web`: **passes** (6.75s; pre-existing chunk-size warning only).
- `npm test`: **cannot run in this sandbox** (all binds denied, `EACCES` —
  affects pre-existing suites identically). Suite is now 94 tests (93 + 1 new
  Mongo rate-limit test). Needs a user-terminal run.
- `vercel dev`/preview deploy: cannot run here (needs Vercel CLI + account +
  binds). Needs a user deploy.

## First-deploy verifications (user checklist, not blockers)

1. `npm test` → expect 94/94.
2. Deploy with Framework Preset **Services**; confirm the build log shows one
   root install + both services built (`web`, `api`).
3. `GET /api/health` → 200; organizer setup → login → create election →
   invite → `/invite` redeem → vote → audit (browser script in
   `PHASE45_VERIFICATION.md` §5).
4. Direct-URL refresh on `/organizer`, `/vote`, `/integrity` → no 404s (SPA
   fallback); `/assets/*` loads with correct content types.
5. If any service misbehaves, check: `entrypoint` path base (config assumes
   service-root-relative `src/index.js`) and install behavior in the build
   log — the two config details the public docs leave implicit.

## Residual risks (accepted, documented)

- Rate limiting fails open during a limiter-store outage (deliberate; it is
  abuse friction, not a security boundary).
- Read-then-write limiter admits a negligible over-admission race under
  concurrency (same rationale).
- Atlas requires `0.0.0.0/0` (Vercel egress is dynamic); mitigated by a
  strong unique DB password.
- Cold starts pay Atlas connect + index verification per instance
  (one-time each; warm requests unaffected).
