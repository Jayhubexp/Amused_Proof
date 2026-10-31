import { createHash, randomBytes } from 'node:crypto';

const HEX_64 = /^[0-9a-f]{64}$/i;

/** SHA-256 hex digest. Used for ballot commitments — not a custom primitive. */
export function sha256Hex(input) {
  return createHash('sha256').update(input).digest('hex');
}

/** 32 random bytes as hex. Used for credential ids, challenges, tokens. */
export function randomHex(bytes = 32) {
  return randomBytes(bytes).toString('hex');
}

/**
 * Nullifier preimage check helper.
 * Phase 1 honesty note: the nullifier is minted server-side at registration and
 * checked for duplicates on submission. That is a server-side one-vote guard,
 * NOT a zero-knowledge proof. Real ZK nullifiers (established libraries only)
 * are Phase 2 work.
 */
export function buildNullifierHash(credentialSecret, electionId) {
  return sha256Hex(`${credentialSecret}:${electionId}`);
}

export function isHex64(value) {
  return typeof value === 'string' && HEX_64.test(value);
}
