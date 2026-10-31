// FICTIONAL fallback data, mirroring apps/api/src/seed/fictional.js.
// Used only when the API is unreachable; the UI labels this state.

export const elections = [
  {
    id: 'metro-transit-2026',
    title: 'Metro Transit Funding Measure',
    description: 'Fictional ballot measure in the invented city of Port Meridian.',
    status: 'open',
    ballotsCast: 0,
    candidates: [
      { id: 'yes-fund', name: 'Yes — approve funding', party: 'Measure' },
      { id: 'no-fund', name: 'No — reject funding', party: 'Measure' },
    ],
  },
  {
    id: 'harbor-board-2026',
    title: 'Harbor District Board Seat 3',
    description: 'Fictional neighbourhood board race. All candidates are invented.',
    status: 'open',
    ballotsCast: 0,
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
    ballotsCast: 0,
    candidates: [
      { id: 'yes-levy', name: 'Yes — renew levy', party: 'Measure' },
      { id: 'no-levy', name: 'No — let levy expire', party: 'Measure' },
    ],
  },
];

// Fictional eligibility roll (mirrors the backend seed). Displayed so the demo
// works out of the box; every person and PIN is invented.
export const demoRoll = [
  { voterRef: 'PM-1001', electionId: 'metro-transit-2026', displayName: 'Demo Voter Ada', pin: '4921' },
  { voterRef: 'PM-1002', electionId: 'metro-transit-2026', displayName: 'Demo Voter Ben', pin: '7734' },
  { voterRef: 'PM-1003', electionId: 'metro-transit-2026', displayName: 'Demo Voter Casey', pin: '2085' },
  { voterRef: 'PM-2001', electionId: 'harbor-board-2026', displayName: 'Demo Voter Dana', pin: '6319' },
  { voterRef: 'PM-2002', electionId: 'harbor-board-2026', displayName: 'Demo Voter Eli', pin: '1457' },
];

export const auditEvents = [
  {
    seq: 1,
    ts: new Date(Date.now() - 86400000 * 9).toISOString(),
    type: 'election.opened',
    electionId: 'metro-transit-2026',
    ref: null,
    detail: 'Offline fixture: start the API for the live audit trail.',
  },
];
