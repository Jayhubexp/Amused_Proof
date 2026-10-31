// Orchestrates integrity analysis: deterministic rules always run; Muse Spark
// interpretation is layered on top when a client is configured. Read-only end to
// end — this module only calls store.listAudit / store.getElection.

import { runRules } from './rules.js';
import { sanitiseEventsForModel, redactText } from './sanitize.js';
import { AISchemaError, validateAnalysisOutput, validateAnswerOutput } from './schema.js';
import {
  ANALYSIS_SYSTEM_PROMPT,
  ASK_SYSTEM_PROMPT,
  AUDIT_TOOL,
  buildAnalysisUserMessage,
  buildAskUserMessage,
} from './prompts.js';
import { MuseSparkError } from './muse.js';

const MAX_TOOL_ROUNDS = 2;
const SEVERITY_RANK = { high: 0, medium: 1, low: 2, info: 3 };

function mergeFindings(ruleFindings, aiFindings) {
  return [...ruleFindings, ...aiFindings].sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      (a.title < b.title ? -1 : 1),
  );
}

function countByType(events) {
  return Object.fromEntries(
    [...new Set(events.map((e) => e.type))].map((t) => [
      t,
      events.filter((e) => e.type === t).length,
    ]),
  );
}

// Per-election rule summary for dashboard charts. Pure rules — no model calls.
async function buildElectionBreakdown(store, events, electionId) {
  const elections = await store.listElections();
  const scoped = electionId ? elections.filter((e) => e.id === electionId) : elections;
  return scoped.map((election) => {
    const scopedEvents = events.filter((e) => e.electionId === election.id);
    const findings = runRules(scopedEvents);
    const count = (severity) => findings.filter((f) => f.severity === severity).length;
    return {
      electionId: election.id,
      title: election.title,
      events: scopedEvents.length,
      findings: findings.length,
      high: count('high'),
      medium: count('medium'),
      low: count('low'),
      info: count('info'),
    };
  });
}

/** Execute one read-only tool call against the store. Args are re-validated here. */
async function executeToolCall(store, call) {
  if (call.name !== 'get_audit_events') {
    return { error: `Unknown tool "${call.name}". Only get_audit_events is available.` };
  }
  const args = call.args && typeof call.args === 'object' ? call.args : {};
  const electionId =
    typeof args.electionId === 'string' && /^[a-z0-9-]{3,64}$/.test(args.electionId)
      ? args.electionId
      : undefined;
  const type =
    typeof args.type === 'string' && /^[a-z0-9.]{1,40}$/.test(args.type) ? args.type : undefined;
  const limit = Math.min(Math.max(Number.parseInt(args.limit, 10) || 20, 1), 100);
  const events = await store.listAudit({ electionId, type, limit });
  const { events: sanitised, dropped, total } = sanitiseEventsForModel(events, {
    maxEvents: limit,
  });
  return { events: sanitised, dropped, total };
}

/**
 * Run the model with a bounded read-only tool loop.
 * @returns {{ content: string|null, knownSeqs: Set, toolRounds: number }}
 */
async function completeWithTools(client, store, { system, userMessage, knownSeqs }) {
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: userMessage },
  ];
  for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
    const { content, toolCalls } = await client.complete({
      messages,
      tools: [AUDIT_TOOL],
    });
    const calls = (toolCalls ?? []).filter((c) => c.id && c.name).slice(0, 3);
    if (calls.length === 0) return { content, knownSeqs, toolRounds: round };
    messages.push({
      role: 'assistant',
      content: null,
      tool_calls: calls.map((c) => ({
        id: c.id,
        type: 'function',
        function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) },
      })),
    });
    for (const call of calls) {
      const result = await executeToolCall(store, call);
      for (const event of result.events ?? []) knownSeqs.add(event.seq);
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }
  return { content: null, knownSeqs, toolRounds: MAX_TOOL_ROUNDS + 1 };
}

function summariseRules(ruleFindings) {
  if (ruleFindings.length === 0) return 'Deterministic rules flagged nothing in this event set.';
  return `Deterministic rules already flagged: ${ruleFindings
    .map((f) => `${f.ruleId} (${f.severity})`)
    .join(', ')}. Corroborate, refine, or add context — do not contradict these mechanical facts.`;
}

/**
 * Full integrity analysis for an election scope (or all elections).
 * Never throws for AI failures: they degrade to rules-only with aiStatus set.
 */
export async function analyzeIntegrity(store, client, { electionId = null } = {}) {
  const events = await store.listAudit({ electionId: electionId ?? undefined, limit: 500 });
  const ruleFindings = runRules(events);
  const election = electionId ? await store.getElection(electionId) : null;

  const base = {
    electionId,
    electionTitle: election?.title ?? (electionId ? 'Unknown election' : 'All elections'),
    eventCount: events.length,
    countsByType: countByType(events),
    ruleFindings,
    electionBreakdown: await buildElectionBreakdown(store, events, electionId),
    readOnly: true,
  };

  if (events.length === 0) {
    return {
      ...base,
      summary: 'No audit events found for this scope. Nothing to analyse yet.',
      aiFindings: [],
      findings: [],
      limitations: ['An empty audit log cannot support any integrity conclusions.'],
      warnings: [],
      live: false,
      model: null,
      aiStatus: client ? 'skipped_empty' : 'disabled',
    };
  }

  if (!client) {
    return {
      ...base,
      summary:
        ruleFindings.length === 0
          ? 'Rules-only review (no API key): deterministic checks found nothing to flag in these audit events.'
          : `Rules-only review (no API key): deterministic checks flagged ${ruleFindings.length} item(s) below. ` +
            'Configure MUSE_SPARK_API_KEY for AI interpretation.',
      aiFindings: [],
      findings: mergeFindings(ruleFindings, []),
      limitations: ['AI interpretation is disabled: MUSE_SPARK_API_KEY is not configured.'],
      warnings: [],
      live: false,
      model: null,
      aiStatus: 'disabled',
    };
  }

  const { events: modelEvents, dropped, total } = sanitiseEventsForModel(events);
  const knownSeqs = new Set(events.map((e) => e.seq));
  try {
    const { content } = await completeWithTools(client, store, {
      system: ANALYSIS_SYSTEM_PROMPT,
      userMessage: buildAnalysisUserMessage({
        electionTitle: base.electionTitle,
        events: modelEvents,
        dropped,
        total,
        ruleSummary: summariseRules(ruleFindings),
      }),
      knownSeqs,
    });
    if (!content) {
      throw new MuseSparkError('Muse Spark returned no analysis content.', { code: 'empty_response' });
    }
    const { report, warnings } = validateAnalysisOutput(content, knownSeqs);
    return {
      ...base,
      summary: report.summary,
      aiFindings: report.findings,
      findings: mergeFindings(ruleFindings, report.findings),
      limitations: report.limitations,
      warnings,
      live: true,
      model: client.model,
      aiStatus: 'ok',
    };
  } catch (err) {
    // Fail closed: only normalised error messages reach the client.
    // Anything else is an unexpected internal failure — log it, don't echo it.
    const normalised = err instanceof MuseSparkError || err instanceof AISchemaError;
    if (!normalised) console.error('Integrity analysis failure:', err);
    const message = normalised ? err.message : 'Unexpected analysis failure.';
    return {
      ...base,
      summary: `AI interpretation failed; showing deterministic rule findings only. (${message})`,
      aiFindings: [],
      findings: mergeFindings(ruleFindings, []),
      limitations: ['AI interpretation failed for this request; results below are rules-only.'],
      warnings: [],
      live: false,
      model: client.model,
      aiStatus: err?.code === 'rate_limited' ? 'rate_limited' : 'error',
      aiError: message,
    };
  }
}

/**
 * Answer a natural-language question from the audit log. Requires a client;
 * callers return 503 when none is configured.
 */
export async function askQuestion(store, client, { electionId = null, question }) {
  const events = await store.listAudit({ electionId: electionId ?? undefined, limit: 500 });
  const cleanQuestion = redactText(question).slice(0, 500);
  if (events.length === 0) {
    return {
      answer: 'There are no audit events in this scope, so there is nothing to answer from.',
      eventSeqs: [],
      limitations: ['Empty audit log.'],
      warnings: [],
      live: false,
      model: client.model,
    };
  }
  const { events: modelEvents, dropped, total } = sanitiseEventsForModel(events);
  const knownSeqs = new Set(events.map((e) => e.seq));
  const { content } = await completeWithTools(client, store, {
    system: ASK_SYSTEM_PROMPT,
    userMessage: buildAskUserMessage({
      question: cleanQuestion,
      events: modelEvents,
      dropped,
      total,
    }),
    knownSeqs,
  });
  if (!content) {
    throw new MuseSparkError('Muse Spark returned no answer content.', { code: 'empty_response' });
  }
  const { report, warnings } = validateAnswerOutput(content, knownSeqs);
  return { ...report, warnings, live: true, model: client.model };
}
