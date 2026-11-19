import test from 'node:test';
import assert from 'node:assert/strict';
import { adaptEvidence, collectGitHubEvidence, collectLinearEvidence, collectLinearEvidenceBatch, EvidenceAdapterError } from './evidence-adapter.mjs';

const sha = '0123456789abcdef0123456789abcdef01234567';
const base = () => ({
  issue: { issueKey: 'F2-04A', environment: 'staging', requiredEvidence: ['architecture', 'ciProtection'], autoMergeRequested: true },
  linear: { source: 'fixture:linear', timestamp: '2026-11-18T10:00:00Z', issueKey: 'F2-04A', dependencies: [{ key: 'F2-03', status: 'READY' }], evidence: { architecture: true } },
  github: { source: 'fixture:github', timestamp: '2026-11-18T10:01:00Z', repository: 'acme/factory', sha, ci: { sha, conclusion: 'success' }, protection: { repository: 'acme/factory', requiredChecksEnforced: true, verified: true } },
});
const run = (input, opts = {}) => adaptEvidence(input, { nowMs: Date.parse('2026-11-18T12:00:00Z'), ...opts });
const rejects = (fn, text) => assert.throws(fn, (error) => error instanceof EvidenceAdapterError && (!text || error.message.includes(text)));

test('normalizes offline Linear and GitHub evidence and feeds controller', () => {
  const result = run(base());
  assert.equal(result.decision.status, 'READY');
  assert.equal(result.decision.automaticMergeAllowed, true);
  assert.equal(result.issue.evidenceMetadata.github.sha, sha);
});
test('rejects missing, malformed, stale, contradictory, or foreign-commit evidence', () => {
  rejects(() => run({ ...base(), github: { ...base().github, source: '' } }), 'source');
  rejects(() => run({ ...base(), github: { ...base().github, sha: 'short' } }), 'SHA');
  rejects(() => run({ ...base(), github: { ...base().github, ci: { sha: sha.replace(/^./, 'f'), conclusion: 'success' } } }), 'different commit');
  rejects(() => run({ ...base(), github: { ...base().github, timestamp: '2020-01-01T00:00:00Z' } }), 'stale');
  rejects(() => run({ ...base(), linear: { ...base().linear, issueKey: 'OTHER' } }), 'contradictory');
});
test('UNKNOWN or unverified evidence cannot become PASS or merge', () => {
  const input = base(); input.github.ci.conclusion = 'UNKNOWN'; input.github.protection.verified = false;
  const result = run(input);
  assert.notEqual(result.decision.status, 'READY');
  assert.equal(result.decision.automaticMergeAllowed, false);
});
test('production requires Gate B bound to the full commit SHA', () => {
  const input = base(); input.issue.environment = 'production';
  rejects(() => run(input), 'Gate B');
  input.issue.gateB = { approved: true, candidateHash: sha };
  assert.equal(run(input).decision.status, 'READY');
  input.issue.gateB.candidateHash = sha.slice(0, 39);
  rejects(() => run(input), 'Gate B');
});
test('identical inputs are deterministic and required-check enforcement is mandatory', () => {
  const input = base(); input.github.protection.requiredChecksEnforced = false;
  const a = run(input); const b = run(structuredClone(input));
  assert.deepEqual(a, b); assert.equal(a.decision.status, 'BLOCKED'); assert.equal(a.decision.automaticMergeAllowed, false);
});

test('normalizes injected Linear identity/status independently from evidence and blocks unknown dependencies', async () => {
  const linear = await collectLinearEvidence({ issueKey: 'HIE-15', nowMs: Date.parse('2026-11-19T00:00:00Z'), fetchIssue: async (key) => ({
    id: 'lin-real-id', identifier: key, url: 'https://linear.app/example/issue/HIE-15', status: 'In Progress',
    dependencies: [{ key: 'HIE-14', status: 'UNKNOWN' }], evidence: { architecture: true },
  }) });
  assert.equal(linear.id, 'lin-real-id');
  assert.equal(linear.url, 'https://linear.app/example/issue/HIE-15');
  assert.equal(linear.status, 'In Progress');
  const input = base(); input.issue.issueKey = 'HIE-15'; input.linear = linear;
  const result = adaptEvidence(input, { nowMs: Date.parse('2026-11-19T01:00:00Z') });
  assert.equal(result.issue.linearIssue.status, 'In Progress');
  assert.equal(result.issue.dependencyStatus['HIE-14'], 'UNKNOWN');
  assert.equal(result.decision.status, 'BLOCKED');
});

test('Linear unavailability fails closed and does not become issue status or Gate B approval', async () => {
  const evidence = await collectLinearEvidence({ issueKey: 'HIE-15', nowMs: Date.parse('2026-11-19T00:00:00Z'), fetchIssue: async () => { throw new Error('offline'); } });
  assert.equal(evidence.available, false);
  assert.equal(evidence.status, 'UNKNOWN');
  assert.deepEqual(evidence.dependencies, []);
});

test('collects bounded Linear GraphQL batch by actual identifiers with injected fetch', async () => {
  const calls = [];
  const result = await collectLinearEvidenceBatch({ credential: 'runtime-only', nowMs: Date.parse('2026-11-19T00:00:00Z'), fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 200, async json() { return { data: { issues: { nodes: ['HIE-14', 'HIE-15', 'HIE-16', 'HIE-17'].map((identifier, i) => ({ id: `uuid-${i}`, identifier, url: `https://linear.app/x/issue/${identifier}`, title: `Issue ${identifier}`, updatedAt: '2026-11-18T23:00:00Z', state: { name: 'In Progress' } })) } } }; } };
  } });
  assert.deepEqual(Object.keys(result), ['HIE-14', 'HIE-15', 'HIE-16', 'HIE-17']);
  assert.equal(result['HIE-14'].id, 'uuid-0');
  assert.equal(result['HIE-14'].verification, 'VERIFIED');
  assert.equal(result['HIE-14'].source, 'linear:graphql:read-only');
  const body = JSON.parse(calls[0].options.body);
  assert.deepEqual(body.variables.identifiers, ['HIE-14', 'HIE-15', 'HIE-16', 'HIE-17']);
  assert.match(body.query, /IssuesByIdentifiers/);
  assert.equal(calls[0].options.headers.authorization, 'Bearer runtime-only');
});

test('Linear GraphQL missing credentials, partial, rate-limited, malformed, and stale responses are NOT_VERIFIED', async () => {
  const absent = await collectLinearEvidenceBatch({ fetchImpl: async () => { throw new Error('must not call'); } });
  assert.equal(absent['HIE-14'].verification, 'NOT_VERIFIED');
  const partial = await collectLinearEvidenceBatch({ credential: 'x', fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ data: { issues: { nodes: [] } } }) }) });
  assert.equal(partial['HIE-14'].available, false);
  const limited = await collectLinearEvidenceBatch({ credential: 'x', fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({}) }) });
  assert.equal(limited['HIE-14'].verification, 'NOT_VERIFIED');
  const stale = await collectLinearEvidenceBatch({ credential: 'x', fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ data: { issues: { nodes: ['HIE-14', 'HIE-15', 'HIE-16', 'HIE-17'].map(identifier => ({ id: identifier, identifier, url: 'https://linear.app/x', title: identifier, updatedAt: '2020-01-01T00:00:00Z', state: { name: 'Done' } })) } } }) }) });
  assert.equal(stale['HIE-14'].available, false);
});

test('collects verified read-only GitHub evidence and preserves SHA/time', async () => {
  const calls = [];
  const fullSha = 'abcdef0123456789abcdef0123456789abcdef01';
  const exec = (args, callback) => {
    calls.push(args);
    const endpoint = args[1];
    const value = endpoint.includes('/commits/main') ? { sha: fullSha } : endpoint.includes('check-runs')
      ? { check_runs: [{ name: 'ci', head_sha: fullSha, conclusion: 'success' }] }
      : { required_status_checks: { contexts: ['ci'] } };
    callback(null, JSON.stringify(value), '');
  };
  const evidence = await collectGitHubEvidence({ repository: 'hurintaipei101/FACAPP-Pipeline-Pilot', requiredChecks: ['ci'], nowMs: Date.parse('2026-11-19T00:00:00Z'), execCommand: exec });
  assert.equal(evidence.sha, fullSha);
  assert.equal(evidence.protection.verified, true);
  assert.equal(evidence.ci.conclusion, 'success');
  assert.equal(evidence.timestamp, '2026-11-19T00:00:00.000Z');
  assert.equal(calls.length, 3);
  assert.ok(calls.every((args) => args[0] === 'api' && args[2] === '--method' && args[3] === 'GET'));
});

test('403 protection, wrong SHA, stale/malformed responses and unknown checks remain NOT_VERIFIED', async () => {
  const sha2 = 'abcdef0123456789abcdef0123456789abcdef02';
  const exec = (args, callback) => {
    const endpoint = args[1];
    if (endpoint.includes('/commits/main')) return callback(null, JSON.stringify({ sha: sha2 }), '');
    if (endpoint.includes('check-runs')) return callback(null, JSON.stringify({ check_runs: [{ name: 'ci', head_sha: sha, conclusion: 'success' }] }), '');
    return callback(Object.assign(new Error('HTTP 403'), { status: 403 }), '', 'forbidden');
  };
  const evidence = await collectGitHubEvidence({ repository: 'acme/factory', requiredChecks: ['unknown'], execCommand: exec });
  assert.equal(evidence.protection.verified, false);
  assert.equal(evidence.protection.requiredChecksEnforced, false);
  assert.equal(evidence.ci.conclusion, 'UNKNOWN');
  assert.equal(evidence.sha, sha2);
  const malformed = await collectGitHubEvidence({ repository: 'acme/factory', execCommand: (_args, cb) => cb(null, '{bad}', '') });
  assert.equal(malformed.protection.verified, false);
  assert.equal(malformed.sha, null);
});
