import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';

// Organizer password hashing with scrypt (Node built-in, established KDF).
// Format: scrypt$N$r$p$saltHex$keyHex. Verification always runs the KDF — even
// for unknown usernames (against a dummy hash) — so timing reveals nothing
// about account existence.

const N = 16384;
const R = 8;
const P = 1;
const KEY_LEN = 64;
const SALT_LEN = 32;

function scryptPassword(password, salt) {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, KEY_LEN, { N, r: R, p: P }, (err, key) =>
      (err ? reject(err) : resolve(key)),
    );
  });
}

export async function hashPassword(password) {
  const salt = randomBytes(SALT_LEN);
  const key = await scryptPassword(password, salt);
  return `scrypt$${N}$${R}$${P}$${salt.toString('hex')}$${key.toString('hex')}`;
}

function parseHash(stored) {
  const parts = String(stored ?? '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const [, n, r, p, saltHex, keyHex] = parts;
  if (Number(n) !== N || Number(r) !== R || Number(p) !== P) return null;
  try {
    return { salt: Buffer.from(saltHex, 'hex'), key: Buffer.from(keyHex, 'hex') };
  } catch {
    return null;
  }
}

// Dummy hash for unknown users: keeps verification timing uniform and never
// matches a real password (fixed salt, random key generated once per boot).
const DUMMY_SALT = randomBytes(SALT_LEN);
const DUMMY_KEY = randomBytes(KEY_LEN);

export async function verifyPassword(password, storedHash) {
  const parsed = parseHash(storedHash);
  const salt = parsed?.salt ?? DUMMY_SALT;
  const expected = parsed?.key ?? DUMMY_KEY;
  const actual = await scryptPassword(String(password ?? ''), salt);
  return (
    parsed !== null &&
    actual.length === expected.length &&
    timingSafeEqual(actual, expected)
  );
}
