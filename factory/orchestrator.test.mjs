import test from 'node:test';
import assert from 'node:assert/strict';
import { orchestrateIssue } from './orchestrator.mjs';

const sha = '0123456789abcdef0123456789abcdef01234567';
const issue = (extra = {}) => ({ issueKey: 'F2-06B', environment: 'staging', repository: 'acme/factory', requiredEvidence: ['architecture', 'ciProtection'], ...extra });
const evidence = (extra = {}) => ({ linear: { source: 'fixture:linear', timestamp: '2026-11-18T10:00:00Z', issueKey: 'F2-06B', dependencies: [], evidence: { architecture: true } }, github: { source: 'fixture:github', timestamp: '2026-11-18T10:01:00Z', repository: 'acme/factory', sha, ci: { sha, conclusion: 'success' }, protection: { repository: 'acme/factory', requiredChecksEnforced: true, verified: true } }, ...extra });
const ok = async () => ({ ok: true });
const opts = () => ({ issue: issue(), evidence: evidence(), codingAgent: ok, testRunner: ok, nowMs: Date.parse('2026-11-18T12:00:00Z') });

test('valid simulated issue completes and preserves identity, repository and SHA', async () => {
  const result = await orchestrateIssue(opts());
  assert.equal(result.status, 'EXECUTED'); assert.equal(result.issueId, 'F2-06B'); assert.equal(result.commitSha, sha);
});

test('missing Linear evidence blocks execution', async () => {
  let calls = 0; const result = await orchestrateIssue({ ...opts(), evidence: { ...evidence(), linear: { ...evidence().linear, available: false } }, codingAgent: async () => { calls += 1; } });
  assert.equal(result.status, 'BLOCKED'); assert.equal(calls, 0);
});

test('GitHub NOT_VERIFIED blocks unsafe actions', async () => {
  let calls = 0; const result = await orchestrateIssue({ ...opts(), evidence: { ...evidence(), github: { ...evidence().github, verification: 'NOT_VERIFIED' } }, codingAgent: async () => { calls += 1; } });
  assert.equal(result.status, 'BLOCKED'); assert.equal(calls, 0);
});

test('failed tests invoke bounded retries', async () => {
  let attempts = 0; const result = await orchestrateIssue({ ...opts(), codingAgent: ok, testRunner: async () => { attempts += 1; return { ok: false }; } });
  assert.equal(attempts, 3); assert.equal(result.status, 'GATE_A');
});

test('security error stops immediately', async () => {
  let tests = 0; const result = await orchestrateIssue({ ...opts(), codingAgent: async () => { throw Object.assign(new Error('security boundary'), { code: 'E_SECURITY' }); }, testRunner: async () => { tests += 1; } });
  assert.equal(result.status, 'STOP'); assert.equal(tests, 0);
});

test('production without Gate B remains denied', async () => {
  const result = await orchestrateIssue({ ...opts(), issue: issue({ environment: 'production' }) });
  assert.equal(result.status, 'STOP');
});

test('concurrent duplicate execution is rejected without side effects', async () => {
  let release; const wait = new Promise((resolve) => { release = resolve; }); let calls = 0;
  const first = orchestrateIssue({ ...opts(), codingAgent: async () => { calls += 1; await wait; return { ok: true }; } });
  const duplicate = await orchestrateIssue(opts()); release(); await first;
  assert.equal(duplicate.status, 'REJECTED'); assert.equal(calls, 1);
});
