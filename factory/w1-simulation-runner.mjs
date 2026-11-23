import { writeSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { types } from 'node:util';
import { issueProfileDigest, runIssueLoop } from './issue-loop.mjs';

const mode = 'SIMULATION';
const realExecution = false;
const repository = 'simulation-only/w1-fixture';
const baseline = '0'.repeat(40);
const candidate = '1'.repeat(40);
const evidenceSources = { linear: 'fixture:linear', github: 'fixture:github' };
const coder = 'fixture:coder';
const reviewer = 'fixture:reviewer';
const pendingCiReason = 'required GitHub checks are still pending after three reads';
const scenarios = [
  { name: 'verified-candidate', issueKey: 'W1SIM-1', expected: 'READY' },
  { name: 'pending-ci', issueKey: 'W1SIM-2', expected: 'BLOCKED' },
  { name: 'review-scope-boundary', issueKey: 'W1SIM-3', expected: 'GATE_A' },
];

function candidateResult({ issueKey, linearIssueId, repository, approvalDigest, memoryScope }, status) {
  return { issueKey, linearIssueId, repository, approvalDigest, memoryScope, revision: candidate, status };
}

function snapshotBaselineCi(baselineCi, approvedBaseline) {
  if (!baselineCi || typeof baselineCi !== 'object' || types.isProxy(baselineCi) || Array.isArray(baselineCi) ||
      Object.getPrototypeOf(baselineCi) !== Object.prototype) {
    return null;
  }
  const snapshot = { sha: baselineCi.sha, conclusion: baselineCi.conclusion, status: baselineCi.status };
  if (snapshot.sha !== approvedBaseline || snapshot.conclusion !== 'success' || snapshot.status !== 'SUCCESS') {
    return null;
  }
  return Object.freeze(snapshot);
}

async function runScenario({ name, issueKey }, configureFixture) {
  const profile = {
    schema_version: 'factory.issue_execution.v1',
    issue_key: issueKey,
    linear_issue_id: `fixture:${issueKey}`,
    project: 'w1-simulation',
    module: 'issue-loop-demo',
    architecture_revision: 'fixture-v1',
    dependencies: [],
    role_profile: coder,
    model: 'fixture-only',
    allowed_environments: ['test'],
    forbidden_operations: ['merge', 'deploy', 'change-production-data', 'read-unapproved-secrets'],
    max_repair_cycles: 3,
    requirements: ['Verify the synthetic candidate'],
    acceptance_tests: ['fixture-acceptance'],
    memory_scope: { short_term: 'issue', long_term: 'project/module', allow_customer_data: false },
    merge_policy: 'disabled',
    release_policy: 'denied',
  };
  // Only these synthetic inputs can be varied by local tests.
  const fixture = {
    profileDigest: issueProfileDigest(profile),
    baselineCi: { sha: baseline, conclusion: 'success', status: 'SUCCESS' },
  };
  configureFixture?.(fixture, name);
  // The approved field exercises admission using synthetic data only.
  const approval = {
    approved: true,
    profileDigest: fixture.profileDigest,
    repository,
    environment: 'test',
    baseline,
    requiredChecks: ['fixture-ci'],
  };
  const baselineCiSnapshot = snapshotBaselineCi(fixture.baselineCi, approval.baseline);
  if (!baselineCiSnapshot) {
    return { reason: 'Invalid synthetic baseline CI evidence' };
  }
  const timestamp = new Date().toISOString();
  const evidence = {
    linear: {
      source: evidenceSources.linear, timestamp, issueKey, id: profile.linear_issue_id,
      dependencies: [], evidence: { architecture: true },
    },
    github: {
      source: evidenceSources.github, timestamp, repository, sha: baseline,
      ci: baselineCiSnapshot,
      protection: { repository, requiredChecksEnforced: true, verified: true },
    },
  };
  const providers = {
    coding: {
      mode, kind: 'agent', principal: coder, profile: profile.role_profile,
      run: (input) => ({ ...candidateResult(input, 'PASS'), baseRevision: baseline }),
    },
    tests: {
      mode, kind: 'deterministic', principal: 'fixture:tests',
      run: (input) => candidateResult(input, 'PASS'),
    },
    ci: {
      mode, kind: 'read-only', principal: 'fixture:ci',
      run: (input) => candidateResult(input, name === 'pending-ci' ? 'PENDING' : 'PASS'),
    },
    review: {
      mode, kind: 'agent', principal: reviewer,
      run: (input) => candidateResult(input, name === 'review-scope-boundary' ? 'GATE_A' : 'PASS'),
    },
  };

  const stateDirectory = await mkdtemp(join(tmpdir(), 'factory-w1-simulation-'));
  try {
    const report = await runIssueLoop({ profile, approval, evidence, providers, stateDirectory, realExecution, pollIntervalMs: 0 });
    return { report };
  } finally {
    await rm(stateDirectory, { recursive: true, force: true });
  }
}

function blocked(reason, scenario) {
  return { mode, realExecution, status: 'BLOCKED', reason, scenario };
}

export async function runSimulation(args, configureFixture) {
  if (args.length !== 1 || args[0] !== '--simulation') {
    return blocked('Usage: node factory/w1-simulation-runner.mjs --simulation');
  }
  const results = [];
  for (const scenario of scenarios) {
    let outcome;
    try {
      outcome = await runScenario(scenario, configureFixture);
    } catch {
      return blocked('Simulation could not complete or clean up temporary state', scenario.name);
    }
    const { report, reason } = outcome;
    if (!report) return blocked(reason, scenario.name);
    const pendingCi = scenario.name === 'pending-ci';
    if (report.status === 'BLOCKED' && (!pendingCi || report.next_action !== pendingCiReason)) {
      return blocked(report.next_action ?? 'Issue Loop blocked the fixture without a reason', scenario.name);
    }
    const checks = Array.isArray(report.checks) ? report.checks : [];
    const lastCheck = checks.at(-1);
    // Each retry requires a bound pending response for the same revision.
    if (report.mode !== mode || report.status !== scenario.expected || !lastCheck ||
        (pendingCi && (report.verification_pending === true || report.revision !== candidate ||
          lastCheck.stage !== 'ci' || lastCheck.status !== 'BLOCKED' || lastCheck.classification !== 'PENDING' ||
          lastCheck.revision !== report.revision || lastCheck.reads !== 3))) {
      return blocked('Fixture did not produce its expected issue-loop result', scenario.name);
    }
    results.push({
      scenario: scenario.name, mode, realExecution, issueKey: report.issue_key, status: report.status,
      candidateSha: report.revision, repairCycles: report.repair_cycles, gate: report.owner_gate,
      checks: checks.map(({ stage, status, classification, reads }) => ({ stage, status, classification, reads })),
    });
  }
  return {
    mode, realExecution, status: 'PASS', approvalSource: 'synthetic-test-fixture',
    repository, baselineSha: baseline, evidenceSources, principals: { coder, reviewer }, results,
  };
}

if (import.meta.main) {
  const result = await runSimulation(process.argv.slice(2));
  if (result.status === 'BLOCKED') process.exitCode = 1;
  writeSync(process.stdout.fd, `${JSON.stringify(result)}\n`);
}
