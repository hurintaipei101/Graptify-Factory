import { createHash } from 'node:crypto';
import { addAbortListener } from 'node:events';
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { executeRepairCycles, MAX_REPAIR_CYCLES } from './executor.mjs';
import { prepareOfflineIssue } from './orchestrator.mjs';

const SHA = /^[0-9a-f]{40}$/;
const ISSUE_KEY = /^[A-Z][A-Z0-9]{0,30}-\d{1,10}$/;
const REPOSITORY = /^[\w.-]{1,100}\/[\w.-]{1,100}$/;
const ENVIRONMENTS = new Set(['isolated-worker', 'test', 'staging']);
const STAGES = ['coding', 'tests', 'ci', 'review'];
const KINDS = { coding: 'agent', tests: 'deterministic', ci: 'read-only', review: 'agent' };
const PROFILE_FIELDS = [
  'schema_version', 'issue_key', 'linear_issue_id', 'project', 'module',
  'architecture_revision', 'dependencies', 'role_profile', 'model',
  'allowed_environments', 'forbidden_operations', 'max_repair_cycles',
  'requirements', 'acceptance_tests', 'memory_scope', 'merge_policy', 'release_policy',
];
const MEMORY_SCOPE_FIELDS = ['short_term', 'long_term', 'allow_customer_data'];
const hash = (values) => createHash('sha256').update(JSON.stringify(values)).digest('hex');
const shortText = (value, max = 128) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const shortList = (value, min = 0, maxLength = 128) => Array.isArray(value) &&
  value.length >= min && value.length <= 24 && new Set(value).size === value.length &&
  [...value].every((item) => shortText(item, maxLength));

/** Bind operator approval to every profile field consumed by the loop. */
export function issueProfileDigest(profile) {
  return hash(PROFILE_FIELDS.map((key) => key === 'memory_scope'
    ? MEMORY_SCOPE_FIELDS.map((field) => profile?.memory_scope?.[field] ?? null)
    : profile?.[key] ?? null));
}

function validMemoryScope(scope) {
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) return false;
  const fields = Object.keys(scope);
  return fields.length === MEMORY_SCOPE_FIELDS.length &&
    MEMORY_SCOPE_FIELDS.every((field) => fields.includes(field)) &&
    shortText(scope.short_term) && shortText(scope.long_term) &&
    typeof scope.allow_customer_data === 'boolean';
}

function approvedProfile(profile, approval) {
  return profile?.schema_version === 'factory.issue_execution.v1' &&
    typeof profile.issue_key === 'string' && ISSUE_KEY.test(profile.issue_key) &&
    ['project', 'module', 'role_profile', 'model', 'architecture_revision'].every((key) => shortText(profile[key])) &&
    profile.architecture_revision !== 'pending-approval' &&
    (profile.linear_issue_id == null || shortText(profile.linear_issue_id)) &&
    shortList(profile.dependencies) && profile.dependencies.every((key) => ISSUE_KEY.test(key) && key !== profile.issue_key) &&
    shortList(profile.allowed_environments, 1) && profile.allowed_environments.every((name) => ENVIRONMENTS.has(name)) &&
    shortList(profile.forbidden_operations) && shortList(profile.requirements, 1, 512) &&
    shortList(profile.acceptance_tests, 1) && profile.max_repair_cycles === MAX_REPAIR_CYCLES &&
    validMemoryScope(profile.memory_scope) &&
    shortText(profile.merge_policy) && shortText(profile.release_policy) &&
    approval?.approved === true && approval.profileDigest === issueProfileDigest(profile) &&
    typeof approval.repository === 'string' && REPOSITORY.test(approval.repository) &&
    profile.allowed_environments.includes(approval.environment) &&
    typeof approval.baseline === 'string' && SHA.test(approval.baseline) &&
    shortList(approval.requiredChecks, 1);
}

function finish(report, status, nextAction) {
  return { ...report, status, owner_gate: status === 'GATE_A' ? 'A' : null, next_action: nextAction };
}

async function persist(directory, state) {
  const file = await open(join(directory, 'next.json'), 'w', 0o600);
  try {
    await file.writeFile(JSON.stringify(state) + '\n');
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(join(directory, 'next.json'), join(directory, 'state.json'));
  await syncDirectory(directory);
}

async function syncDirectory(directory) {
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function replay(directory, fingerprint, report) {
  try {
    const stored = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'));
    if (stored.fingerprint !== fingerprint) return finish(report, 'BLOCKED', 'issue already claimed with different approved inputs');
    if (stored.report.status !== 'RUNNING') return stored.report;
    return finish(stored.report, 'BLOCKED', 'run is active or interrupted; reconcile persisted state before taking further action');
  } catch {
    return finish(report, 'BLOCKED', 'run is claimed but persisted state is unavailable; reconcile before taking further action');
  }
}

function validProviders(providers, profile) {
  return STAGES.every((stage) => providers[stage]?.mode === 'SIMULATION' &&
    providers[stage]?.kind === KINDS[stage] && shortText(providers[stage]?.principal) &&
    typeof providers[stage]?.run === 'function') &&
    providers.coding.profile === profile.role_profile &&
    providers.coding.principal !== providers.review.principal &&
    providers.coding.run !== providers.review.run;
}

function compactFindings(findings, stage, allowedChecks) {
  if (!Array.isArray(findings) || findings.length === 0 || findings.length > 8) return [];
  if (![...findings].every((item) => shortText(item?.id) && !/[\p{Cc}]/u.test(item.id) &&
      shortText(item.summary, 384) && (stage !== 'ci' || allowedChecks.includes(item.id)))) return [];
  return findings.map(({ id, summary }) => ({ id, summary, stage }));
}

class ProviderDeadline extends Error {}

async function callProvider(run, input, { signal, expiresAt }) {
  if (signal.aborted || performance.now() >= expiresAt) throw new ProviderDeadline();
  let subscription;
  const deadline = new Promise((_, reject) => {
    subscription = addAbortListener(signal, () => reject(new ProviderDeadline()));
  });
  try {
    const outcome = await Promise.race([run(structuredClone(input), { signal }), deadline]);
    if (signal.aborted || performance.now() >= expiresAt) throw new ProviderDeadline();
    return outcome;
  } finally {
    subscription[Symbol.dispose]();
  }
}

async function verifyCandidate({ providers, approval, profile, revision, report, cycle, budget, pollIntervalMs }) {
  const input = { issueKey: profile.issue_key, repository: approval.repository, revision };
  for (const stage of STAGES.slice(1)) {
    const args = stage === 'tests' ? { ...input, acceptanceTests: profile.acceptance_tests }
      : stage === 'ci' ? { ...input, requiredChecks: approval.requiredChecks }
      : { ...input, baseline: approval.baseline, requirements: profile.requirements, acceptanceTests: profile.acceptance_tests };
    let result;
    let reads = 0;
    const maxReads = stage === 'ci' ? 3 : 1;
    do {
      if (reads > 0) await delay(pollIntervalMs, undefined, { signal: budget.signal });
      result = await callProvider(providers[stage].run, args, budget);
      reads += 1;
    } while (result?.status === 'PENDING' && result.revision === revision && reads < maxReads);
    const findings = result?.status === 'FAIL' ? compactFindings(result.findings, stage, approval.requiredChecks) : [];
    let status = result?.status;
    if (!['PASS', 'FAIL', 'GATE_A'].includes(status) || result.revision !== revision ||
        (status === 'FAIL' && findings.length === 0)) status = 'BLOCKED';
    report.checks.push({ cycle, revision, stage, status, reads, findings: findings.map(({ id }) => id) });
    if (status === 'BLOCKED') {
      const reason = stage === 'ci' && result?.status === 'PENDING' && result.revision === revision
        ? 'required GitHub checks are still pending after three reads'
        : `${stage} provider did not supply usable verification for the candidate revision`;
      return { status, reason };
    }
    if (status === 'GATE_A') return { status, reason: `${stage} reported a scope, security or permission boundary` };
    if (status === 'FAIL') return { status, findings };
  }
  return { status: 'PASS', reason: 'simulated tests, CI and independent review passed on the same revision' };
}

/** Run one approved issue with durable deduplication. Only injected simulations can dispatch. */
export async function runIssueLoop({
  profile, approval, evidence, providers = {}, stateDirectory, realExecution = false,
  timeoutMs = 120_000, pollIntervalMs = 1_000,
} = {}) {
  const report = {
    schema_version: 'factory.issue_run_report.v1',
    run_id: null,
    issue_key: typeof profile?.issue_key === 'string' && ISSUE_KEY.test(profile.issue_key) ? profile.issue_key : null,
    mode: realExecution === false ? 'SIMULATION' : 'LIVE',
    status: 'RUNNING',
    revision: null,
    repair_cycles: 0,
    attempts: [],
    checks: [],
    reviewer: { profile: null, verdict: 'UNKNOWN' },
    owner_gate: null,
    next_action: null,
  };
  if (!approvedProfile(profile, approval)) return finish(report, 'BLOCKED', 'missing or invalid issue profile approval');
  if (typeof stateDirectory !== 'string' || !isAbsolute(stateDirectory) ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000 ||
      !Number.isInteger(pollIntervalMs) || pollIntervalMs < 0 || pollIntervalMs > 5_000) {
    return finish(report, 'BLOCKED', 'an absolute state directory and bounded timing options are required');
  }

  profile = structuredClone(Object.fromEntries(PROFILE_FIELDS.map((key) => [key, profile[key]])));
  const { profileDigest, repository, environment, baseline, requiredChecks } = approval;
  approval = { profileDigest, repository, environment, baseline, requiredChecks: [...requiredChecks] };
  report.run_id = hash([approval.repository.toLowerCase(), report.issue_key, report.mode]);
  const fingerprint = hash([approval.profileDigest, approval.environment, approval.baseline, approval.requiredChecks]);
  const directory = join(stateDirectory, report.run_id);
  const save = (current) => persist(directory, { fingerprint, report: current });
  let timeout;
  try {
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    try {
      await mkdir(directory, { mode: 0o700 });
    } catch (error) {
      if (error.code === 'EEXIST') return replay(directory, fingerprint, report);
      throw error;
    }
    await syncDirectory(stateDirectory);

    async function run() {
      if (realExecution !== false) {
        return finish(report, 'BLOCKED', 'live dispatch is disabled pending verified write isolation, CI access and independent review');
      }
      const admission = prepareOfflineIssue({
        issue: { issueKey: report.issue_key, environment: approval.environment, autoMergeRequested: false },
        evidence,
      });
      if (admission.status !== 'READY') return finish(report, admission.gate === 'A' ? 'GATE_A' : 'BLOCKED', 'preflight evidence did not satisfy Factory gates');
      const { linearIssue, dependencies, evidenceMetadata } = admission.issue;
      if (evidenceMetadata.github.repository !== approval.repository || evidenceMetadata.github.sha !== approval.baseline ||
          (profile.linear_issue_id != null && linearIssue.id !== profile.linear_issue_id) ||
          dependencies.length !== profile.dependencies.length ||
          !profile.dependencies.every((key) => dependencies.some((dependency) => dependency?.key === key))) {
        return finish(report, 'BLOCKED', 'preflight evidence does not match the approved repository, baseline or issue dependencies');
      }
      if (!providers || !validProviders(providers, profile)) return finish(report, 'BLOCKED', 'required simulation providers or independent reviewer are unavailable');
      const abort = new AbortController();
      const budget = { signal: abort.signal, expiresAt: performance.now() + timeoutMs };
      timeout = setTimeout(() => abort.abort(), timeoutMs);
      const revisions = new Set([approval.baseline]);
      const outcome = await executeRepairCycles({
        beforeAttempt: async (cycle) => {
          report.attempts.push({ cycle, revision: null, status: 'RUNNING' });
          report.repair_cycles = cycle;
          report.reviewer = { profile: providers.review.principal, verdict: 'UNKNOWN' };
          await save(report);
        },
        performAttempt: async ({ cycle, findings }) => {
          const attempt = report.attempts.at(-1);
          try {
            const coded = await callProvider(providers.coding.run, {
              issueKey: report.issue_key, repository: approval.repository, runId: report.run_id, cycle,
              baseRevision: report.revision ?? approval.baseline, model: profile.model,
              requirements: profile.requirements, acceptanceTests: profile.acceptance_tests,
              forbiddenOperations: profile.forbidden_operations, memoryScope: profile.memory_scope, findings,
            }, budget);
            if (coded?.status === 'GATE_A') return { status: 'GATE_A', reason: 'coding reported a scope, security or permission boundary' };
            if (coded?.status !== 'PASS' || typeof coded.revision !== 'string' ||
                !SHA.test(coded.revision) || revisions.has(coded.revision)) {
              return { status: 'BLOCKED', reason: 'coding provider did not return a new candidate revision' };
            }
            revisions.add(coded.revision);
            report.revision = attempt.revision = coded.revision;
            return await verifyCandidate({ providers, approval, profile, revision: coded.revision, report, cycle, budget, pollIntervalMs });
          } catch (error) {
            const reason = budget.signal.aborted || error instanceof ProviderDeadline ? 'provider deadline reached' : 'provider invocation failed';
            return { status: 'BLOCKED', reason };
          }
        },
        recordAttempt: async (cycle, result) => {
          const attempt = report.attempts.at(-1);
          attempt.status = result.status;
          report.reviewer.verdict = report.checks.find((check) => check.cycle === cycle && check.stage === 'review')?.status ?? 'UNKNOWN';
          await save(report);
        },
      });
      const status = outcome.status === 'PASS' ? 'READY' : outcome.status;
      const nextAction = status === 'GATE_A' ? `${outcome.reason}. Owner decision required to revise scope or stop the issue` : outcome.reason;
      return finish(report, status, nextAction);
    }

    const result = await run();
    await save(result);
    return result;
  } catch {
    return finish(report, 'BLOCKED', 'durable state could not be written; reconcile before taking further action');
  } finally {
    clearTimeout(timeout);
  }
}
