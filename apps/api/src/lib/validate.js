import { isHex64 } from './crypto.js';

function fail(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  throw err;
}

export function requireString(value, field, { min = 1, max = 200 } = {}) {
  if (typeof value !== 'string' || value.trim().length < min || value.length > max) {
    fail(`Invalid ${field}: expected a non-empty string.`);
  }
  return value.trim();
}

export function requireHex64(value, field) {
  if (!isHex64(value)) fail(`Invalid ${field}: expected 64 hex characters.`);
  return value.toLowerCase();
}

export function requireId(value, field) {
  if (typeof value !== 'string' || !/^[a-z0-9-]{3,64}$/.test(value)) {
    fail(`Invalid ${field}: expected a lowercase slug id.`);
  }
  return value;
}

export function requireVoterRef(value, field = 'voter ref') {
  if (typeof value !== 'string' || !/^[A-Z0-9-]{3,32}$/.test(value)) {
    fail(`Invalid ${field}: expected a voter reference like PM-1001.`);
  }
  return value;
}

export function requirePin(value, field = 'PIN') {
  if (typeof value !== 'string' || !/^[0-9]{4,12}$/.test(value)) {
    fail(`Invalid ${field}: expected a 4-12 digit demo PIN.`);
  }
  return value;
}
