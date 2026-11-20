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
const PROVIDER_BINDING_VERSION = 1;
const INVALID_PROVIDER_BINDING = 'INVALID_PROVIDER_BINDING';
const PROVIDER_BINDING_FIELDS = ['issueKey', 'linearIssueId', 'repository', 'approvalDigest', 'memoryScope'];
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

function canResumeVerification(report) {
  const attempt = report.attempts?.at(-1);
  return report.verification_pending === true && ['RUNNING', 'BLOCKED'].includes(report.status) &&
    SHA.test(report.revision ?? '') && attempt?.revision === report.revision && attempt.cycle === report.repair_cycles;
}

async function replay({ directory, fingerprint, report, resume, recheck, decision }) {
  function replayBlock(stored) {
    if (stored.providerBindingVersion !== PROVIDER_BINDING_VERSION) {
      return decision(report, 'BLOCKED', 'stored claim predates required provider approval binding; reconcile the claim',
        'UNVERIFIED_STORED_BINDING');
    }
    if (stored.fingerprint !== fingerprint) {
      return decision(report, 'BLOCKED', 'issue already claimed with different approved inputs');
    }
    return null;
  }
  let stored;
  try {
    stored = await readStoredRun(directory);
  } catch {
    return decision(report, 'BLOCKED', 'run is claimed but persisted state is unavailable; reconcile before taking further action');
  }
  const blocked = replayBlock(stored);
  if (blocked) return blocked;
  if (stored.report.status === 'RUNNING' && !canResumeVerification(stored.report)) {
    return decision(stored.report, 'BLOCKED', ACTIVE_CLAIM);
  }
  if (!canResumeVerification(stored.report) && (!recheck || !canRefreshGitHubEvidence(stored.report))) return stored.report;

  const lock = join(directory, 'github-refresh');
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    return decision(stored.report, 'BLOCKED', stored.report.status === 'RUNNING' ? ACTIVE_CLAIM
      : 'GitHub evidence refresh is active or interrupted');
  }
  try {
    // A worker may have refreshed between our first read and acquiring the claim.
    stored = await readStoredRun(directory);
    const blocked = replayBlock(stored);
    if (blocked) return blocked;
    const save = async (current) => {
      stored.report = current;
      await persist(directory, stored);
    };
    if (canResumeVerification(stored.report)) {
      const resumed = await resume(stored.report, save);
      await save(resumed);
      return resumed;
    }
    if (stored.report.status === 'RUNNING') return decision(stored.report, 'BLOCKED', ACTIVE_CLAIM);
    if (!recheck || !canRefreshGitHubEvidence(stored.report)) return stored.report;
    const now = Date.now();
    if (now - stored.githubRefreshStartedAt < GITHUB_REFRESH_INTERVAL_MS) {
      return stored.report.status === 'BLOCKED' ? stored.report
        : decision(stored.report, 'BLOCKED', 'GitHub evidence refresh is rate limited; retry after the refresh interval');
    }
    stored.githubRefreshStartedAt = now;
    await persist(directory, stored);
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
  if (new Set(findings.map(({ id }) => id)).size !== findings.length) return [];
  return findings.map(({ id, summary }) => ({ id, summary, stage }));
}

function matchesBinding(result, input) {
  return result && typeof result === 'object' && !Array.isArray(result) &&
    PROVIDER_BINDING_FIELDS.every((field) => Object.hasOwn(result, field)) &&
    result.issueKey === input.issueKey && result.linearIssueId === input.linearIssueId &&
    result.repository === input.repository && result.approvalDigest === input.approvalDigest &&
    validMemoryScope(result.memoryScope) &&
    MEMORY_SCOPE_FIELDS.every((field) => result.memoryScope[field] === input.memoryScope[field]) &&
    (result.baseRevision === undefined || result.baseRevision === input.baseRevision);
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

async function verifyCandidate({ providers, approval, approvalBinding, profile, revision, report, cycle, budget, pollIntervalMs, recordCheck,
  stages = STAGES.slice(1), ciReads = 3 }) {
  const input = { ...approvalBinding, revision };
  for (const stage of stages) {
    const args = stage === 'tests' ? { ...input, acceptanceTests: profile.acceptance_tests }
      : stage === 'ci' ? { ...input, requiredChecks: approval.requiredChecks }
      : { ...input, baseline: approval.baseline, requirements: profile.requirements, acceptanceTests: profile.acceptance_tests };
    let result;
    let invalidBinding = false;
    let reads = 0;
    const github = approval.githubPullRequest !== undefined && stage !== 'tests';
    const maxReads = stage === 'ci' ? ciReads : 1;
    try {
      do {
        if (reads > 0) await delay(pollIntervalMs, undefined, { signal: budget.signal });
        reads += 1;
        result = await callProvider(providers[stage].run, args, budget);
        invalidBinding = !matchesBinding(result, args);
      } while (!invalidBinding && result.status === 'PENDING' && result.revision === revision && reads < maxReads);
    } catch (error) {
      const interrupted = budget.signal.aborted || error instanceof ProviderDeadline;
      if (!interrupted) return { status: 'BLOCKED', reason: 'provider invocation failed' };
      if (!github || externallyCancelled(budget)) {
        return { status: 'BLOCKED', reason: interruptionReason(budget), interrupted: true };
      }
      result = { status: 'BLOCKED', revision, reason: 'GitHub evidence read deadline reached' };
    }
    const bound = !invalidBinding && result?.revision === revision;
    const findings = bound && result.status === 'FAIL' ? compactFindings(result.findings, stage, approval.requiredChecks) : [];
    let status = result?.status;
    if (!['PASS', 'FAIL', 'GATE_A'].includes(status) || !bound ||
        (status === 'FAIL' && findings.length === 0)) status = 'BLOCKED';
    const classification = invalidBinding ? 'UNRESOLVED'
      : result?.revision != null && result.revision !== revision ? 'STALE'
      : status === 'PASS' ? 'CLEAN'
      : status === 'FAIL' ? 'FAILED'
      : bound && github && result.classification === 'STALE' ? 'STALE'
      : bound && (result.status === 'PENDING' || (github && result.classification === 'PENDING')) ? 'PENDING'
      : 'UNRESOLVED';
    const check = { cycle, revision, stage, status, classification, reads, findings: findings.map(({ id }) => id) };
    if (invalidBinding) check.reason_code = INVALID_PROVIDER_BINDING;
    if (github && bound && result.evidence) check.evidence = result.evidence;
    if (github && bound && result.reason) check.reason = result.reason;
    const reason = invalidBinding ? `${stage} provider returned an invalid approval binding`
      : check.reason ?? (stage === 'ci' && classification === 'PENDING'
      ? (ciReads === 3 ? 'required GitHub checks are still pending after three reads' : 'required GitHub checks are still pending')
      : `${stage} provider did not supply usable verification for the candidate revision`);
    report.checks.push(check);
    await recordCheck(check, status === 'BLOCKED' ? reason : undefined);
    if (invalidBinding) return { status, reason, reasonCode: INVALID_PROVIDER_BINDING };
    if (externallyCancelled(budget)) return { status: 'BLOCKED', reason: interruptionReason(budget), interrupted: true };
    if (status === 'BLOCKED') return { status, reason };
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
    feedback_binding: null,
    feedback: [],
    reviewer: { profile: null, verdict: 'UNKNOWN' },
    owner_gate: null,
    next_action: null,
  };
  if (!validMemoryScope(profile?.memory_scope)) {
    return decision(report, 'BLOCKED', 'missing or invalid issue profile approval: memory_scope is missing or invalid');
  }
  if (!approvedProfile(profile, approval)) return decision(report, 'BLOCKED', 'missing or invalid issue profile approval');
  if (typeof stateDirectory !== 'string' || !isAbsolute(stateDirectory) ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000 ||
      !Number.isInteger(pollIntervalMs) || pollIntervalMs < 0 || pollIntervalMs > 5_000 ||
      (signal !== undefined && !(signal instanceof AbortSignal))) {
    return decision(report, 'BLOCKED', 'an absolute state directory and bounded timing options are required');
  }
  profile = structuredClone(Object.fromEntries(PROFILE_FIELDS.map((key) => [key, profile[key]])));
  const { profileDigest, repository, environment, baseline, requiredChecks, githubPullRequest } = approval;
  approval = { profileDigest, repository, environment, baseline, requiredChecks: [...requiredChecks], githubPullRequest };
  const approvalBinding = {
    issueKey: profile.issue_key, linearIssueId: profile.linear_issue_id ?? profile.issue_key,
    repository, approvalDigest: profileDigest, memoryScope: profile.memory_scope,
  };
  const githubProviders = githubPullRequest === undefined ? null
    : createGitHubEvidenceProviders({ pullRequest: githubPullRequest, fetchImpl: githubEvidenceFetch });
  if (githubProviders) providers = { ...providers, ...githubProviders };
  report.run_id = hash([approval.repository.toLowerCase(), report.issue_key, report.mode]);
  const inputs = [approval.profileDigest, approval.environment, approval.baseline, approval.requiredChecks];
  if (githubProviders) inputs.push(githubPullRequest, githubProviders.ci.mode);
  const simulateCodex = realExecution === false && codexSimulation !== undefined;
  const workspace = simulateCodex ? codexSimulation?.workspace : undefined;
  if (simulateCodex && (typeof workspace !== 'string' || !isAbsolute(workspace))) {
    return decision(report, 'BLOCKED', 'an absolute workspace is required for Codex simulation');
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
  const fingerprint = hash([...inputs, PROVIDER_BINDING_VERSION]);
  report.feedback_binding = {
    issue_key: report.issue_key, linear_issue_id: approvalBinding.linearIssueId, repository,
    pull_request: githubPullRequest ?? null, approval_digest: profileDigest, run_fingerprint: fingerprint,
    memory_scope: profile.memory_scope,
  };
  const directory = join(stateDirectory, report.run_id);
  const lock = join(directory, 'github-refresh');
  const save = (current) => persist(directory, { fingerprint, providerBindingVersion: PROVIDER_BINDING_VERSION, report: current });
  if (signal?.aborted) return decision(report, 'BLOCKED', 'execution cancelled');
  try {
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    try {
      await mkdir(directory, { mode: 0o700 });
    } catch (error) {
      if (error.code === 'EEXIST') {
        return await replay({
          directory, fingerprint, report, resume: resumeVerification, decision,
          recheck: realExecution === false && githubProviders ? recheckGitHubEvidence : undefined,
        });
      }
      throw error;
    }
    await syncDirectory(stateDirectory);
    await mkdir(lock, { mode: 0o700 });
    try {
      const blocked = executionBlock();
      const result = blocked ? decision(report, blocked.status, blocked.reason)
        : await withBudget((budget) => runAttempts(report, save, budget));
      await save(result);
      return result;
    } finally {
      await rmdir(lock);
    }
  } catch {
    return decision(report, 'BLOCKED', 'durable state could not be written; reconcile before taking further action');
  }

  function record(current, event, details = {}) {
    current.feedback_binding ??= report.feedback_binding;
    current.feedback ??= [];
    current.feedback.push({
      event, recorded_at: new Date().toISOString(), cycle: current.repair_cycles,
      candidate_sha: current.revision,
      ...Object.fromEntries(Object.entries(details).filter(([, value]) => value !== undefined)),
    });
  }

  function decision(current, status, reason, reasonCode) {
    record(current, 'DECISION', { status, reason, reason_code: reasonCode });
    const result = finish(current, status, reason);
    if (reasonCode) result.reason_code = reasonCode;
    return result;
  }

  function checkRecorder(current, save) {
    return async ({ stage, status, classification, reads, findings, evidence, reason_code }, reason) => {
      record(current, 'VERIFICATION', { stage, status, classification, reads, findings, evidence, reason, reason_code });
      await save(current);
    };
  }

  function executionBlock() {
    const admission = prepareOfflineIssue({
      issue: { issueKey: profile.issue_key, environment: approval.environment, autoMergeRequested: false },
      evidence,
    });
    if (admission.status !== 'READY') return {
      status: admission.gate === 'A' ? 'GATE_A' : 'BLOCKED', reason: 'preflight evidence did not satisfy Factory gates',
    };
    const { linearIssue, dependencies, evidenceMetadata } = admission.issue;
    if (evidenceMetadata.github.repository !== approval.repository || evidenceMetadata.github.sha !== approval.baseline ||
        (profile.linear_issue_id != null && linearIssue.id !== profile.linear_issue_id) ||
        dependencies.length !== profile.dependencies.length ||
        !profile.dependencies.every((key) => dependencies.some((dependency) => dependency?.key === key))) {
      return { status: 'BLOCKED', reason: 'preflight evidence does not match the approved repository, baseline or issue dependencies' };
    }
    if (realExecution !== false) {
      const credentialBlock = hasGitHubEvidenceCredential(approval.repository) ? ''
        : '. Missing GitHub Actions job token for the approved repository';
      return {
        status: 'BLOCKED',
        reason: 'live dispatch requires verified write isolation, process containment, credential separation and permissions' + credentialBlock,
      };
    }
    if (simulateCodex && githubProviders?.ci.mode === 'LIVE') {
      return { status: 'BLOCKED', reason: 'Codex process simulation requires simulated GitHub evidence' };
    }
    if (!providers || !validProviders(providers, profile, githubProviders)) {
      return { status: 'BLOCKED', reason: 'required providers or independent reviewer are unavailable' };
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
      beforeAttempt: async (cycle, findings) => {
        if (deadlineReached(budget)) {
          return { status: 'BLOCKED', reason: interruptionReason(budget), interrupted: cycle > 0 };
        }
        if (cycle > 0) {
          const blocked = executionBlock();
          if (blocked) return blocked;
        }
        report.status = 'RUNNING';
        report.owner_gate = null;
        report.next_action = null;
        report.attempts.push({ cycle, revision: null, status: 'RUNNING' });
        report.repair_cycles = cycle;
        delete report.verification_pending;
        report.reviewer = { profile: providers.review.principal, verdict: 'UNKNOWN' };
        record(report, cycle === 0 ? 'DISPATCH_CLAIM' : 'REPAIR_CLAIM', {
          base_sha: report.revision ?? approval.baseline,
          findings: findings.map(({ stage, id }) => ({ stage, id })),
        });
        await save(report);
      },
      performAttempt: async ({ cycle, findings }) => {
        const attempt = report.attempts.at(-1);
        let coded;
        try {
          const input = {
            ...approvalBinding, githubPullRequest, runId: report.run_id, cycle,
            baseRevision: report.revision ?? approval.baseline, model: profile.model,
            requirements: profile.requirements, acceptanceTests: profile.acceptance_tests,
            forbiddenOperations: profile.forbidden_operations, findings,
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
            await save(report);
          }
          coded = await callProvider(providers.coding.run, input, budget);
          if (!matchesBinding(coded, input) || (runCodex && coded.status !== 'GATE_A' && coded.baseRevision !== input.baseRevision)) {
            return {
              status: 'BLOCKED', reason: 'coding candidate does not match the dispatched approval binding or base revision',
              reasonCode: INVALID_PROVIDER_BINDING,
            };
          }
          if (coded?.status === 'GATE_A') return { status: 'GATE_A', reason: 'coding reported a scope, security or permission boundary' };
          if (coded?.status !== 'PASS' || typeof coded.revision !== 'string' ||
              !SHA.test(coded.revision) || revisions.has(coded.revision)) {
            return { status: 'BLOCKED', reason: 'coding provider did not return a new candidate revision' };
          }
        } catch (error) {
          const reason = budget.signal.aborted || error instanceof ProviderDeadline ? interruptionReason(budget) : 'provider invocation failed';
          return { status: 'BLOCKED', reason };
        }
        revisions.add(coded.revision);
        const previous = report.revision;
        report.revision = attempt.revision = coded.revision;
        if (attempt.dispatch) attempt.dispatch.candidate_revision = coded.revision;
        report.verification_pending = true;
        record(report, 'CANDIDATE_HANDOFF', { invalidated_sha: previous });
        await save(report);
        return verifyAttempt(report, save, budget);
      },
      recordAttempt: (_cycle, result) => recordAttempt(report, save, result),
    });
    return finishVerification(report, outcome);
  }

  function finishVerification(current, outcome) {
    if (outcome.interrupted) current.verification_pending = true;
    else delete current.verification_pending;
    const status = outcome.status === 'PASS' ? 'READY' : outcome.status;
    const nextAction = status === 'GATE_A' ? `${outcome.reason}. Owner decision required to revise scope or stop the issue` : outcome.reason;
    return decision(current, status, nextAction, outcome.reasonCode);
  }

  function verifyAttempt(current, save, budget) {
    return verifyCandidate({
      providers, approval, approvalBinding, profile, revision: current.revision, report: current, cycle: current.repair_cycles,
      budget, pollIntervalMs, recordCheck: checkRecorder(current, save),
    });
  }

  async function recordAttempt(current, save, outcome) {
    const attempt = current.attempts.at(-1);
    attempt.status = outcome.status;
    current.reviewer.verdict = current.checks.find((check) =>
      check.cycle === attempt.cycle && check.stage === 'review')?.status ?? 'UNKNOWN';
    record(current, 'ATTEMPT_RESULT', {
      status: outcome.status, reason: outcome.reason, reason_code: outcome.reasonCode,
    });
    await save(current);
  }

  async function resumeVerification(stored, save) {
    const blocked = executionBlock();
    if (blocked) return finishVerification(stored, blocked);
    const cycle = stored.repair_cycles;
    const current = {
      ...stored, status: 'RUNNING', next_action: null, reviewer: { profile: providers.review.principal, verdict: 'UNKNOWN' },
      checks: stored.checks.filter((check) => check.cycle !== cycle),
    };
    record(current, 'VERIFICATION_RESUMED');
    await save(current);
    return withBudget(async (budget) => {
      const outcome = await verifyAttempt(current, save, budget);
      await recordAttempt(current, save, outcome);
      return outcome.status === 'FAIL'
        ? runAttempts(current, save, budget, { cycle, findings: outcome.findings })
        : finishVerification(current, outcome);
    });
  }

  async function recheckGitHubEvidence(stored, save) {
    const cycle = stored.repair_cycles;
    const current = {
      ...structuredClone(stored),
      checks: stored.checks.filter((check) => check.cycle !== cycle || check.stage === 'tests'),
    };
    return withBudget(async (budget) => {
      const saveAudit = () => save({ ...stored, feedback: current.feedback, feedback_binding: current.feedback_binding });
      const outcome = await verifyCandidate({
        providers, approval, approvalBinding, profile, revision: current.revision, report: current, cycle, budget, pollIntervalMs,
        stages: ['ci', 'review'], ciReads: 1, recordCheck: checkRecorder(current, saveAudit),
      });
      if (externallyCancelled(budget) && !outcome.reasonCode) {
        record(current, 'DECISION', { status: 'BLOCKED', reason: 'execution cancelled during GitHub evidence refresh' });
        await saveAudit();
        return null;
      }
      current.reviewer = {
        profile: providers.review.principal,
        verdict: current.checks.find((check) => check.cycle === cycle && check.stage === 'review')?.status ?? 'UNKNOWN',
      };
      if (outcome.status !== 'FAIL') return finishVerification(current, outcome);
      return runAttempts(current, save, budget, { cycle, findings: outcome.findings });
    });
  }
}
