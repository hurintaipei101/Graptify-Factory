import { evaluateIssue } from './controller.mjs';
import { execFile } from 'node:child_process';

const SHA = /^[0-9a-f]{40,64}$/i;
export const GITHUB_EVIDENCE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export class EvidenceAdapterError extends Error {
  constructor(message) { super(message); this.name = 'EvidenceAdapterError'; }
}

const GH_ENDPOINTS = Object.freeze({
  commit: (repo, ref) => `repos/${repo}/commits/${ref}`,
  checks: (repo, sha) => `repos/${repo}/commits/${sha}/check-runs`,
  protection: (repo, branch) => `repos/${repo}/branches/${branch}/protection`,
});

const LINEAR_ENDPOINT = 'https://api.linear.app/graphql';
const LINEAR_BATCH_LIMIT = 4;
const LINEAR_IDENTIFIER = /^[A-Z][A-Z0-9]*-\d+$/;
const LINEAR_QUERY = `query IssuesByIdentifiers($identifiers: [String!]!) {
  issues(filter: { identifier: { in: $identifiers } }) {
    nodes { id identifier url title updatedAt state { name } }
  }
}`;

function ghRead(execCommand, endpoint) {
  return new Promise((resolve) => {
    const callback = (error, stdout = '', stderr = '') => {
      if (error) return resolve({ ok: false, error, stdout, stderr });
      try { resolve({ ok: true, value: JSON.parse(stdout) }); }
      catch (parseError) { resolve({ ok: false, error: parseError, stdout, stderr }); }
    };
    try {
      const result = execCommand(['api', endpoint, '--method', 'GET'], callback);
      if (result?.then) result.then((value) => callback(null, typeof value === 'string' ? value : JSON.stringify(value))).catch((error) => callback(error));
    } catch (error) { callback(error); }
  });
}

function defaultGh(args, callback) { execFile('gh', args, { encoding: 'utf8', windowsHide: true }, callback); }

/** Read the latest exact-revision GitHub check runs without AI or write access. */
export async function inspectGitHubChecks({
  issueKey, linearIssueId, repository, approvalDigest, memoryScope, revision, requiredChecks, signal, execCommand, read,
} = {}) {
  const binding = issueKey === undefined ? {} : { issueKey, linearIssueId, repository, approvalDigest, memoryScope };
  const result = (status, extras) => ({ ...binding, revision, status, ...extras });
  if (typeof repository !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(repository) ||
      repository.split('/').some((part) => part === '.' || part === '..') ||
      typeof revision !== 'string' || !/^[0-9a-f]{40}$/.test(revision) ||
      !Array.isArray(requiredChecks) || requiredChecks.length === 0 || requiredChecks.length > 24 ||
      [...requiredChecks].some((name) => typeof name !== 'string' || !name || name.length > 128) || signal?.aborted) {
    return result('BLOCKED');
  }
  const command = execCommand ?? ((args, callback) => execFile('gh', args, {
    encoding: 'utf8', windowsHide: true, timeout: 10_000, maxBuffer: 262_144, killSignal: 'SIGKILL', signal,
  }, callback));
  const endpoint = `${GH_ENDPOINTS.checks(repository, revision)}?filter=latest&per_page=100`;
  const response = read ? await read(endpoint) : await ghRead(command, endpoint);
  const nowMs = Date.now();
  const { check_runs: runs, total_count: count } = response.value ?? {};
  if (!response.ok) return result('BLOCKED', { reason: response.reason });
  if (!Array.isArray(runs) || count !== runs.length || count > 100 || signal?.aborted) {
    return result('BLOCKED', { reason: 'GitHub check-run response is invalid or incomplete' });
  }
  const findings = [];
  const checks = [];
  const missing = [];
  let pending = false;
  for (const name of requiredChecks) {
    const matches = runs.filter((run) => run?.name === name);
    if (matches.length > 1) return result('BLOCKED', { reason: 'required GitHub check name is ambiguous' });
    const [check] = matches;
    if (!check) {
      missing.push(name);
      continue;
    }
    if (check.head_sha !== revision) return result('BLOCKED', {
      reason: 'GitHub check run is for a different SHA', classification: 'STALE',
    });
    if (read && (!hasGitHubActionsProvenance(check, repository) || checks.some(({ id }) => id === check.id))) {
      return result('BLOCKED', { reason: 'required check run has unverified GitHub Actions provenance' });
    }
    if (['queued', 'in_progress', 'pending', 'requested', 'waiting'].includes(check.status)) {
      pending = true;
      if (read) checks.push({ id: check.id, name, status: check.status });
      continue;
    }
    if (check.status !== 'completed' || !['success', 'failure'].includes(check.conclusion)) {
      return result('BLOCKED', { reason: 'required GitHub check has no usable conclusion' });
    }
    if (read) {
      if (!isFreshGitHubTimestamp(check.completed_at, nowMs)) {
        return result('BLOCKED', {
          reason: 'required GitHub check has a stale or invalid completion time', classification: 'STALE',
        });
      }
      checks.push({ id: check.id, name, conclusion: check.conclusion, completed_at: check.completed_at });
    }
    if (check.conclusion === 'failure') findings.push({ id: name, summary: 'Required GitHub check failed' });
  }
  const metadata = read ? { checks } : {};
  if (findings.length > 0) return result('FAIL', { ...metadata, findings });
  if (missing.length) return result('PENDING', { ...metadata, reason: 'required GitHub check runs are missing' });
  return result(pending ? 'PENDING' : 'PASS', metadata);
}

export function hasGitHubActionsProvenance(check, repository) {
  return Number.isSafeInteger(check.id) && check.id > 0 && check.app?.id === 15368 &&
    check.app?.slug === 'github-actions' && typeof check.url === 'string' &&
    check.url.toLowerCase() === `https://api.github.com/repos/${repository}/check-runs/${check.id}`.toLowerCase();
}

export function isFreshGitHubTimestamp(value, nowMs) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value)) return false;
  const parsed = Date.parse(value);
  return parsed <= nowMs && nowMs - parsed <= GITHUB_EVIDENCE_MAX_AGE_MS;
}

/** Collect only read-only GitHub evidence. No successful CI result implies protection. */
export async function collectGitHubEvidence({ repository, branch = 'main', ref = branch, requiredChecks = [], nowMs = Date.now(), execCommand = defaultGh } = {}) {
  const observedAt = new Date(nowMs).toISOString();
  const notVerified = (sha = null) => ({ source: 'gh:api:read-only', timestamp: observedAt, repository, sha, ci: { sha, conclusion: 'UNKNOWN' }, protection: { repository, requiredChecksEnforced: false, verified: false } });
  if (typeof repository !== 'string' || !/^[^/]+\/[^/]+$/.test(repository) || typeof branch !== 'string' || typeof ref !== 'string' || !Array.isArray(requiredChecks)) return notVerified();
  const commit = await ghRead(execCommand, GH_ENDPOINTS.commit(repository, ref));
  const shaValue = commit.ok && typeof commit.value?.sha === 'string' && SHA.test(commit.value.sha) ? commit.value.sha : null;
  if (!shaValue) return notVerified();
  const [checks, protection] = await Promise.all([
    ghRead(execCommand, GH_ENDPOINTS.checks(repository, shaValue)),
    ghRead(execCommand, GH_ENDPOINTS.protection(repository, branch)),
  ]);
  const runs = checks.ok && Array.isArray(checks.value?.check_runs) ? checks.value.check_runs : [];
  const ciPass = runs.length > 0 && requiredChecks.every((name) => runs.some((run) => run?.name === name && run?.head_sha === shaValue && run?.conclusion === 'success'));
  const contexts = protection.ok && Array.isArray(protection.value?.required_status_checks?.contexts) ? protection.value.required_status_checks.contexts : null;
  const protectionVerified = Boolean(protection.ok && contexts && requiredChecks.length > 0 && requiredChecks.every((name) => contexts.includes(name)));
  return {
    source: 'gh:api:read-only', timestamp: observedAt, repository, sha: shaValue,
    ci: { sha: shaValue, conclusion: ciPass ? 'success' : 'UNKNOWN' },
    protection: { repository, requiredChecksEnforced: protectionVerified, verified: protectionVerified },
  };
}

function fail(message) { throw new EvidenceAdapterError(message); }
function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`malformed ${name}`);
  return value;
}
function timestamp(value, name, nowMs, maxAgeMs) {
  const parsed = Date.parse(value);
  if (typeof value !== 'string' || !Number.isFinite(parsed)) fail(`malformed ${name} timestamp`);
  if (parsed > nowMs || nowMs - parsed > maxAgeMs) fail(`stale ${name} evidence`);
  return value;
}
function source(value, name) {
  if (typeof value !== 'string' || value.length === 0) fail(`missing ${name} source`);
  return value;
}
function sha(value, name) {
  if (typeof value !== 'string' || !SHA.test(value)) fail(`malformed ${name} SHA`);
  return value;
}
function bool(value, name) { if (typeof value !== 'boolean') fail(`malformed ${name}`); return value; }

function normalizeLinearDependency(value) {
  if (typeof value === 'string' && value) return { key: value, status: 'UNKNOWN' };
  if (!value || typeof value !== 'object' || typeof value.key !== 'string' || !value.key) return { key: String(value?.key ?? 'UNKNOWN'), status: 'UNKNOWN' };
  return { key: value.key, status: typeof value.status === 'string' && value.status ? value.status : 'UNKNOWN' };
}

/** Normalize one injected, read-only Linear issue response. No live connector is assumed. */
export function normalizeLinearEvidence(raw, { nowMs, maxAgeMs = 24 * 60 * 60 * 1000 } = {}) {
  if (!Number.isInteger(nowMs) || !Number.isInteger(maxAgeMs) || maxAgeMs < 0) fail('invalid clock options');
  object(raw, 'Linear issue response');
  const issueKey = typeof raw.identifier === 'string' && raw.identifier ? raw.identifier : raw.issueKey;
  if (typeof issueKey !== 'string' || !issueKey) fail('missing Linear issue key');
  const observedAt = raw.observedAt ?? raw.timestamp;
  const linearTimestamp = timestamp(observedAt, 'Linear', nowMs, maxAgeMs);
  const linearSource = source(raw.source ?? 'linear:read-only:injected', 'Linear');
  const dependencies = (Array.isArray(raw.dependencies) ? raw.dependencies : []).map(normalizeLinearDependency);
  return {
    source: linearSource,
    timestamp: linearTimestamp,
    issueKey,
    id: raw.id ?? null,
    url: raw.url ?? null,
    status: typeof raw.status === 'string' && raw.status ? raw.status : 'UNKNOWN',
    dependencies,
    evidence: raw.evidence && typeof raw.evidence === 'object' && !Array.isArray(raw.evidence) ? { ...raw.evidence } : {},
  };
}

/** Collect exactly one issue through a caller-supplied read-only connector. */
export async function collectLinearEvidence({ issueKey, fetchIssue, nowMs = Date.now(), maxAgeMs = 24 * 60 * 60 * 1000 } = {}) {
  const observedAt = new Date(nowMs).toISOString();
  if (typeof issueKey !== 'string' || !issueKey || typeof fetchIssue !== 'function') {
    return { source: 'linear:read-only:injected', timestamp: observedAt, issueKey, status: 'UNKNOWN', dependencies: [], evidence: {}, available: false };
  }
  try {
    const raw = await fetchIssue(issueKey);
    if (!raw || typeof raw !== 'object') throw new Error('Linear unavailable');
    return { ...normalizeLinearEvidence({ ...raw, issueKey, observedAt, source: raw.source ?? 'linear:read-only:injected' }, { nowMs, maxAgeMs }), available: true };
  } catch {
    return { source: 'linear:read-only:injected', timestamp: observedAt, issueKey, status: 'UNKNOWN', dependencies: [], evidence: {}, available: false };
  }
}

function linearNotVerified(issueKeys, observedAt, error = 'NOT_VERIFIED') {
  return Object.fromEntries(issueKeys.map((issueKey) => [issueKey, {
    source: 'linear:graphql:read-only', timestamp: observedAt, issueKey,
    id: null, url: null, title: null, updatedAt: null, status: 'UNKNOWN',
    dependencies: [], evidence: {}, available: false, verification: 'NOT_VERIFIED', error,
  }]));
}

/** Collect a bounded, read-only Linear batch using actual issue identifiers as GraphQL variables. */
export async function collectLinearEvidenceBatch({ issueKeys = ['HIE-14', 'HIE-15', 'HIE-16', 'HIE-17'], credential, fetch: injectedFetch, fetchImpl = injectedFetch ?? globalThis.fetch, nowMs = Date.now(), maxAgeMs = 24 * 60 * 60 * 1000 } = {}) {
  const observedAt = new Date(nowMs).toISOString();
  const keys = Array.isArray(issueKeys) ? [...new Set(issueKeys)] : [];
  if (keys.length === 0 || keys.length > LINEAR_BATCH_LIMIT || keys.some((key) => typeof key !== 'string' || !LINEAR_IDENTIFIER.test(key)) || typeof credential !== 'string' || !credential || typeof fetchImpl !== 'function') return linearNotVerified(keys, observedAt, 'invalid-input-or-missing-credential');
  try {
    const response = await fetchImpl(LINEAR_ENDPOINT, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${credential}` },
      body: JSON.stringify({ query: LINEAR_QUERY, variables: { identifiers: keys } }),
    });
    if (!response || !response.ok || response.status === 429) throw new Error('HTTP error or rate limit');
    const payload = await response.json();
    object(payload, 'Linear GraphQL response');
    if (Array.isArray(payload.errors) && payload.errors.length) throw new Error('GraphQL errors');
    const nodes = payload.data?.issues?.nodes;
    if (!Array.isArray(nodes) || nodes.length !== keys.length) throw new Error('partial GraphQL response');
    const byKey = new Map();
    for (const node of nodes) {
      object(node, 'Linear issue');
      if (typeof node.identifier !== 'string' || !keys.includes(node.identifier) || byKey.has(node.identifier) || typeof node.id !== 'string' || !node.id || typeof node.url !== 'string' || !node.url || typeof node.title !== 'string' || !node.title || typeof node.updatedAt !== 'string' || !node.updatedAt || !node.state || typeof node.state.name !== 'string' || !node.state.name) throw new Error('malformed or mismatched Linear issue');
      const updatedAt = timestamp(node.updatedAt, 'Linear issue update', nowMs, maxAgeMs);
      byKey.set(node.identifier, { source: 'linear:graphql:read-only', timestamp: observedAt, issueKey: node.identifier, id: node.id, url: node.url, title: node.title, updatedAt, status: node.state.name, dependencies: [], evidence: {}, available: true, verification: 'VERIFIED' });
    }
    if (byKey.size !== keys.length) throw new Error('partial GraphQL response');
    return Object.fromEntries(keys.map((key) => [key, byKey.get(key)]));
  } catch (error) { return linearNotVerified(keys, observedAt, error?.message ?? 'NOT_VERIFIED'); }
}

/** Normalize offline Linear/GitHub evidence and evaluate it through F2-02. */
export function adaptEvidence(input, { nowMs, maxAgeMs = 24 * 60 * 60 * 1000 } = {}) {
  if (!Number.isInteger(nowMs) || !Number.isInteger(maxAgeMs) || maxAgeMs < 0) fail('invalid clock options');
  object(input, 'evidence input');
  const issue = object(input.issue, 'issue');
  const linear = object(input.linear, 'Linear');
  const github = object(input.github, 'GitHub');
  const issueKey = typeof issue.issueKey === 'string' && issue.issueKey ? issue.issueKey : fail('missing issue key');
  if (linear.issueKey !== issueKey) fail('contradictory issue key evidence');
  const linearTimestamp = timestamp(linear.timestamp, 'Linear', nowMs, maxAgeMs);
  const githubTimestamp = timestamp(github.timestamp, 'GitHub', nowMs, maxAgeMs);
  const linearSource = source(linear.source, 'Linear');
  const githubSource = source(github.source, 'GitHub');
  const repository = typeof github.repository === 'string' && github.repository ? github.repository : fail('missing repository');
  const commitSha = sha(github.sha, 'repository');
  const ci = object(github.ci, 'CI');
  const protection = object(github.protection, 'protection');
  if (ci.sha !== commitSha) fail('CI evidence belongs to a different commit');
  if (protection.repository !== repository) fail('contradictory repository evidence');
  const ciSuccess = ci.conclusion === 'success' || ci.status === 'SUCCESS';
  const checksEnforced = protection.requiredChecksEnforced === true && protection.verified === true;
  const normalized = {
    ...issue,
    issueKey,
    dependencies: linear.dependencies,
    dependencyStatus: Object.fromEntries((linear.dependencies ?? []).map((d) => [d.key, d.status])),
    linearIssue: { id: linear.id ?? null, url: linear.url ?? null, status: linear.status ?? 'UNKNOWN' },
    evidence: { ...(issue.evidence ?? {}), ...(linear.evidence ?? {}), architecture: linear.evidence?.architecture === true, ciProtection: checksEnforced },
    requiredEvidence: issue.requiredEvidence ?? ['architecture', 'ciProtection'],
    githubChecksOperationallyVerified: ciSuccess && checksEnforced,
    evidenceMetadata: {
      linear: { source: linearSource, timestamp: linearTimestamp },
      github: { source: githubSource, timestamp: githubTimestamp, repository, sha: commitSha },
    },
  };
  if (issue.environment === 'production') {
    const gateB = object(issue.gateB, 'release Gate B');
    if (gateB.candidateHash !== commitSha || gateB.approved !== true) fail('Production requires release-bound Gate B');
    normalized.candidateHash = commitSha;
  }
  const decision = evaluateIssue(normalized);
  return { issue: normalized, decision };
}

export const normalizeEvidence = adaptEvidence;
