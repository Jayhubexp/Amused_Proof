// One-shot Atlas verification for CivicProof API operators.
// Reads MONGODB_URI from the environment only and NEVER prints it (or any
// secret). Usage from apps/api:  node scripts/atlas-verify.mjs
// Exit 0 = connected, indexes verified, scratch write/read/delete OK.
import 'dotenv/config';
import mongoose from 'mongoose';
import { ensureMongoIndexes } from '../src/models/index.js';

const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error('ATLAS_VERIFY: MONGODB_URI is not set.');
  process.exit(2);
}

try {
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
  console.log('ATLAS_VERIFY: connected.');
  const ping = await mongoose.connection.db.admin().ping();
  console.log(`ATLAS_VERIFY: ping ok (${JSON.stringify(ping)}).`);
  const info = await mongoose.connection.db.admin().serverInfo();
  console.log(`ATLAS_VERIFY: server v${info.version}; replica set: ${info.setName ?? '(none reported)'}.`);
  await ensureMongoIndexes();
  console.log('ATLAS_VERIFY: required unique indexes created and verified.');
  const scratch = mongoose.connection.db.collection('_civicproof_verify');
  const marker = `verify-${Date.now()}`;
  await scratch.insertOne({ _id: marker, at: new Date().toISOString() });
  const found = await scratch.findOne({ _id: marker });
  if (!found) throw new Error('scratch write/read mismatch');
  await scratch.deleteOne({ _id: marker });
  console.log('ATLAS_VERIFY: scratch write/read/delete ok.');
  await mongoose.disconnect();
  console.log('ATLAS_VERIFY: PASS');
} catch (err) {
  console.error(`ATLAS_VERIFY: FAIL — ${err.name}: ${err.message}`);
  try {
    await mongoose.disconnect();
  } catch {
    // ignore cleanup errors on the failure path
  }
  process.exit(1);
}
