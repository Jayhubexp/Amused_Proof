// Single gateway to the Express package. It loads Express via dynamic import
// on purpose — never a static import declaration: Vercel's Express
// entrypoint detection selects files that statically import the framework
// package, and src/index.js must be the ONLY such file so deployments prefer
// the real entry. (Defense in depth only: src/app.js now ALSO carries a valid
// delegating default export, so either module serves correctly if loaded.)
// Behavior is identical: same package, same references, loaded once.
const { default: express } = await import('express');

export function createExpressApp(...args) {
  return express(...args);
}

export function jsonBodyParser(...args) {
  return express.json(...args);
}

export const Router = express.Router;
