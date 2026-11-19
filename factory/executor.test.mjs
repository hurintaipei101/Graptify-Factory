import test from 'node:test';
import assert from 'node:assert/strict';
import { executeIssue } from './executor.mjs';

const sha = '0123456789abcdef0123456789abcdef01234567';
const ready = (extra = {}) => ({ issueKey: 'F2-06A', source: 'fixture', commitSha: sha, dependencies: [], requiredEvidence: ['architecture'], evidence: { architecture: true }, ...extra });
const verified = (issue = ready()) => ({ issue, decision: { status: 'READY', reasons: [] } });
const okAgent = async () => ({ ok: true });
const okTests = async () => ({ ok: true });

test('ready issue executes simulated task and preserves identity', async () => {
  const result = await executeIssue({ issue: ready(), evidence: verified(), codingAgent: okAgent, testRunner: okTests });
  assert.deepEqual(result, { issueId: 'F2-06A', source: 'fixture', commitSha: sha, status: 'EXECUTED', gate: null, executed: true, repairCycles: 0, reasons: ['simulated task and tests passed'] });
});

test('blocked and unverified issues do not execute', async () => {
  let calls = 0;
  const blocked = await executeIssue({ issue: ready(), evidence: { issue: ready(), decision: { status: 'BLOCKED', reasons: ['missing evidence'] } }, codingAgent: async () => { calls += 1; }, testRunner: okTests });
  const unverified = await executeIssue({ issue: ready(), evidence: { issue: ready(), decision: { status: 'BLOCKED', reasons: ['NOT_VERIFIED'] } }, codingAgent: async () => { calls += 1; }, testRunner: okTests });
  assert.equal(blocked.status, 'BLOCKED'); assert.equal(unverified.status, 'BLOCKED'); assert.equal(calls, 0);
});

test('failed tests retry and three failed cycles trigger Gate A', async () => {
  let attempts = 0;
  const result = await executeIssue({ issue: ready(), evidence: verified(), codingAgent: async () => ({ ok: true }), testRunner: async () => { attempts += 1; return { ok: false }; } });
  assert.equal(attempts, 3); assert.equal(result.status, 'GATE_A'); assert.equal(result.gate, 'A');
});

test('security and permission errors stop immediately', async () => {
  let tests = 0;
  const result = await executeIssue({ issue: ready(), evidence: verified(), codingAgent: async () => { throw Object.assign(new Error('permission denied'), { code: 'E_PERMISSION' }); }, testRunner: async () => { tests += 1; } });
  assert.equal(result.status, 'STOP'); assert.equal(result.gate, 'A'); assert.equal(tests, 0);
});

test('duplicate concurrent execution is rejected without external effects', async () => {
  let release;
  const wait = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const first = executeIssue({ issue: ready(), evidence: verified(), codingAgent: async () => { calls += 1; await wait; return { ok: true }; }, testRunner: okTests });
  const duplicate = await executeIssue({ issue: ready(), evidence: verified(), codingAgent: okAgent, testRunner: okTests });
  release(); await first;
  assert.equal(duplicate.status, 'REJECTED'); assert.equal(calls, 1);
});

test('production cannot bypass Gate B', async () => {
  const result = await executeIssue({ issue: ready({ environment: 'production' }), evidence: { issue: ready({ environment: 'production' }), decision: { status: 'STOP', reasons: ['Production requires release-specific Gate B approval'] } }, codingAgent: okAgent, testRunner: okTests });
  assert.equal(result.status, 'STOP'); assert.equal(result.gate, 'A');
});

test('identical inputs produce deterministic results', async () => {
  const a = await executeIssue({ issue: ready(), evidence: verified(), codingAgent: okAgent, testRunner: okTests });
  const b = await executeIssue({ issue: structuredClone(ready()), evidence: verified(structuredClone(ready())), codingAgent: okAgent, testRunner: okTests });
  assert.deepEqual(a, b);
});
