// Sanitise audit events before they are sent to the Muse Spark API.
// Defence in depth: the audit log is public-safe by construction, but this module
// guarantees that guarantee — unknown fields are dropped and secret-like text is
// redacted even if a future event type carries it.

export const MAX_EVENTS_TO_MODEL = 60;
export const MAX_DETAIL_CHARS = 300;

// Alert-bearing types are sent first so a capped payload keeps the signal.
const PRIORITY_TYPES = new Set([
  'ballot.rejected',
  'proof.rejected',
  'auth.failed',
  'admin.updated',
  'transaction.error',
]);

const REDACTIONS = [
  [/sess_[A-Za-z0-9]+/g, '[SESSION_REDACTED]'],
  [/cred-[A-Za-z0-9-]+/g, '[CREDENTIAL_REDACTED]'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[EMAIL_REDACTED]'],
  // Long hex blobs (nullifiers, commitments, key material): keep a short prefix.
  [/\b[0-9a-f]{32,}\b/gi, (m) => `${m.slice(0, 8)}…[HASH_TRUNCATED]`],
];

export function redactText(value) {
  if (typeof value !== 'string') return '';
  let out = value;
  for (const [pattern, replacement] of REDACTIONS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

function sanitiseOne(event) {
  return {
    seq: event.seq,
    ts: event.ts,
    type: event.type,
    electionId: event.electionId,
    detail: redactText(event.detail).slice(0, MAX_DETAIL_CHARS),
  };
}

/**
 * Select and sanitise events for model input.
 * @returns {{ events: Array, dropped: number, total: number }}
 */
export function sanitiseEventsForModel(events, { maxEvents = MAX_EVENTS_TO_MODEL } = {}) {
  const sorted = [...events].sort((a, b) => {
    const pa = PRIORITY_TYPES.has(a.type) ? 0 : 1;
    const pb = PRIORITY_TYPES.has(b.type) ? 0 : 1;
    return pa - pb || b.seq - a.seq; // priority first, then newest
  });
  const selected = sorted.slice(0, maxEvents);
  selected.sort((a, b) => a.seq - b.seq); // chronological for the model
  return {
    events: selected.map(sanitiseOne),
    dropped: Math.max(0, events.length - selected.length),
    total: events.length,
  };
}
