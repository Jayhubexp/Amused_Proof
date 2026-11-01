// Guards the Vercel deployment contract: src/index.js must default-export a
// real, request-serving Express application. Runs the check in an isolated
// subprocess with scrubbed env (memory store, no Atlas, no ports) so it can
// run anywhere, including alongside the port-bound suites.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const apiDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('Vercel entrypoints default-export serving HTTP handlers', async () => {
  const { stdout } = await execFileAsync(
    process.execPath,
    [path.join(apiDir, 'scripts', 'entrypoint-check.mjs')],
    {
      cwd: apiDir,
      env: { ...process.env, MONGODB_URI: '', DEMO_ORGANIZERS: '', NODE_ENV: 'test' },
      timeout: 90000,
    },
  );
  assert.match(stdout, /ENTRYPOINT PASS/);
});
