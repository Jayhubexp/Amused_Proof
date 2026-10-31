// FICTIONAL seed data for the CivicProof AI research prototype.
// Every person, election, and event below is invented for demo purposes.

export const elections = [
  {
    id: 'metro-transit-2026',
    title: 'Metro Transit Funding Measure',
    description:
      'Fictional ballot measure on funding night-bus service in the invented city of Port Meridian.',
    status: 'open',
    startsAt: '2026-10-01T07:00:00.000Z',
    endsAt: '2026-11-07T19:00:00.000Z',
    candidates: [
      { id: 'yes-fund', name: 'Yes — approve funding', party: 'Measure' },
      { id: 'no-fund', name: 'No — reject funding', party: 'Measure' },
    ],
  },
  {
    id: 'harbor-board-2026',
    title: 'Harbor District Board Seat 3',
    description:
      'Fictional neighbourhood board race in Port Meridian. All candidates are invented.',
    status: 'open',
    startsAt: '2026-10-01T07:00:00.000Z',
    endsAt: '2026-11-07T19:00:00.000Z',
    candidates: [
      { id: 'a-okafor', name: 'Amara Okafor', party: 'Harbor Alliance' },
      { id: 'l-reyes', name: 'Luis Reyes', party: 'Shoreline Independents' },
      { id: 'p-nakamura', name: 'Priya Nakamura', party: 'Harbor Greens' },
    ],
  },
  {
    id: 'library-levy-2025',
    title: 'Library Levy Renewal (Certified Demo)',
    description: 'Closed fictional election used to demonstrate a certified result.',
    status: 'certified',
    startsAt: '2025-09-01T07:00:00.000Z',
    endsAt: '2025-09-08T19:00:00.000Z',
    candidates: [
      { id: 'yes-levy', name: 'Yes — renew levy', party: 'Measure' },
      { id: 'no-levy', name: 'No — let levy expire', party: 'Measure' },
    ],
  },
];

// Fictional eligibility roll. Only these voter refs (with their demo PINs) may
// register a passkey. Every person here is invented; PINs are demo-only and
// would never exist in a real eligibility system.
export const voterRoll = [
  { voterRef: 'PM-1001', electionId: 'metro-transit-2026', displayName: 'Demo Voter Ada', pin: '4921' },
  { voterRef: 'PM-1002', electionId: 'metro-transit-2026', displayName: 'Demo Voter Ben', pin: '7734' },
  { voterRef: 'PM-1003', electionId: 'metro-transit-2026', displayName: 'Demo Voter Casey', pin: '2085' },
  { voterRef: 'PM-2001', electionId: 'harbor-board-2026', displayName: 'Demo Voter Dana', pin: '6319' },
  { voterRef: 'PM-2002', electionId: 'harbor-board-2026', displayName: 'Demo Voter Eli', pin: '1457' },
  { voterRef: 'PM-3001', electionId: 'library-levy-2025', displayName: 'Demo Voter Farah', pin: '9082' },
];

// Public-safe audit events. Never include voter identities or plaintext votes.
export function seedAuditEvents() {
  const now = Date.now();
  const events = [];
  let seq = 1;
  for (const election of elections) {
    events.push({
      seq: seq++,
      ts: new Date(now - 86400000 * 9).toISOString(),
      type: 'election.opened',
      electionId: election.id,
      ref: null,
      detail: `Election "${election.title}" opened for credential holders.`,
    });
  }
  events.push({
    seq: seq++,
    ts: new Date(now - 86400000 * 2).toISOString(),
    type: 'tally.checkpoint',
    electionId: 'library-levy-2025',
    ref: null,
    detail: 'Certified demo tally checkpoint published (fictional counts).',
  });
  // -- Fictional integrity incidents for the AI assistant demo -----------------
  // Each is crafted to exercise one deterministic rule. Correlation refs are
  // opaque hashes; no identities, secrets, or plaintext votes appear here.
  const incident = (hoursAgo, type, electionId, ref, detail) => ({
    seq: seq++,
    ts: new Date(now - hoursAgo * 3600000).toISOString(),
    type,
    electionId,
    ref,
    detail,
  });
  events.push(
    incident(30, 'auth.failed', 'metro-transit-2026', 'corr-9f2c41aa', 'Passkey verification failed (invalid or expired challenge).'),
    incident(29.5, 'auth.failed', 'metro-transit-2026', 'corr-9f2c41aa', 'Passkey verification failed (invalid or expired challenge).'),
    incident(29, 'auth.failed', 'metro-transit-2026', 'corr-9f2c41aa', 'Passkey verification failed (invalid or expired challenge).'),
    incident(26, 'ballot.rejected', 'metro-transit-2026', 'corr-51bd77e0', 'Duplicate ballot rejected (nullifier already recorded).'),
    incident(
      20, 'admin.updated', 'harbor-board-2026', null,
      'Election metadata edited outside the published maintenance window (unscheduled change by duty officer).',
    ),
    incident(
      12, 'transaction.error', 'harbor-board-2026', null,
      'Tally batch step failed unexpectedly (fictional infrastructure fault); no commitments affected.',
    ),
  );
  return events;
}
