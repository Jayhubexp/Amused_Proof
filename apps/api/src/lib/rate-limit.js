// Sliding-window rate limiter with a pluggable backing store. Default is
// in-memory (tests, local dev). Production with MongoDB configures the Mongo
// store at boot (see index.js), so buckets are shared across every serverless
// function instance instead of resetting per instance.
// Abuse friction, not a security boundary: see docs/ARCHITECTURE.md.

function prune(now, windowMs, stamps) {
  const cutoff = now - windowMs;
  let i = 0;
  while (i < stamps.length && stamps[i] <= cutoff) i += 1;
  if (i > 0) stamps.splice(0, i);
  return stamps;
}

function decide(stamps, now, windowMs, max) {
  if (stamps.length >= max) {
    const retryAfterMs = windowMs - (now - stamps[0]);
    return { allowed: false, retryAfterSec: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
  }
  return { allowed: true, retryAfterSec: 0 };
}

export class MemoryRateLimitStore {
  constructor() {
    this.buckets = new Map(); // key -> array of epoch-ms timestamps
  }

  check(key, { windowMs, max }) {
    const now = Date.now();
    const stamps = prune(now, windowMs, this.buckets.get(key) ?? []);
    this.buckets.set(key, stamps);
    const verdict = decide(stamps, now, windowMs, max);
    if (verdict.allowed) stamps.push(now);
    return verdict;
  }

  reset() {
    this.buckets.clear();
  }
}

export const memoryRateLimitStore = new MemoryRateLimitStore();
let activeStore = memoryRateLimitStore;

/** Swap the backing store (production boot installs the Mongo store). */
export function configureRateLimitStore(store) {
  activeStore = store;
}

/** Check (and record, when allowed) one attempt. May return a Promise. */
export function checkRateLimit(key, opts) {
  return activeStore.check(key, opts);
}

/** Express middleware factory. Counts every request, including rejected ones. */
export function rateLimit({ windowMs, max, bucket }) {
  return async (req, res, next) => {
    const ip = req.ip ?? req.socket?.remoteAddress ?? 'unknown';
    let result;
    try {
      result = await checkRateLimit(`${bucket}:${ip}`, { windowMs, max });
    } catch (err) {
      // Limiter outage (e.g. MongoDB blip) fails OPEN: rate limiting is abuse
      // friction, and erroring every request would turn an outage into a
      // full denial of service. The failure is logged, not silent.
      console.error(`CivicProof: rate limiter unavailable, allowing request (${err.message}).`);
      next();
      return;
    }
    res.setHeader('X-RateLimit-Limit', String(max));
    if (!result.allowed) {
      res.setHeader('Retry-After', String(result.retryAfterSec));
      return res.status(429).json({ error: 'Too many attempts. Try again later.' });
    }
    next();
  };
}

/** Test-only reset of the in-memory buckets. */
export function resetRateLimits() {
  memoryRateLimitStore.reset();
}

// Named buckets. Strict buckets guard secrets (passwords, invitation tokens);
// generous buckets exist only as backstops and stay far above test volumes.
export const RATE_LIMITS = {
  organizerSetup: { windowMs: 60 * 60 * 1000, max: 5, bucket: 'organizer-setup' },
  organizerAuth: { windowMs: 15 * 60 * 1000, max: 10, bucket: 'organizer-auth' },
  invitation: { windowMs: 15 * 60 * 1000, max: 30, bucket: 'invitation' },
  registration: { windowMs: 15 * 60 * 1000, max: 500, bucket: 'registration' },
  anonymous: { windowMs: 60 * 1000, max: 500, bucket: 'anonymous' },
};
