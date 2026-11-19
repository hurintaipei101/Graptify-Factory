import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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


const token = 'synthetic-token';
const ref = (sha) => ({ ref: 'refs/heads/main', object: { type: 'commit', sha } });

function smokeFixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'factory-main-test-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '--initial-branch=main');
  git('config', 'user.name', 'Smoke Fixture');
  git('config', 'user.email', 'smoke@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  const commit = (message) => {
    git('commit', '--allow-empty', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  const baseline = commit('Initial main');
  writeFileSync(join(cwd, 'dispatch.txt'), 'historical workflow');
  git('add', 'dispatch.txt');
  const dispatched = commit('Historical dispatch');
  const advanced = commit('Main advances');
  git('revert', '--no-edit', dispatched);
  const reverted = git('rev-parse', 'HEAD');
  git('checkout', '--detach', dispatched);

  function run(responses, extraEnv = {}, mode = 'report') {
    const preload = `
      import assert from 'node:assert/strict';
      const responses = ${JSON.stringify(responses)};
      const requests = [];
      globalThis.fetch = async (url, options) => {
        assert.equal(options.headers.authorization, 'Bearer ${token}');
        assert.equal(options.redirect, 'error');
        assert.equal(options.cache, 'no-store');
        assert.equal(new URL(url).origin, 'https://api.github.com');
        if (url.endsWith('/git/ref/heads/main')) {
          assert.equal(url, 'https://api.github.com/repos/${target.repository}/git/ref/heads/main');
          assert.equal(options.headers['cache-control'], 'no-cache');
          requests.push('main');
          const next = responses.shift();
          if (next === 'offline') throw new Error('sensitive upstream diagnostic');
          return new Response(JSON.stringify(next.body), { status: next.status || 200 });
        }
        assert.equal(url, 'https://api.github.com/repos/${target.repository}/pulls/4');
        requests.push('handoff');
        return new Response('{}');
      };
      process.on('exit', () => {
        assert.equal(responses.length, 0);
        assert.deepEqual(requests, ${JSON.stringify(extraEnv.WORKER_CANDIDATE_SHA
          ? ['main', 'handoff', 'main'] : responses.map(() => 'main'))});
      });
    `;
    const entry = new URL('./isolation-smoke.mjs', import.meta.url);
    const result = spawnSync(process.execPath, ['--import', 'data:text/javascript,' + encodeURIComponent(preload),
      entry.pathname, mode], {
      cwd, encoding: 'utf8', timeout: 10_000,
      env: {
        GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', GITHUB_EVENT_NAME: 'workflow_dispatch',
        GITHUB_REF: 'refs/heads/main', GITHUB_REPOSITORY: target.repository, GITHUB_TOKEN: token,
        GITHUB_SHA: dispatched, GITHUB_WORKFLOW_SHA: dispatched, GITHUB_RUN_ATTEMPT: '1',
        GITHUB_OUTPUT: join(cwd, 'outputs'), ...extraEnv,
      },
    });
    assert.ifError(result.error);
    assert.equal(result.stderr, '');
    assert.doesNotMatch(result.stdout, /synthetic-token|sensitive upstream diagnostic/);
    assert.equal(result.status, mode === 'report' ? 1 : 0);
    return mode === 'report' ? JSON.parse(readFileSync(join(cwd, 'isolation-evidence.json'), 'utf8')) : {
      ...JSON.parse(result.stdout), outputs: readFileSync(join(cwd, 'outputs'), 'utf8'),
    };
  }

  return { run, baseline, dispatched, advanced, reverted };
}

test('requires an authenticated exact current main match at admission and recording', (t) => {
  const { run, dispatched } = smokeFixture(t);
  const report = run([{ body: ref(dispatched) }, { body: ref(dispatched) }]);
  assert.equal(report.mode, 'LIVE');
  assert.equal(report.controls.trusted_main, 'PASS');
  assert.deepEqual(report.main_verification, {
    status: 'PASS', reason_code: 'CURRENT_MAIN_VERIFIED', dispatched_sha: dispatched,
    checked_out_sha: dispatched, current_main_sha: dispatched,
  });
  assert.equal(report.controls.github_job_cancellation, 'BLOCKED');
});

test('blocks stale dispatches, historical reruns and reverted commits', async (t) => {
  const { run, baseline, dispatched, advanced, reverted } = smokeFixture(t);
  for (const [name, head, attempt] of [
    ['main advances although the dispatch is still an ancestor', advanced, '1'],
    ['historical workflow rerun retains its original SHA', advanced, '2'],
    ['main points to a subsequent revert commit', reverted, '1'],
    ['main is force-updated to a preceding commit', baseline, '2'],
  ]) {
    await t.test(name, () => {
      const report = run([{ body: ref(head) }], { GITHUB_RUN_ATTEMPT: attempt });
      assert.equal(report.mode, 'UNVERIFIED');
      assert.equal(report.controls.trusted_main, 'FAIL');
      assert.equal(report.overall, 'FAIL');
      assert.deepEqual(report.main_verification, {
        status: 'FAIL', reason_code: 'CURRENT_MAIN_SHA_MISMATCH', dispatched_sha: dispatched,
        checked_out_sha: dispatched, current_main_sha: head,
      });
    });
  }
  const worker = run([{ body: ref(advanced) }], { GITHUB_RUN_ATTEMPT: '2' }, 'worker');
  assert.equal(worker.main_verification.reason_code, 'CURRENT_MAIN_SHA_MISMATCH');
  assert.doesNotMatch(worker.outputs, /PASS|candidate_sha/);
});

test('missing or denied authenticated lookups and ambiguous refs fail closed', async (t) => {
  const { run, dispatched, advanced } = smokeFixture(t);
  for (const [name, responses, env, reason] of [
    ['missing token', [], { GITHUB_TOKEN: '' }, 'MAIN_LOOKUP_TOKEN_MISSING'],
    ['network failure', ['offline'], {}, 'MAIN_LOOKUP_FAILED'],
    ['permission denial', [{ status: 403, body: {} }], {}, 'MAIN_LOOKUP_DENIED_OR_UNAVAILABLE'],
    ['wrong ref', [{ body: { ...ref(dispatched), ref: 'refs/heads/main-copy' } }], {}, 'MAIN_RESPONSE_UNVERIFIED'],
    ['checkout differs from dispatch', [], { GITHUB_SHA: advanced, GITHUB_WORKFLOW_SHA: advanced }, 'CHECKOUT_SHA_MISMATCH'],
  ]) {
    await t.test(name, () => {
      const report = run(responses, env);
      assert.equal(report.mode, 'UNVERIFIED');
      assert.equal(report.main_verification.reason_code, reason);
      assert.equal(report.main_verification.current_main_sha, null);
      assert.equal(report.controls.trusted_main, name === 'checkout differs from dispatch' ? 'FAIL' : 'BLOCKED');
    });
  }
});

test('a main change during evidence collection discards probe and handoff results', (t) => {
  const { run, dispatched, advanced } = smokeFixture(t);
  const report = run([{ body: ref(dispatched) }, { body: ref(advanced) }], {
    WORKER_CANDIDATE_SHA: target.revision, WORKER_CONTROLS: '{"credentials":"PASS","workspace":"PASS"}',
    PERMISSION_NEGATIVE: 'PASS',
  });
  assert.equal(report.mode, 'UNVERIFIED');
  assert.equal(report.main_verification.reason_code, 'CURRENT_MAIN_SHA_MISMATCH');
  assert.equal(report.main_verification.current_main_sha, advanced);
  assert.equal(report.controls.trusted_main, 'FAIL');
  assert.ok(Object.values(report.controls).every((status) => status !== 'PASS'));
  assert.equal(report.github_evidence, undefined);
});
