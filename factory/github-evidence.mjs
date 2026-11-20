import { hasGitHubActionsProvenance, inspectGitHubChecks, isFreshGitHubTimestamp } from './evidence-adapter.mjs';

const API = 'https://api.github.com/';
const CODEX = 'chatgpt-codex-connector';
const REVIEW_QUERY = `query CandidateReview($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    nameWithOwner
    pullRequest(number: $number) {
      number state headRefOid headRepository { nameWithOwner }
      reviews(first: 100) {
        pageInfo { hasNextPage }
        nodes { id state submittedAt commit { oid } author { login __typename } }
      }
      reviewThreads(first: 100) {
        pageInfo { hasNextPage }
        nodes {
          id isResolved
          comments(first: 1) {
            nodes {
              id body createdAt updatedAt author { login __typename }
              originalCommit { oid } pullRequestReview { id }
            }
          }
        }
      }
    }
  }
}`;

const sha = (value) => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
const id = (value) => typeof value === 'string' && /^[\w=+/\-]{1,128}$/.test(value);
const sameRepo = (actual, expected) => typeof actual === 'string' && actual.toLowerCase() === expected.toLowerCase();
const isCodex = (author) => author?.login === CODEX && author.__typename === 'Bot';
const fullConnection = (value) => value?.pageInfo?.hasNextPage === false && Array.isArray(value.nodes) && value.nodes.length <= 100;
const states = new Set(['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED', 'PENDING']);
const validRepository = (value) => typeof value === 'string' && /^[\w.-]{1,100}\/[\w.-]{1,100}$/.test(value) &&
  value.split('/').every((part) => part !== '.' && part !== '..');
const validPullRequest = (value) => Number.isInteger(value) && value >= 1 && value <= 2_147_483_647;

function findingSeverity(body) {
  if (typeof body !== 'string' || !body.trimEnd().endsWith('<!-- codex-code-review-finding:v1 -->')) return;
  return /^\*\*<sub><sub>!\[(P[0-3]) Badge\]\(https:\/\/img\.shields\.io\/badge\/\1-[a-z]+\?style=flat\)<\/sub><\/sub>/.exec(body)?.[1];
}

function verifyReview(pr, revision, nowMs) {
  const blocked = (reason, details, classification = 'UNRESOLVED') => ({ status: 'BLOCKED', reason, details, classification });
  if (!fullConnection(pr.reviews) || !fullConnection(pr.reviewThreads)) {
    return blocked('GitHub review or thread response is invalid or incomplete');
  }
  const byId = new Map();
  for (const review of pr.reviews.nodes) {
    if (!id(review?.id) || byId.has(review.id) || !states.has(review.state) ||
        (!sha(review.commit?.oid) && (review.state !== 'PENDING' || review.commit != null))) {
      return blocked('GitHub review response has invalid or duplicate entries');
    }
    byId.set(review.id, review);
  }
  const codexReviews = [...byId.values()].filter(({ author }) => isCodex(author));
  const current = codexReviews.filter(({ commit }) => commit?.oid === revision);
  if (codexReviews.some(({ state, commit }) => state === 'PENDING' && (!commit || commit.oid === revision))) {
    return blocked('Codex review is pending', undefined, 'PENDING');
  }
  if (current.length === 0) {
    const priorReviews = codexReviews.filter(({ commit }) => sha(commit?.oid));
    return blocked('no trusted Codex review is bound to the candidate SHA',
      { prior_reviews: priorReviews.map(({ id, commit }) => ({ id, sha: commit.oid })) },
      priorReviews.length ? 'STALE' : 'PENDING');
  }
  if (current.length !== 1) return blocked('multiple trusted Codex reviews are bound to the candidate SHA');
  const [review] = current;
  if (!isFreshGitHubTimestamp(review.submittedAt, nowMs)) {
    return blocked('Codex review completion is stale or invalid', { review_id: review.id }, 'STALE');
  }
  const details = {
    author: CODEX, review_id: review.id, state: review.state, submitted_at: review.submittedAt, findings: [],
  };
  if (review.state === 'DISMISSED') return blocked('Codex review was dismissed', details);
  const threadIds = new Set();
  const commentIds = new Set();
  const findings = [];
  for (const thread of pr.reviewThreads.nodes) {
    const roots = thread?.comments?.nodes;
    const comment = Array.isArray(roots) && roots.length === 1 ? roots[0] : null;
    if (!id(thread?.id) || threadIds.has(thread.id) || typeof thread.isResolved !== 'boolean' ||
        !id(comment?.id) || commentIds.has(comment.id)) {
      return blocked('GitHub review thread lacks a unique root comment or resolution state', details);
    }
    threadIds.add(thread.id);
    commentIds.add(comment.id);
    const fromReview = comment.pullRequestReview?.id === review.id;
    const fromCandidate = isCodex(comment.author) && comment.originalCommit?.oid === revision;
    if (!fromReview && !fromCandidate) continue;
    if (!fromReview || !fromCandidate || typeof comment.body !== 'string' ||
        !isFreshGitHubTimestamp(comment.createdAt, nowMs) || comment.updatedAt !== comment.createdAt) {
      return blocked('Codex review comment has mismatched or unverifiable provenance', details);
    }
    const severity = findingSeverity(comment.body);
    if (!severity) {
      return blocked('Codex finding format is unrecognized', details);
    }
    if (thread.isResolved || severity === 'P3') continue;
    if (findings.length === 8) return blocked('Codex findings exceed the repair evidence limit', details);
    details.findings.push({ thread_id: thread.id, comment_id: comment.id, severity });
    findings.push({ id: comment.id, summary: `Resolve the open Codex ${severity} finding in GitHub` });
  }
  if (findings.length) return { status: 'FAIL', findings, details };
  if (review.state !== 'APPROVED') return blocked('Codex review has no verifiable approval for the candidate SHA', details);
  return { status: 'PASS', details };
}

function actionsJobToken(repository) {
  const { GITHUB_ACTIONS, GITHUB_REPOSITORY, GITHUB_TOKEN, GH_TOKEN } = process.env;
  return GITHUB_ACTIONS === 'true' && sameRepo(GITHUB_REPOSITORY, repository) ? GITHUB_TOKEN || GH_TOKEN : undefined;
}

export function hasGitHubEvidenceCredential(repository) {
  return Boolean(actionsJobToken(repository));
}

function createGitHubEvidenceClient(fetchImpl) {
  const mode = fetchImpl === undefined ? 'LIVE' : 'SIMULATION';
  const request = mode === 'LIVE' ? globalThis.fetch : fetchImpl;
  const source = mode === 'LIVE' ? 'github.com:read-only' : 'fixture:github-api';

  async function read(endpoint, { repository, signal, query, variables }) {
    const token = mode === 'LIVE' ? actionsJobToken(repository) : undefined;
    if (mode === 'LIVE' && !token) {
      return { ok: false, reason: 'missing GitHub Actions job token for the approved repository' };
    }
    const headers = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' };
    if (mode === 'LIVE') headers.authorization = `Bearer ${token}`;
    if (query) headers['content-type'] = 'application/json';
    try {
      const response = await request(API + endpoint, {
        headers, redirect: 'error', cache: 'no-store',
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
        method: query ? 'POST' : 'GET',
        body: query ? JSON.stringify({ query, variables }) : undefined,
      });
      if (!response.ok) {
        const permission = endpoint.includes('/check-runs?') ? 'checks: read' : 'pull-requests: read';
        const reason = [401, 403, 404].includes(response.status)
          ? `GitHub API HTTP ${response.status}; verify job token access (${permission})`
          : `GitHub API request failed (HTTP ${Number.isInteger(response.status) ? response.status : 'unknown'})`;
        let permissionDenied = false;
        if (response.status === 403) {
          const error = await response.json().catch(() => null);
          permissionDenied = error?.message === 'Resource not accessible by integration';
        }
        return { ok: false, reason, permissionDenied };
      }
      const value = await response.json();
      if (query && value?.errors !== undefined) {
        const denied = Array.isArray(value.errors) && value.errors.some((error) =>
          ['FORBIDDEN', 'UNAUTHORIZED', 'INSUFFICIENT_SCOPES'].includes(error?.type));
        return {
          ok: false, permissionDenied: denied,
          reason: denied ? 'GitHub GraphQL denied pull-request read access' : 'GitHub GraphQL returned errors',
        };
      }
      return { ok: true, value };
    } catch {
      return { ok: false, reason: 'GitHub API response was unavailable or invalid' };
    }
  }
  return { mode, source, read };
}

/** Use the Actions job token on GitHub.com. An injected API transport is always simulated. */
export function createGitHubEvidenceProviders({ pullRequest, fetchImpl } = {}) {
  const { mode, source, read } = createGitHubEvidenceClient(fetchImpl);
  function provider(kind, principal, inspect) {
    return {
      mode, kind, principal,
      async run(input, { signal } = {}) {
        const { repository, revision } = input;
        const options = { repository, signal };
        if (!validRepository(repository) || !sha(revision) || !validPullRequest(pullRequest)) {
          return { revision, status: 'BLOCKED', reason: 'invalid approved repository, PR number or candidate SHA' };
        }
        const { details, ...result } = await inspect(input, options);
        return {
          ...result, revision,
          evidence: { mode, source, repository, pull_request: pullRequest, observed_at: new Date().toISOString(), ...details },
        };
      },
    };
  }

  async function readCandidateHead({ repository, revision }, options) {
    const response = await read(`repos/${repository}/pulls/${pullRequest}`, options);
    if (!response.ok) return { status: 'BLOCKED', reason: response.reason };
    const pr = response.value;
    if (!sameRepo(pr?.base?.repo?.full_name, repository) || !sameRepo(pr?.head?.repo?.full_name, repository) ||
        pr.number !== pullRequest || pr.state !== 'open' || !sha(pr.head.sha)) {
      return { status: 'BLOCKED', reason: 'GitHub pull request does not match the repository and candidate head' };
    }
    if (pr.head.sha !== revision) return {
      status: 'BLOCKED', classification: 'STALE', details: { observed_head_sha: pr.head.sha },
      reason: 'GitHub pull request does not match the repository and candidate head',
    };
    return null;
  }

  const ci = provider('read-only', 'github-actions', async (input, options) => {
    const blocked = await readCandidateHead(input, options);
    if (blocked) return blocked;
    const { checks, ...result } = await inspectGitHubChecks({
      ...input, ...options, read: (endpoint) => read(endpoint, options),
    });
    const details = checks ? { app: 'github-actions', app_id: 15368, checks } : undefined;
    if (result.status === 'FAIL') {
      // A failing check can authorize a repair without going through the review provider's head check.
      const changed = await readCandidateHead(input, options);
      if (changed) return { ...changed, details: { ...details, ...changed.details } };
    }
    return { ...result, details };
  });

  const review = provider('read-only', CODEX, async ({ repository, revision }, options) => {
    const [owner, name] = repository.split('/');
    const response = await read('graphql', {
      ...options, query: REVIEW_QUERY, variables: { owner, name, number: pullRequest },
    });
    if (!response.ok) return { status: 'BLOCKED', reason: response.reason };
    const repo = response.value?.data?.repository;
    const pr = repo?.pullRequest;
    if (!sameRepo(repo?.nameWithOwner, repository) || !sameRepo(pr?.headRepository?.nameWithOwner, repository) ||
        pr.number !== pullRequest || pr.state !== 'OPEN' || !sha(pr.headRefOid)) {
      return { status: 'BLOCKED', reason: 'GitHub review is for a different repository, PR or candidate head' };
    }
    if (pr.headRefOid !== revision) return {
      status: 'BLOCKED', classification: 'STALE', details: { observed_head_sha: pr.headRefOid },
      reason: 'GitHub review is for a different repository, PR or candidate head',
    };
    return verifyReview(pr, revision, Date.now());
  });
  return { ci, review };
}

/** Read historical evidence without producing an issue-loop verdict. */
export async function observeMergedGitHubEvidence({
  repository, pullRequest, revision, mergeCommit, requiredCheck, fetchImpl,
} = {}) {
  const { mode, source, read } = createGitHubEvidenceClient(fetchImpl);
  const report = { mode, source, authorization: 'BLOCKED' };
  const fail = (reason, permissionDenied) => ({
    ...report, evidence_read: 'BLOCKED', reason, ...(permissionDenied ? { permission_denied: true } : {}),
  });
  if (!validRepository(repository) || !validPullRequest(pullRequest) || !sha(revision) ||
      !sha(mergeCommit) || revision === mergeCommit || typeof requiredCheck !== 'string' ||
      !/^[\w .-]{1,128}$/.test(requiredCheck)) {
    return fail('Invalid merged PR evidence target');
  }
  const now = new Date();
  const validTimestamp = (value) => typeof value === 'string' &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value) && Date.parse(value) <= now.getTime();
  const options = { repository };
  const prResponse = await read(`repos/${repository}/pulls/${pullRequest}`, options);
  if (!prResponse.ok) return fail(prResponse.reason, prResponse.permissionDenied);
  const pr = prResponse.value;
  if (!sameRepo(pr?.base?.repo?.full_name, repository) || !sameRepo(pr?.head?.repo?.full_name, repository) ||
      pr.number !== pullRequest || pr.state !== 'closed' || pr.merged !== true || pr.base.ref !== 'main' ||
      pr.head.sha !== revision || pr.merge_commit_sha !== mergeCommit || !validTimestamp(pr.merged_at)) {
    return fail('GitHub merged PR does not match the repository, candidate and main merge');
  }
  Object.assign(report, {
    repository, pull_request: pullRequest, candidate_sha: revision, merge_sha: mergeCommit, observed_at: now.toISOString(),
  });

  const [owner, name] = repository.split('/');
  const [checks, graph] = await Promise.all([
    read(`repos/${repository}/commits/${revision}/check-runs?filter=latest&per_page=100`, options),
    read('graphql', { ...options, query: REVIEW_QUERY, variables: { owner, name, number: pullRequest } }),
  ]);
  if (!checks.ok) return fail(checks.reason, checks.permissionDenied);
  const { check_runs: runs, total_count: count } = checks.value ?? {};
  if (!Array.isArray(runs) || runs.length !== count || count > 100) {
    return fail('GitHub check-run response is invalid or incomplete');
  }
  const matches = runs.filter((run) => run?.name === requiredCheck);
  const [check] = matches;
  if (matches.length !== 1 || check.head_sha !== revision || !hasGitHubActionsProvenance(check, repository) ||
      check.status !== 'completed' || !['success', 'failure'].includes(check.conclusion) ||
      !validTimestamp(check.completed_at)) {
    return fail('Required GitHub Actions check is missing, incomplete or has unverified provenance');
  }
  report.ci = {
    id: check.id, name: requiredCheck, app: 'github-actions', app_id: 15368,
    conclusion: check.conclusion, completed_at: check.completed_at,
  };

  if (!graph.ok) return fail(graph.reason, graph.permissionDenied);
  const repo = graph.value?.data?.repository;
  const reviewed = repo?.pullRequest;
  if (!sameRepo(repo?.nameWithOwner, repository) || !sameRepo(reviewed?.headRepository?.nameWithOwner, repository) ||
      reviewed.number !== pullRequest || reviewed.state !== 'MERGED' || reviewed.headRefOid !== revision ||
      !fullConnection(reviewed.reviews) || !fullConnection(reviewed.reviewThreads)) {
    return fail('GitHub merged PR review response is mismatched, invalid or incomplete');
  }
  const reviews = new Map();
  const reviewIds = new Set();
  for (const item of reviewed.reviews.nodes) {
    if (!id(item?.id) || reviewIds.has(item.id) || !states.has(item.state)) {
      return fail('GitHub review response has invalid or duplicate entries');
    }
    reviewIds.add(item.id);
    if (!isCodex(item.author)) continue;
    if (!sha(item.commit?.oid) || !validTimestamp(item.submittedAt)) {
      return fail('Codex review lacks a verifiable commit or submission time');
    }
    reviews.set(item.id, {
      id: item.id, sha: item.commit.oid, state: item.state, submitted_at: item.submittedAt,
    });
  }
  if (reviews.size === 0) return fail('No trusted Codex review was found on the merged PR');
  const findings = [];
  const threadIds = new Set();
  const commentIds = new Set();
  for (const thread of reviewed.reviewThreads.nodes) {
    const roots = thread?.comments?.nodes;
    const comment = Array.isArray(roots) && roots.length === 1 ? roots[0] : null;
    if (!id(thread?.id) || threadIds.has(thread.id) || typeof thread.isResolved !== 'boolean' ||
        !id(comment?.id) || commentIds.has(comment.id)) {
      return fail('GitHub review thread lacks a unique root comment or resolution state');
    }
    threadIds.add(thread.id);
    commentIds.add(comment.id);
    const review = reviews.get(comment.pullRequestReview?.id);
    if (!review && !isCodex(comment.author)) continue;
    const severity = findingSeverity(comment.body);
    if (!review || !isCodex(comment.author) || comment.originalCommit?.oid !== review.sha ||
        !validTimestamp(comment.createdAt) || comment.updatedAt !== comment.createdAt || !severity) {
      return fail('Codex finding has invalid format or unverified review and SHA provenance');
    }
    findings.push({
      thread_id: thread.id, comment_id: comment.id, review_id: review.id,
      sha: review.sha, severity, resolved: thread.isResolved,
    });
  }
  const observedReviews = [...reviews.values()];
  return {
    ...report, evidence_read: 'PASS',
    review: {
      author: CODEX, reviews: observedReviews, findings,
      candidate_reviews: observedReviews.filter((review) => review.sha === revision).length,
      candidate_findings: findings.filter((finding) => finding.sha === revision).length,
    },
  };
}
