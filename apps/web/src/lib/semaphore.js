import { sha256Hex } from './api.js';

// Client-side Semaphore helpers. Identities are created, stored, and proved
// with EXCLUSIVELY in this browser tab: the private key must never leave it.
// Only the identity COMMITMENT (a public hash) is ever sent to the server.
//
// Field encoding below MUST stay identical to apps/api/src/zk/semaphore.js:
// the same commitment/scope inputs must reduce to the same field elements or
// server verification fails.

export const SNARK_FIELD = BigInt(
  '21888242871839275222246405745257275088548364400416034343698204186575808495617',
);

export function toFieldDecimal(hexString) {
  return (BigInt(`0x${hexString}`) % SNARK_FIELD).toString();
}

export async function electionScope(electionId) {
  return toFieldDecimal(await sha256Hex(`civicproof-scope:${electionId}`));
}

export function commitmentMessage(ballotCommitmentHex) {
  return toFieldDecimal(ballotCommitmentHex);
}

/** Generate a fresh random Semaphore identity. Returns export + commitment. */
export async function createIdentity() {
  const { Identity } = await import('@semaphore-protocol/identity');
  const identity = new Identity();
  return { backup: identity.export(), commitment: identity.commitment.toString() };
}

/** Rebuild an identity object from an exported backup string. Throws if invalid. */
export async function restoreIdentity(backup) {
  const { Identity } = await import('@semaphore-protocol/identity');
  const identity = Identity.import(backup.trim());
  return { identity, commitment: identity.commitment.toString() };
}

/**
 * Generate a real membership proof. Downloads Semaphore proving keys on first
 * use (cached by the browser afterwards). The identity secret never leaves
 * this function call.
 */
export async function generateBallotProof({ backup, members, ballotCommitment, scope }) {
  const [{ Identity }, { Group }, { generateProof }] = await Promise.all([
    import('@semaphore-protocol/identity'),
    import('@semaphore-protocol/group'),
    import('@semaphore-protocol/proof'),
  ]);
  const identity = Identity.import(backup.trim());
  const group = new Group(members.map((member) => BigInt(member)));
  return generateProof(identity, group, commitmentMessage(ballotCommitment), scope);
}

// Tab-scoped backup storage. sessionStorage (NOT localStorage): the secret
// dies with the tab, limiting the theft window. There is deliberately no
// server-side recovery — losing every copy means losing the vote.
const keyFor = (electionId) => `civicproof.semaphore.${electionId}`;

export function saveIdentityBackup(electionId, backup) {
  try {
    sessionStorage.setItem(keyFor(electionId), backup);
  } catch {
    // Private-mode storage failure: the in-memory copy still works this page.
  }
}

export function loadIdentityBackup(electionId) {
  try {
    return sessionStorage.getItem(keyFor(electionId));
  } catch {
    return null;
  }
}

export function clearIdentityBackup(electionId) {
  try {
    sessionStorage.removeItem(keyFor(electionId));
  } catch {
    // Ignore: nothing sensitive persists outside this tab regardless.
  }
}
