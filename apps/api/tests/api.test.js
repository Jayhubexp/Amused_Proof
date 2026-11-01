import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { MemoryStore } from '../src/store/memory.js';
import { validateConfig } from '../src/config.js';
import { demoOrganizers } from '../src/seed/fictional.js';
import { seedDemoOrganizers } from '../src/seed/demo-organizers.js';

let app;

beforeEach(() => {
  // Pin AI to disabled: route behaviour here must not depend on a local .env key.
  app = createApp(new MemoryStore(), { aiClient: null });
});

test('health reports store mode', async () => {
  const res = await request(app).get('/api/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.store, 'memory');
});

test('elections list and detail', async () => {
  const list = await request(app).get('/api/elections');
  assert.equal(list.status, 200);
  assert.ok(list.body.elections.length >= 3);

  const detail = await request(app).get('/api/elections/metro-transit-2026');
  assert.equal(detail.status, 200);
  assert.equal(detail.body.election.id, 'metro-transit-2026');
  assert.ok(detail.body.election.candidates.length >= 2);

  const missing = await request(app).get('/api/elections/does-not-exist');
  assert.equal(missing.status, 404);
});

test('legacy simulated auth endpoints are removed', async () => {
  // Phase 3 replaced the simulated ceremony with real WebAuthn; the old
  // bypass routes must not exist (see tests/webauthn.test.js for the flows).
  assert.equal((await request(app).post('/api/voters/register').send({})).status, 404);
  assert.equal((await request(app).post('/api/auth/passkey/challenge').send({})).status, 404);
  assert.equal((await request(app).post('/api/auth/passkey/verify').send({})).status, 404);
});

test('unknown routes return JSON 404', async () => {
  const res = await request(app).get('/api/nope');
  assert.equal(res.status, 404);
});

test('AI integrity endpoint is read-only stub', async () => {
  const res = await request(app).get('/api/ai/integrity?electionId=metro-transit-2026');
  assert.equal(res.status, 200);
  assert.equal(res.body.readOnly, true);
  assert.equal(res.body.live, false);
});

test('demo organizers are forbidden in production config', async () => {
  assert.throws(
    () => validateConfig({ demoOrganizers: true, isProduction: true }),
    /forbidden in production/,
  );
  validateConfig({ demoOrganizers: false, isProduction: true });
  validateConfig({ demoOrganizers: true, isProduction: false });
});

test('demo organizer seed enables README login on a fresh store', async () => {
  assert.equal(demoOrganizers.length, 3);
  const store = new MemoryStore();
  await seedDemoOrganizers(store);
  await seedDemoOrganizers(store); // reseed is idempotent
  const loginApp = createApp(store, { aiClient: null });
  for (const { username, password } of demoOrganizers) {
    const res = await request(loginApp).post('/api/organizer/login').send({ username, password });
    assert.equal(res.status, 200);
    assert.ok(res.body.csrfToken);
  }
});
