import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { mergedEvidenceTarget as target } from './github-evidence-smoke.mjs';
import { permissionNegative, verifyHandoff } from './isolation-smoke.mjs';

test('the handoff never treats simulated evidence or malformed worker output as live proof', async () => {
  const read = async () => ({
    mode: 'SIMULATION', evidence_read: 'PASS', candidate_sha: target.revision, merge_sha: target.mergeCommit,
  });
  assert.deepEqual((await verifyHandoff(target.revision, read)).controls, {
    github_permissions: 'BLOCKED', candidate_sha: 'BLOCKED', stale_sha_negative: 'BLOCKED',
  });
  assert.equal((await verifyHandoff('malformed\noutput', () => assert.fail())).controls.candidate_sha, 'BLOCKED');
});

test('permission negative needs explicit denial from the live evidence reader', () => {
  const denied = { mode: 'LIVE', evidence_read: 'BLOCKED', permission_denied: true };
  assert.equal(permissionNegative(denied), 'PASS');
  assert.equal(permissionNegative({ ...denied, mode: 'SIMULATION' }), 'BLOCKED');
  assert.equal(permissionNegative({ ...denied, permission_denied: undefined, reason: 'GitHub API HTTP 403' }), 'BLOCKED');
  assert.equal(permissionNegative({ mode: 'LIVE', evidence_read: 'PASS' }), 'BLOCKED');
});

test('untrusted ref cannot turn forged worker outputs into a live result', (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'factory-smoke-test-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [new URL('./isolation-smoke.mjs', import.meta.url).pathname, 'report'], {
    cwd, encoding: 'utf8',
    env: {
      GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', GITHUB_EVENT_NAME: 'workflow_dispatch',
      GITHUB_REF: 'refs/heads/topic', GITHUB_REPOSITORY: target.repository, GITHUB_TOKEN: 'synthetic-token',
      WORKER_CANDIDATE_SHA: target.revision, WORKER_CONTROLS: '{"credentials":"PASS","workspace":"PASS"}',
      PERMISSION_NEGATIVE: 'PASS',
    },
  });
  assert.equal(result.status, 1);
  const body = readFileSync(join(cwd, 'isolation-evidence.json'), 'utf8');
  const report = JSON.parse(body);
  assert.equal(report.mode, 'UNVERIFIED');
  assert.equal(report.authorization, 'BLOCKED');
  assert.equal(report.realExecution, false);
  assert.ok(Object.values(report.controls).every((value) => value === 'BLOCKED'));
  assert.doesNotMatch(body + result.stdout + result.stderr, /synthetic-token/);
});
