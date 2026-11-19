import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateIssue } from './controller.mjs';

const readyIssue = () => ({
  issueKey: 'F2-09',
  environment: 'staging',
  dependencies: ['F2-03', 'F2-04'],
  dependencyStatus: { 'F2-03': 'READY', 'F2-04': 'COMPLETE' },
  requiredEvidence: ['architecture', 'ciProtection'],
  evidence: { architecture: true, ciProtection: true },
  githubChecksOperationallyVerified: true,
  autoMergeRequested: true,
  failedRepairCycles: 0,
});

test('valid issue is READY and may auto-merge when checks are verified', () => {
  const result = evaluateIssue(readyIssue());
  assert.equal(result.status, 'READY');
  assert.equal(result.automaticMergeAllowed, true);
});

test('missing dependency is BLOCKED', () => {
  const issue = readyIssue();
  issue.dependencyStatus['F2-04'] = 'BLOCKED';
  const result = evaluateIssue(issue);
  assert.equal(result.status, 'BLOCKED');
  assert.match(result.reasons[0], /F2-04/);
});

test('missing CI protection evidence blocks readiness and merge', () => {
  const issue = readyIssue();
  issue.evidence.ciProtection = false;
  const result = evaluateIssue(issue);
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.automaticMergeAllowed, false);
  assert.match(result.reasons[0], /ciProtection/);
});

test('Production without release-specific Gate B is STOP', () => {
  const issue = readyIssue();
  issue.environment = 'production';
  const result = evaluateIssue(issue);
  assert.equal(result.status, 'STOP');
  assert.equal(result.gate, 'A');
  assert.match(result.reasons[0], /Gate B/);
});

test('security boundary and retry limit both stop at Gate A', () => {
  const security = evaluateIssue({ ...readyIssue(), securityBoundary: true });
  assert.equal(security.status, 'STOP');
  assert.equal(security.gate, 'A');

  const retryLimit = evaluateIssue({ ...readyIssue(), failedRepairCycles: 3 });
  assert.equal(retryLimit.status, 'STOP');
  assert.equal(retryLimit.gate, 'A');
});

test('unverified GitHub checks deny automatic merge', () => {
  const result = evaluateIssue({ ...readyIssue(), githubChecksOperationallyVerified: false });
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.automaticMergeAllowed, false);
  assert.match(result.reasons[0], /GitHub checks/);
});

test('malformed or contradictory issue fields fail closed', () => {
  for (const issue of [
    { ...readyIssue(), dependencies: 'F2-03' },
    { ...readyIssue(), requiredEvidence: 'architecture' },
  ]) {
    const result = evaluateIssue(issue);
    assert.notEqual(result.status, 'READY');
    assert.equal(result.automaticMergeAllowed, false);
  }

  for (const issue of [
    { ...readyIssue(), autoMergeRequested: 'yes' },
    { ...readyIssue(), failedRepairCycles: '3' },
  ]) {
    assert.equal(evaluateIssue(issue).automaticMergeAllowed, false);
  }
});

test('unknown dependency status is BLOCKED', () => {
  const result = evaluateIssue({
    ...readyIssue(),
    dependencyStatus: { 'F2-03': 'MAYBE', 'F2-04': 'COMPLETE' },
  });
  assert.equal(result.status, 'BLOCKED');
  assert.match(result.reasons[0], /F2-03/);
});

test('CI success without verified required-check enforcement cannot auto-merge', () => {
  const result = evaluateIssue({
    ...readyIssue(),
    ci: { success: true },
    githubChecksOperationallyVerified: false,
  });
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.automaticMergeAllowed, false);
});

test('Gate B approval must match the exact release SHA', () => {
  const base = { ...readyIssue(), environment: 'production', candidateHash: 'sha-1' };
  const approved = evaluateIssue({ ...base, gateB: { approved: true, candidateHash: 'sha-1' } });
  const stale = evaluateIssue({ ...base, gateB: { approved: true, candidateHash: 'sha-old' } });
  const nonString = evaluateIssue({ ...base, candidateHash: {}, gateB: { approved: true, candidateHash: {} } });
  assert.equal(approved.status, 'READY');
  assert.equal(stale.status, 'STOP');
  assert.equal(nonString.status, 'STOP');
});

test('security and permission boundaries stop immediately', () => {
  const result = evaluateIssue({
    ...readyIssue(),
    securityBoundary: true,
    dependencies: ['missing'],
    failedRepairCycles: 3,
  });
  assert.equal(result.status, 'STOP');
  assert.match(result.reasons[0], /security or permission/);
});

test('three failed repair cycles trigger Gate A', () => {
  const result = evaluateIssue({ ...readyIssue(), failedRepairCycles: 3 });
  assert.equal(result.status, 'STOP');
  assert.equal(result.gate, 'A');
});

test('identical input produces a deterministic decision', () => {
  const issue = readyIssue();
  assert.deepEqual(evaluateIssue(issue), evaluateIssue(structuredClone(issue)));
});
