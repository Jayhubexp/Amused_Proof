// Vercel serverless entry: serves same-origin /api/* by wrapping the Express
// app (sessions use SameSite=Lax cookies, so the API must share the
// frontend's origin). MongoDB connects once per warm instance and is reused;
// indexes are verified and seeds applied on cold start only.
import { config, validateConfig } from '../apps/api/src/config.js';
import { createApp } from '../apps/api/src/app.js';
import { MongoStore } from '../apps/api/src/store/mongo.js';
import { ensureMongoIndexes } from '../apps/api/src/models/index.js';
import { seedDemoOrganizers } from '../apps/api/src/seed/demo-organizers.js';

let ready = null;

function init() {
  if (!ready) {
    ready = (async () => {
      validateConfig();
      if (!config.mongoUri) {
        throw new Error('MONGODB_URI is required in production.');
      }
      await MongoStore.connect(config.mongoUri);
      await ensureMongoIndexes();
      const store = new MongoStore();
      await store.ensureSeeded();
      if (config.demoOrganizers) await seedDemoOrganizers(store);
      return createApp(store);
    })();
  }
  return ready;
}

export default async function handler(req, res) {
  let app;
  try {
    app = await init();
  } catch (err) {
    // Fail closed with a diagnosable 500 (never a silent fallback, never a
    // half-booted app). The cached promise is reset so a later invocation
    // retries after a transient failure (e.g. an Atlas blip).
    ready = null;
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: `API unavailable: ${err.message}` }));
    return;
  }
  return app(req, res);
}
