// Minimal in-memory sliding-window rate limiter for abuse-sensitive routes
// (organizer auth, invitation attempts, anonymous submissions). Keyed by
// client IP + route bucket. Single-process by design: state does not span
// processes or restarts — a documented prototype limitation, not a security
// boundary. Real deployments need a shared store (e.g. Redis).

const buckets = new Map(); // key -> array of epoch-ms timestamps

function prune(now, windowMs, stamps) {
  const cutoff = now - windowMs;
  let i = 0;
  while (i < stamps.length && stamps[i] <= cutoff) i += 1;
  if (i > 0) stamps.splice(0, i);
  return stamps;
}

export function checkRateLimit(key, { windowMs, max }) {
  const now = Date.now();
  const stamps = prune(now, windowMs, buckets.get(key) ?? []);
  buckets.set(key, stamps);
  if (stamps.length >= max) {
    const retryAfterMs = windowMs - (now - stamps[0]);
    return { allowed: false, retryAfterSec: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
  }
  stamps.push(now);
  return { allowed: true, retryAfterSec: 0 };
}

/** Express middleware factory. Counts every request, including rejected ones. */
export function rateLimit({ windowMs, max, bucket }) {
  return (req, res, next) => {
    const ip = req.ip ?? req.socket?.remoteAddress ?? 'unknown';
    const result = checkRateLimit(`${bucket}:${ip}`, { windowMs, max });
    res.setHeader('X-RateLimit-Limit', String(max));
    if (!result.allowed) {
      res.setHeader('Retry-After', String(result.retryAfterSec));
      return res.status(429).json({ error: 'Too many attempts. Try again later.' });
    }
    next();
  };
}

/** Test-only reset so suites can isolate rate-limit windows. */
export function resetRateLimits() {
  buckets.clear();
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
