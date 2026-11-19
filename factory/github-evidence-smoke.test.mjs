import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { observeMergedGitHubEvidence } from './github-evidence.mjs';

const repository = 'test/factory';
const revision = '1'.repeat(40);
const mergeCommit = '2'.repeat(40);
const previous = '3'.repeat(40);
const requiredCheck = 'Node 22 Tests';
const target = { repository, pullRequest: 4, revision, mergeCommit, requiredCheck };
const timestamp = '2020-01-01T00:00:00Z';
const author = { login: 'chatgpt-codex-connector', __typename: 'Bot' };
const connection = (nodes) => ({ nodes, pageInfo: { hasNextPage: false } });

function fixture(mutate = () => {}) {
  const pr = {
    number: 4, state: 'closed', merged: true, merged_at: timestamp, merge_commit_sha: mergeCommit,
    base: { ref: 'main', repo: { full_name: repository } },
    head: { sha: revision, repo: { full_name: repository } },
  };
  const check = {
    id: 101, name: requiredCheck, head_sha: revision, status: 'completed', conclusion: 'success',
    completed_at: timestamp, app: { id: 15368, slug: 'github-actions' },
    url: `https://api.github.com/repos/${repository}/check-runs/101`,
  };
  const review = { id: 'PRR_1', state: 'COMMENTED', commit: { oid: previous }, submittedAt: timestamp, author };
  const comment = {
    id: 'PRRC_1', author, originalCommit: { oid: previous }, pullRequestReview: { id: review.id },
    createdAt: timestamp, updatedAt: timestamp,
    body: '**<sub><sub>![P1 Badge](https://img.shields.io/badge/P1-orange?style=flat)</sub></sub> private finding\n<!-- codex-code-review-finding:v1 -->',
  };
  const reviewPr = {
    number: 4, state: 'MERGED', headRefOid: revision, headRepository: { nameWithOwner: repository },
    reviews: connection([review]),
    reviewThreads: connection([{ id: 'PRRT_1', isResolved: false, comments: { nodes: [comment] } }]),
  };
  const checks = { total_count: 1, check_runs: [check] };
  const graph = { data: { repository: { nameWithOwner: repository, pullRequest: reviewPr } } };
  const responses = new Map([
    ['/repos/test/factory/pulls/4', pr],
    [`/repos/test/factory/commits/${revision}/check-runs?filter=latest&per_page=100`, checks],
    ['/graphql', graph],
  ]);
  const calls = [];
  const fetchImpl = async (url, request) => {
    const parsed = new URL(url);
    const path = parsed.pathname + parsed.search;
    calls.push({ path, origin: parsed.origin, method: request.method, authorization: request.headers.authorization });
    const status = mutate({ path, pr, checks, check, graph, reviewPr, review, comment }) ?? 200;
    return { ok: status === 200, status, json: async () => responses.get(path) };
  };
  return { run: () => observeMergedGitHubEvidence({ ...target, fetchImpl }), calls };
}

test('reads historical CI, Codex reviews and findings without upgrading COMMENTED or logging bodies', async () => {
  const { run, calls } = fixture();
  const report = await run();
  assert.deepEqual(calls.map(({ method }) => method), ['GET', 'GET', 'POST']);
  assert.ok(calls.every(({ origin, authorization }) => origin === 'https://api.github.com' && authorization === undefined));
  assert.equal(report.evidence_read, 'PASS');
  assert.equal(report.mode, 'SIMULATION');
  assert.equal(report.source, 'fixture:github-api');
  assert.equal(report.authorization, 'BLOCKED');
  assert.equal(report.candidate_sha, revision);
  assert.equal(report.merge_sha, mergeCommit);
  assert.equal(report.ci.id, 101);
  assert.equal(report.review.candidate_reviews, 0);
  assert.equal(report.review.candidate_findings, 0);
  assert.deepEqual(report.review.reviews[0], { id: 'PRR_1', sha: previous, state: 'COMMENTED', submitted_at: timestamp });
  assert.deepEqual(report.review.findings[0], {
    thread_id: 'PRRT_1', comment_id: 'PRRC_1', review_id: 'PRR_1', sha: previous, severity: 'P1', resolved: false,
  });
  assert.doesNotMatch(JSON.stringify(report), /private finding/);
});

test('a candidate-bound receipt and finding leave authorization blocked', async () => {
  const report = await fixture(({ review, comment }) => {
    review.commit.oid = revision;
    comment.originalCommit.oid = revision;
  }).run();
  assert.equal(report.evidence_read, 'PASS');
  assert.equal(report.review.candidate_reviews, 1);
  assert.equal(report.review.candidate_findings, 1);
  assert.equal(report.authorization, 'BLOCKED');
});

test('rejects missing permissions, malformed evidence and substituted provenance', async (t) => {
  const cases = [
    ['PR token denied', ({ path }) => path.endsWith('/pulls/4') ? 401 : 200, /pull-requests: read/],
    ['Checks token denied', ({ path }) => path.includes('/check-runs?') ? 403 : 200, /checks: read/],
    ['GraphQL permission denied', ({ graph }) => { graph.errors = [{ type: 'FORBIDDEN', message: 'private response' }]; }, /denied pull-request read access/],
    ['Different merge', ({ pr }) => { pr.merge_commit_sha = previous; }, /does not match/],
    ['Different repository', ({ pr }) => { pr.head.repo.full_name = 'other/factory'; }, /does not match/],
    ['Different check SHA', ({ check }) => { check.head_sha = mergeCommit; }, /unverified provenance/],
    ['Unexpected check app', ({ check }) => { check.app.id = 999; }, /unverified provenance/],
    ['Incomplete checks', ({ checks }) => { checks.total_count = 3; }, /invalid or incomplete/],
    ['Incomplete reviews', ({ reviewPr }) => { reviewPr.reviews.pageInfo.hasNextPage = true; }, /invalid or incomplete/],
    ['Mismatched review head', ({ reviewPr }) => { reviewPr.headRefOid = mergeCommit; }, /mismatched/],
    ['Mismatched finding SHA', ({ comment }) => { comment.originalCommit.oid = revision; }, /unverified review and SHA/],
  ];
  for (const [name, mutate, reason] of cases) {
    await t.test(name, async () => {
      const report = await fixture(mutate).run();
      assert.equal(report.evidence_read, 'BLOCKED');
      assert.equal(report.authorization, 'BLOCKED');
      assert.match(report.reason, reason);
      assert.doesNotMatch(JSON.stringify(report), /private response|private finding/);
    });
  }
});

test('rejects equal candidate and merge SHAs and disallows a non-main dispatch', async () => {
  const report = await observeMergedGitHubEvidence({ ...target, mergeCommit: revision });
  assert.equal(report.evidence_read, 'BLOCKED');
  assert.match(report.reason, /Invalid merged PR evidence target/);

  const result = spawnSync(process.execPath, ['factory/github-evidence-smoke.mjs'], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8',
    env: {
      GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/topic',
      GITHUB_REPOSITORY: 'hurintaipei101/Graptify-Factory', GITHUB_TOKEN: 'fixture-token',
    },
  });
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).evidence_read, 'BLOCKED');
  assert.doesNotMatch(result.stdout + result.stderr, /fixture-token/);
});
