import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';

/**
 * Default SimpleWebAuthn binding. All ceremony cryptography (attestation and
 * assertion verification: challenge, origin, RP ID, signature, UV flags,
 * counters) is performed by this established library — never by custom code.
 * Tests inject fakes with the same four-function shape; production always uses
 * the real implementations below.
 */
export const defaultWebAuthnLib = {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
};

function fail(message, status) {
  const err = new Error(message);
  err.status = status;
  throw err;
}

/**
 * Registration options. No `authenticatorAttachment` restriction: platform
 * authenticators AND roaming security keys are accepted, so voters without
 * biometric hardware can use a PIN-based security key (non-biometric option).
 */
export function buildRegistrationOptions(lib, {
  rpName,
  rpId,
  userName,
  userDisplayName,
  userIdBytes,
  excludeCredentialIds = [],
}) {
  return lib.generateRegistrationOptions({
    rpName,
    rpID: rpId,
    userName,
    userID: userIdBytes,
    userDisplayName,
    attestationType: 'none',
    excludeCredentials: excludeCredentialIds.map((id) => ({ id })),
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
  });
}

/** Verify attestation: challenge, origin, RP ID, and user verification. */
export async function verifyRegistration(lib, { response, expectedChallenge, rpId, origin }) {
  let verification;
  try {
    verification = await lib.verifyRegistrationResponse({
      response,
      expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpId,
      requireUserVerification: true,
    });
  } catch {
    fail('Passkey registration could not be verified.', 401);
  }
  if (!verification.verified || !verification.registrationInfo) {
    fail('Passkey registration could not be verified.', 401);
  }
  return verification.registrationInfo;
}

export function buildAuthenticationOptions(lib, { rpId, allowCredentials }) {
  return lib.generateAuthenticationOptions({
    rpID: rpId,
    allowCredentials,
    userVerification: 'required',
  });
}

/**
 * Verify assertion: challenge, origin, RP ID, signature (against the stored
 * public key), user verification flag, and authenticator counter.
 */
export async function verifyAuthentication(lib, {
  response,
  expectedChallenge,
  rpId,
  origin,
  credential,
}) {
  let verification;
  try {
    verification = await lib.verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpId,
      credential,
      requireUserVerification: true,
    });
  } catch {
    fail('Passkey authentication failed verification.', 401);
  }
  if (!verification.verified || !verification.authenticationInfo) {
    fail('Passkey authentication failed verification.', 401);
  }
  return verification.authenticationInfo;
}
