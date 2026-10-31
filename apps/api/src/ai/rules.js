// Deterministic integrity rules over audit events.
// These run on every analysis, with or without the Muse Spark API key, and their
// output is merged with (never replaced by) AI interpretation.

export const SEVERITIES = ['info', 'low', 'medium', 'high'];

function finding({ ruleId, title, severity, eventSeqs, explanation, recommendedSteps }) {
  return {
    source: 'rule',
    ruleId,
    title,
    severity,
    eventSeqs: [...new Set(eventSeqs)].sort((a, b) => a - b),
    explanation,
    recommendedSteps,
  };
}

function byType(events, type) {
  return events.filter((e) => e.type === type);
}

function duplicateVoteAttempts(events) {
  const rejected = byType(events, 'ballot.rejected').filter((e) => /duplicate/i.test(e.detail ?? ''));
  if (rejected.length === 0) return null;
  const repeated = rejected.length >= 2;
  return finding({
    ruleId: 'duplicate-vote-attempts',
    title: repeated
      ? `${rejected.length} duplicate-vote attempts were rejected`
      : 'A duplicate-vote attempt was rejected',
    severity: repeated ? 'high' : 'medium',
    eventSeqs: rejected.map((e) => e.seq),
    explanation:
      'The server-side one-credential-one-vote guard rejected ballot submissions whose ' +
      'nullifier was already recorded. Rejection is the safe outcome; repetition may ' +
      'indicate a confused client retrying, or deliberate double-vote probing.',
    recommendedSteps: [
      'Confirm each rejected nullifier corresponds to exactly one accepted ballot.cast event.',
      'Check whether rejections cluster around one election or time window.',
      'If probing is suspected, review rate limiting on the ballot endpoint.',
    ],
  });
}

function repeatedAuthFailures(events) {
  const failures = byType(events, 'auth.failed');
  if (failures.length === 0) return null;
  const repeated = failures.length >= 3;
  return finding({
    ruleId: 'repeated-auth-failures',
    title: repeated
      ? `${failures.length} authentication failures detected`
      : 'Isolated authentication failures detected',
    severity: repeated ? 'high' : 'low',
    eventSeqs: failures.map((e) => e.seq),
    explanation:
      'Passkey verification failures were recorded. A small number is consistent with ' +
      'expired challenges or user error; a burst is consistent with credential-stuffing ' +
      'probes or a broken client build. No session tokens were issued for these events.',
    recommendedSteps: [
      'Check whether failures share a credential correlation hash or time window.',
      'Verify the challenge expiry and single-use behaviour are unchanged.',
      'Consider temporary throttling if failures continue to climb.',
    ],
  });
}

function suspiciousAdminChanges(events) {
  const changes = byType(events, 'admin.updated');
  if (changes.length === 0) return null;
  const offHours = changes.filter((e) => /off-hours|outside .*window|unscheduled/i.test(e.detail ?? ''));
  const tallyAffecting = changes.filter((e) => /tally|certif|result|eligib/i.test(e.detail ?? ''));
  const severity = offHours.length > 0 || tallyAffecting.length > 0 ? 'high' : 'medium';
  return finding({
    ruleId: 'suspicious-admin-changes',
    title:
      offHours.length > 0
        ? `${offHours.length} administrative change(s) outside the maintenance window`
        : `${changes.length} administrative change(s) recorded`,
    severity,
    eventSeqs: changes.map((e) => e.seq),
    explanation:
      'Administrative modifications are expected during published maintenance, but ' +
      'changes outside that window — especially anything touching tallies, results, or ' +
      'eligibility — warrant human review. This rule flags timing and topic, not intent.',
    recommendedSteps: [
      'Confirm each change against the published maintenance log and approver.',
      'Re-verify any tally checkpoint published after the change.',
      'Ensure admin actions require a second approver before certification.',
    ],
  });
}

function invalidProofs(events) {
  const rejected = byType(events, 'proof.rejected');
  if (rejected.length === 0) return null;
  const repeated = rejected.length >= 3;
  const reasons = [...new Set(rejected.map((e) => (e.detail ?? '').replace('Anonymous ballot rejected: ', '')))];
  return finding({
    ruleId: 'invalid-proofs',
    title: repeated
      ? `${rejected.length} anonymous ballots failed proof verification`
      : 'An anonymous ballot failed proof verification',
    severity: repeated ? 'high' : 'medium',
    eventSeqs: rejected.map((e) => e.seq),
    explanation:
      'Semaphore membership proofs were rejected during anonymous submission ' +
      `(${reasons.join('; ')}). A single failure is consistent with a stale group ` +
      'snapshot or client bug; repetition suggests probing with forged or ' +
      'transplanted proofs. No ballot was recorded for these events.',
    recommendedSteps: [
      'Check whether rejections share a reason code or time window.',
      'Confirm the election group snapshots have not been rolled back.',
      'If probing is suspected, review rate limiting on the anonymous ballot endpoint.',
    ],
  });
}

function transactionErrors(events) {
  const errors = byType(events, 'transaction.error');
  if (errors.length === 0) return null;
  const repeated = errors.length >= 3;
  return finding({
    ruleId: 'transaction-errors',
    title: repeated
      ? `${errors.length} transaction errors recorded`
      : 'A transaction error was recorded',
    severity: repeated ? 'high' : 'medium',
    eventSeqs: errors.map((e) => e.seq),
    explanation:
      'One or more audited transactions failed unexpectedly. A single error can be ' +
      'transient infrastructure; repetition suggests a systemic fault that could ' +
      'delay or duplicate downstream processing.',
    recommendedSteps: [
      'Correlate errors with infrastructure logs for the same time window.',
      'Confirm no ballot commitment was recorded twice as a result of retries.',
      'Re-run the affected batch step in a staging environment before retrying.',
    ],
  });
}

/**
 * Run all deterministic rules. Pure function of the event list.
 * @returns {Array} findings ordered by severity (high first), then rule id.
 */
export function runRules(events) {
  const rank = { high: 0, medium: 1, low: 2, info: 3 };
  return [duplicateVoteAttempts, repeatedAuthFailures, suspiciousAdminChanges, transactionErrors, invalidProofs]
    .map((rule) => rule(events))
    .filter(Boolean)
    .sort((a, b) => rank[a.severity] - rank[b.severity] || (a.ruleId < b.ruleId ? -1 : 1));
}
