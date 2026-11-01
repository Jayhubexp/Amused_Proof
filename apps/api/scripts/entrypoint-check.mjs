// Verifies the Vercel deployment contract WITHOUT ports: BOTH modules Vercel
// might load as the function entry (src/index.js and src/app.js — the latter
// was actually selected in production) must default-export a working HTTP
// request handler (a function — never the factory, a config object, or a
// Promise) that serves requests through the identically initialized app.
//
// Self-scrubbed boot: force the memory store regardless of any .env file or
// parent environment, so this check never touches Atlas. Must run before
// importing the entries (config is static at import, and dotenv never
// overrides already-set vars — including empty strings, which is what makes
// this robust where spawn-passed empty vars are lossy on Windows).
process.env.MONGODB_URI = '';
process.env.DEMO_ORGANIZERS = '';
process.env.NODE_ENV = 'test';

import { call } from './mock-http.mjs';

const failures = [];

async function checkEntry(name, specifier) {
  const mod = await import(specifier);
  if (typeof mod.default !== 'function') {
    failures.push(`${name}: default export is ${typeof mod.default}, expected function (HTTP handler)`);
    return;
  }
  // createApp (the factory) takes (store, opts); a real handler serves here.
  const res = await call(mod.default, { method: 'GET', url: '/api/health' });
  const body = res.parsedBody();
  if (res.statusCode !== 200 || body?.ok !== true) {
    failures.push(`${name}: GET /api/health -> ${res.statusCode} ${res.bodyText().slice(0, 200)}`);
  }
}

// The preferred entry boots eagerly-shared state first; the app.js entry then
// proves delegation reaches the same initialized application.
await checkEntry('src/index.js', '../src/index.js');
await checkEntry('src/app.js', '../src/app.js');

if (failures.length > 0) {
  console.error(`ENTRYPOINT FAIL:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}

console.log('ENTRYPOINT PASS: both entries default-export serving HTTP handlers; GET /api/health -> 200 JSON.');
