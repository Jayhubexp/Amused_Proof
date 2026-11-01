import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, validateConfig } from './config.js';
import { createApp } from './app.js';
import { MemoryStore } from './store/memory.js';
import { MongoStore } from './store/mongo.js';
import { ensureMongoIndexes } from './models/index.js';
import { seedDemoOrganizers } from './seed/demo-organizers.js';
import { configureRateLimitStore } from './lib/rate-limit.js';
import { MongoRateLimitStore } from './lib/rate-limit-mongo.js';

// Dual purpose: `node src/index.js` runs the standalone server (local dev),
// while Vercel imports this module (framework "express", entrypoint
// "src/index.js") and serves the default-exported Express app. Boot is
// identical in both: fail-closed validation, Mongo connect + index
// verification, seeding. Nothing here falls back silently.
const isMainModule = process.argv[1] != null
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

function fatal(message) {
  // CLI: log + exit code. Imported (serverless cold start): throw so the
  // instance fails loudly instead of serving half-booted.
  if (isMainModule) {
    console.error(`CivicProof API: FATAL — ${message}`);
    process.exit(1);
  }
  throw new Error(`CivicProof API: FATAL — ${message}`);
}

try {
  validateConfig();
} catch (err) {
  fatal(err.message);
}

let store;
if (config.mongoUri) {
  try {
    await MongoStore.connect(config.mongoUri);
  } catch (err) {
    fatal(
      `cannot reach MongoDB (${err.message}). ` +
        'Refusing to fall back to in-memory voting storage.',
    );
  }
  try {
    await ensureMongoIndexes();
  } catch (err) {
    fatal(err.message);
  }
  store = new MongoStore();
  await store.ensureSeeded();
  // Serverless-safe rate limiting: buckets live in MongoDB, shared by every
  // function instance. (Memory store keeps the in-process limiter.)
  configureRateLimitStore(new MongoRateLimitStore());
  if (config.demoOrganizers) {
    await seedDemoOrganizers(store);
    console.log('CivicProof API: demo organizer logins enabled (README credentials). Local testing only.');
  }
  console.log('CivicProof API: connected to MongoDB (required indexes verified).');
} else if (config.isProduction) {
  fatal('NODE_ENV=production requires MONGODB_URI. Refusing to boot on ephemeral storage.');
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
export default app;

if (isMainModule) {
  app.listen(config.port, () => {
    console.log(`CivicProof API listening on http://localhost:${config.port}`);
  });
}
