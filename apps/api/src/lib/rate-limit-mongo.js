import { RateLimitModel } from '../models/index.js';

// MongoDB-backed sliding-window buckets for production: shared across every
// serverless function instance (the in-memory store would reset per instance).
// Read-then-write admits a negligible over-admission race under concurrency;
// acceptable for abuse friction, which this is (not a security boundary).
export class MongoRateLimitStore {
  async check(key, { windowMs, max }) {
    const now = Date.now();
    const cutoff = now - windowMs;
    const doc = await RateLimitModel.findById(key).lean();
    const stamps = (doc?.stamps ?? []).filter((t) => t > cutoff);
    if (stamps.length >= max) {
      const retryAfterMs = windowMs - (now - stamps[0]);
      return { allowed: false, retryAfterSec: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
    }
    await RateLimitModel.updateOne(
      { _id: key },
      {
        $push: { stamps: { $each: [now], $slice: -2000 } },
        $set: { updatedAt: now },
      },
      { upsert: true },
    );
    return { allowed: true, retryAfterSec: 0 };
  }
}
