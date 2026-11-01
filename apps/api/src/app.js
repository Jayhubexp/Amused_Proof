import cors from 'cors';
import cookieParser from 'cookie-parser';
import { config } from './config.js';
import { createExpressApp, jsonBodyParser } from './lib/http.js';
import { buildRouter } from './routes/index.js';
import { buildOrganizerRouter } from './routes/organizer.js';
import { createMuseClientFromConfig } from './ai/muse.js';

/**
 * Testable Express app factory — pass any store implementing the interface.
 * `aiClient`: undefined = build from env (null when no key); null = force
 * disabled; any object with `complete()` = use directly (tests inject mocks).
 * `webauthn`: undefined = real SimpleWebAuthn library; tests inject fakes.
 */
export function createApp(store, { aiClient, webauthn } = {}) {
  const resolvedAi = aiClient === undefined ? createMuseClientFromConfig(config) : aiClient;
  const routerOptions = { aiClient: resolvedAi };
  if (webauthn !== undefined) routerOptions.webauthn = webauthn;
  const app = createExpressApp();
  app.use(cors({ origin: config.corsOrigins, credentials: true }));
  app.use(cookieParser());
  app.use(jsonBodyParser({ limit: '64kb' }));

  app.use('/api', buildRouter(store, routerOptions));
  app.use('/api/organizer', buildOrganizerRouter(store));
  app.use((req, res) => res.status(404).json({ error: 'Not found.' }));

  // Central error handler: validation/store errors carry .status; never leak stacks.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = Number.isInteger(err.status) ? err.status : 500;
    if (status === 500) console.error(err);
    res.status(status).json({ error: status === 500 ? 'Internal error.' : err.message });
  });

  return app;
}

// Default export: Vercel-compatible HTTP handler. Vercel has loaded THIS
// module as the function entry in production (see docs/DEPLOYMENT_READINESS),
// so it must serve the identical initialized application as src/index.js —
// never fail with "Invalid export". Delegation is via dynamic import (not a
// static import: index.js statically imports createApp from here, so a static
// back-import would be a module cycle). Importing this module never boots
// anything, so the named { createApp } import used by tests is unaffected.
export default async function vercelHandler(req, res) {
  try {
    const { default: handler } = await import('./index.js');
    return handler(req, res);
  } catch (err) {
    console.error(`CivicProof API: entrypoint failure (${err.message}).`);
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'API unavailable.' }));
    return undefined;
  }
}
