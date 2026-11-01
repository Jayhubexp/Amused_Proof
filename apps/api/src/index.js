import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Direct import is load-bearing: Vercel's Express entrypoint detection selects
// files that import the express package, and this file must be the ONLY such
// file so deployments prefer loading the real entry (see lib/http.js).
// eslint-disable-next-line no-unused-vars
import express from 'express';
import { config, validateConfig } from './config.js';
import { createApp } from './app.js';
import { MemoryStore } from './store/memory.js';
import { MongoStore } from './store/mongo.js';
import { ensureMongoIndexes } from './models/index.js';
import { seedDemoOrganizers } from './seed/demo-organizers.js';
import { configureRateLimitStore } from './lib/rate-limit.js';
import { MongoRateLimitStore } from './lib/rate-limit-mongo.js';

// Dual purpose: `node src/index.js` runs the standalone server (local dev),
// while Vercel imports this module (framework "express") and serves the
// default-exported request handler below.
//
// Importing this module NEVER boots anything: boot runs lazily inside a
// cached promise on the first request (or direct execution). That keeps the
// default export synchronously valid (a plain function — never an app that
// might not exist yet, never a Promise) and makes boot failures retryable:
// the cache resets, so the next invocation boots from scratch instead of
// reusing poisoned state.
//
// Boot is identical in both modes: fail-closed validation, Mongo connect +
// index verification, seeding. Nothing here falls back silently.
const isMainModule = process.argv[1] != null
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

let bootedApp = null;

function bootOnce() {
  if (!bootedApp) {
    bootedApp = (async () => {
      validateConfig();
      let store;
      if (config.mongoUri) {
        try {
          await MongoStore.connect(config.mongoUri);
        } catch (err) {
          throw new Error(
            `cannot reach MongoDB (${err.message}). ` +
              'Refusing to fall back to in-memory voting storage.',
          );
        }
        await ensureMongoIndexes();
        store = new MongoStore();
        await store.ensureSeeded();
        // Serverless-safe rate limiting: buckets live in MongoDB, shared by
        // every function instance. (Memory store keeps the in-process limiter.)
        configureRateLimitStore(new MongoRateLimitStore());
        if (config.demoOrganizers) {
          await seedDemoOrganizers(store);
          console.log('CivicProof API: demo organizer logins enabled (README credentials). Local testing only.');
        }
        console.log('CivicProof API: connected to MongoDB (required indexes verified).');
      } else if (config.isProduction) {
        throw new Error('NODE_ENV=production requires MONGODB_URI. Refusing to boot on ephemeral storage.');
      } else if (config.storeFile) {
        store = new MemoryStore({ persistPath: config.storeFile });
        if (config.demoOrganizers) {
          await seedDemoOrganizers(store);
          console.log('CivicProof API: demo organizer logins enabled (README credentials). Local testing only.');
        }
        console.log(`CivicProof API: memory store with disk snapshots at ${config.storeFile}.`);
      } else {
        store = new MemoryStore();
        if (config.demoOrganizers) {
          await seedDemoOrganizers(store);
          console.log('CivicProof API: demo organizer logins enabled (README credentials). Local testing only.');
        }
        console.log(
          'CivicProof API: MONGODB_URI not set — using seeded in-memory store. ' +
            'NOT SUITABLE for multi-user testing (single process, no shared state).',
        );
      }
      const app = createApp(store);
      // The served value MUST be a real Express application (function with the
      // handler interface) — never the factory, a config object, or a Promise.
      if (typeof app !== 'function' || typeof app.handle !== 'function' || typeof app.set !== 'function') {
        throw new Error('Express app failed to initialize: not a valid application.');
      }
      return app;
    })();
  }
  return bootedApp;
}

// Vercel-compatible default export: an actual HTTP request handler. Awaits the
// cached boot, then delegates. No request is ever served without successful
// initialization: boot failures fail closed (generic 500, details logged
// server-side only) and reset the cache so the next invocation retries.
export default async function vercelHandler(req, res) {
  try {
    const app = await bootOnce();
    return app(req, res);
  } catch (err) {
    bootedApp = null;
    console.error(`CivicProof API: boot failed (${err.message}).`);
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'API unavailable.' }));
    return undefined;
  }
}

if (isMainModule) {
  bootOnce().then(
    (app) => {
      app.listen(config.port, () => {
        console.log(`CivicProof API listening on http://localhost:${config.port}`);
      });
    },
    (err) => {
      console.error(`CivicProof API: FATAL — ${err.message}`);
      process.exit(1);
    },
  );
}
