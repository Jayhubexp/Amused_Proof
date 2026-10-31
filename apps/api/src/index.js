import { config } from './config.js';
import { createApp } from './app.js';
import { MemoryStore } from './store/memory.js';
import { MongoStore } from './store/mongo.js';

let store = new MemoryStore({ persistPath: config.storeFile });
if (config.mongoUri) {
  await MongoStore.connect(config.mongoUri);
  store = new MongoStore();
  await store.ensureSeeded();
  console.log('CivicProof API: connected to MongoDB.');
} else if (config.storeFile) {
  console.log(`CivicProof API: memory store with disk snapshots at ${config.storeFile}.`);
} else {
  console.log('CivicProof API: MONGODB_URI not set — using seeded in-memory store.');
}

const app = createApp(store);
app.listen(config.port, () => {
  console.log(`CivicProof API listening on http://localhost:${config.port}`);
});
