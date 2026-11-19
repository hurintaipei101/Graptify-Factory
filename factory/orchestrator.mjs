import { adaptEvidence } from './evidence-adapter.mjs';
import { executeIssue } from './executor.mjs';

const activeIssues = new Set();

function identity(issue) { return issue?.issueKey ?? issue?.id ?? issue?.identifier ?? null; }

function metadata(issue, evidence) {
  return {
    issueId: identity(issue),
    repository: evidence?.issue?.evidenceMetadata?.github?.repository ?? evidence?.github?.repository ?? issue?.repository ?? null,
    commitSha: evidence?.issue?.evidenceMetadata?.github?.sha ?? evidence?.github?.sha ?? issue?.commitSha ?? null,
  };
}

function blocked(issue, reason, status = 'BLOCKED', evidence) {
  return { ...metadata(issue, evidence), status, gate: status === 'STOP' ? 'A' : null, executed: false, repairCycles: 0, reasons: [reason] };
}

function unavailable(input) {
  return input === undefined || input === null || input.available === false || input.verification === 'NOT_VERIFIED';
}

function evidenceUnavailable(evidence) {
  return unavailable(evidence?.linear) || unavailable(evidence?.github) ||
    evidence?.github?.verification === 'NOT_VERIFIED' || evidence?.github?.protection?.verified === false;
}

/** Admit one offline issue using the existing evidence and controller gates. */
export function prepareOfflineIssue({ issue, evidence, nowMs = Date.now(), maxAgeMs, dryRun = true } = {}) {
  const key = identity(issue);
  if (!key) return blocked(issue, 'missing issue identity', 'REJECTED');
  if (dryRun !== true) return blocked(issue, 'offline orchestrator is dry-run only', 'REJECTED');
  if (evidenceUnavailable(evidence)) return blocked(issue, 'evidence is unavailable or NOT_VERIFIED');

  let normalized;
  try {
    normalized = adaptEvidence({ issue, linear: evidence.linear, github: evidence.github }, { nowMs, ...(maxAgeMs === undefined ? {} : { maxAgeMs }) });
  } catch (error) {
    const reason = error?.message ?? 'evidence is invalid, stale or contradictory';
    return blocked(issue, reason, /Gate B/i.test(reason) ? 'STOP' : 'BLOCKED');
  }
  if (normalized.decision.status !== 'READY') return blocked(normalized.issue, normalized.decision.reasons[0] ?? normalized.decision.status, normalized.decision.status, normalized);
  return { status: 'READY', ...normalized };
}

/** Normalize exactly one offline issue and execute only when the normalized decision is READY. */
export async function orchestrateIssue({ issue, evidence, codingAgent, testRunner, nowMs, maxAgeMs, dryRun = true } = {}) {
  const key = identity(issue);
  if (key && dryRun === true && activeIssues.has(key)) return blocked(issue, 'duplicate concurrent issue execution', 'REJECTED');
  const normalized = prepareOfflineIssue({ issue, evidence, nowMs, maxAgeMs, dryRun });
  if (normalized.status !== 'READY') return normalized;
  activeIssues.add(key);
  try {
    return await executeIssue({ issue: normalized.issue, evidence: normalized, codingAgent, testRunner });
  } finally { activeIssues.delete(key); }
}

export const runOfflineIssue = orchestrateIssue;
