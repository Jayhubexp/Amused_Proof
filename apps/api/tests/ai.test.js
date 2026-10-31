import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { MemoryStore } from '../src/store/memory.js';
import { MuseSparkClient, MuseSparkError } from '../src/ai/muse.js';
import { runRules } from '../src/ai/rules.js';
import { redactText, sanitiseEventsForModel } from '../src/ai/sanitize.js';
import { validateAnalysisOutput } from '../src/ai/schema.js';

// Scripted mock Muse client: each script entry is { content, toolCalls } or
// { throw: Error }. Records every call for assertions. No network involved.
function mockClient(script, { model = 'muse-spark-test' } = {}) {
  const calls = [];
  let step = 0;
  return {
    model,
    calls,
    async complete({ messages, tools }) {
      calls.push({ messages, tools });
      const entry = script[Math.min(step, script.length - 1)];
      step += 1;
      if (entry?.throw) throw entry.throw;
      return { content: entry?.content ?? null, toolCalls: entry?.toolCalls ?? [] };
    },
  };
}

function analysisJson(overrides = {}) {
  return JSON.stringify({
    summary: 'Mock analysis of the fictional audit log.',
    findings: [
      {
        title: 'Repeated authentication failures merit review',
        severity: 'medium',
        eventSeqs: [5, 6, 7],
        explanation: 'Three failures share one correlation hash in a short window.',
        recommendedSteps: ['Review the credential correlation hash.'],
      },
    ],
    limitations: ['Fictional data; mock model output.'],
    ...overrides,
  });
}

let store;

beforeEach(() => {
  store = new MemoryStore();
});

// -- deterministic rules ------------------------------------------------------
test('rules flag all four fictional incident types with real event seqs', async () => {
  const app = createApp(store, { aiClient: null });
  const res = await request(app).get('/api/ai/integrity');
  assert.equal(res.status, 200);
  assert.equal(res.body.live, false);
  assert.equal(res.body.aiStatus, 'disabled');
  assert.equal(res.body.readOnly, true);

  const ruleIds = res.body.ruleFindings.map((f) => f.ruleId).sort();
  assert.deepEqual(ruleIds, [
    'duplicate-vote-attempts',
    'repeated-auth-failures',
    'suspicious-admin-changes',
    'transaction-errors',
  ]);

  // Every cited seq must exist in the actual audit log.
  const seqs = new Set(store.listAudit({}).map((e) => e.seq));
  for (const finding of res.body.ruleFindings) {
    assert.ok(finding.eventSeqs.length > 0);
    for (const seq of finding.eventSeqs) assert.ok(seqs.has(seq), `unknown seq ${seq}`);
  }
  assert.ok(res.body.summary.includes('Rules-only'));
});

test('integrity response includes a per-election rule breakdown', async () => {
  const app = createApp(store, { aiClient: null });
  const res = await request(app).get('/api/ai/integrity');
  assert.equal(res.status, 200);
  assert.equal(res.body.electionBreakdown.length, 3);
  const metro = res.body.electionBreakdown.find((e) => e.electionId === 'metro-transit-2026');
  assert.ok(metro.events > 0);
  assert.ok(metro.findings >= 2);
  assert.ok(metro.high + metro.medium + metro.low + metro.info === metro.findings);

  const scoped = await request(app).get('/api/ai/integrity?electionId=harbor-board-2026');
  assert.equal(scoped.body.electionBreakdown.length, 1);
  assert.equal(scoped.body.electionBreakdown[0].electionId, 'harbor-board-2026');
});

test('rules respect the election scope filter', () => {
  const metro = runRules(store.listAudit({ electionId: 'metro-transit-2026' }));
  const harbor = runRules(store.listAudit({ electionId: 'harbor-board-2026' }));
  assert.ok(metro.some((f) => f.ruleId === 'repeated-auth-failures'));
  assert.ok(!metro.some((f) => f.ruleId === 'suspicious-admin-changes'));
  assert.ok(harbor.some((f) => f.ruleId === 'suspicious-admin-changes'));
  assert.ok(!harbor.some((f) => f.ruleId === 'repeated-auth-failures'));
});

test('runtime duplicate votes feed the duplicate-attempt rule', async () => {
  const app = createApp(store, { aiClient: null });
  // Seed an authenticated session directly: ceremony coverage lives in
  // tests/webauthn.test.js; here we only need a voted-then-duplicate trail.
  await store.savePasskey({
    id: 'rule-probe-cred', voterRef: 'PM-1001', electionId: 'metro-transit-2026',
    userIdBase64: 'dXNlcg', publicKeyBase64: 'AQID', counter: 1,
  });
  const session = await store.createSession({
    voterRef: 'PM-1001', electionId: 'metro-transit-2026', credentialId: 'rule-probe-cred', ttlMs: 3600000,
  });
  const agent = request.agent(app);
  await agent.jar.setCookie(`cp_session=${session.id}`);
  const ballot = { electionId: 'metro-transit-2026', ballotCommitment: 'a'.repeat(64) };
  const headers = { 'x-csrf-token': session.csrfToken };
  assert.equal((await agent.post('/api/ballots').set(headers).send(ballot)).status, 201);
  assert.equal((await agent.post('/api/ballots').set(headers).send(ballot)).status, 409);

  const res = await request(app).get('/api/ai/integrity?electionId=metro-transit-2026');
  const dup = res.body.ruleFindings.find((f) => f.ruleId === 'duplicate-vote-attempts');
  assert.ok(dup);
  assert.equal(dup.severity, 'high'); // seed incident + runtime rejection
  const serialised = JSON.stringify(res.body);
  assert.ok(!serialised.includes('PM-1001'));
});

// -- mocked model success -------------------------------------------------------
test('mocked AI findings merge with rules, sorted by severity', async () => {
  const client = mockClient([{ content: analysisJson() }]);
  const app = createApp(store, { aiClient: client });
  const res = await request(app).get('/api/ai/integrity');
  assert.equal(res.status, 200);
  assert.equal(res.body.live, true);
  assert.equal(res.body.aiStatus, 'ok');
  assert.equal(res.body.model, 'muse-spark-test');
  assert.equal(res.body.aiFindings.length, 1);
  assert.equal(res.body.aiFindings[0].source, 'ai');

  const rank = { high: 0, medium: 1, low: 2, info: 3 };
  const severities = res.body.findings.map((f) => rank[f.severity]);
  assert.deepEqual([...severities].sort((a, b) => a - b), severities);
  // Model received sanitised events, not raw store rows: the user message must
  // carry no credential material and no secret-bearing field names.
  const userMessage = client.calls[0].messages.find((m) => m.role === 'user').content;
  assert.ok(!userMessage.includes('sess_'));
  assert.ok(!userMessage.includes('credentialSecret'));
  assert.ok(!userMessage.includes('"secret"'));
});

// -- fabricated / malformed model output -----------------------------------------
test('fabricated event seqs are dropped with warnings', async () => {
  const client = mockClient([
    { content: analysisJson({ findings: [{ title: 'Invented incident', severity: 'high', eventSeqs: [5, 9999], explanation: 'Bogus.', recommendedSteps: [] }] }) },
  ]);
  const app = createApp(store, { aiClient: client });
  const res = await request(app).get('/api/ai/integrity');
  assert.equal(res.status, 200);
  assert.equal(res.body.live, true);
  assert.deepEqual(res.body.aiFindings[0].eventSeqs, [5]);
  assert.ok(res.body.warnings.some((w) => w.includes('#9999')));
});

test('malformed model JSON degrades to rules-only with aiStatus error', async () => {
  const client = mockClient([{ content: 'not json at all {{{' }]);
  const app = createApp(store, { aiClient: client });
  const res = await request(app).get('/api/ai/integrity');
  assert.equal(res.status, 200);
  assert.equal(res.body.live, false);
  assert.equal(res.body.aiStatus, 'error');
  assert.ok(res.body.aiError.includes('JSON'));
  assert.ok(res.body.ruleFindings.length > 0);
  assert.deepEqual(res.body.aiFindings, []);
});

test('model timeout / outage degrades without leaking internals', async () => {
  const boom = new Error('socket hang up');
  boom.code = 'ETIMEDOUT';
  const client = mockClient([{ throw: boom }]);
  // Force immediate failure: single attempt.
  client.complete = async () => { throw boom; };
  const app = createApp(store, { aiClient: client });
  const res = await request(app).get('/api/ai/integrity');
  assert.equal(res.status, 200);
  assert.equal(res.body.live, false);
  assert.equal(res.body.aiStatus, 'error');
  assert.ok(!JSON.stringify(res.body).includes('socket hang up'));
});

// -- retry policy (unit level, scripted requestFn) --------------------------------
test('client retries rate limits with a bound, then surfaces rate_limited', async () => {
  let calls = 0;
  const limited = () => {
    calls += 1;
    return Promise.reject(Object.assign(new Error('slow down'), { status: 429 }));
  };
  const client = new MuseSparkClient({ requestFn: limited, maxRetries: 2 });
  const err = await client.complete({ messages: [] }).then(
    () => null,
    (e) => e,
  );
  assert.ok(err instanceof MuseSparkError);
  assert.equal(err.code, 'rate_limited');
  assert.equal(calls, 3); // 1 initial + 2 retries
});

test('client recovers when a retry succeeds', async () => {
  let calls = 0;
  const flaky = () => {
    calls += 1;
    if (calls === 1) return Promise.reject(Object.assign(new Error('x'), { status: 503 }));
    return Promise.resolve({ choices: [{ message: { content: '{}' } }] });
  };
  const client = new MuseSparkClient({ requestFn: flaky, maxRetries: 2 });
  const res = await client.complete({ messages: [] });
  assert.equal(res.content, '{}');
  assert.equal(calls, 2);
});

test('client does not retry client errors (400)', async () => {
  let calls = 0;
  const bad = () => {
    calls += 1;
    return Promise.reject(Object.assign(new Error('bad'), { status: 400 }));
  };
  const client = new MuseSparkClient({ requestFn: bad });
  await assert.rejects(() => client.complete({ messages: [] }), MuseSparkError);
  assert.equal(calls, 1);
});

test('client without key or injection reports not_configured', () => {
  assert.throws(() => new MuseSparkClient({}), /not configured/);
});

// -- read-only tool loop ------------------------------------------------------------
test('model can pull extra audit context through the read-only tool', async () => {
  const client = mockClient([
    {
      content: null,
      toolCalls: [{ id: 'call-1', name: 'get_audit_events', args: { type: 'auth.failed', limit: 5 } }],
    },
    { content: analysisJson() },
  ]);
  const app = createApp(store, { aiClient: client });
  const res = await request(app).get('/api/ai/integrity');
  assert.equal(res.status, 200);
  assert.equal(res.body.live, true);
  assert.equal(client.calls.length, 2);
  const toolReply = client.calls[1].messages.find((m) => m.role === 'tool');
  assert.ok(toolReply);
  assert.ok(toolReply.content.includes('auth.failed'));
});

test('unknown tools and endless tool loops degrade safely', async () => {
  const client = mockClient([
    { content: null, toolCalls: [{ id: 'call-x', name: 'drop_database', args: {} }] },
  ]);
  const app = createApp(store, { aiClient: client });
  const res = await request(app).get('/api/ai/integrity');
  assert.equal(res.status, 200);
  assert.equal(res.body.live, false);
  assert.equal(res.body.aiStatus, 'error');
  assert.ok(client.calls.length <= 3); // bounded loop
});

// -- empty audit log ------------------------------------------------------------------
test('empty audit scope short-circuits without calling the model', async () => {
  const client = mockClient([{ content: analysisJson() }]);
  const app = createApp(store, { aiClient: client });
  const res = await request(app).get('/api/ai/integrity?electionId=no-events-here-1');
  assert.equal(res.status, 200);
  assert.equal(res.body.eventCount, 0);
  assert.equal(res.body.aiStatus, 'skipped_empty');
  assert.equal(client.calls.length, 0);
});

// -- follow-up questions ---------------------------------------------------------------
test('ask answers from events with validated citations', async () => {
  const client = mockClient([
    { content: JSON.stringify({ answer: 'Three failures were recorded.', eventSeqs: [5, 6], limitations: [] }) },
  ]);
  const app = createApp(store, { aiClient: client });
  const res = await request(app)
    .post('/api/ai/ask')
    .send({ electionId: 'metro-transit-2026', question: 'Were there any failed logins?' });
  assert.equal(res.status, 200);
  assert.equal(res.body.live, true);
  assert.equal(res.body.readOnly, true);
  assert.deepEqual(res.body.eventSeqs, [5, 6]);
});

test('ask is unavailable without a client (503) and validates input', async () => {
  const app = createApp(store, { aiClient: null });
  const unavailable = await request(app).post('/api/ai/ask').send({ question: 'Hello?' });
  assert.equal(unavailable.status, 503);
  assert.match(unavailable.body.error, /MUSE_SPARK_API_KEY/);

  const client = mockClient([{ content: JSON.stringify({ answer: 'x', eventSeqs: [] }) }]);
  const live = createApp(store, { aiClient: client });
  assert.equal((await request(live).post('/api/ai/ask').send({ question: '' })).status, 400);
  assert.equal((await request(live).post('/api/ai/ask').send({ question: 'x'.repeat(501) })).status, 400);
  assert.equal((await request(live).post('/api/ai/ask').send({})).status, 400);
  assert.equal(
    (await request(live).post('/api/ai/ask').send({ electionId: 'BAD!', question: 'ok?' })).status,
    400,
  );
});

test('ask surfaces rate limits as 429', async () => {
  const limited = new MuseSparkError('Muse Spark rate limit reached. Try again shortly.', {
    status: 429, code: 'rate_limited', retryable: true,
  });
  const client = mockClient([{ throw: limited }]);
  const app = createApp(store, { aiClient: client });
  const res = await request(app).post('/api/ai/ask').send({ question: 'Anything?' });
  assert.equal(res.status, 429);
});

// -- sanitizer ----------------------------------------------------------------------------
test('sanitizer redacts secrets and prioritises alert events', () => {
  assert.match(redactText('token sess_abc123 here'), /SESSION_REDACTED/);
  assert.ok(!redactText('token sess_abc123 here').includes('sess_abc123'));
  assert.match(redactText('id cred-ff00ab'), /CREDENTIAL_REDACTED/);
  assert.match(redactText('mail a@b.co'), /EMAIL_REDACTED/);
  const hex = 'de'.repeat(32);
  assert.ok(!redactText(hex).includes(hex));

  const events = [
    { seq: 1, ts: 't', type: 'election.opened', electionId: 'e', detail: 'routine' },
    { seq: 2, ts: 't', type: 'auth.failed', electionId: 'e', detail: 'suspicious sess_zzz' },
  ];
  const { events: out } = sanitiseEventsForModel(events, { maxEvents: 1 });
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 'auth.failed'); // alert beats routine under the cap
  assert.ok(!out[0].detail.includes('sess_zzz'));
  assert.deepEqual(Object.keys(out[0]).sort(), ['detail', 'electionId', 'seq', 'ts', 'type']);
});

// -- schema edge cases -----------------------------------------------------------------------
test('schema coerces bad severities and rejects missing summaries', () => {
  const { report, warnings } = validateAnalysisOutput(
    JSON.stringify({
      summary: 'ok',
      findings: [{ title: 't', severity: 'CRITICAL', eventSeqs: [], explanation: 'e' }],
    }),
    new Set(),
  );
  assert.equal(report.findings[0].severity, 'low');
  assert.ok(warnings.length > 0);
  assert.throws(
    () => validateAnalysisOutput(JSON.stringify({ findings: [] }), new Set()),
    /summary/,
  );
});
