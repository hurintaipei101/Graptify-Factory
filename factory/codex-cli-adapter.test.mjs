import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCodexCliAdapter } from './codex-cli-adapter.mjs';

const issue = (extra = {}) => ({ issueKey: 'F2-06C', environment: 'staging', ...extra });
const completed = '{"type":"turn.completed","usage":{"input_tokens":2,"cached_input_tokens":0,"output_tokens":1}}\n';
const child = ({ output = completed, code = 0, delay = 0 } = {}) => { const handlers = {}; const stdoutHandlers = {}; const stream = (target) => ({ on: (event, fn) => { target[event] = fn; } }); const p = { stdout: stream(stdoutHandlers), stderr: stream({}), kill: () => {}, on: (event, fn) => { handlers[event] = fn; if (event === 'close') setTimeout(() => { stdoutHandlers.data?.(output); fn(code, null); }, delay); } }; return p; };
async function setup() { return mkdtemp(path.join(os.tmpdir(), 'codex-adapter-')); }
function ready(root, overrides = {}) { return createCodexCliAdapter({ realExecution: true, allowedWorkspaces: [root], runtimeIsolation: { verified: true }, mcpAccess: { verified: true, allowed: true }, spawn: () => child(), ...overrides }); }

test('fake CLI successful invocation returns compact PASS evidence', async () => { const root = await setup(); const result = await ready(root)(issue(), { workspace: root, prompt: 'test' }); assert.equal(result.status, 'PASS'); assert.equal(result.passed, true); assert.equal(result.evidence.eventCount, 1); assert.equal(result.evidence.lastEventType, 'turn.completed'); });

test('zero CLI exit without turn.completed is FAIL', async () => {
  const root = await setup();
  for (const output of ['{"type":"result"}\n', '']) {
    const result = await ready(root, { spawn: () => child({ output }) })(issue(), { workspace: root });
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
    const result = await ready(root, { maxEvents: 1, spawn: () => child({ output }) })(issue(), { workspace: root });
    assert.equal(result.status, 'FAIL');
    assert.equal(result.passed, false);
    assert.equal(result.evidence.exitCode, 0);
    assert.match(result.reason, /turn\.failed/);
  }
});

test('completion beyond the evidence count limit still allows PASS', async () => {
  const root = await setup();
  const output = '{"type":"turn.started"}\n' + completed;
  const result = await ready(root, { maxEvents: 1, spawn: () => child({ output }) })(issue(), { workspace: root });
  assert.equal(result.status, 'PASS');
  assert.equal(result.evidence.eventCount, 1);
  assert.equal(result.evidence.lastEventType, 'turn.completed');
});
test('nonzero CLI exit is FAIL', async () => { const root = await setup(); const result = await ready(root, { spawn: () => child({ code: 2 }) })(issue(), { workspace: root }); assert.equal(result.status, 'FAIL'); assert.equal(result.evidence.exitCode, 2); });
test('timeout and cancellation do not pass', async () => { const root = await setup(); const timed = await ready(root, { timeoutMs: 5, spawn: () => child({ delay: 30 }) })(issue(), { workspace: root }); assert.equal(timed.status, 'FAIL'); assert.equal(timed.evidence.timedOut, true); const controller = new AbortController(); controller.abort(); const cancelled = await ready(root)(issue(), { workspace: root, signal: controller.signal }); assert.equal(cancelled.evidence.cancelled, true); });
test('invalid workspace and symlink escape are rejected', async () => { const root = await setup(); const outside = await setup(); const link = path.join(root, 'link'); await symlink(outside, link, 'junction'); assert.equal((await ready(root)(issue(), { workspace: path.join(root, 'missing') })).status, 'FAIL'); assert.match((await ready(root)(issue(), { workspace: link })).reason, /outside|allowed/); });
test('unverified MCP or runtime isolation fails closed', async () => { const root = await setup(); assert.match((await createCodexCliAdapter({ realExecution: true, allowedWorkspaces: [root], spawn: () => { throw new Error('must not spawn'); } })(issue(), { workspace: root })).reason, /isolation/); assert.match((await createCodexCliAdapter({ realExecution: true, allowedWorkspaces: [root], runtimeIsolation: { verified: true }, spawn: () => { throw new Error('must not spawn'); } })(issue(), { workspace: root })).reason, /MCP/); });
test('malformed JSONL is rejected', async () => { const root = await setup(); const result = await ready(root, { spawn: () => child({ output: 'not-json\n' }) })(issue(), { workspace: root }); assert.match(result.reason, /malformed/); });
test('BLOCKED and STOP never spawn; merge/deploy capability is unavailable', async () => { const root = await setup(); let calls = 0; const adapter = ready(root, { spawn: () => { calls += 1; return child(); } }); assert.equal((await adapter({ status: 'BLOCKED' }, { workspace: root })).status, 'FAIL'); assert.equal((await adapter(issue({ capabilities: ['merge'] }), { workspace: root })).status, 'FAIL'); assert.equal(calls, 0); });
test('real execution is disabled by default', async () => { const root = await setup(); let calls = 0; const result = await createCodexCliAdapter({ allowedWorkspaces: [root], spawn: () => { calls += 1; } })(issue(), { workspace: root }); assert.equal(result.status, 'FAIL'); assert.equal(calls, 0); });
