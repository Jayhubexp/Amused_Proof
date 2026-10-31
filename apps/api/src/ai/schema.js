// Server-side validation of Muse Spark output. Every AI claim shown to users
// passes through here: unknown event seqs are dropped (never trusted), enums are
// coerced, and oversized payloads are clamped.

import { SEVERITIES } from './rules.js';

const MAX_FINDINGS = 10;
const MAX_SEQS_PER_FINDING = 20;
const MAX_STEPS = 8;
const MAX_TEXT = 2000;
const MAX_SHORT_TEXT = 300;

export class AISchemaError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AISchemaError';
    this.status = 502;
  }
}

function asText(value, max, field) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AISchemaError(`AI response is missing a valid "${field}".`);
  }
  return value.trim().slice(0, max);
}

function asOptionalText(value, max) {
  if (typeof value !== 'string' || !value.trim()) return null;
  return value.trim().slice(0, max);
}

function asStringList(value, maxItems, maxChars) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => typeof item === 'string' && item.trim())
    .map((item) => item.trim().slice(0, maxChars))
    .slice(0, maxItems);
}

function checkSeqs(rawSeqs, knownSeqs, warnings, where) {
  const seqs = [];
  for (const seq of Array.isArray(rawSeqs) ? rawSeqs : []) {
    const n = typeof seq === 'number' ? seq : Number.parseInt(seq, 10);
    if (!Number.isInteger(n)) continue;
    if (!knownSeqs.has(n)) {
      warnings.push(`${where} cited unknown event #${n}; citation dropped.`);
      continue;
    }
    if (!seqs.includes(n)) seqs.push(n);
    if (seqs.length >= MAX_SEQS_PER_FINDING) break;
  }
  return seqs;
}

/**
 * Validate a full integrity-analysis response.
 * @returns {{ report: object, warnings: string[] }}
 */
export function validateAnalysisOutput(raw, knownSeqs) {
  let parsed = raw;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      throw new AISchemaError('AI response was not valid JSON.');
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AISchemaError('AI response had an unexpected shape.');
  }

  const warnings = [];
  const known = knownSeqs instanceof Set ? knownSeqs : new Set(knownSeqs);
  const findings = [];
  const rawFindings = Array.isArray(parsed.findings) ? parsed.findings.slice(0, MAX_FINDINGS) : [];

  rawFindings.forEach((item, index) => {
    const where = `Finding ${index + 1}`;
    if (!item || typeof item !== 'object') {
      warnings.push(`${where} was not an object; skipped.`);
      return;
    }
    const title = asOptionalText(item.title, MAX_SHORT_TEXT);
    const explanation = asOptionalText(item.explanation, MAX_TEXT);
    if (!title || !explanation) {
      warnings.push(`${where} was missing a title or explanation; skipped.`);
      return;
    }
    let severity = typeof item.severity === 'string' ? item.severity.toLowerCase() : '';
    if (!SEVERITIES.includes(severity)) {
      warnings.push(`${where} had an invalid severity; defaulted to "low".`);
      severity = 'low';
    }
    findings.push({
      source: 'ai',
      title,
      severity,
      eventSeqs: checkSeqs(item.eventSeqs ?? item.eventIds, known, warnings, where),
      explanation,
      recommendedSteps: asStringList(item.recommendedSteps, MAX_STEPS, MAX_SHORT_TEXT),
    });
  });

  return {
    report: {
      summary: asText(parsed.summary, MAX_TEXT, 'summary'),
      findings,
      limitations: asStringList(parsed.limitations, MAX_STEPS, MAX_SHORT_TEXT),
    },
    warnings,
  };
}

/**
 * Validate a follow-up question response.
 * @returns {{ report: object, warnings: string[] }}
 */
export function validateAnswerOutput(raw, knownSeqs) {
  let parsed = raw;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      throw new AISchemaError('AI response was not valid JSON.');
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AISchemaError('AI response had an unexpected shape.');
  }
  const warnings = [];
  const known = knownSeqs instanceof Set ? knownSeqs : new Set(knownSeqs);
  return {
    report: {
      answer: asText(parsed.answer, MAX_TEXT, 'answer'),
      eventSeqs: checkSeqs(parsed.eventSeqs ?? parsed.eventIds, known, warnings, 'Answer'),
      limitations: asStringList(parsed.limitations, MAX_STEPS, MAX_SHORT_TEXT),
    },
    warnings,
  };
}
