import { config, validateConfig } from './config.js';
import { createApp } from './app.js';
import { MemoryStore } from './store/memory.js';
import { MongoStore } from './store/mongo.js';
import { ensureMongoIndexes } from './models/index.js';
import { seedDemoOrganizers } from './seed/demo-organizers.js';

// Fail closed: invalid config (e.g. demo credentials in production) stops the
// boot before anything else. When MongoDB is configured but unreachable, the
// API refuses to boot rather than silently falling back to ephemeral
// in-memory voting storage. Production additionally refuses to boot without
// MongoDB at all.
try {
  validateConfig();
} catch (err) {
  console.error(`CivicProof API: FATAL — ${err.message}`);
  process.exit(1);
}

let store;
if (config.mongoUri) {
  try {
    await MongoStore.connect(config.mongoUri);
  } catch (err) {
    console.error(
      `CivicProof API: FATAL — cannot reach MongoDB (${err.message}). ` +
        'Refusing to fall back to in-memory voting storage.',
    );
    process.exit(1);
  }
  try {
    await ensureMongoIndexes();
  } catch (err) {
    console.error(`CivicProof API: FATAL — ${err.message}`);
    process.exit(1);
  }
  store = new MongoStore();
  await store.ensureSeeded();
  if (config.demoOrganizers) {
    await seedDemoOrganizers(store);
    console.log('CivicProof API: demo organizer logins enabled (README credentials). Local testing only.');
  }
  console.log('CivicProof API: connected to MongoDB (required indexes verified).');
} else if (config.isProduction) {
  console.error(
    'CivicProof API: FATAL — NODE_ENV=production requires MONGODB_URI. ' +
      'Refusing to boot on ephemeral storage.',
  );
  process.exit(1);
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
app.listen(config.port, () => {
  console.log(`CivicProof API listening on http://localhost:${config.port}`);
});
