import { dirname } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

// Crash-tolerant JSON snapshots for the memory store's DURABLE domain state
// (passkeys, ballots, audit log, Semaphore groups/enrollments). Ephemeral
// state — WebAuthn challenges and login sessions — is deliberately NOT
// persisted: an API restart invalidates ceremonies and logs everyone out.
// MongoDB remains the preferred durable backend; this exists so the
// zero-infrastructure store can also survive restarts (STORE_FILE env).

export const STORE_SNAPSHOT_VERSION = 1;

export function saveStoreFile(path, snapshot) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(snapshot));
}

export function loadStoreFile(path) {
  try {
    if (!path || !existsSync(path)) return null;
    const data = JSON.parse(readFileSync(path, 'utf8'));
    if (!data || data.version !== STORE_SNAPSHOT_VERSION) return null;
    if (!Array.isArray(data.passkeys) || !Array.isArray(data.ballots) || !Array.isArray(data.audit)) {
      return null;
    }
    return data;
  } catch {
    return null;
  }
}
