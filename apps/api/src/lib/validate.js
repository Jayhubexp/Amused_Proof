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

export function requireUsername(value, field = 'username') {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]{2,31}$/.test(value)) {
    fail(`Invalid ${field}: expected a 3-32 char lowercase slug.`);
  }
  return value;
}

export function requirePassword(value, field = 'password') {
  if (typeof value !== 'string' || value.length < 12 || value.length > 200) {
    fail(`Invalid ${field}: expected 12-200 characters.`);
  }
  return value;
}

export function requireInvitationToken(value, field = 'invitation token') {
  if (typeof value !== 'string' || !/^inv_[0-9a-f]{48}$/.test(value)) {
    fail(`Invalid ${field}: expected an invitation code.`);
  }
  return value;
}

export function requireSlug(value, field) {
  return requireId(value, field);
}

export function requireCandidates(value, field = 'candidates') {
  if (!Array.isArray(value) || value.length < 2 || value.length > 20) {
    fail(`Invalid ${field}: expected 2-20 ballot choices.`);
  }
  return value.map((candidate, index) => {
    if (!candidate || typeof candidate !== 'object') {
      fail(`Invalid ${field}[${index}]: expected an object.`);
    }
    return {
      name: requireString(candidate.name, `${field}[${index}].name`, { max: 120 }),
      party: requireString(candidate.party ?? 'Independent', `${field}[${index}].party`, { max: 120 }),
    };
  });
}

export function requireElectionStatus(value, field = 'status') {
  if (!['draft', 'open', 'closed', 'enrolment', 'frozen', 'voting'].includes(value)) {
    fail(`Invalid ${field}: expected a known election status.`);
  }
  return value;
}

export function requireVotingMode(value, field = 'voting mode') {
  if (!['standard', 'anonymous'].includes(value)) {
    fail(`Invalid ${field}: expected standard or anonymous.`);
  }
  return value;
}

export function requireAccessMode(value, field = 'access') {
  if (!['roll', 'invitation'].includes(value)) {
    fail(`Invalid ${field}: expected roll or invitation.`);
  }
  return value;
}

export function requireInt(value, field, { min = 1, max = 100 } = {}) {
  if (!Number.isInteger(value) || value < min || value > max) {
    fail(`Invalid ${field}: expected an integer ${min}-${max}.`);
  }
  return value;
}

export function requireIsoDate(value, field) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    fail(`Invalid ${field}: expected an ISO date string.`);
  }
  return new Date(value).toISOString();
}
