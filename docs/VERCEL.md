# Deploying CivicProof AI on Vercel (Services)

One Vercel project hosts two services from this monorepo (see root
`vercel.json`, which follows the
[Vercel Services](https://vercel.com/docs/services) format):

| Service | Root | Framework | Serves |
|---|---|---|---|
| `web` | `apps/web/` | `vite` | `/` — the React SPA (client routes fall back to `/index.html` inside the service) |
| `api` | `apps/api/` | `express`, entrypoint `src/index.js` | `/api/*` — the Express app (receives the original path, so `/api` mounts work unchanged) |

Top-level routing sends `/api/:path*` to `api` and everything else to `web`.
Same-origin serving is load-bearing: voter and organizer sessions use
`SameSite=Lax` HttpOnly cookies, which browsers will not send to a
cross-origin API. Do not split the services across two projects/domains
without reworking cookies (explicitly out of scope).

## Dashboard setup

1. Push the repo to GitHub and import it in Vercel. Root Directory: repository
   root. Framework Preset: **Services** (Vercel detects both applications).
2. Build/install settings come from `vercel.json` + the workspace
   `package-lock.json` — no dashboard overrides needed. `installCommand` is
   deliberately unset so Vercel uses its monorepo-aware default install.
3. Add the environment variables below (Production scope), then deploy.
4. After deploy: `/organizer/login` → First-time setup with
   `ORGANIZER_SETUP_TOKEN` → create elections → walk the voter flow once on
   the live URL (this shakes out any RP/origin mismatch immediately).

## Environment variables (production)

| Variable | Required | Value / notes |
|---|---|---|
| `NODE_ENV` | Auto | Vercel sets `production`; enables all fail-closed guards |
| `MONGODB_URI` | Yes | Atlas connection string. Boot refuses without it — never a silent memory fallback |
| `ORGANIZER_SETUP_TOKEN` | Yes | Random 32-byte hex; single-use founding-organizer bootstrap |
| `WEBAUTHN_RP_ID` | Yes | Production host only, no scheme/port (e.g. `my-app.vercel.app`) |
| `WEBAUTHN_ORIGIN` | Yes | `https://` + host; must match exactly what browsers visit |
| `WEBAUTHN_RP_NAME` | No | Display name (default `CivicProof AI`) |
| `COOKIE_SECURE` | Yes | `true` (required for HTTPS cookies) |
| `CORS_ORIGINS` | Yes | `https://` + host (same origin) |
| `SESSION_TTL_MS` | No | Voter sessions (default 3600000) |
| `ORGANIZER_SESSION_TTL_MS` | No | Organizer sessions (default 3600000) |
| `MUSE_SPARK_API_KEY` | No | Server-side only, never reaches the frontend; without it integrity runs rules-only |

Never set in production: `DEMO_ORGANIZERS` (boot refuses), `STORE_FILE`
(serverless filesystem is ephemeral), `MONGODB_TEST_URI` (test-only).

## Atlas preparation

- Any cluster tier works (all are replica sets, so transactions function).
- Create a least-privilege database user with a strong password.
- Network Access must allow `0.0.0.0/0` — Vercel function egress IPs are
  dynamic, so there is no fixed IP to whitelist. Compensate with a strong,
  unique database password.

## Operational notes

- Cold starts are slowish (Atlas connect + index verification once per
  instance); later requests reuse the warm instance. Zero-knowledge
  verification needs no downloads — the verification key is embedded in
  `@semaphore-protocol/proof` and `groth16.verify` is pure computation.
  (Proving artifacts download only in browsers, which do the proving.)
- Rate limiting is MongoDB-backed in production, shared across all function
  instances. If the limiter store itself errors, requests fail open (logged)
  rather than turning an outage into a full denial of service.
- `vercel dev` runs both services locally (`devCommand` per service); without
  the Vercel CLI, `npm run dev:api` + `npm run dev:web` from the root is the
  equivalent local flow.
