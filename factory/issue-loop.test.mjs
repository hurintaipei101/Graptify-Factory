import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, rmdir, unlink, writeFile } from 'node:fs/promises';
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
function boundResult({ issueKey, linearIssueId, repository, approvalDigest, memoryScope, revision }, status) {
  return { issueKey, linearIssueId, repository, approvalDigest, memoryScope, revision, status };
}
const pass = (input) => boundResult(input, 'PASS');
const failure = (input, id) => ({ ...boundResult(input, 'FAIL'), findings: [{ id, summary: 'Fix the failing assertion' }] });

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'factory-loop-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stateDirectory = join(directory, 'state');
  const workspace = join(directory, 'worker');
  await Promise.all([mkdir(stateDirectory), mkdir(workspace)]);
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
    coding: { ...provider('agent', 'coder', (input) => pass({ ...input, revision: candidate(input.cycle) })), profile: profile.role_profile },
    tests: provider('deterministic', 'node', pass),
    ci: provider('read-only', 'github-fixture', pass),
    review: provider('agent', 'reviewer', (input) => pass(input)),
  };
  return { profile, approval, evidence, providers, stateDirectory, workspace, pollIntervalMs: 0 };
}

function codexFixture(options, spawn) {
  const { workspace } = options;
  options.codexSimulation = {
    workspace, allowedWorkspaces: [workspace], runtimeIsolation: { verified: true },
    mcpAccess: { verified: true, allowed: true }, spawnFixture: spawn,
  };
  options.providers.coding.run = (input) =>
    ({ ...pass({ ...input, revision: candidate(input.cycle) }), baseRevision: input.baseRevision });
}

function codexChild() {
  const process = new EventEmitter();
  process.stdout = new EventEmitter();
  process.stderr = new EventEmitter();
  process.kill = () => process.emit('close', null, 'SIGTERM');
  return process;
}

function successfulCodexChild() {
  const process = codexChild();
  queueMicrotask(() => {
    process.stdout.emit('data', Buffer.from('{"type":"turn.completed","secret":"do not retain"}\n'));
    process.emit('close', 0, null);
  });
  return process;
}

test('approved Codex simulation persists compact evidence for the issue and candidate', async (t) => {
  const options = await fixture(t);
  codexFixture(options, ({ command, args, options: launch }) => {
    assert.equal(command, 'codex');
    assert.deepEqual(args.slice(0, 4), ['exec', '--json', '--sandbox', 'read-only']);
    const prompt = JSON.parse(args.at(-1));
    assert.equal(prompt.issueKey, options.profile.issue_key);
    assert.equal(prompt.baseRevision, baseline);
    assert.deepEqual(prompt.memoryScope, options.profile.memory_scope);
    assert.deepEqual(Object.keys(launch.env).sort(), ['CODEX_HOME', 'HOME', 'PATH']);
    return successfulCodexChild();
  });
  const report = await runIssueLoop(options);
  assert.equal(report.status, 'READY');
  assert.deepEqual(report.attempts[0].dispatch, {
    mode: 'SIMULATION', issue_key: options.profile.issue_key, repository,
    approval_digest: options.approval.profileDigest, base_revision: baseline, candidate_revision: candidate(0),
    status: 'PASS', event_count: 1, exit_code: 0, close_confirmed: true, timed_out: false, cancelled: false,
  });
  assert.ok(!JSON.stringify(report).includes('do not retain'));
  const stored = JSON.parse(await readFile(join(options.stateDirectory, report.run_id, 'state.json'), 'utf8'));
  assert.deepEqual(stored.report, report);
});

test('dispatch blocks unsigned scope, invalid memory, and missing isolation or credentials', async (t) => {
  const cases = [
    ['unsigned scope', (o) => { o.profile.requirements.push('unsigned'); }, /profile approval/],
    ['missing memory', (o) => { delete o.profile.memory_scope; o.approval.profileDigest = issueProfileDigest(o.profile); }, /memory_scope/],
    ['invalid memory', (o) => { o.profile.memory_scope.allow_customer_data = 'false'; o.approval.profileDigest = issueProfileDigest(o.profile); }, /memory_scope/],
    ['missing isolation', (o) => { delete o.codexSimulation.runtimeIsolation; }, /isolation is not verified/],
    ['missing MCP permissions', (o) => { delete o.codexSimulation.mcpAccess; }, /MCP access is not verified/],
    ['missing live credential', (o) => { o.realExecution = true; }, /Missing GitHub Actions job token/],
    ['live GitHub evidence', (o) => { o.approval.githubPullRequest = pullRequest; }, /requires simulated GitHub evidence/],
  ];
  for (const [name, change, reason] of cases) {
    await t.test(name, async (t) => {
      const options = await fixture(t);
      let calls = 0;
      codexFixture(options, () => { calls += 1; return successfulCodexChild(); });
      change(options);
      const result = await runIssueLoop(options);
      assert.equal(result.status, 'BLOCKED');
      assert.match(result.next_action, reason);
      assert.equal(calls, 0);
    });
  }
});

test('candidate provenance must match the dispatch before any verification runs', async (t) => {
  for (const [field, value] of [['issueKey', 'F2-99'], ['repository', 'other/factory'], ['baseRevision', candidate(1)]]) {
    await t.test(field, async (t) => {
      const options = await fixture(t);
      codexFixture(options, successfulCodexChild);
      const coding = options.providers.coding.run;
      options.providers.coding.run = (input) => ({ ...coding(input), [field]: value });
      options.providers.tests.run = () => assert.fail('must not verify an unrelated candidate');
      const result = await runIssueLoop(options);
      assert.equal(result.status, 'BLOCKED');
      assert.match(result.next_action, /candidate does not match/);
      assert.equal(result.attempts[0].dispatch.candidate_revision, null);
      assert.deepEqual(result.checks, []);
    });
  }
});

for (const [trigger, reason] of [['cancellation', /cancelled/], ['timeout', /timed out/], ['process error', /process error/], ['stderr overflow', /output exceeds/]]) {
  test(`Codex ${trigger} waits for cleanup and retains the durable claim`, async (t) => {
    const options = await fixture(t);
    const controller = new AbortController();
    options.signal = controller.signal;
    options.timeoutMs = 500;
    const signals = [];
    let dispatchStarted;
    const started = new Promise((resolve) => { dispatchStarted = resolve; });
    codexFixture(options, () => {
      const process = codexChild();
      process.kill = (signal) => {
        signals.push(signal);
        setTimeout(() => process.emit('close', null, signal), 10);
      };
      if (trigger === 'process error') queueMicrotask(() => process.emit('error', new Error('private detail')));
      if (trigger === 'stderr overflow') queueMicrotask(() => process.stderr.emit('data', Buffer.alloc(33_000)));
      dispatchStarted();
      return process;
    });
    const running = runIssueLoop(options);
    await started;
    const concurrent = await runIssueLoop(options);
    assert.equal(concurrent.status, 'BLOCKED');
    if (trigger === 'cancellation') controller.abort();
    const report = await running;
    assert.equal(report.status, 'BLOCKED');
    assert.match(report.next_action, reason);
    assert.deepEqual(signals, ['SIGTERM']);
    const { dispatch } = report.attempts[0];
    assert.equal(dispatch.close_confirmed, true);
    assert.equal(dispatch.cancelled, trigger === 'cancellation');
    assert.equal(dispatch.timed_out, trigger === 'timeout');
    assert.equal(report.attempts.length, 1);
    options.codexSimulation.spawnFixture = () => assert.fail('claim must never redispatch');
    assert.deepEqual(await runIssueLoop({ ...options, signal: undefined }), report);
  });
}

test('only the initial Codex dispatch and three repairs can run before Gate A', async (t) => {
  const options = await fixture(t);
  const bases = [];
  codexFixture(options, ({ args }) => {
    bases.push(JSON.parse(args.at(-1)).baseRevision);
    return successfulCodexChild();
  });
  options.providers.tests.run = (input) => failure(input, 'T01');
  const report = await runIssueLoop(options);
  assert.equal(report.status, 'GATE_A');
  assert.equal(report.owner_gate, 'A');
  assert.equal(report.repair_cycles, 3);
  assert.deepEqual(bases, [baseline, candidate(0), candidate(1), candidate(2)]);
});

function githubFixture(options, mutate = () => {}, head = () => candidate(0)) {
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
    const revision = head();
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
  assert.deepEqual(report.feedback_binding, {
    issue_key: options.profile.issue_key, linear_issue_id: options.profile.issue_key, repository, pull_request: pullRequest,
    approval_digest: options.approval.profileDigest, run_fingerprint: stored.fingerprint,
    memory_scope: options.profile.memory_scope,
  });
  const verdicts = report.feedback.filter(({ event }) => event === 'VERIFICATION');
  assert.deepEqual(verdicts.map(({ stage, classification, candidate_sha }) => [stage, classification, candidate_sha]), [
    ['tests', 'CLEAN', candidate(0)], ['ci', 'CLEAN', candidate(0)], ['review', 'CLEAN', candidate(0)],
  ]);
  assert.match((await runIssueLoop({ ...options, githubEvidenceFetch: undefined })).next_action, /different approved inputs/);
  assert.match((await runIssueLoop({ ...options, approval: { ...options.approval, githubPullRequest: 43 } })).next_action,
    /different approved inputs/);

  changedHead = true;
  options.providers.coding.run = () => assert.fail('replayed claim dispatched coding');
  const replay = await runIssueLoop(options);
  assert.equal(replay.status, 'BLOCKED');
  assert.match(replay.next_action, /candidate head/);
  assert.equal(replay.checks.at(-1).classification, 'STALE');
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
        return input.cycle === 0 ? pass({ ...input, revision: candidate(0) }) : boundResult(input, 'GATE_A');
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

test('repairs only open P1 and P2 findings and invalidates evidence when coding returns a new SHA', async (t) => {
  const options = await fixture(t);
  let head = candidate(0);
  const prompts = [];
  codexFixture(options, ({ args }) => {
    prompts.push(JSON.parse(args.at(-1)));
    return successfulCodexChild();
  });
  const coding = options.providers.coding.run;
  options.providers.coding.run = (input) => {
    const output = coding(input);
    head = output.revision;
    return output;
  };
  githubFixture(options, ({ pr, review, thread }) => {
    review.commit.oid = candidate(0);
    review.state = 'COMMENTED';
    if (head !== candidate(0)) return;
    for (const [number, severity, resolved] of [[1, 'P1', false], [2, 'P2', false], [3, 'P3', false], [4, 'P2', true]]) {
      const finding = structuredClone(thread);
      finding.id = `PRRT_${number}`;
      finding.isResolved = resolved;
      const [root] = finding.comments.nodes;
      root.id = `PRRC_${number}`;
      root.body = root.body.replaceAll('P1', severity);
      pr.reviewThreads.nodes.push(finding);
    }
  }, () => head);
  const report = await runIssueLoop(options);
  assert.equal(report.status, 'BLOCKED');
  assert.equal(report.revision, candidate(1));
  assert.equal(report.repair_cycles, 1);
  assert.equal(prompts.length, 2);
  const request = prompts[1];
  assert.equal(request.baseRevision, candidate(0));
  assert.equal(request.issueKey, options.profile.issue_key);
  assert.equal(request.approvalDigest, options.approval.profileDigest);
  assert.deepEqual(request.memoryScope, options.profile.memory_scope);
  assert.deepEqual(request.findings.map(({ id }) => id), ['PRRC_1', 'PRRC_2']);
  const [original, stale] = report.checks.filter(({ stage }) => stage === 'review');
  assert.equal(original.classification, 'FAILED');
  assert.equal(original.evidence.state, 'COMMENTED');
  assert.equal(stale.classification, 'STALE');
  assert.deepEqual(stale.findings, []);
  assert.deepEqual(stale.evidence.prior_reviews, [{ id: 'PRR_1', sha: candidate(0) }]);
  const claim = report.feedback.find(({ event }) => event === 'REPAIR_CLAIM');
  assert.equal(claim.candidate_sha, candidate(0));
  assert.deepEqual(claim.findings, [{ stage: 'review', id: 'PRRC_1' }, { stage: 'review', id: 'PRRC_2' }]);
  const handoff = report.feedback.filter(({ event }) => event === 'CANDIDATE_HANDOFF').at(-1);
  assert.deepEqual([handoff.candidate_sha, handoff.invalidated_sha], [candidate(1), candidate(0)]);
  assert.ok(!JSON.stringify(report).includes('Fixture finding'));
  await runIssueLoop(options);
  assert.equal(prompts.length, 2);
});

test('a head change during a failing CI read prevents any repair', async (t) => {
  const options = await fixture(t);
  let head = candidate(0);
  githubFixture(options, ({ path, run }) => {
    if (path.endsWith('/check-runs')) {
      run.conclusion = 'failure';
      head = candidate(1);
    }
  }, () => head);
  options.providers.coding.run = (input) => {
    assert.equal(input.cycle, 0);
    return pass({ ...input, revision: candidate(0) });
  };
  const report = await runIssueLoop(options);
  assert.equal(report.status, 'BLOCKED');
  assert.equal(report.attempts.length, 1);
  const stale = report.checks.at(-1);
  assert.equal(stale.classification, 'STALE');
  assert.equal(stale.evidence.observed_head_sha, candidate(1));
  assert.deepEqual(stale.findings, []);
  assert.ok(!report.feedback.some(({ event }) => event === 'REPAIR_CLAIM'));
});

test('coding and verification reject invalid approval-binding fields independently', async (t) => {
  const mismatches = {
    issueKey: 'F2-99', linearIssueId: 'another-linear-id', repository: 'other/factory',
    approvalDigest: 'a'.repeat(64),
    memoryScope: { short_term: 'issue', long_term: 'project/module', allow_customer_data: true },
  };
  for (const stage of ['coding', 'ci']) {
    for (const [field, mismatch] of Object.entries(mismatches)) {
      await t.test(`${stage} requires ${field}`, async (t) => {
        for (const [kind, value] of [
          ['missing'], ['null', null], ['empty', field === 'memoryScope' ? {} : ''],
          ['wrong type', 123], ['mismatched', mismatch],
        ]) {
          await t.test(kind, async (t) => {
            const options = await fixture(t);
            options.profile.linear_issue_id = options.evidence.linear.id = 'approved-linear-id';
            options.approval.profileDigest = issueProfileDigest(options.profile);
            let dispatches = 0;
            const coding = options.providers.coding.run;
            options.providers.coding.run = (input) => {
              dispatches += 1;
              const result = coding(input);
              return stage === 'coding' ? invalid(result) : result;
            };
            options.providers.ci.run = (input) => invalid(failure(input, check));
            const report = await runIssueLoop(options);
            assert.equal(report.status, 'BLOCKED');
            assert.equal(report.reason_code, 'INVALID_PROVIDER_BINDING');
            assert.equal(report.feedback.at(-1).reason_code, report.reason_code);
            assert.equal(report.repair_cycles, 0);
            assert.equal(dispatches, 1);
            if (stage === 'coding') {
              assert.equal(report.revision, null);
              assert.deepEqual(report.checks, []);
            } else {
              assert.equal(report.revision, candidate(0));
              assert.equal(report.checks.at(-1).stage, 'ci');
              assert.equal(report.checks.at(-1).reason_code, report.reason_code);
              assert.deepEqual(report.checks.at(-1).findings, []);
            }
            assert.ok(!report.feedback.some(({ event }) => event === 'REPAIR_CLAIM'));

            function invalid(result) {
              if (kind === 'missing') delete result[field];
              else result[field] = value;
              return result;
            }
          });
        }
      });
    }
  }
});

test('cached review for the same SHA is rejected under a different approval', async (t) => {
  const original = await fixture(t);
  let cachedReview;
  original.providers.review.run = (input) => {
    cachedReview = pass(input);
    return cachedReview;
  };
  assert.equal((await runIssueLoop(original)).status, 'READY');
  const options = await fixture(t);
  options.profile.requirements.push('Different approved scope');
  options.approval.profileDigest = issueProfileDigest(options.profile);
  options.providers.review.run = ({ revision }) => {
    assert.equal(cachedReview.revision, revision);
    return cachedReview;
  };
  const report = await runIssueLoop(options);
  assert.equal(report.status, 'BLOCKED');
  assert.equal(report.reason_code, 'INVALID_PROVIDER_BINDING');
  assert.equal(report.checks.at(-1).stage, 'review');
  assert.equal(report.repair_cycles, 0);
  assert.ok(!JSON.stringify(report).includes(cachedReview.approvalDigest));
});

test('replay blocks claims written before provider bindings were required', async (t) => {
  for (const github of [false, true]) {
    await t.test(github ? 'GitHub refresh' : 'stored READY', async (t) => {
      const options = await fixture(t);
      let failing = false;
      const calls = github ? githubFixture(options, ({ run }) => { if (failing) run.conclusion = 'failure'; }) : [];
      const ready = await runIssueLoop(options);
      assert.equal(ready.status, 'READY');
      const statePath = join(options.stateDirectory, ready.run_id, 'state.json');
      const state = JSON.parse(await readFile(statePath, 'utf8'));
      delete state.providerBindingVersion;
      await writeFile(statePath, JSON.stringify(state));
      const readCount = calls.length;
      failing = true;
      let dispatches = 0;
      options.providers.coding.run = () => { dispatches += 1; };
      const replayed = await runIssueLoop(options);
      assert.equal(replayed.status, 'BLOCKED');
      assert.equal(replayed.reason_code, 'UNVERIFIED_STORED_BINDING');
      assert.equal(replayed.feedback.at(-1).reason_code, replayed.reason_code);
      assert.equal(dispatches, 0);
      assert.equal(calls.length, readCount);
      assert.deepEqual(JSON.parse(await readFile(statePath, 'utf8')), state);
    });
  }
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

test('refreshed CI failures and Codex P1 findings resume the next authorized repair', async (t) => {
  for (const stage of ['ci', 'review']) {
    await t.test(stage, async (t) => {
      const options = await fixture(t);
      const prompts = [];
      const tested = [];
      let head = candidate(0);
      let pending = true;
      githubFixture(options, ({ run, review, pr, thread }) => {
        if (head !== candidate(0)) return;
        if (stage === 'ci') {
          run.status = pending ? 'in_progress' : 'completed';
          run.conclusion = pending ? null : 'failure';
        } else if (pending) {
          review.state = 'PENDING';
          review.submittedAt = null;
        } else {
          review.state = 'COMMENTED';
          pr.reviewThreads.nodes.push(thread);
        }
      }, () => head);
      options.providers.coding.run = (input) => {
        prompts.push(input);
        head = candidate(input.cycle);
        return pass({ ...input, revision: head });
      };
      options.providers.tests.run = (input) => { tested.push(input.revision); return pass(input); };

      const blocked = await runIssueLoop(options);
      assert.equal(blocked.status, 'BLOCKED');
      assert.equal(blocked.repair_cycles, 0);
      pending = false;
      const ready = await runIssueLoop(options);
      assert.equal(ready.status, 'READY');
      assert.equal(ready.run_id, blocked.run_id);
      assert.equal(ready.revision, candidate(1));
      assert.equal(ready.repair_cycles, 1);
      assert.deepEqual(ready.attempts, [
        ...blocked.attempts, { cycle: 1, revision: candidate(1), status: 'PASS' },
      ]);
      assert.deepEqual(prompts.map(({ cycle, baseRevision }) => [cycle, baseRevision]), [[0, baseline], [1, candidate(0)]]);
      assert.deepEqual(tested, [candidate(0), candidate(1)]);
      assert.deepEqual(prompts[1].memoryScope, options.profile.memory_scope);
      assert.deepEqual(prompts[1].findings.map(({ id, stage }) => [id, stage]),
        [[stage === 'ci' ? check : 'PRRC_3', stage]]);
      const failed = ready.checks.find((entry) => entry.status === 'FAIL');
      assert.equal(failed.revision, candidate(0));
      assert.equal(failed.evidence.pull_request, pullRequest);
      assert.equal(failed.evidence.mode, 'SIMULATION');
      assert.ok(!JSON.stringify(ready).includes('Fixture finding'));
    });
  }
});

test('replay revalidates the execution envelope before dispatching a repair', async (t) => {
  for (const boundary of ['preflight', 'provider', 'memory approval', 'GitHub permission']) {
    await t.test(boundary, async (t) => {
      const options = await fixture(t);
      let pending = true;
      githubFixture(options, ({ path, run }) => {
        run.status = pending ? 'queued' : 'completed';
        run.conclusion = pending ? null : 'failure';
        if (!pending && boundary === 'GitHub permission' && path.endsWith('/check-runs')) return 403;
      });
      assert.equal((await runIssueLoop(options)).status, 'BLOCKED');
      let dispatches = 0;
      options.providers.coding.run = (input) => { dispatches += 1; return pass({ ...input, revision: candidate(1) }); };
      if (boundary === 'preflight') options.evidence = {};
      if (boundary === 'provider') options.providers.coding.mode = 'LIVE';
      if (boundary === 'memory approval') options.profile.memory_scope.allow_customer_data = true;
      pending = false;
      const report = await runIssueLoop(options);
      assert.equal(report.status, 'BLOCKED');
      const reason = {
        preflight: /preflight evidence/, provider: /providers or independent reviewer/,
        'memory approval': /profile approval/, 'GitHub permission': /HTTP 403/,
      }[boundary];
      assert.match(report.next_action, reason);
      assert.equal(report.repair_cycles, 0);
      assert.equal(dispatches, 0);
    });
  }
});

test('a previous replay that persisted FAIL rechecks GitHub before resuming', async (t) => {
  const options = await fixture(t);
  let pending = true;
  const calls = githubFixture(options, ({ run }) => {
    run.status = pending ? 'queued' : 'completed';
    run.conclusion = pending ? null : 'failure';
  });
  const blocked = await runIssueLoop(options);
  const statePath = join(options.stateDirectory, blocked.run_id, 'state.json');
  const stored = JSON.parse(await readFile(statePath, 'utf8'));
  stored.report.next_action = 'stored candidate no longer passes GitHub verification';
  stored.report.checks.at(-1).status = 'FAIL';
  stored.report.checks.at(-1).findings = ['stale-finding'];
  await writeFile(statePath, JSON.stringify(stored));
  pending = false;
  let prompt;
  options.providers.coding.run = (input) => {
    prompt = input;
    return boundResult(input, 'GATE_A');
  };
  const gate = await runIssueLoop(options);
  assert.equal(gate.status, 'GATE_A');
  assert.equal(gate.repair_cycles, 1);
  assert.equal(prompt.cycle, 1);
  assert.deepEqual(prompt.findings.map(({ id }) => id), [check]);
  assert.equal(calls.length, 9);
});

test('concurrent replay acknowledges a durable repair claim and dispatches it once', async (t) => {
  const options = await fixture(t);
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  let pending = true;
  let head = candidate(0);
  const prompts = [];
  githubFixture(options, ({ run }) => {
    if (head !== candidate(0)) return;
    run.status = pending ? 'queued' : 'completed';
    run.conclusion = pending ? null : 'failure';
  }, () => head);
  options.providers.coding.run = async (input) => {
    const { cycle } = input;
    prompts.push(cycle);
    if (cycle === 1) {
      entered.resolve();
      await release.promise;
    }
    head = candidate(cycle);
    return pass({ ...input, revision: head });
  };
  const original = await runIssueLoop(options);
  assert.equal(original.status, 'BLOCKED');
  pending = false;
  const repair = runIssueLoop(options);
  await entered.promise;
  try {
    const statePath = join(options.stateDirectory, original.run_id, 'state.json');
    const stored = JSON.parse(await readFile(statePath, 'utf8')).report;
    assert.equal(stored.status, 'RUNNING');
    assert.equal(stored.checks.at(-1).status, 'FAIL');
    assert.deepEqual(stored.attempts.at(-1), { cycle: 1, revision: null, status: 'RUNNING' });
    const duplicate = await runIssueLoop(options);
    assert.equal(duplicate.status, 'BLOCKED');
    assert.match(duplicate.next_action, /run is active or interrupted/);
    assert.deepEqual(prompts, [0, 1]);
  } finally {
    release.resolve();
  }
  const ready = await repair;
  assert.equal(ready.status, 'READY');
  assert.equal(ready.repair_cycles, 1);
  assert.deepEqual(prompts, [0, 1]);
});

test('a refreshed failure at the third repair raises Gate A without another dispatch', async (t) => {
  const options = await fixture(t);
  const cycles = [];
  let pending = true;
  let head = candidate(0);
  githubFixture(options, ({ run }) => {
    const waiting = head === candidate(3) && pending;
    run.status = waiting ? 'queued' : 'completed';
    run.conclusion = waiting ? null : 'failure';
  }, () => head);
  options.providers.coding.run = (input) => {
    const { cycle } = input;
    cycles.push(cycle);
    head = candidate(cycle);
    return pass({ ...input, revision: head });
  };
  const blocked = await runIssueLoop(options);
  assert.equal(blocked.status, 'BLOCKED');
  assert.equal(blocked.repair_cycles, 3);
  pending = false;
  const gate = await runIssueLoop(options);
  assert.equal(gate.status, 'GATE_A');
  assert.equal(gate.owner_gate, 'A');
  assert.equal(gate.repair_cycles, 3);
  assert.equal(gate.revision, candidate(3));
  assert.equal(gate.checks.at(-1).status, 'FAIL');
  assert.deepEqual(gate.attempts, blocked.attempts);
  assert.deepEqual(cycles, [0, 1, 2, 3]);
  assert.deepEqual(await runIssueLoop(options), gate);
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
      if (kind === 'security') options.providers.tests.run = (input) => boundResult(input, 'GATE_A');

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

test('cancelling CI or review refresh preserves the durable report and permits an identical retry', async (t) => {
  const cases = [
    { stage: 'CI', endpoint: '/check-runs', initialStatus: 'READY' },
    { stage: 'review', endpoint: '/graphql', initialStatus: 'BLOCKED' },
  ];
  for (const { stage, endpoint, initialStatus } of cases) {
    await t.test(stage, { timeout: 10_000 }, async (t) => {
      const options = await fixture(t);
      let now = Date.now();
      t.mock.method(Date, 'now', () => now);
      let phase = 'initial';
      let dispatches = 0;
      let tests = 0;
      let entered = Promise.withResolvers();
      let release = Promise.withResolvers();
      const coding = options.providers.coding.run;
      options.providers.coding.run = (input) => {
        dispatches += 1;
        assert.deepEqual(input.memoryScope, options.profile.memory_scope);
        return coding(input);
      };
      options.providers.tests.run = (input) => { tests += 1; return pass(input); };
      const calls = githubFixture(options, async ({ path, review }) => {
        if (phase === 'initial' && initialStatus === 'BLOCKED') {
          review.state = 'PENDING';
          review.submittedAt = null;
        }
        if (phase !== 'initial' && path.endsWith(endpoint)) {
          entered.resolve();
          await release.promise;
        }
      });
      const initial = await runIssueLoop(options);
      assert.equal(initial.status, initialStatus);
      const statePath = join(options.stateDirectory, initial.run_id, 'state.json');
      const before = JSON.parse(await readFile(statePath, 'utf8'));

      phase = 'cancel';
      now += 60_000;
      const controller = new AbortController();
      const active = runIssueLoop({ ...options, signal: controller.signal });
      await entered.promise;
      controller.abort();
      let cancelled;
      try {
        cancelled = await active;
      } finally {
        release.resolve();
      }
      assert.equal(cancelled.status, 'BLOCKED');
      assert.match(cancelled.next_action, /execution cancelled/);
      const after = JSON.parse(await readFile(statePath, 'utf8'));
      assert.equal(after.githubRefreshStartedAt, now);
      assert.equal(after.fingerprint, before.fingerprint);
      const { feedback: audit, ...preserved } = after.report;
      const { feedback: originalAudit, ...original } = before.report;
      assert.deepEqual(preserved, original);
      assert.deepEqual(audit.slice(0, originalAudit.length), originalAudit);
      assert.equal(audit.at(-1).status, 'BLOCKED');
      assert.match(audit.at(-1).reason, /execution cancelled/);
      if (stage === 'review') {
        assert.equal(audit.at(-2).stage, 'ci');
        assert.equal(audit.at(-2).classification, 'CLEAN');
      }
      const readsAfterCancel = calls.length;
      assert.equal((await runIssueLoop(options)).status, 'BLOCKED');
      assert.equal(calls.length, readsAfterCancel);

      phase = 'retry';
      now += 5_000;
      entered = Promise.withResolvers();
      release = Promise.withResolvers();
      const retry = runIssueLoop(options);
      await entered.promise;
      try {
        const concurrent = await runIssueLoop(options);
        assert.equal(concurrent.status, 'BLOCKED');
        assert.match(concurrent.next_action, /refresh is active/);
      } finally {
        release.resolve();
      }
      const ready = await retry;
      assert.equal(ready.status, 'READY');
      assert.equal(ready.issue_key, initial.issue_key);
      assert.equal(ready.run_id, initial.run_id);
      assert.equal(ready.revision, initial.revision);
      assert.equal(ready.repair_cycles, initial.repair_cycles);
      assert.deepEqual(ready.attempts, initial.attempts);
      assert.equal(calls.length, readsAfterCancel + 3);
      assert.equal(dispatches, 1);
      assert.equal(tests, 1);
      assert.equal(JSON.parse(await readFile(statePath, 'utf8')).fingerprint, before.fingerprint);
    });
  }
});

test('retry after a cancelled refresh blocks invalid, stale, or unauthorized evidence', async (t) => {
  const cases = [
    ['invalid SHA', ({ restPr }) => { restPr.head.sha = 'invalid'; }, /candidate head/],
    ['stale CI', ({ run }) => { run.completed_at = '2020-01-01T00:00:00Z'; }, /stale or invalid completion/],
    ['untrusted CI app', ({ run }) => { run.app.id = 17; }, /unverified GitHub Actions provenance/],
    ['denied review', ({ path }) => path === '/graphql' ? 403 : undefined, /HTTP 403/],
  ];
  for (const [name, invalidate, reason] of cases) {
    await t.test(name, async (t) => {
      const options = await fixture(t);
      let now = Date.now();
      t.mock.method(Date, 'now', () => now);
      const controller = new AbortController();
      let phase = 'initial';
      githubFixture(options, (response) => {
        if (phase === 'cancel' && response.path === '/graphql') controller.abort();
        if (phase === 'retry') return invalidate(response);
      });
      const initial = await runIssueLoop(options);
      assert.equal(initial.status, 'READY');
      phase = 'cancel';
      const cancelled = await runIssueLoop({ ...options, signal: controller.signal });
      assert.match(cancelled.next_action, /execution cancelled/);
      phase = 'retry';
      now += 5_000;
      const retry = await runIssueLoop(options);
      assert.equal(retry.status, 'BLOCKED');
      assert.match(retry.next_action, reason);
      assert.equal(retry.revision, initial.revision);
      assert.equal(retry.repair_cycles, initial.repair_cycles);
      assert.deepEqual(retry.attempts, initial.attempts);
    });
  }
});

test('cancelling initial verification resumes the recorded SHA without coding again', async (t) => {
  const options = await fixture(t);
  const controller = new AbortController();
  const checking = Promise.withResolvers();
  let waiting = true;
  let dispatches = 0;
  codexFixture(options, () => { dispatches += 1; return successfulCodexChild(); });
  githubFixture(options, ({ path }) => {
    if (waiting && path === '/graphql') {
      checking.resolve();
      return new Promise(() => {});
    }
  });
  const initial = runIssueLoop({ ...options, signal: controller.signal });
  await checking.promise;
  controller.abort();
  const cancelled = await initial;
  assert.equal(cancelled.status, 'BLOCKED');
  assert.equal(cancelled.verification_pending, true);
  assert.equal(cancelled.revision, candidate(0));
  assert.deepEqual(cancelled.checks.map(({ stage }) => stage), ['tests', 'ci']);
  assert.equal(cancelled.attempts[0].dispatch.candidate_revision, candidate(0));
  assert.match(cancelled.feedback.at(-1).reason, /cancelled/);
  waiting = false;
  const resumed = await runIssueLoop(options);
  assert.equal(resumed.status, 'READY');
  assert.equal(resumed.revision, candidate(0));
  assert.equal(resumed.verification_pending, undefined);
  assert.equal(resumed.attempts.length, 1);
  assert.equal(dispatches, 1);
  assert.deepEqual(resumed.feedback.slice(0, cancelled.feedback.length), cancelled.feedback);
  assert.equal(resumed.feedback[cancelled.feedback.length].event, 'VERIFICATION_RESUMED');
});

test('cancellation recovery rejects a same-SHA failure missing an approval binding', async (t) => {
  const options = await fixture(t);
  const controller = new AbortController();
  const checking = Promise.withResolvers();
  let codingCalls = 0;
  const coding = options.providers.coding.run;
  options.providers.coding.run = (input) => { codingCalls += 1; return coding(input); };
  options.providers.ci.run = () => {
    checking.resolve();
    return new Promise(() => {});
  };
  const running = runIssueLoop({ ...options, signal: controller.signal });
  await checking.promise;
  controller.abort();
  const cancelled = await running;
  assert.equal(cancelled.verification_pending, true);

  options.providers.ci.run = (input) => {
    assert.equal(input.revision, cancelled.revision);
    const result = failure(input, check);
    delete result.linearIssueId;
    return result;
  };
  const resumed = await runIssueLoop(options);
  assert.equal(resumed.status, 'BLOCKED');
  assert.equal(resumed.reason_code, 'INVALID_PROVIDER_BINDING');
  assert.equal(resumed.repair_cycles, 0);
  assert.equal(codingCalls, 1);
  assert.deepEqual(await runIssueLoop(options), resumed);
  assert.equal(codingCalls, 1);
});

test('a process exit preserves candidate and check evidence for verification-only recovery', async (t) => {
  const options = await fixture(t);
  const childScript = `
    const { runIssueLoop } = await import(process.argv[1]);
    const options = JSON.parse(process.argv[2]);
    const provider = (kind, principal, run) => ({ mode: 'SIMULATION', kind, principal, run });
    const pass = ({ issueKey, linearIssueId, repository, approvalDigest, memoryScope, revision }) =>
      ({ issueKey, linearIssueId, repository, approvalDigest, memoryScope, revision, status: 'PASS' });
    options.providers = {
      coding: { ...provider('agent', 'coder', (input) => pass({ ...input, revision: process.argv[3] })), profile: options.profile.role_profile },
      tests: provider('deterministic', 'node', pass),
      ci: provider('read-only', 'ci', () => process.exit(75)),
      review: provider('agent', 'reviewer', (input) => pass(input)),
    };
    await runIssueLoop(options);
  `;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', childScript,
    new URL('./issue-loop.mjs', import.meta.url).href, JSON.stringify(options), candidate(0)], { stdio: 'ignore' });
  assert.deepEqual(await once(child, 'exit'), [75, null]);

  options.providers.coding.run = () => assert.fail('known candidate must never be redispatched');
  const interrupted = await runIssueLoop(options);
  assert.equal(interrupted.status, 'BLOCKED');
  assert.match(interrupted.next_action, /active or interrupted/);
  assert.equal(interrupted.revision, candidate(0));
  assert.deepEqual(interrupted.checks.map(({ stage, status }) => [stage, status]), [['tests', 'PASS']]);
  // The child is confirmed dead, so the abandoned lock can be reconciled.
  await rmdir(join(options.stateDirectory, interrupted.run_id, 'github-refresh'));
  const resumed = await runIssueLoop(options);
  assert.equal(resumed.status, 'READY');
  assert.equal(resumed.revision, candidate(0));
  assert.equal(resumed.attempts.length, 1);
  assert.ok(resumed.feedback.some(({ event }) => event === 'VERIFICATION_RESUMED'));
  assert.equal(resumed.feedback.filter(({ event }) => event === 'DISPATCH_CLAIM').length, 1);
});

test('runs targeted test, CI and independent review repairs and replays persisted evidence', async (t) => {
  const options = await fixture(t);
  const prompts = [];
  const coding = options.providers.coding.run;
  options.providers.coding.run = (input) => {
    prompts.push(input);
    return coding(input);
  };
  options.providers.tests.run = (input) => input.revision === candidate(0) ? failure(input, 'T01') : pass(input);
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
  options.providers.review.run = (input) => input.revision === candidate(2) ? failure(input, 'task.mjs:12') : pass(input);

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
  const { feedback, ...summary } = report;
  assert.ok(JSON.stringify(summary).length < 4096);
  assert.equal(feedback.filter(({ event }) => event === 'REPAIR_CLAIM').length, 3);
  assert.ok(!JSON.stringify(report).includes('Fix the failing assertion'));
});

test('Gate A requires three unsuccessful repairs after the initial attempt', async (t) => {
  const options = await fixture(t);
  options.providers.tests.run = (input) => failure(input, 'T01');
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
      options.providers.ci.run = (input) => {
        calls += 1;
        return boundResult({ ...input, revision: foreign ? baseline : input.revision }, status);
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
  options.providers.coding.run = async (input) => {
    const { cycle } = input;
    calls += 1;
    started.resolve();
    await release.promise;
    return pass({ ...input, revision: candidate(cycle) });
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
  options.providers.coding.run = (input) => {
    suppliedScope = input.memoryScope;
    return pass({ ...input, revision: candidate(0) });
  };

  assert.equal((await runIssueLoop(options)).status, 'READY');
  assert.deepEqual(suppliedScope, options.profile.memory_scope);
});

test('an explicit provider boundary stops at Gate A without a retry', async (t) => {
  const options = await fixture(t);
  options.providers.review.run = (input) => boundResult(input, 'GATE_A');
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
