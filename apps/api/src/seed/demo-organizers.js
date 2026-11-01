import { demoOrganizers } from './fictional.js';
import { hashPassword } from '../lib/password.js';

/**
 * Creates the public README demo organizer accounts (scrypt-hashed), skipping
 * any username that already exists so reseeding is idempotent. Callers must
 * gate this on the DEMO_ORGANIZERS flag — these passwords are public.
 */
export async function seedDemoOrganizers(store) {
  for (const { username, password } of demoOrganizers) {
    if (await store.getOrganizer(username)) continue;
    await store.createOrganizer({
      username,
      passwordHash: await hashPassword(password),
      createdBy: 'demo-seed',
    });
  }
}
