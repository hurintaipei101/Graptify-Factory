import { createHash } from 'node:crypto';
import { addAbortListener } from 'node:events';
import { mkdir, open, readFile, rename, rmdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createCodexCliAdapter } from './codex-cli-adapter.mjs';
import { executeRepairCycles, MAX_REPAIR_CYCLES } from './executor.mjs';
import { createGitHubEvidenceProviders, hasGitHubEvidenceCredential } from './github-evidence.mjs';
import { prepareOfflineIssue } from './orchestrator.mjs';

const SHA = /^[0-9a-f]{40}$/;
const ISSUE_KEY = /^[A-Z][A-Z0-9]{0,30}-\d{1,10}$/;
const REPOSITORY = /^[\w.-]{1,100}\/[\w.-]{1,100}$/;
const ENVIRONMENTS = new Set(['isolated-worker', 'test', 'staging']);
const STAGES = ['coding', 'tests', 'ci', 'review'];
const KINDS = { coding: 'agent', tests: 'deterministic', ci: 'read-only', review: 'agent' };
const GITHUB_REFRESH_INTERVAL_MS = 5_000;
const ACTIVE_CLAIM = 'run is active or interrupted; reconcile persisted state before taking further action';
// Match the reasons already persisted in issue reports, including reports from before refresh was supported.
const RECOVERABLE_GITHUB_BLOCKS = new Set([
  'required GitHub checks are still pending after three reads',
  'required GitHub checks are still pending',
  'required GitHub check runs are missing',
  'required GitHub check has a stale or invalid completion time',
  'Codex review is pending',
  'no trusted Codex review is bound to the candidate SHA',
  'Codex review completion is stale or invalid',
  'Codex review has no verifiable approval for the candidate SHA',
  'GitHub API response was unavailable or invalid',
  'GitHub evidence read deadline reached',
]);
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
    shortText(profile.merge_policy) && shortText(profile.release_policy) &&
    approval?.approved === true && approval.profileDigest === issueProfileDigest(profile) &&
    typeof approval.repository === 'string' && REPOSITORY.test(approval.repository) &&
    approval.repository.split('/').every((part) => part !== '.' && part !== '..') &&
    profile.allowed_environments.includes(approval.environment) &&
    typeof approval.baseline === 'string' && SHA.test(approval.baseline) &&
    shortList(approval.requiredChecks, 1) &&
    (approval.githubPullRequest === undefined || (Number.isInteger(approval.githubPullRequest) &&
      approval.githubPullRequest > 0 && approval.githubPullRequest <= 2_147_483_647));
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

async function readStoredRun(directory) {
  const stored = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'));
  if (!stored?.report?.status) throw new Error('Missing stored report');
  return stored;
}

function canRefreshGitHubEvidence(report) {
  const cycle = report.repair_cycles;
  const revision = report.revision;
  const lastAttempt = report.attempts?.at(-1);
  const checks = report.checks?.filter((check) => check.cycle === cycle && check.revision === revision);
  if (!Number.isInteger(cycle) || cycle < 0 || cycle > MAX_REPAIR_CYCLES ||
      typeof revision !== 'string' || !SHA.test(revision) || lastAttempt?.revision !== revision ||
      lastAttempt.cycle !== cycle || !checks?.some((check) => check.stage === 'tests' && check.status === 'PASS')) {
    return false;
  }
  if (report.status === 'READY') return true;
  const lastCheck = checks.at(-1);
  if (report.status !== 'BLOCKED' || !['ci', 'review'].includes(lastCheck?.stage)) return false;
  // Recheck reports written by the earlier replay path that stopped on a verified failure.
  if (lastCheck.status === 'FAIL') return report.next_action === 'stored candidate no longer passes GitHub verification';
  return lastCheck.status === 'BLOCKED' && (RECOVERABLE_GITHUB_BLOCKS.has(report.next_action) ||
    /^GitHub API request failed \(HTTP (429|5\d\d)\)$/.test(report.next_action));
}

async function replay(directory, fingerprint, report, recheck) {
  let stored;
  try {
    stored = await readStoredRun(directory);
  } catch {
    return finish(report, 'BLOCKED', 'run is claimed but persisted state is unavailable; reconcile before taking further action');
  }
  if (stored.fingerprint !== fingerprint) return finish(report, 'BLOCKED', 'issue already claimed with different approved inputs');
  if (stored.report.status === 'RUNNING') {
    return finish(stored.report, 'BLOCKED', ACTIVE_CLAIM);
  }
  if (!recheck || !canRefreshGitHubEvidence(stored.report)) return stored.report;

  const lock = join(directory, 'github-refresh');
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    return finish(stored.report, 'BLOCKED', 'GitHub evidence refresh is active or interrupted');
  }
  try {
    // A worker may have refreshed between our first read and acquiring the claim.
    stored = await readStoredRun(directory);
    if (stored.fingerprint !== fingerprint) return finish(report, 'BLOCKED', 'issue already claimed with different approved inputs');
    if (stored.report.status === 'RUNNING') return finish(stored.report, 'BLOCKED', ACTIVE_CLAIM);
    if (!canRefreshGitHubEvidence(stored.report)) return stored.report;
    const now = Date.now();
    if (now - stored.githubRefreshStartedAt < GITHUB_REFRESH_INTERVAL_MS) {
      return stored.report.status === 'BLOCKED' ? stored.report
        : finish(stored.report, 'BLOCKED', 'GitHub evidence refresh is rate limited; retry after the refresh interval');
    }
    stored.githubRefreshStartedAt = now;
    await persist(directory, stored);
    const save = async (current) => {
      stored.report = current;
      await persist(directory, stored);
    };
    const refreshed = await recheck(stored.report, save);
    if (refreshed === null) {
      // Retain the prior verification and the refresh cooldown for the next replay.
      return finish(stored.report, 'BLOCKED', 'execution cancelled during GitHub evidence refresh');
    }
    await save(refreshed);
    return stored.report;
  } finally {
    await rmdir(lock);
  }
}

function validProviders(providers, profile, githubProviders) {
  return STAGES.every((stage) => providers[stage]?.mode === (githubProviders?.[stage]?.mode ?? 'SIMULATION') &&
    providers[stage]?.kind === (githubProviders?.[stage]?.kind ?? KINDS[stage]) && shortText(providers[stage]?.principal) &&
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

function externallyCancelled(budget) {
  return budget.signal.aborted && !(budget.signal.reason instanceof ProviderDeadline);
}

function interruptionReason(budget) {
  return externallyCancelled(budget) ? 'execution cancelled' : 'provider deadline reached';
}

function deadlineReached({ signal, expiresAt }) {
  return signal.aborted || performance.now() >= expiresAt;
}

async function callProvider(run, input, budget) {
  const { signal } = budget;
  if (deadlineReached(budget)) throw new ProviderDeadline();
  let subscription;
  const deadline = new Promise((_, reject) => {
    subscription = addAbortListener(signal, () => reject(new ProviderDeadline()));
  });
  try {
    const outcome = await Promise.race([run(structuredClone(input), { signal }), deadline]);
    if (deadlineReached(budget)) throw new ProviderDeadline();
    return outcome;
  } finally {
    subscription[Symbol.dispose]();
  }
}

async function verifyCandidate({ providers, approval, profile, revision, report, cycle, budget, pollIntervalMs,
  stages = STAGES.slice(1), ciReads = 3 }) {
  const input = { issueKey: profile.issue_key, repository: approval.repository, revision };
  for (const stage of stages) {
    const args = stage === 'tests' ? { ...input, acceptanceTests: profile.acceptance_tests }
      : stage === 'ci' ? { ...input, requiredChecks: approval.requiredChecks }
      : { ...input, baseline: approval.baseline, requirements: profile.requirements, acceptanceTests: profile.acceptance_tests };
    let result;
    let reads = 0;
    const github = approval.githubPullRequest !== undefined && stage !== 'tests';
    const maxReads = stage === 'ci' ? ciReads : 1;
    try {
      do {
        if (reads > 0) await delay(pollIntervalMs, undefined, { signal: budget.signal });
        reads += 1;
        result = await callProvider(providers[stage].run, args, budget);
      } while (result?.status === 'PENDING' && result.revision === revision && reads < maxReads);
    } catch (error) {
      if (!github || externallyCancelled(budget) || !(budget.signal.aborted || error instanceof ProviderDeadline)) throw error;
      result = { status: 'BLOCKED', revision, reason: 'GitHub evidence read deadline reached' };
    }
    const findings = result?.status === 'FAIL' ? compactFindings(result.findings, stage, approval.requiredChecks) : [];
    let status = result?.status;
    if (!['PASS', 'FAIL', 'GATE_A'].includes(status) || result.revision !== revision ||
        (status === 'FAIL' && findings.length === 0)) status = 'BLOCKED';
    const check = { cycle, revision, stage, status, reads, findings: findings.map(({ id }) => id) };
    if (github && result?.evidence) check.evidence = result.evidence;
    if (github && result?.reason) check.reason = result.reason;
    report.checks.push(check);
    if (status === 'BLOCKED') {
      const reason = check.reason ?? (stage === 'ci' && result?.status === 'PENDING' && result.revision === revision
        ? (ciReads === 3 ? 'required GitHub checks are still pending after three reads' : 'required GitHub checks are still pending')
        : `${stage} provider did not supply usable verification for the candidate revision`);
      return { status, reason };
    }
    if (status === 'GATE_A') return { status, reason: `${stage} reported a scope, security or permission boundary` };
    if (status === 'FAIL') return { status, findings };
  }
  return { status: 'PASS', reason: providers.ci.mode === 'LIVE'
    ? 'simulated tests and live GitHub CI and Codex review passed on the same revision'
    : 'simulated tests, CI and independent review passed on the same revision' };
}

/** Run one approved issue with durable deduplication. Only injected simulations can dispatch. */
export async function runIssueLoop({
  profile, approval, evidence, providers = {}, stateDirectory, realExecution = false,
  timeoutMs = 120_000, pollIntervalMs = 1_000, githubEvidenceFetch, signal, codexSimulation,
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
  if (!validMemoryScope(profile?.memory_scope)) {
    return finish(report, 'BLOCKED', 'missing or invalid issue profile approval: memory_scope is missing or invalid');
  }
  if (!approvedProfile(profile, approval)) return finish(report, 'BLOCKED', 'missing or invalid issue profile approval');
  if (typeof stateDirectory !== 'string' || !isAbsolute(stateDirectory) ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000 ||
      !Number.isInteger(pollIntervalMs) || pollIntervalMs < 0 || pollIntervalMs > 5_000 ||
      (signal !== undefined && !(signal instanceof AbortSignal))) {
    return finish(report, 'BLOCKED', 'an absolute state directory and bounded timing options are required');
  }
  if (signal?.aborted) return finish(report, 'BLOCKED', 'execution cancelled');

  profile = structuredClone(Object.fromEntries(PROFILE_FIELDS.map((key) => [key, profile[key]])));
  const { profileDigest, repository, environment, baseline, requiredChecks, githubPullRequest } = approval;
  approval = { profileDigest, repository, environment, baseline, requiredChecks: [...requiredChecks], githubPullRequest };
  const githubProviders = githubPullRequest === undefined ? null
    : createGitHubEvidenceProviders({ pullRequest: githubPullRequest, fetchImpl: githubEvidenceFetch });
  if (githubProviders) providers = { ...providers, ...githubProviders };
  report.run_id = hash([approval.repository.toLowerCase(), report.issue_key, report.mode]);
  const inputs = [approval.profileDigest, approval.environment, approval.baseline, approval.requiredChecks];
  if (githubProviders) inputs.push(githubPullRequest, githubProviders.ci.mode);
  const simulateCodex = realExecution === false && codexSimulation !== undefined;
  const workspace = simulateCodex ? codexSimulation?.workspace : undefined;
  if (simulateCodex && (typeof workspace !== 'string' || !isAbsolute(workspace))) {
    return finish(report, 'BLOCKED', 'an absolute workspace is required for Codex simulation');
  }
  let runCodex;
  if (simulateCodex) {
    const { spawnFixture, allowedWorkspaces, runtimeIsolation, mcpAccess } = codexSimulation;
    runCodex = createCodexCliAdapter({
      simulation: true, spawnFixture, allowedWorkspaces: Array.isArray(allowedWorkspaces) ? [...allowedWorkspaces] : [],
      runtimeIsolation: { verified: runtimeIsolation?.verified },
      mcpAccess: { verified: mcpAccess?.verified, allowed: mcpAccess?.allowed },
      timeoutMs,
    });
    inputs.push('codex-cli-simulation', workspace);
  }
  const fingerprint = hash(inputs);
  const directory = join(stateDirectory, report.run_id);
  const save = (current) => persist(directory, { fingerprint, report: current });
  try {
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    try {
      await mkdir(directory, { mode: 0o700 });
    } catch (error) {
      if (error.code === 'EEXIST') {
        return await replay(directory, fingerprint, report, realExecution === false && githubProviders
          ? recheckGitHubEvidence : undefined);
      }
      throw error;
    }
    await syncDirectory(stateDirectory);

    const blocked = executionBlock(report);
    const result = blocked ?? await withBudget((budget) => runAttempts(report, save, budget));
    await save(result);
    return result;
  } catch {
    return finish(report, 'BLOCKED', 'durable state could not be written; reconcile before taking further action');
  }

  function executionBlock(current) {
    const admission = prepareOfflineIssue({
      issue: { issueKey: current.issue_key, environment: approval.environment, autoMergeRequested: false },
      evidence,
    });
    if (admission.status !== 'READY') return finish(current, admission.gate === 'A' ? 'GATE_A' : 'BLOCKED', 'preflight evidence did not satisfy Factory gates');
    const { linearIssue, dependencies, evidenceMetadata } = admission.issue;
    if (evidenceMetadata.github.repository !== approval.repository || evidenceMetadata.github.sha !== approval.baseline ||
        (profile.linear_issue_id != null && linearIssue.id !== profile.linear_issue_id) ||
        dependencies.length !== profile.dependencies.length ||
        !profile.dependencies.every((key) => dependencies.some((dependency) => dependency?.key === key))) {
      return finish(current, 'BLOCKED', 'preflight evidence does not match the approved repository, baseline or issue dependencies');
    }
    if (realExecution !== false) {
      const credentialBlock = hasGitHubEvidenceCredential(approval.repository) ? ''
        : '. Missing GitHub Actions job token for the approved repository';
      return finish(current, 'BLOCKED', 'live dispatch requires verified write isolation, process containment, credential separation and permissions' + credentialBlock);
    }
    if (simulateCodex && githubProviders?.ci.mode === 'LIVE') {
      return finish(current, 'BLOCKED', 'Codex process simulation requires simulated GitHub evidence');
    }
    if (!providers || !validProviders(providers, profile, githubProviders)) {
      return finish(current, 'BLOCKED', 'required providers or independent reviewer are unavailable');
    }
    return null;
  }

  async function withBudget(run) {
    const abort = new AbortController();
    const budget = { signal: signal ? AbortSignal.any([signal, abort.signal]) : abort.signal, expiresAt: performance.now() + timeoutMs };
    const timeout = setTimeout(() => abort.abort(new ProviderDeadline()), timeoutMs);
    try {
      return await run(budget);
    } finally {
      clearTimeout(timeout);
    }
  }

  async function runAttempts(report, save, budget, previousFailure) {
    const revisions = new Set([approval.baseline, ...report.attempts.map(({ revision }) => revision)]);
    const outcome = await executeRepairCycles({
      previousFailure,
      beforeAttempt: async (cycle) => {
        if (deadlineReached(budget)) return { status: 'BLOCKED', reason: interruptionReason(budget) };
        report.status = 'RUNNING';
        report.owner_gate = null;
        report.next_action = null;
        report.attempts.push({ cycle, revision: null, status: 'RUNNING' });
        report.repair_cycles = cycle;
        report.reviewer = { profile: providers.review.principal, verdict: 'UNKNOWN' };
        await save(report);
      },
      performAttempt: async ({ cycle, findings }) => {
        const attempt = report.attempts.at(-1);
        try {
          const input = {
            issueKey: report.issue_key, repository: approval.repository, runId: report.run_id, cycle,
            baseRevision: report.revision ?? approval.baseline, model: profile.model,
            requirements: profile.requirements, acceptanceTests: profile.acceptance_tests,
            forbiddenOperations: profile.forbidden_operations, memoryScope: profile.memory_scope, findings,
          };
          if (runCodex) {
            if (deadlineReached(budget)) return { status: 'BLOCKED', reason: interruptionReason(budget) };
            // Await the adapter's termination result even when the shared budget expires.
            const dispatched = await runCodex({ environment: approval.environment }, {
              workspace, signal: budget.signal, prompt: JSON.stringify(input),
            });
            const { eventCount, exitCode, timedOut, cancelled, closeConfirmed } = dispatched.evidence;
            const budgetExpired = cancelled && budget.signal.reason instanceof ProviderDeadline;
            attempt.dispatch = {
              mode: 'SIMULATION', issue_key: input.issueKey, repository: input.repository,
              approval_digest: approval.profileDigest, base_revision: input.baseRevision,
              candidate_revision: null, status: dispatched.status,
              event_count: eventCount, exit_code: Number.isInteger(exitCode) ? exitCode : null, close_confirmed: closeConfirmed,
              timed_out: timedOut || budgetExpired, cancelled: cancelled && !budgetExpired,
            };
            if (dispatched.status !== 'PASS') {
              const reason = budgetExpired
                ? dispatched.reason.replace('execution cancelled', 'execution timed out') : dispatched.reason;
              attempt.dispatch.reason = reason;
              return { status: 'BLOCKED', reason };
            }
          }
          const coded = await callProvider(providers.coding.run, input, budget);
          if (coded?.status === 'GATE_A') return { status: 'GATE_A', reason: 'coding reported a scope, security or permission boundary' };
          if (runCodex && (coded?.issueKey !== input.issueKey || coded.repository !== input.repository ||
              coded.baseRevision !== input.baseRevision)) {
            return { status: 'BLOCKED', reason: 'coding candidate does not match the dispatched issue, repository or base revision' };
          }
          if (coded?.status !== 'PASS' || typeof coded.revision !== 'string' ||
              !SHA.test(coded.revision) || revisions.has(coded.revision)) {
            return { status: 'BLOCKED', reason: 'coding provider did not return a new candidate revision' };
          }
          revisions.add(coded.revision);
          report.revision = attempt.revision = coded.revision;
          if (attempt.dispatch) attempt.dispatch.candidate_revision = coded.revision;
          return await verifyCandidate({ providers, approval, profile, revision: coded.revision, report, cycle, budget, pollIntervalMs });
        } catch (error) {
          const reason = budget.signal.aborted || error instanceof ProviderDeadline ? interruptionReason(budget) : 'provider invocation failed';
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
    return finishVerification(report, outcome);
  }

  function finishVerification(current, outcome) {
    const status = outcome.status === 'PASS' ? 'READY' : outcome.status;
    const nextAction = status === 'GATE_A' ? `${outcome.reason}. Owner decision required to revise scope or stop the issue` : outcome.reason;
    return finish(current, status, nextAction);
  }

  async function recheckGitHubEvidence(stored, save) {
    const cycle = stored.repair_cycles;
    const current = {
      ...stored,
      attempts: [...stored.attempts],
      checks: stored.checks.filter((check) => check.cycle !== cycle || check.stage === 'tests'),
    };
    return withBudget(async (budget) => {
      let outcome;
      try {
        outcome = await verifyCandidate({
          providers, approval, profile, revision: current.revision, report: current, cycle, budget, pollIntervalMs,
          stages: ['ci', 'review'], ciReads: 1,
        });
      } catch {
        if (externallyCancelled(budget)) return null;
        return finish({ ...current, reviewer: { profile: providers.review.principal, verdict: 'UNKNOWN' } },
          'BLOCKED', 'GitHub evidence could not be revalidated');
      }
      if (externallyCancelled(budget)) return null;
      current.reviewer = {
        profile: providers.review.principal,
        verdict: current.checks.find((check) => check.cycle === cycle && check.stage === 'review')?.status ?? 'UNKNOWN',
      };
      if (outcome.status !== 'FAIL') return finishVerification(current, outcome);
      const blocked = cycle < MAX_REPAIR_CYCLES ? executionBlock(current) : null;
      return blocked ?? runAttempts(current, save, budget, { cycle, findings: outcome.findings });
    });
  }
}
