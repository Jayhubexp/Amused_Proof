import { Group } from '@semaphore-protocol/group';
import { verifyProof } from '@semaphore-protocol/proof';
import { sha256Hex } from '../lib/crypto.js';

/**
 * Semaphore (v4) integration helpers.
 *
 * ALL zero-knowledge cryptography — proving, verification, Merkle trees,
 * circuits — is performed by the maintained @semaphore-protocol packages.
 * This module only wires them to elections: deterministic scope/message
 * derivation, group assembly from stored commitments, proof shape validation,
 * and a fail-closed verification wrapper.
 */

// BN254 scalar field prime. Semaphore circuit signals must lie in this field,
// so hashes are reduced modulo it on both client and server (identical code,
// see apps/web/src/lib/semaphore.js). Reduction of a hash output modulo the
// field prime is standard practice, not custom cryptography.
export const SNARK_FIELD = BigInt(
  '21888242871839275222246405745257275088548364400416034343698204186575808495617',
);

export const MIN_TREE_DEPTH = 1;
export const MAX_TREE_DEPTH = 32;

/** Election-specific Semaphore scope, as a decimal string. One scope per election. */
export function electionScope(electionId) {
  const digest = sha256Hex(`civicproof-scope:${electionId}`);
  return (BigInt(`0x${digest}`) % SNARK_FIELD).toString();
}

/**
 * Proof message cryptographically bound to a ballot commitment: the SHA-256
 * commitment reduced into the circuit field. The server recomputes this from
 * the submitted commitment and requires an exact match with proof.message,
 * so a proof cannot be transplanted onto a different ballot.
 */
export function commitmentMessage(ballotCommitmentHex) {
  return (BigInt(`0x${ballotCommitmentHex}`) % SNARK_FIELD).toString();
}

/** Rebuild a Semaphore group from stored member commitments (decimal strings). */
export function buildGroup(memberCommitments) {
  return new Group(memberCommitments.map((m) => BigInt(m)));
}

function fail(message, status) {
  const err = new Error(message);
  err.status = status;
  throw err;
}

function requireFieldString(value, field) {
  if (typeof value !== 'string' || !/^\d{1,78}$/.test(value)) {
    fail(`Invalid proof: ${field} must be a decimal field element.`, 400);
  }
  let n;
  try {
    n = BigInt(value);
  } catch {
    fail(`Invalid proof: ${field} is not a valid integer.`, 400);
  }
  if (n >= SNARK_FIELD) fail(`Invalid proof: ${field} is outside the circuit field.`, 400);
  return value;
}

/**
 * Structural validation of a client-submitted Semaphore proof. Rejects
 * malformed payloads BEFORE any cryptographic work, so the library only ever
 * sees well-formed input and failures map to 4xx, never 500s.
 */
export function validateProofShape(proof) {
  if (!proof || typeof proof !== 'object' || Array.isArray(proof)) {
    fail('Invalid proof: expected a proof object.', 400);
  }
  const { merkleTreeDepth, merkleTreeRoot, message, nullifier, scope, points } = proof;
  if (!Number.isInteger(merkleTreeDepth) || merkleTreeDepth < MIN_TREE_DEPTH || merkleTreeDepth > MAX_TREE_DEPTH) {
    fail(`Invalid proof: merkleTreeDepth must be an integer ${MIN_TREE_DEPTH}-${MAX_TREE_DEPTH}.`, 400);
  }
  requireFieldString(merkleTreeRoot, 'merkleTreeRoot');
  requireFieldString(message, 'message');
  requireFieldString(nullifier, 'nullifier');
  requireFieldString(scope, 'scope');
  if (!Array.isArray(points) || points.length !== 8) {
    fail('Invalid proof: points must be an array of 8 packed Groth16 values.', 400);
  }
  for (const point of points) {
    if (typeof point !== 'string' || !/^\d{1,80}$/.test(point)) {
      fail('Invalid proof: every point must be a decimal string.', 400);
    }
  }
  return proof;
}

/** Validate a client-submitted identity commitment (decimal string in-field). */
export function validateCommitment(commitment) {
  if (typeof commitment !== 'string' || !/^\d{1,78}$/.test(commitment)) {
    fail('Invalid commitment: expected a decimal field element.', 400);
  }
  if (BigInt(commitment) >= SNARK_FIELD) {
    fail('Invalid commitment: value is outside the circuit field.', 400);
  }
  return commitment;
}

/**
 * Fail-closed wrapper around the library verifier. Returns true only for a
 * genuinely valid Groth16 proof; every throw or false becomes false.
 * Callers MUST still check scope, message, and root against server-approved
 * values — verifyProof alone does not bind a proof to an election.
 */
export async function verifyMembershipProof(proof) {
  try {
    return (await verifyProof(proof)) === true;
  } catch {
    return false;
  }
}
