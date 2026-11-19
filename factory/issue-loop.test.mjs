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
const pullRequest = 42;
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

function githubFixture(options, mutate = () => {}) {
  options.approval.githubPullRequest = pullRequest;
  const calls = [];
  options.githubEvidenceFetch = async (url, request) => {
    const path = new URL(url).pathname;
    calls.push(path);
    assert.equal(new URL(url).origin, 'https://api.github.com');
    assert.equal(request.headers.authorization, undefined);
    assert.equal(request.redirect, 'error');
    assert.ok(request.signal instanceof AbortSignal);
    const timestamp = new Date(Date.now()).toISOString();
    const revision = candidate(0);
    const author = { login: 'chatgpt-codex-connector', __typename: 'Bot' };
    const connection = (nodes) => ({ nodes, pageInfo: { hasNextPage: false } });
    const review = { id: 'PRR_1', state: 'APPROVED', author, commit: { oid: revision }, submittedAt: timestamp };
    const thread = {
      id: 'PRRT_2', isResolved: false,
      comments: { nodes: [{
        id: 'PRRC_3', author, originalCommit: { oid: revision }, pullRequestReview: { id: review.id },
        createdAt: timestamp, updatedAt: timestamp,
        body: '**<sub><sub>![P1 Badge](https://img.shields.io/badge/P1-orange?style=flat)</sub></sub>  Fixture finding\n\n<!-- codex-code-review-finding:v1 -->',
      }] },
    };
    const pr = {
      number: pullRequest, state: 'OPEN', headRefOid: revision, headRepository: { nameWithOwner: repository },
      reviews: connection([review]), reviewThreads: connection([]),
    };
    const restPr = {
      number: pullRequest, state: 'open',
      base: { repo: { full_name: repository } }, head: { repo: { full_name: repository }, sha: revision },
    };
    const run = {
      id: 101, name: check, head_sha: revision, status: 'completed', conclusion: 'success', completed_at: timestamp,
      app: { id: 15368, slug: 'github-actions' }, url: `https://api.github.com/repos/${repository}/check-runs/101`,
    };
    const checks = { total_count: 1, check_runs: [run] };
    const graph = { data: { repository: { nameWithOwner: repository, pullRequest: pr } } };
    const status = (await mutate({ path, restPr, run, checks, graph, pr, review, thread })) ?? 200;
    if (path === '/graphql') {
      assert.equal(request.method, 'POST');
      const { query, variables } = JSON.parse(request.body);
      assert.match(query, /^query CandidateReview/);
      assert.deepEqual(variables, { owner: 'test', name: 'factory', number: pullRequest });
      return { ok: status === 200, status, json: async () => graph };
    }
    assert.equal(request.method, 'GET');
    if (path === `/repos/${repository}/pulls/${pullRequest}`) {
      return { ok: status === 200, status, json: async () => restPr };
    }
    assert.equal(path, `/repos/${repository}/commits/${restPr.head.sha}/check-runs`);
    assert.equal(new URL(url).search, '?filter=latest&per_page=100');
    return { ok: status === 200, status, json: async () => checks };
  };
  return calls;
}

test('binds GitHub API evidence to the issue claim and persists compact simulated provenance', async (t) => {
  const options = await fixture(t);
  let changedHead = false;
  const calls = githubFixture(options, ({ restPr }) => {
    if (changedHead) restPr.head.sha = candidate(1);
  });
  const report = await runIssueLoop(options);
  assert.equal(report.status, 'READY');
  assert.equal(report.mode, 'SIMULATION');
  assert.equal(report.revision, candidate(0));
  assert.equal(calls.length, 3);
  const [, ci, review] = report.checks;
  assert.deepEqual([ci.evidence.mode, ci.evidence.source, ci.evidence.repository, ci.evidence.pull_request],
    ['SIMULATION', 'fixture:github-api', repository, pullRequest]);
  assert.deepEqual([ci.evidence.app_id, ci.evidence.checks[0].id], [15368, 101]);
  assert.deepEqual([review.evidence.author, review.evidence.review_id, review.evidence.state],
    ['chatgpt-codex-connector', 'PRR_1', 'APPROVED']);
  const stored = JSON.parse(await readFile(join(options.stateDirectory, report.run_id, 'state.json'), 'utf8'));
  assert.deepEqual(stored.report, report);
  assert.match((await runIssueLoop({ ...options, githubEvidenceFetch: undefined })).next_action, /different approved inputs/);
  assert.match((await runIssueLoop({ ...options, approval: { ...options.approval, githubPullRequest: 43 } })).next_action,
    /different approved inputs/);

  changedHead = true;
  options.providers.coding.run = () => assert.fail('replayed claim dispatched coding');
  const replay = await runIssueLoop(options);
  assert.equal(replay.status, 'BLOCKED');
  assert.match(replay.next_action, /candidate head/);
  assert.equal(calls.length, 4);
});

test('GitHub API evidence fails closed with no repairs for incomplete or mismatched proof', async (t) => {
  const cases = [
    ['stale check SHA', ({ run }) => { run.head_sha = baseline; }, /different SHA/, 2],
    ['missing CI', ({ checks }) => { checks.check_runs = []; checks.total_count = 0; }, /check runs are missing/, 6],
    ['stale CI', ({ run }) => { run.completed_at = '2020-01-01T00:00:00Z'; }, /stale or invalid completion/, 2],
    ['invalid CI response', ({ checks }) => { checks.total_count = 2; }, /invalid or incomplete/, 2],
    ['ambiguous CI', ({ checks, run }) => { checks.check_runs.push(run); checks.total_count = 2; }, /ambiguous/, 2],
    ['untrusted CI app', ({ run }) => { run.app.id = 17; }, /unverified GitHub Actions provenance/, 2],
    ['different repo', ({ restPr }) => { restPr.base.repo.full_name = 'other/factory'; }, /repository and candidate head/, 1],
    ['different PR', ({ pr }) => { pr.number = 41; }, /different repository, PR or candidate head/, 3],
    ['stale review SHA', ({ review }) => { review.commit.oid = baseline; }, /bound to the candidate SHA/, 3],
    ['old review', ({ review }) => { review.submittedAt = '2020-01-01T00:00:00Z'; }, /completion is stale/, 3],
    ['pending review', ({ review }) => { review.state = 'PENDING'; review.submittedAt = null; }, /review is pending/, 3],
    ['commented without verdict', ({ review }) => { review.state = 'COMMENTED'; }, /no verifiable approval/, 3],
    ['ambiguous reviews', ({ pr, review }) => { pr.reviews.nodes.push({ ...review, id: 'PRR_2' }); }, /multiple trusted/, 3],
    ['untrusted author', ({ review }) => { review.author.__typename = 'User'; }, /no trusted Codex review/, 3],
    ['partial threads', ({ pr }) => { pr.reviewThreads.pageInfo.hasNextPage = true; }, /invalid or incomplete/, 3],
    ['unbound P1', ({ pr, thread }) => {
      thread.comments.nodes[0].originalCommit.oid = baseline;
      pr.reviewThreads.nodes.push(thread);
    }, /comment has mismatched/, 3],
    ['missing CI permission', ({ path }) => path.endsWith('/check-runs') ? 403 : 200, /HTTP 403.*token access/, 2],
    ['missing review permission', ({ graph }) => { graph.errors = [{ type: 'FORBIDDEN' }]; }, /denied pull-request read access/, 3],
    ['API error', ({ path }) => path === '/graphql' ? 502 : 200, /HTTP 502/, 3],
    ['invalid API response', ({ path }) => { if (path === '/graphql') throw new SyntaxError('invalid response'); }, /unavailable or invalid/, 3],
  ];
  for (const [name, mutate, reason, reads] of cases) {
    await t.test(name, async (t) => {
      const options = await fixture(t);
      const calls = githubFixture(options, mutate);
      const report = await runIssueLoop(options);
      assert.equal(report.status, 'BLOCKED');
      assert.match(report.next_action, reason);
      assert.equal(report.repair_cycles, 0);
      assert.equal(calls.length, reads);
    });
  }
});

test('failed CI and unresolved Codex P1 findings enter the existing repair path', async (t) => {
  for (const failure of ['ci', 'review']) {
    await t.test(failure, async (t) => {
      const options = await fixture(t);
      const prompts = [];
      options.providers.coding.run = (input) => {
        prompts.push(input);
        return input.cycle === 0 ? pass({ revision: candidate(0) }) : { status: 'GATE_A' };
      };
      githubFixture(options, ({ run, pr, review, thread }) => {
        if (failure === 'ci') run.conclusion = 'failure';
        else {
          review.state = 'COMMENTED';
          pr.reviewThreads.nodes.push(thread);
        }
      });
      const report = await runIssueLoop(options);
      assert.equal(report.status, 'GATE_A');
      assert.equal(report.owner_gate, 'A');
      assert.equal(report.repair_cycles, 1);
      const [finding] = prompts[1].findings;
      assert.deepEqual([finding.stage, finding.id], [failure, failure === 'ci' ? check : 'PRRC_3']);
      const failed = report.checks.at(-1);
      assert.equal(failed.status, 'FAIL');
      if (failure === 'review') {
        assert.deepEqual(failed.evidence.findings, [{ thread_id: 'PRRT_2', comment_id: 'PRRC_3', severity: 'P1' }]);
        assert.ok(!JSON.stringify(report).includes('Fixture finding'));
      }
    });
  }
});

test('a resolved Codex finding does not supply approval on its own', async (t) => {
  const options = await fixture(t);
  githubFixture(options, ({ pr, review, thread }) => {
    review.state = 'COMMENTED';
    thread.isResolved = true;
    pr.reviewThreads.nodes.push(thread);
  });
  const report = await runIssueLoop(options);
  assert.equal(report.status, 'BLOCKED');
  assert.match(report.next_action, /no verifiable approval/);
  assert.equal(report.repair_cycles, 0);
});

test('an unavailable Actions login blocks live evidence without relabeling it as simulated', async (t) => {
  const options = await fixture(t);
  options.approval.githubPullRequest = pullRequest;
  const report = await runIssueLoop(options);
  assert.equal(report.mode, 'SIMULATION');
  assert.equal(report.status, 'BLOCKED');
  assert.match(report.next_action, /missing GitHub Actions job token for the approved repository/);
  assert.equal(report.checks.at(-1).evidence.mode, 'LIVE');
  assert.equal(report.checks.at(-1).evidence.source, 'github.com:read-only');
});

test('identical replay refreshes recoverable GitHub evidence using the original candidate', async (t) => {
  const cases = [
    ['pending CI', ({ run }) => { run.status = 'in_progress'; run.conclusion = null; }, 6],
    ['CI not posted', ({ checks }) => { checks.check_runs = []; checks.total_count = 0; }, 6],
    ['pending review', ({ review }) => { review.state = 'PENDING'; review.submittedAt = null; }, 3],
    ['review not posted', ({ pr }) => { pr.reviews.nodes = []; }, 3],
    ['temporary API outage', ({ path }) => path === '/graphql' ? 503 : 200, 3],
    ['expired CI', ({ run }) => { run.completed_at = '2020-01-01T00:00:00Z'; }, 2],
  ];
  for (const [name, block, initialReads] of cases) {
    await t.test(name, async (t) => {
      const options = await fixture(t);
      let recovered = false;
      let dispatches = 0;
      let tests = 0;
      const calls = githubFixture(options, (response) => recovered ? undefined : block(response));
      const dispatch = options.providers.coding.run;
      options.providers.coding.run = (input) => {
        dispatches += 1;
        assert.deepEqual(input.memoryScope, options.profile.memory_scope);
        return dispatch(input);
      };
      options.providers.tests.run = (input) => { tests += 1; return pass(input); };
      const blocked = await runIssueLoop(options);
      assert.equal(blocked.status, 'BLOCKED');
      assert.equal(blocked.revision, candidate(0));
      assert.equal(calls.length, initialReads);
      const statePath = join(options.stateDirectory, blocked.run_id, 'state.json');
      const before = JSON.parse(await readFile(statePath, 'utf8'));

      recovered = true;
      const ready = await runIssueLoop(options);
      const after = JSON.parse(await readFile(statePath, 'utf8'));
      assert.equal(ready.status, 'READY');
      assert.equal(ready.reviewer.verdict, 'PASS');
      assert.equal(ready.run_id, blocked.run_id);
      assert.equal(ready.revision, blocked.revision);
      assert.equal(ready.repair_cycles, blocked.repair_cycles);
      assert.deepEqual(ready.attempts, blocked.attempts);
      assert.equal(after.fingerprint, before.fingerprint);
      assert.deepEqual(after.report, ready);
      assert.equal(calls.length, initialReads + 3);
      assert.equal(dispatches, 1);
      assert.equal(tests, 1);
    });
  }
});

test('recoverable replay blocks if GitHub reports a different head', async (t) => {
  const options = await fixture(t);
  let headChanged = false;
  const calls = githubFixture(options, ({ restPr, review }) => {
    if (headChanged) restPr.head.sha = candidate(1);
    else { review.state = 'PENDING'; review.submittedAt = null; }
  });
  const original = await runIssueLoop(options);
  assert.equal(original.status, 'BLOCKED');
  assert.match(original.next_action, /review is pending/);
  headChanged = true;
  const replay = await runIssueLoop(options);
  assert.equal(replay.status, 'BLOCKED');
  assert.match(replay.next_action, /candidate head/);
  assert.equal(replay.revision, original.revision);
  assert.deepEqual(replay.attempts, original.attempts);
  assert.deepEqual(await runIssueLoop(options), replay);
  assert.equal(calls.length, 4);
});

test('replay preserves preflight, execution, security and SHA mismatch decisions', async (t) => {
  for (const kind of ['preflight', 'execution', 'security', 'unauthorized', 'SHA mismatch']) {
    await t.test(kind, async (t) => {
      const options = await fixture(t);
      let recovered = false;
      const calls = githubFixture(options, ({ path, restPr }) => {
        if (recovered) return;
        if (kind === 'unauthorized' && path === '/graphql') return 403;
        if (kind === 'SHA mismatch') restPr.head.sha = candidate(1);
      });
      let dispatches = 0;
      const dispatch = options.providers.coding.run;
      options.providers.coding.run = (input) => { dispatches += 1; return dispatch(input); };
      const originalEvidence = options.evidence;
      if (kind === 'preflight') options.evidence = {};
      if (kind === 'execution') options.providers.tests.run = () => { throw new Error('test runner failed'); };
      if (kind === 'security') options.providers.tests.run = ({ revision }) => ({ status: 'GATE_A', revision });

      const original = await runIssueLoop(options);
      assert.equal(original.status, kind === 'security' ? 'GATE_A' : 'BLOCKED');
      const reads = calls.length;
      options.evidence = originalEvidence;
      options.providers.tests.run = pass;
      recovered = true;
      assert.deepEqual(await runIssueLoop(options), original);
      assert.equal(calls.length, reads);
      assert.equal(dispatches, kind === 'preflight' ? 0 : 1);
    });
  }
});

test('concurrent evidence replays share a durable refresh limit and never dispatch', async (t) => {
  const options = await fixture(t);
  const now = Date.now();
  const clock = t.mock.method(Date, 'now', () => now);
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  let refreshing = false;
  let completed = false;
  const calls = githubFixture(options, async ({ path, run }) => {
    if (refreshing && path.endsWith('/check-runs')) {
      entered.resolve();
      await release.promise;
    }
    if (!completed) { run.status = 'in_progress'; run.conclusion = null; }
  });
  const initial = await runIssueLoop(options);
  assert.equal(initial.status, 'BLOCKED');
  assert.equal(calls.length, 6);
  options.providers.coding.run = () => assert.fail('refresh dispatched coding');
  options.providers.tests.run = () => assert.fail('refresh invoked tests');

  refreshing = true;
  const active = runIssueLoop(options);
  await entered.promise;
  try {
    const duplicate = await runIssueLoop(options);
    assert.equal(duplicate.status, 'BLOCKED');
    assert.match(duplicate.next_action, /refresh is active/);
    assert.equal(calls.length, 8);
  } finally {
    release.resolve();
  }
  const pending = await active;
  assert.equal(pending.status, 'BLOCKED');
  assert.equal(pending.checks.at(-1).reads, 1);
  completed = true;
  assert.deepEqual(await runIssueLoop(options), pending);
  assert.equal(calls.length, 8);

  clock.mock.mockImplementation(() => now + 5_000);
  const ready = await runIssueLoop(options);
  assert.equal(ready.status, 'READY');
  assert.equal(ready.repair_cycles, 0);
  assert.equal(calls.length, 11);
  const limited = await runIssueLoop(options);
  assert.equal(limited.status, 'BLOCKED');
  assert.match(limited.next_action, /rate limited/);
  assert.equal(calls.length, 11);
});

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
  assert.deepEqual(prompts.map(({ memoryScope }) => memoryScope), Array(4).fill(options.profile.memory_scope));
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

test('changing allow_customer_data invalidates approval before coding dispatch', async (t) => {
  const options = await fixture(t);
  options.profile.memory_scope.allow_customer_data = true;
  assert.notEqual(issueProfileDigest(options.profile), options.approval.profileDigest);
  let calls = 0;
  options.providers.coding.run = () => { calls += 1; };

  const report = await runIssueLoop(options);
  assert.equal(report.status, 'BLOCKED');
  assert.match(report.next_action, /invalid issue profile approval/);
  assert.equal(calls, 0);
});

test('malformed memory scopes block dispatch even with a matching digest', async (t) => {
  for (const memoryScope of [
    undefined,
    { short_term: 'issue', long_term: 'project/module' },
    { short_term: 'issue', long_term: 'project/module', allow_customer_data: 'false' },
    { short_term: '', long_term: 'project/module', allow_customer_data: false },
    { short_term: 'issue', long_term: [], allow_customer_data: false },
  ]) {
    const options = await fixture(t);
    options.profile.memory_scope = memoryScope;
    options.approval.profileDigest = issueProfileDigest(options.profile);
    let calls = 0;
    options.providers.coding.run = () => { calls += 1; };

    const report = await runIssueLoop(options);
    assert.equal(report.status, 'BLOCKED');
    assert.match(report.next_action, /invalid issue profile approval/);
    assert.equal(calls, 0);
  }
});

test('coding receives the explicitly approved customer-data policy', async (t) => {
  const options = await fixture(t);
  options.profile.memory_scope.allow_customer_data = true;
  options.approval.profileDigest = issueProfileDigest(options.profile);
  const { short_term, long_term } = options.profile.memory_scope;
  options.profile.memory_scope = { allow_customer_data: true, long_term, short_term };
  let suppliedScope;
  options.providers.coding.run = ({ memoryScope }) => {
    suppliedScope = memoryScope;
    return { status: 'PASS', revision: candidate(0) };
  };

  assert.equal((await runIssueLoop(options)).status, 'READY');
  assert.deepEqual(suppliedScope, options.profile.memory_scope);
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
