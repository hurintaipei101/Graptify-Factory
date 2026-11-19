import { evaluateIssue } from './controller.mjs';

const activeIssues = new Set();
const MAX_FAILED_CYCLES = 3;

function identity(issue) {
  return issue?.issueKey ?? issue?.id ?? issue?.identifier ?? null;
}

function metadata(issue) {
  return {
    issueId: identity(issue),
    source: issue?.source ?? issue?.evidenceMetadata?.linear?.source ?? null,
    commitSha: issue?.commitSha ?? issue?.evidenceMetadata?.github?.sha ?? null,
  };
}

function gateA(issue, reasons, status = 'GATE_A') {
  return { ...metadata(issue), status, gate: 'A', executed: false, repairCycles: 0, reasons };
}

function isImmediateError(error) {
  const text = `${error?.code ?? ''} ${error?.kind ?? ''} ${error?.message ?? error ?? ''}`.toLowerCase();
  return ['security', 'permission', 'scope', 'forbidden', 'unauthorized'].some((word) => text.includes(word));
}

function failed(result) {
  if (result === false) return true;
  if (!result || typeof result !== 'object') return false;
  return result.ok === false || result.passed === false || result.success === false || result.status === 'FAIL';
}

function reasonOf(result, fallback) {
  return result?.reason ?? result?.message ?? result?.error ?? fallback;
}

/**
 * Runs a deterministic, dry-run task using only injected functions.
 * `evidence` should be the result of adaptEvidence/normalizeEvidence.
 */
export async function executeIssue({ issue, evidence, codingAgent, testRunner } = {}) {
  const candidate = evidence?.issue ?? issue;
  const key = identity(candidate);
  if (!key) return gateA(candidate, ['missing issue identity'], 'REJECTED');
  if (activeIssues.has(key)) return gateA(candidate, ['duplicate concurrent issue execution'], 'REJECTED');
  if (typeof codingAgent !== 'function' || typeof testRunner !== 'function') {
    return gateA(candidate, ['coding-agent and test-runner functions are required'], 'REJECTED');
  }

  const decision = evidence?.decision ?? evaluateIssue(candidate);
  if (decision.status !== 'READY') return gateA(candidate, decision.reasons, decision.status === 'BLOCKED' ? 'BLOCKED' : 'STOP');
  if (evidence && evidence.issue && evidence.decision?.status !== 'READY') {
    return gateA(candidate, ['evidence is not verified for execution'], 'REJECTED');
  }

  activeIssues.add(key);
  try {
    let failures = 0;
    for (let cycle = 0; cycle <= MAX_FAILED_CYCLES; cycle += 1) {
      let repair;
      try { repair = await codingAgent(structuredClone(candidate), { cycle, dryRun: true }); }
      catch (error) {
        if (isImmediateError(error)) return { ...metadata(candidate), status: 'STOP', gate: 'A', executed: false, repairCycles: failures, reasons: [reasonOf(error, 'security, scope or permission error')] };
        repair = { ok: false, reason: reasonOf(error, 'coding agent failed') };
      }
      if (isImmediateError(repair)) return { ...metadata(candidate), status: 'STOP', gate: 'A', executed: false, repairCycles: failures, reasons: [reasonOf(repair, 'security, scope or permission error')] };
      let test;
      try { test = await testRunner(structuredClone(candidate), repair, { cycle, dryRun: true }); }
      catch (error) {
        if (isImmediateError(error)) return { ...metadata(candidate), status: 'STOP', gate: 'A', executed: false, repairCycles: failures, reasons: [reasonOf(error, 'security, scope or permission error')] };
        test = { ok: false, reason: reasonOf(error, 'test runner failed') };
      }
      if (isImmediateError(test)) return { ...metadata(candidate), status: 'STOP', gate: 'A', executed: false, repairCycles: failures, reasons: [reasonOf(test, 'security, scope or permission error')] };
      if (!failed(repair) && !failed(test)) return { ...metadata(candidate), status: 'EXECUTED', gate: null, executed: true, repairCycles: failures, reasons: ['simulated task and tests passed'] };
      failures += 1;
      if (failures >= MAX_FAILED_CYCLES) return gateA(candidate, ['three failed repair cycles require Gate A'], 'GATE_A');
    }
  } finally { activeIssues.delete(key); }
}

export const MAX_REPAIR_CYCLES = MAX_FAILED_CYCLES;

/** Run the initial attempt or continue from a freshly verified failure. */
export async function executeRepairCycles({ performAttempt, beforeAttempt, recordAttempt, previousFailure }) {
  let findings = previousFailure?.findings ?? [];
  const nextCycle = previousFailure ? previousFailure.cycle + 1 : 0;
  for (let cycle = nextCycle; cycle <= MAX_REPAIR_CYCLES; cycle += 1) {
    const stopped = await beforeAttempt(cycle);
    if (stopped) return stopped;
    const outcome = await performAttempt({ cycle, findings });
    await recordAttempt(cycle, outcome);
    if (outcome.status !== 'FAIL') return outcome;
    findings = outcome.findings;
  }
  return { status: 'GATE_A', reason: 'three repair cycles failed verification' };
}
