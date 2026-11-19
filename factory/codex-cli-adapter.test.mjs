import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn as spawnNode } from 'node:child_process';
import { EventEmitter, getEventListeners } from 'node:events';
import { mkdtemp, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCodexCliAdapter } from './codex-cli-adapter.mjs';

const issue = (extra = {}) => ({ issueKey: 'F2-06C', environment: 'staging', ...extra });
const completed = '{"type":"turn.completed","usage":{"input_tokens":2,"cached_input_tokens":0,"output_tokens":1}}\n';
function child({ output = completed, chunks = [Buffer.from(output)], code = 0, delay = 0, kill = () => {} } = {}) {
  const stdout = new EventEmitter();
  return {
    stdout,
    stderr: new EventEmitter(),
    kill,
    on(event, listener) {
      if (event === 'close') setTimeout(() => {
        for (const chunk of chunks) stdout.emit('data', chunk);
        listener(code, null);
      }, delay);
    },
  };
}
async function setup() { return mkdtemp(path.join(os.tmpdir(), 'codex-adapter-')); }
function ready(root, overrides = {}) { return createCodexCliAdapter({ simulation: true, allowedWorkspaces: [root], runtimeIsolation: { verified: true }, mcpAccess: { verified: true, allowed: true }, spawnFixture: () => child(), ...overrides }); }

function launchNode(t, source, signals, onReady) {
  const subprocess = spawnNode(process.execPath, ['-e', source], { stdio: ['ignore', 'pipe', 'pipe'] });
  const kill = subprocess.kill.bind(subprocess);
  const watchdog = setTimeout(() => kill('SIGKILL'), 4000);
  let close = null;
  const closed = new Promise((resolve) => subprocess.once('close', (code, signal) => {
    close = { code, signal };
    clearTimeout(watchdog);
    resolve();
  }));
  if (onReady) subprocess.stderr.once('data', onReady);
  subprocess.kill = (signal) => {
    signals.push(signal);
    return kill(signal);
  };
  t.after(async () => {
    if (!close) kill('SIGKILL');
    await closed;
  }, { timeout: 4500 });
  return { subprocess, get close() { return close; } };
}

test('fake CLI successful invocation returns compact PASS evidence', async () => { const root = await setup(); const result = await ready(root)(issue(), { workspace: root, prompt: 'test' }); assert.equal(result.status, 'PASS'); assert.equal(result.passed, true); assert.equal(result.evidence.eventCount, 1); assert.equal(result.evidence.lastEventType, 'turn.completed'); });

test('zero CLI exit without turn.completed is FAIL', async () => {
  const root = await setup();
  for (const output of ['{"type":"result"}\n', '']) {
    const result = await ready(root, { spawnFixture: () => child({ output }) })(issue(), { workspace: root });
    assert.equal(result.status, 'FAIL');
    assert.equal(result.passed, false);
    assert.equal(result.evidence.exitCode, 0);
    assert.match(result.reason, /turn\.completed/);
  }
});

test('turn.failed overrides zero exit and any completion event', async () => {
  const root = await setup();
  const failed = '{"type":"turn.failed","error":{"message":"turn failed"}}\n';
  for (const output of [failed, completed + failed, failed + completed]) {
    const result = await ready(root, { maxEvents: 1, spawnFixture: () => child({ output }) })(issue(), { workspace: root });
    assert.equal(result.status, 'FAIL');
    assert.equal(result.passed, false);
    assert.equal(result.evidence.exitCode, 0);
    assert.match(result.reason, /turn\.failed/);
  }
});

test('completion beyond the evidence count limit still allows PASS', async () => {
  const root = await setup();
  const output = '{"type":"turn.started"}\n' + completed;
  const result = await ready(root, { maxEvents: 1, spawnFixture: () => child({ output }) })(issue(), { workspace: root });
  assert.equal(result.status, 'PASS');
  assert.equal(result.evidence.eventCount, 1);
  assert.equal(result.evidence.lastEventType, 'turn.completed');
});

test('raw stdout overflow after completion stays FAIL when the child exits zero', async () => {
  const root = await setup();
  const completion = Buffer.from(completed);
  const chunks = [completion, Buffer.from('\r\n'), Buffer.from('\n')];
  const signals = [];
  const result = await ready(root, {
    maxOutputBytes: completion.length,
    spawnFixture: () => child({ chunks, kill: (signal) => signals.push(signal) }),
  })(issue(), { workspace: root });

  assert.equal(result.status, 'FAIL');
  assert.equal(result.evidence.exitCode, 0);
  assert.match(result.reason, /output exceeds/);
  assert.deepEqual(signals, ['SIGTERM']);
});

test('invalid UTF-8 inside a JSONL event after completion is FAIL', async () => {
  const root = await setup();
  const invalid = Buffer.concat([Buffer.from('{"type":"'), Buffer.from([0xff]), Buffer.from('"}\n')]);
  const chunks = [Buffer.from(completed), invalid];
  const result = await ready(root, { spawnFixture: () => child({ chunks }) })(issue(), { workspace: root });

  assert.equal(result.status, 'FAIL');
  assert.equal(result.evidence.exitCode, 0);
  assert.match(result.reason, /UTF-8/);
});

test('valid UTF-8 split across stdout chunks is preserved', async () => {
  const root = await setup();
  const type = 'café 🧪';
  const prefix = Buffer.from(completed + '{"type":"caf');
  const suffix = Buffer.from('é 🧪"}\n');
  const chunks = [prefix, suffix.subarray(0, 1), suffix.subarray(1, 5), suffix.subarray(5)];
  const result = await ready(root, {
    maxOutputBytes: prefix.length + suffix.length,
    spawnFixture: () => child({ chunks }),
  })(issue(), { workspace: root });

  assert.equal(result.status, 'PASS');
  assert.equal(result.evidence.lastEventType, type);
});

test('truncated UTF-8 after completion is rejected when stdout closes', async () => {
  const root = await setup();
  const chunks = [Buffer.from(completed), Buffer.from([0xf0, 0x9f])];
  const result = await ready(root, { spawnFixture: () => child({ chunks }) })(issue(), { workspace: root });

  assert.equal(result.status, 'FAIL');
  assert.match(result.reason, /UTF-8/);
});

test('truncated JSONL after completion is FAIL', async () => {
  const root = await setup();
  const chunks = [Buffer.from(completed), Buffer.from('{"type":"item.completed"')];
  const result = await ready(root, { spawnFixture: () => child({ chunks }) })(issue(), { workspace: root });

  assert.equal(result.status, 'FAIL');
  assert.match(result.reason, /malformed JSONL/);
});

for (const [description, suffix] of [
  ['empty record', '\n'],
  ['whitespace-only record', ' \t\r\n'],
  ['whitespace-only suffix', ' \t'],
  ['BOM-only record', '\ufeff\n'],
  ['BOM-only suffix', '\ufeff'],
]) {
  test(`JSONL rejects a trailing ${description} after completion`, async () => {
    const root = await setup();
    const chunks = [Buffer.from(completed), Buffer.from(suffix)];
    const result = await ready(root, { spawnFixture: () => child({ chunks }) })(issue(), { workspace: root });
    assert.equal(result.status, 'FAIL');
    assert.match(result.reason, /malformed JSONL/);
  });
}

test('JSONL accepts a single LF or CRLF delimiter and a complete final record without one', async () => {
  const root = await setup();
  const record = completed.trimEnd();
  for (const suffix of ['\n', '\r\n', '']) {
    const result = await ready(root, { spawnFixture: () => child({ output: record + suffix }) })(issue(), { workspace: root });
    assert.equal(result.status, 'PASS');
  }
});

test('pre-decoded stdout fails because byte integrity cannot be verified', async () => {
  const root = await setup();
  const result = await ready(root, { spawnFixture: () => child({ chunks: [completed] }) })(issue(), { workspace: root });
  assert.equal(result.status, 'FAIL');
  assert.match(result.reason, /raw bytes/);
});

for (const [trigger, reason] of [
  ['overflow', /output exceeds/],
  ['timeout', /timed out/],
  ['cancellation', /cancelled/],
]) {
  test(`${trigger} escalates to SIGKILL and waits for a SIGTERM-resistant Node child to close`, { timeout: 5500 }, async (t) => {
    const root = await setup();
    const controller = new AbortController();
    const signals = [];
    const output = trigger === 'overflow' ? completed + ' '.repeat(256) : completed;
    const script = `
      process.on('SIGTERM', () => {});
      setTimeout(() => process.exit(99), 3500);
      process.stdout.write(${JSON.stringify(output)});
      process.stderr.write('ready\\n');
    `;
    let launched;
    const result = await ready(root, {
      maxOutputBytes: 128,
      timeoutMs: 800,
      spawnFixture: () => {
        const onReady = trigger === 'cancellation' ? () => controller.abort() : undefined;
        launched = launchNode(t, script, signals, onReady);
        return launched.subprocess;
      },
    })(issue(), { workspace: root, signal: controller.signal });

    assert.equal(result.status, 'FAIL');
    assert.match(result.reason, reason);
    assert.deepEqual(launched.close, { code: null, signal: 'SIGKILL' });
    assert.equal(result.evidence.signal, 'SIGKILL');
    assert.equal(result.evidence.timedOut, trigger === 'timeout');
    assert.equal(result.evidence.cancelled, trigger === 'cancellation');
    assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  });
}

test('normal Node child exit closes without a kill signal', { timeout: 5500 }, async (t) => {
  const root = await setup();
  const signals = [];
  let launched;
  const result = await ready(root, {
    timeoutMs: 800,
    spawnFixture: () => {
      launched = launchNode(t, `process.stdout.write(${JSON.stringify(completed)});`, signals);
      return launched.subprocess;
    },
  })(issue(), { workspace: root });

  assert.equal(result.status, 'PASS');
  assert.deepEqual(launched.close, { code: 0, signal: null });
  assert.deepEqual(signals, []);
});

test('repeated stop triggers preserve the first failure and report unconfirmed closure', { timeout: 2000 }, async () => {
  const root = await setup();
  const controller = new AbortController();
  const signals = [];
  const subprocess = new EventEmitter();
  subprocess.stdout = new EventEmitter();
  subprocess.kill = (signal) => {
    signals.push(signal);
    controller.abort();
    subprocess.stdout.emit('data', Buffer.alloc(129));
    return false;
  };
  const result = await ready(root, {
    timeoutMs: 15,
    maxOutputBytes: 128,
    spawnFixture: () => {
      setImmediate(() => subprocess.stdout.emit('data', Buffer.alloc(129)));
      return subprocess;
    },
  })(issue(), { workspace: root, signal: controller.signal });

  assert.equal(result.status, 'FAIL');
  assert.match(result.reason, /output exceeds/);
  assert.match(result.reason, /termination failed.*close/);
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
});

test('observed exit cancels escalation while missing close still fails explicitly', { timeout: 2000 }, async () => {
  const root = await setup();
  const { signal } = new AbortController();
  const signals = [];
  const subprocess = new EventEmitter();
  subprocess.kill = (signal) => {
    signals.push(signal);
    subprocess.emit('exit', 0, null);
  };
  const result = await ready(root, { timeoutMs: 5, spawnFixture: () => subprocess })(issue(), { workspace: root, signal });

  assert.equal(result.status, 'FAIL');
  assert.equal(result.evidence.timedOut, true);
  assert.match(result.reason, /termination failed.*close/);
  assert.deepEqual(signals, ['SIGTERM']);
  assert.deepEqual(getEventListeners(signal, 'abort'), []);
});

test('shared abort cancels a real Node child after completion even when an earlier listener stops propagation', { timeout: 5500 }, async (t) => {
  const root = await setup();
  const controller = new AbortController();
  const { signal } = controller;
  const stopPropagation = (event) => event.stopImmediatePropagation();
  signal.addEventListener('abort', stopPropagation);
  const signals = [];
  const script = `
    process.on('SIGTERM', () => process.exit(0));
    process.stdout.write(${JSON.stringify(completed)});
    setTimeout(() => process.exit(0), 700);
  `;
  let launched;
  const result = await ready(root, {
    timeoutMs: 2500,
    spawnFixture: () => {
      launched = launchNode(t, script, signals);
      queueMicrotask(() => launched.subprocess.stdout.once('data', () => controller.abort()));
      return launched.subprocess;
    },
  })(issue(), { workspace: root, signal });

  assert.equal(result.status, 'FAIL');
  assert.equal(result.evidence.cancelled, true);
  assert.equal(result.evidence.exitCode, 0);
  assert.deepEqual(launched.close, { code: 0, signal: null });
  assert.deepEqual(signals, ['SIGTERM']);
  assert.deepEqual(getEventListeners(signal, 'abort'), [stopPropagation]);
});

test('already-aborted execution fails without spawning or adding a listener', async () => {
  const root = await setup();
  const signal = AbortSignal.abort();
  const spawn = () => assert.fail('an already-aborted execution must not spawn');
  const result = await ready(root, { spawnFixture: spawn })(issue(), { workspace: root, signal });

  assert.equal(result.status, 'FAIL');
  assert.equal(result.evidence.cancelled, true);
  assert.deepEqual(getEventListeners(signal, 'abort'), []);
});

test('spawn failure disposes the abort subscription', async () => {
  const root = await setup();
  const { signal } = new AbortController();
  const spawn = () => { throw new Error('test spawn failure'); };
  const result = await ready(root, { spawnFixture: spawn })(issue(), { workspace: root, signal });

  assert.equal(result.status, 'FAIL');
  assert.match(result.reason, /spawn failed/);
  assert.deepEqual(getEventListeners(signal, 'abort'), []);
});

for (const [closeMs, decisionMs] of [[9, 9], [10, 10], [11, 11], [9, 10]]) {
  test(`close at ${closeMs} ms and final check at ${decisionMs} ms enforce the 10 ms deadline`, async (t) => {
    const root = await setup();
    const { signal } = new AbortController();
    let elapsed = 0n;
    let closing = false;
    t.mock.method(process.hrtime, 'bigint', () => {
      const now = elapsed;
      if (closing) elapsed = BigInt(decisionMs) * 1_000_000n;
      return now;
    });
    const timers = new Set();
    const wakeUp = t.mock.method(globalThis, 'setTimeout', (callback) => {
      timers.add(callback);
      return callback;
    });
    t.mock.method(globalThis, 'clearTimeout', (callback) => timers.delete(callback));
    const subprocess = new EventEmitter();
    subprocess.stdout = new EventEmitter();
    subprocess.kill = () => assert.fail('close already confirms termination');
    const result = await ready(root, {
      timeoutMs: 10,
      spawnFixture: () => {
        queueMicrotask(() => {
          subprocess.stdout.emit('data', Buffer.from(completed));
          elapsed = BigInt(closeMs) * 1_000_000n;
          closing = true;
          subprocess.emit('close', 0, null);
        });
        return subprocess;
      },
    })(issue(), { workspace: root, signal });

    const expired = decisionMs >= 10;
    assert.equal(result.status, expired ? 'FAIL' : 'PASS');
    assert.equal(result.evidence.timedOut, expired);
    assert.equal(result.evidence.exitCode, 0);
    assert.equal(wakeUp.mock.callCount(), 1);
    assert.equal(timers.size, 0);
    assert.deepEqual(getEventListeners(signal, 'abort'), []);
  });
}

test('an event-loop stall past the deadline prevents PASS even when close runs before timers', async () => {
  const root = await setup();
  const subprocess = new EventEmitter();
  subprocess.stdout = new EventEmitter();
  subprocess.kill = () => assert.fail('the child has already closed');
  const result = await ready(root, {
    timeoutMs: 20,
    spawnFixture: () => {
      queueMicrotask(() => {
        subprocess.stdout.emit('data', Buffer.from(completed));
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40);
        subprocess.emit('close', 0, null);
      });
      return subprocess;
    },
  })(issue(), { workspace: root });

  assert.equal(result.status, 'FAIL');
  assert.equal(result.evidence.timedOut, true);
  assert.equal(result.evidence.exitCode, 0);
});

test('nonzero CLI exit is FAIL', async () => { const root = await setup(); const result = await ready(root, { spawnFixture: () => child({ code: 2 }) })(issue(), { workspace: root }); assert.equal(result.status, 'FAIL'); assert.equal(result.evidence.exitCode, 2); });
test('timeout and cancellation do not pass', async () => { const root = await setup(); const timed = await ready(root, { timeoutMs: 5, spawnFixture: () => child({ delay: 30 }) })(issue(), { workspace: root }); assert.equal(timed.status, 'FAIL'); assert.equal(timed.evidence.timedOut, true); const controller = new AbortController(); controller.abort(); const cancelled = await ready(root)(issue(), { workspace: root, signal: controller.signal }); assert.equal(cancelled.evidence.cancelled, true); });
test('invalid workspace and symlink escape are rejected', async () => { const root = await setup(); const outside = await setup(); const link = path.join(root, 'link'); await symlink(outside, link, 'junction'); assert.equal((await ready(root)(issue(), { workspace: path.join(root, 'missing') })).status, 'FAIL'); assert.match((await ready(root)(issue(), { workspace: link })).reason, /outside|allowed/); });
test('unverified MCP or runtime isolation fails closed', async () => { const root = await setup(); assert.match((await createCodexCliAdapter({ simulation: true, allowedWorkspaces: [root], spawnFixture: () => { throw new Error('must not spawn'); } })(issue(), { workspace: root })).reason, /isolation/); assert.match((await createCodexCliAdapter({ simulation: true, allowedWorkspaces: [root], runtimeIsolation: { verified: true }, spawnFixture: () => { throw new Error('must not spawn'); } })(issue(), { workspace: root })).reason, /MCP/); });
test('malformed JSONL is rejected', async () => { const root = await setup(); const result = await ready(root, { spawnFixture: () => child({ output: 'not-json\n' }) })(issue(), { workspace: root }); assert.match(result.reason, /malformed/); });
test('BLOCKED and STOP never spawn; merge/deploy capability is unavailable', async () => { const root = await setup(); let calls = 0; const adapter = ready(root, { spawnFixture: () => { calls += 1; return child(); } }); assert.equal((await adapter({ status: 'BLOCKED' }, { workspace: root })).status, 'FAIL'); assert.equal((await adapter(issue({ capabilities: ['merge'] }), { workspace: root })).status, 'FAIL'); assert.equal(calls, 0); });
test('real execution is disabled by default', async () => { const root = await setup(); let calls = 0; const result = await createCodexCliAdapter({ allowedWorkspaces: [root], spawnFixture: () => { calls += 1; } })(issue(), { workspace: root }); assert.equal(result.status, 'FAIL'); assert.equal(calls, 0); });

test('simulated control flags cannot authorize live execution', async () => {
  const root = await setup();
  const result = await ready(root, {
    realExecution: true,
    spawnFixture: () => assert.fail('live isolation is unavailable'),
  })(issue(), { workspace: root });
  assert.equal(result.status, 'BLOCKED');
  assert.match(result.reason, /live Codex process isolation is not verified/);
});
