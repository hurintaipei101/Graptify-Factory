import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs, { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { runSimulation } from './w1-simulation-runner.mjs';

const runner = fileURLToPath(new URL('./w1-simulation-runner.mjs', import.meta.url));
const execute = promisify(execFile);

async function temporaryRoot(t) {
  const path = await mkdtemp(join(tmpdir(), 'factory-w1-runner-test-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

async function localTemporaryRoot(t) {
  const root = await temporaryRoot(t);
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = root;
  t.after(() => {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
  });
  return root;
}

async function invoke(tempRoot, ...args) {
  const child = await execute(process.execPath, [runner, ...args], {
    env: { TMPDIR: tempRoot }, encoding: 'utf8', timeout: 10_000,
  }).catch((error) => {
    if (error.code !== 1) throw error;
    return error;
  });
  assert.equal(child.stderr, '');
  const result = JSON.parse(child.stdout);
  assert.equal(result.mode, 'SIMULATION');
  assert.equal(result.realExecution, false);
  return { exitCode: child.code ?? 0, result };
}

test('runs three fixture scenarios and removes their temporary state', async (t) => {
  const root = await temporaryRoot(t);
  const { exitCode, result } = await invoke(root, '--simulation');
  assert.equal(exitCode, 0);
  assert.equal(result.status, 'PASS');
  assert.equal(result.approvalSource, 'synthetic-test-fixture');
  assert.notEqual(result.principals.coder, result.principals.reviewer);
  assert.deepEqual(result.results.map(({ status }) => status), ['READY', 'BLOCKED', 'GATE_A']);
  const [ready, blocked, gateA] = result.results;
  for (const scenario of result.results) {
    assert.equal(scenario.mode, 'SIMULATION');
    assert.equal(scenario.realExecution, false);
    assert.match(scenario.candidateSha, /^[0-9a-f]{40}$/);
    assert.notEqual(scenario.candidateSha, result.baselineSha);
    assert.equal(scenario.repairCycles, 0);
  }
  assert.deepEqual(ready.checks.map(({ stage, status }) => [stage, status]), [
    ['tests', 'PASS'], ['ci', 'PASS'], ['review', 'PASS'],
  ]);
  assert.deepEqual(blocked.checks.map(({ stage }) => stage), ['tests', 'ci']);
  assert.deepEqual(blocked.checks.at(-1), { stage: 'ci', status: 'BLOCKED', classification: 'PENDING', reads: 3 });
  assert.equal(gateA.gate, 'A');
  assert.equal(gateA.checks.at(-1).stage, 'review');
  assert.equal(gateA.checks.at(-1).status, 'GATE_A');
  assert.deepEqual(await readdir(root), []);
  assert.ok(!JSON.stringify(result).includes(root));
});

test('requires the simulation flag and rejects extra options', async (t) => {
  const root = await temporaryRoot(t);
  for (const args of [[], ['--live'], ['--simulation', '--live']]) {
    const { exitCode, result } = await invoke(root, ...args);
    assert.equal(exitCode, 1);
    assert.equal(result.status, 'BLOCKED');
    assert.match(result.reason, /--simulation/);
    assert.equal(result.results, undefined);
  }
  assert.deepEqual(await readdir(root), []);
});

test('fails closed with sanitized output when temporary state cannot be created', async (t) => {
  const root = await temporaryRoot(t);
  const { exitCode, result } = await invoke(join(root, 'missing'), '--simulation');
  assert.equal(exitCode, 1);
  assert.equal(result.status, 'BLOCKED');
  assert.match(result.reason, /temporary state/);
  assert.equal(result.results, undefined);
  assert.ok(!JSON.stringify(result).includes(root));
});

test('uses the validated CI snapshot when the original changes during state allocation', async (t) => {
  const root = await localTemporaryRoot(t);
  const originals = [];
  let readsAfterMutation = 0;
  const mkdtempOriginal = fs.mkdtemp;
  const createState = t.mock.method(fs, 'mkdtemp', async (prefix) => {
    const allocation = mkdtempOriginal(prefix);
    await Promise.resolve();
    const original = originals.at(-1);
    Object.defineProperty(original, 'conclusion', {
      get() {
        readsAfterMutation += 1;
        return 'failure';
      },
    });
    return allocation;
  });
  syncBuiltinESMExports();
  let result;
  try {
    result = await runSimulation(['--simulation'], (fixture) => {
      originals.push(fixture.baselineCi);
    });
  } finally {
    createState.mock.restore();
    syncBuiltinESMExports();
  }

  assert.equal(createState.mock.callCount(), 3);
  assert.equal(readsAfterMutation, 0);
  assert.equal(result.status, 'PASS');
  assert.deepEqual(result.results.map(({ status }) => status), ['READY', 'BLOCKED', 'GATE_A']);
  assert.deepEqual(await readdir(root), []);
});

test('rejects a failed pending CI state write and removes only its owned temporary state', async (t) => {
  const root = await localTemporaryRoot(t);
  const unrelatedDirectory = 'factory-w1-simulation-unrelated';
  const unrelatedFile = 'unrelated.txt';
  await mkdir(join(root, unrelatedDirectory));
  await writeFile(join(root, unrelatedDirectory, 'keep.txt'), 'directory contents');
  await writeFile(join(root, unrelatedFile), 'file contents');

  const rename = fs.rename;
  let interruptedCheck;
  let entriesAtFailure;
  const writeFault = t.mock.method(fs, 'rename', async (source, destination) => {
    if (source.startsWith(`${root}${sep}`) && basename(source) === 'next.json') {
      const { report } = JSON.parse(await readFile(source, 'utf8'));
      if (report.issue_key === 'W1SIM-2' && report.status === 'BLOCKED') {
        interruptedCheck = report.checks.at(-1);
        entriesAtFailure = { owned: basename(dirname(dirname(source))), names: await readdir(root) };
        throw Object.assign(new Error('Injected state write failure'), { code: 'EIO' });
      }
    }
    return rename(source, destination);
  });
  syncBuiltinESMExports();
  let result;
  try {
    result = await runSimulation(['--simulation']);
  } finally {
    writeFault.mock.restore();
    syncBuiltinESMExports();
  }

  assert.equal(interruptedCheck?.stage, 'ci');
  assert.equal(interruptedCheck.classification, 'PENDING');
  assert.equal(interruptedCheck.reads, 3);
  assert.match(entriesAtFailure.owned, /^factory-w1-simulation-/);
  assert.deepEqual(entriesAtFailure.names.sort(), [entriesAtFailure.owned, unrelatedDirectory, unrelatedFile].sort());
  assert.deepEqual(result, {
    mode: 'SIMULATION', realExecution: false, status: 'BLOCKED', scenario: 'pending-ci',
    reason: 'durable state could not be written; reconcile before taking further action',
  });
  assert.deepEqual((await readdir(root)).sort(), [unrelatedDirectory, unrelatedFile].sort());
  assert.equal(await readFile(join(root, unrelatedDirectory, 'keep.txt'), 'utf8'), 'directory contents');
  assert.equal(await readFile(join(root, unrelatedFile), 'utf8'), 'file contents');
});

test('rejects missing, null, failed, invalid and unbound baseline CI evidence', async (t) => {
  const root = await localTemporaryRoot(t);
  for (const invalid of [
    undefined, null, {}, { conclusion: null }, { conclusion: 'failure', status: 'SUCCESS' },
    { conclusion: true }, { conclusion: 'success', sha: 'f'.repeat(40) },
  ]) {
    const result = await runSimulation(['--simulation'], (fixture, scenario) => {
      if (scenario === 'pending-ci') {
        fixture.baselineCi = invalid && { sha: fixture.baselineCi.sha, ...invalid };
      }
    });
    assert.deepEqual(result, {
      mode: 'SIMULATION', realExecution: false, status: 'BLOCKED', scenario: 'pending-ci',
      reason: 'Invalid synthetic baseline CI evidence',
    });
    assert.deepEqual(await readdir(root), []);
  }
});

test('fails closed through Issue Loop preflight when the approval binding is missing', async (t) => {
  const root = await localTemporaryRoot(t);
  const result = await runSimulation(['--simulation'], (fixture, scenario) => {
    if (scenario === 'pending-ci') delete fixture.profileDigest;
  });
  assert.deepEqual(result, {
    mode: 'SIMULATION', realExecution: false, status: 'BLOCKED', scenario: 'pending-ci',
    reason: 'missing or invalid issue profile approval',
  });
  assert.deepEqual(await readdir(root), []);
});

test('rejects invalid baseline CI fixtures before reaching simulation state or provider dispatch', async (t) => {
  const root = await localTemporaryRoot(t);
  const sha = '0'.repeat(40);
  const passing = { sha, conclusion: 'success', status: 'SUCCESS' };
  class BaselineCi {
    constructor(fields) {
      Object.assign(this, fields);
    }
  }
  const invalidFixtures = [
    ['success conclusion with failure status', { ...passing, status: 'FAILURE' }],
    ['failure conclusion with success status', { ...passing, conclusion: 'failure' }],
    ['failed CI', { ...passing, conclusion: 'failure', status: 'FAILURE' }],
    ['pending CI', { ...passing, conclusion: null, status: 'PENDING' }],
    ['pending status with success conclusion', { ...passing, status: 'PENDING' }],
    ['array with passing fields', Object.assign([], passing)],
    ['proxy with passing fields', new Proxy(passing, {})],
    ['class instance with passing fields', new BaselineCi(passing)],
    ['custom-prototype object with passing fields', Object.assign(Object.create({}), passing)],
    ['null-prototype object with passing fields', Object.assign(Object.create(null), passing)],
    ['malformed object', { ...passing, status: { value: 'SUCCESS' } }],
    ['non-object', 'SUCCESS'],
    ['missing evidence', undefined],
    ['null evidence', null],
    ['missing status', { sha, conclusion: 'success' }],
    ['missing conclusion', { sha, status: 'SUCCESS' }],
    ['missing SHA', { conclusion: 'success', status: 'SUCCESS' }],
    ['invalid SHA', { ...passing, sha: 'z'.repeat(40) }],
    ['different commit SHA', { ...passing, sha: 'f'.repeat(40) }],
  ];

  // Issue Loop and all fixture provider calls are downstream of mkdtemp.
  const createState = t.mock.method(fs, 'mkdtemp');
  syncBuiltinESMExports();
  try {
    for (const [description, baselineCi] of invalidFixtures) {
      const result = await runSimulation(['--simulation'], (fixture) => {
        fixture.baselineCi = baselineCi;
      });
      assert.equal(createState.mock.callCount(), 0, description);
      assert.deepEqual(result, {
        mode: 'SIMULATION', realExecution: false, status: 'BLOCKED', scenario: 'verified-candidate',
        reason: 'Invalid synthetic baseline CI evidence',
      }, description);
    }
  } finally {
    createState.mock.restore();
    syncBuiltinESMExports();
  }
  assert.deepEqual(await readdir(root), []);
});
