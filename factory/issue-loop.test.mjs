import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { inspectGitHubChecks } from './evidence-adapter.mjs';
import { issueProfileDigest, runIssueLoop } from './issue-loop.mjs';

const repository = 'test/factory';
const baseline = '0'.repeat(40);
const check = 'Node 22 Tests';
const candidate = (cycle) => String(cycle + 1).repeat(40);
const provider = (kind, principal, run) => ({ mode: 'SIMULATION', kind, principal, run });
const pass = ({ revision }) => ({ status: 'PASS', revision });
const failure = (revision, id) => ({ status: 'FAIL', revision, findings: [{ id, summary: 'Fix the failing assertion' }] });

async function fixture(t) {
  const stateDirectory = await mkdtemp(join(tmpdir(), 'factory-loop-'));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  const timestamp = new Date().toISOString();
  const profile = JSON.parse(await readFile(new URL('./contracts/issue_execution_profile.example.json', import.meta.url), 'utf8'));
  profile.architecture_revision = 'approved-v1';
  const approval = {
    approved: true, profileDigest: issueProfileDigest(profile), repository, baseline,
    environment: 'isolated-worker', requiredChecks: [check],
  };
  const evidence = {
    linear: {
      source: 'fixture:linear', timestamp, issueKey: profile.issue_key, evidence: { architecture: true },
      dependencies: profile.dependencies.map((key) => ({ key, status: 'DONE' })),
    },
    github: {
      source: 'fixture:github', timestamp, repository, sha: baseline,
      ci: { sha: baseline, conclusion: 'success' },
      protection: { repository, requiredChecksEnforced: true, verified: true },
    },
  };
  const providers = {
    coding: { ...provider('agent', 'coder', ({ cycle }) => ({ status: 'PASS', revision: candidate(cycle) })), profile: profile.role_profile },
    tests: provider('deterministic', 'node', pass),
    ci: provider('read-only', 'github-fixture', pass),
    review: provider('agent', 'reviewer', (input) => pass(input)),
  };
  return { profile, approval, evidence, providers, stateDirectory, pollIntervalMs: 0 };
}

test('runs targeted test, CI and independent review repairs and replays persisted evidence', async (t) => {
  const options = await fixture(t);
  const prompts = [];
  const coding = options.providers.coding.run;
  options.providers.coding.run = (input) => {
    prompts.push(input);
    return coding(input);
  };
  options.providers.tests.run = ({ revision }) => revision === candidate(0) ? failure(revision, 'T01') : pass({ revision });
  let reads = 0;
  options.providers.ci.run = (input, { signal }) => inspectGitHubChecks({
    ...input, signal,
    execCommand: (args, callback) => {
      assert.deepEqual(args, ['api', `repos/${repository}/commits/${input.revision}/check-runs?filter=latest&per_page=100`, '--method', 'GET']);
      reads += 1;
      const waiting = reads === 1;
      const conclusion = input.revision === candidate(1) ? 'failure' : 'success';
      callback(null, JSON.stringify({ total_count: 1, check_runs: [{
        name: check, head_sha: input.revision, status: waiting ? 'queued' : 'completed',
        conclusion: waiting ? null : conclusion,
      }] }));
    },
  });
  options.providers.review.run = ({ revision }) => revision === candidate(2) ? failure(revision, 'task.mjs:12') : pass({ revision });

  const report = await runIssueLoop(options);
  assert.equal(report.status, 'READY');
  assert.equal(report.mode, 'SIMULATION');
  assert.equal(report.repair_cycles, 3);
  assert.equal(report.revision, candidate(3));
  assert.deepEqual(report.reviewer, { profile: 'reviewer', verdict: 'PASS' });
  assert.deepEqual(report.attempts.map(({ status }) => status), ['FAIL', 'FAIL', 'FAIL', 'PASS']);
  assert.deepEqual(prompts.map(({ baseRevision }) => baseRevision), [baseline, ...[0, 1, 2].map(candidate)]);
  assert.deepEqual(prompts.flatMap(({ findings }) => findings.map(({ stage, id }) => [stage, id])),
    [['tests', 'T01'], ['ci', check], ['review', 'task.mjs:12']]);
  assert.equal(report.checks.find(({ stage }) => stage === 'ci').reads, 2);
  assert.equal(reads, 4);
  assert.deepEqual(await runIssueLoop({ ...options, providers: {}, evidence: {} }), report);
  assert.equal(prompts.length, 4);
  assert.ok(JSON.stringify(report).length < 4096);
  assert.ok(!JSON.stringify(report).includes('Fix the failing assertion'));
});

test('Gate A requires three unsuccessful repairs after the initial attempt', async (t) => {
  const options = await fixture(t);
  options.providers.tests.run = ({ revision }) => failure(revision, 'T01');
  const report = await runIssueLoop(options);
  assert.equal(report.status, 'GATE_A');
  assert.equal(report.owner_gate, 'A');
  assert.equal(report.repair_cycles, 3);
  assert.equal(report.attempts.length, 4);
  assert.equal(report.checks.length, 4);
});

test('an unavailable, mismatched or pending CI provider cannot trigger a repair', async (t) => {
  for (const [status, foreign, expectedReads] of [['BLOCKED', false, 1], ['PASS', true, 1], ['PENDING', false, 3]]) {
    await t.test(`${status} ${foreign ? 'foreign SHA' : 'same SHA'}`, async (t) => {
      const options = await fixture(t);
      let calls = 0;
      options.providers.ci.run = ({ revision }) => {
        calls += 1;
        return { status, revision: foreign ? baseline : revision };
      };
      options.providers.review.run = () => assert.fail('review before CI passes');
      const report = await runIssueLoop(options);
      assert.equal(report.status, 'BLOCKED');
      assert.equal(report.repair_cycles, 0);
      assert.equal(calls, expectedReads);
    });
  }
});

test('a concurrent claim and an interrupted claim never dispatch twice', async (t) => {
  const options = await fixture(t);
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  let calls = 0;
  options.providers.coding.run = async ({ cycle }) => {
    calls += 1;
    started.resolve();
    await release.promise;
    return { status: 'PASS', revision: candidate(cycle) };
  };
  const active = runIssueLoop(options);
  await started.promise;
  const duplicate = await runIssueLoop(options);
  assert.equal(duplicate.status, 'BLOCKED');
  assert.match(duplicate.next_action, /active or interrupted/);
  release.resolve();
  assert.equal((await active).status, 'READY');
  const changed = { ...options, approval: { ...options.approval, baseline: candidate(0) } };
  assert.match((await runIssueLoop(changed)).next_action, /different approved inputs/);
  await unlink(join(options.stateDirectory, duplicate.run_id, 'state.json'));
  assert.equal((await runIssueLoop(options)).status, 'BLOCKED');
  assert.equal(calls, 1);
});

test('admission rejects changed profile, unavailable dependencies, same reviewer and live dispatch', async (t) => {
  for (const scenario of ['profile', 'evidence', 'reviewer', 'live']) {
    await t.test(scenario, async (t) => {
      const options = await fixture(t);
      let calls = 0;
      options.providers.coding.run = () => { calls += 1; };
      if (scenario === 'profile') options.profile.requirements.push('unsigned scope');
      if (scenario === 'evidence') options.evidence.linear.dependencies.pop();
      if (scenario === 'reviewer') options.providers.review.principal = options.providers.coding.principal;
      if (scenario === 'live') options.realExecution = true;

      const report = await runIssueLoop(options);
      assert.equal(report.status, 'BLOCKED');
      assert.equal(calls, 0);
      if (scenario === 'live') assert.match(report.next_action, /verified write isolation/);
    });
  }
});

test('an explicit provider boundary stops at Gate A without a retry', async (t) => {
  const options = await fixture(t);
  options.providers.review.run = ({ revision }) => ({ status: 'GATE_A', revision });
  const report = await runIssueLoop(options);
  assert.equal(report.status, 'GATE_A');
  assert.equal(report.repair_cycles, 0);
  assert.equal(report.attempts.length, 1);
});

test('the provider deadline blocks once and aborts the simulated provider', async (t) => {
  const options = await fixture(t);
  let signal;
  options.timeoutMs = 150;
  options.providers.coding.run = (_input, context) => {
    signal = context.signal;
    return new Promise(() => {});
  };
  const report = await runIssueLoop(options);
  assert.equal(report.status, 'BLOCKED');
  assert.match(report.next_action, /deadline/);
  assert.equal(signal.aborted, true);
  assert.equal(report.attempts.length, 1);
});

test('GitHub check inspection fails closed on read errors, ambiguous checks and incomplete pages', async () => {
  const args = { repository, revision: candidate(0), requiredChecks: [check] };
  const run = { name: check, head_sha: args.revision, conclusion: 'success', status: 'completed' };
  const inspect = (value) => inspectGitHubChecks({
    ...args, execCommand: (_args, callback) => callback(value instanceof Error ? value : null, JSON.stringify(value)),
  });
  assert.equal((await inspect(new Error('missing GitHub read permission'))).status, 'BLOCKED');
  assert.equal((await inspect({ total_count: 2, check_runs: [run, run] })).status, 'BLOCKED');
  assert.equal((await inspect({ total_count: 2, check_runs: [run] })).status, 'BLOCKED');
  assert.equal((await inspect({ total_count: 1, check_runs: [{ ...run, head_sha: baseline }] })).status, 'BLOCKED');
  assert.equal((await inspect({ total_count: 1, check_runs: [{ ...run, conclusion: 'cancelled' }] })).status, 'BLOCKED');
});
