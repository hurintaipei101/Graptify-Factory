import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { TextDecoder } from 'node:util';

const DEFAULT_LIMITS = Object.freeze({ timeoutMs: 120_000, maxEvents: 256, maxEventBytes: 16_384, maxOutputBytes: 32_768 });
const FORBIDDEN_CAPABILITIES = new Set(['merge', 'deploy', 'production']);
const TERMINATION_GRACE_MS = 100;
const CLOSE_CONFIRMATION_MS = 250;

function fail(reason, evidence = {}) { return { status: 'FAIL', passed: false, reason, evidence: compactEvidence(evidence) }; }
function compactEvidence(evidence) {
  return { eventCount: evidence.eventCount ?? 0, lastEventType: evidence.lastEventType ?? null, exitCode: evidence.exitCode ?? null, signal: evidence.signal ?? null, timedOut: evidence.timedOut === true, cancelled: evidence.cancelled === true };
}
function isInside(child, root) { return child === root || child.startsWith(`${root}${path.sep}`); }
async function verifiedWorkspace(workspace, allowedWorkspaces) {
  if (typeof workspace !== 'string' || !path.isAbsolute(workspace) || !Array.isArray(allowedWorkspaces) || allowedWorkspaces.length === 0) throw new Error('workspace is not explicitly allowed');
  const resolved = await realpath(workspace).catch(() => { throw new Error('workspace does not exist or cannot be resolved'); });
  const allowed = await Promise.all(allowedWorkspaces.map(async (entry) => realpath(entry).catch(() => null)));
  if (!allowed.some((root) => root && isInside(resolved, root))) throw new Error('workspace is outside the allowed workspace roots');
  const info = await stat(resolved);
  if (!info.isDirectory()) throw new Error('workspace is not a directory');
  return resolved;
}
function parseJsonl(text, limits) {
  let eventCount = 0;
  let lastEventType = null;
  let turnCompleted = false;
  let turnFailed = false;
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  for (const line of lines) {
    if (Buffer.byteLength(line) > limits.maxEventBytes) throw new Error('JSONL event exceeds bounded memory limit');
    let event; try { event = JSON.parse(line); } catch { throw new Error('malformed JSONL event'); }
    if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('JSONL event must be an object');
    if (eventCount < limits.maxEvents) eventCount += 1;
    lastEventType = typeof event.type === 'string' ? event.type : null;
    if (lastEventType === 'turn.completed') turnCompleted = true;
    if (lastEventType === 'turn.failed') turnFailed = true;
  }
  return { eventCount, lastEventType, turnCompleted, turnFailed };
}

/** Create a bounded, injectable adapter. Real execution is opt-in and isolation is fail-closed. */
export function createCodexCliAdapter(options = {}) {
  const { spawn = null, allowedWorkspaces = [], realExecution = false, runtimeIsolation = {}, mcpAccess = {}, timeoutMs = DEFAULT_LIMITS.timeoutMs, maxEvents = DEFAULT_LIMITS.maxEvents, maxEventBytes = DEFAULT_LIMITS.maxEventBytes, maxOutputBytes = DEFAULT_LIMITS.maxOutputBytes } = options;
  const limits = { maxEvents, maxEventBytes };
  return async function runCodex(issue = {}, context = {}) {
    if (issue?.status === 'BLOCKED' || issue?.status === 'STOP' || context?.status === 'BLOCKED' || context?.status === 'STOP') return fail('execution status does not permit subprocess');
    if (!realExecution) return fail('real Codex execution is disabled by default');
    if (runtimeIsolation?.verified !== true) return fail('runtime isolation is not verified');
    if (mcpAccess?.verified !== true || mcpAccess?.allowed !== true) return fail('configured MCP access is not verified');
    if (issue?.environment === 'production' || issue?.production === true) return fail('production path is forbidden');
    const capabilities = context.capabilities ?? issue.capabilities ?? [];
    if (!Array.isArray(capabilities) || capabilities.some((value) => FORBIDDEN_CAPABILITIES.has(String(value).toLowerCase()))) return fail('merge/deploy/production capability is forbidden');
    let workspace;
    try { workspace = await verifiedWorkspace(context.workspace ?? issue.workspace, allowedWorkspaces); } catch (error) { return fail(error.message); }
    if (typeof spawn !== 'function') return fail('injectable process factory is required');
    if (context.signal?.aborted) return fail('execution cancelled', { cancelled: true });
    const args = ['exec', '--json', '--sandbox', 'read-only', '--skip-git-repo-check', String(context.prompt ?? issue.prompt ?? '')];
    const env = { PATH: process.env.PATH ?? '', CODEX_HOME: context.codexHome ?? path.join(workspace, '.codex-isolated') };
    return new Promise((resolve) => {
      let settled = false;
      let exited = false;
      let termination;
      let executionTimer;
      let escalationTimer;
      let confirmationTimer;
      let stdout = '';
      let stdoutBytes = 0;
      const stdoutDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
      let child;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(executionTimer);
        clearTimeout(escalationTimer);
        clearTimeout(confirmationTimer);
        context.signal?.removeEventListener('abort', cancel);
        resolve(result);
      };
      const sendSignal = (signal) => {
        try { child.kill?.(signal); } catch {
          // Signal delivery can fail. The close event or confirmation deadline determines the result.
        }
      };
      const waitForClose = () => {
        if (confirmationTimer) return;
        const { reason, evidence } = termination;
        confirmationTimer = setTimeout(() => {
          finish(fail(`${reason}; termination failed: child close was not confirmed`, evidence));
          child.stdin?.destroy?.();
          child.stdout?.destroy?.();
          child.stderr?.destroy?.();
          child.unref?.();
        }, CLOSE_CONFIRMATION_MS);
      };
      const terminate = (reason, evidence = {}) => {
        if (settled || termination) return;
        termination = { reason, evidence };
        stdout = '';
        clearTimeout(executionTimer);
        if (exited) return waitForClose();
        escalationTimer = setTimeout(() => {
          waitForClose();
          sendSignal('SIGKILL');
        }, TERMINATION_GRACE_MS);
        sendSignal('SIGTERM');
      };
      const cancel = () => terminate('execution cancelled', { cancelled: true });
      try { child = spawn('codex', args, { cwd: workspace, env, windowsHide: true }); } catch (error) { finish(fail(`spawn failed: ${error.message}`)); return; }
      executionTimer = setTimeout(() => terminate('execution timed out', { timedOut: true }), timeoutMs);
      child.on('error', (error) => terminate(`process error: ${error.message}`));
      child.on('exit', () => {
        if (settled) return;
        exited = true;
        clearTimeout(escalationTimer);
        if (termination) waitForClose();
      });
      child.on('close', (exitCode, signal) => {
        if (settled) return;
        if (termination) return finish(fail(termination.reason, { ...termination.evidence, exitCode, signal }));
        try {
          stdout += stdoutDecoder.decode();
        } catch {
          return finish(fail('invalid UTF-8 in Codex CLI stdout', { exitCode, signal }));
        }
        let parsed; try { parsed = parseJsonl(stdout, limits); } catch (error) { finish(fail(error.message, { exitCode, signal })); return; }
        const evidence = { ...parsed, exitCode, signal };
        if (exitCode !== 0) return finish(fail(`Codex CLI exited with code ${exitCode}`, evidence));
        if (parsed.turnFailed) return finish(fail('Codex CLI reported turn.failed', evidence));
        if (!parsed.turnCompleted) return finish(fail('Codex CLI did not report turn.completed', evidence));
        finish({ status: 'PASS', passed: true, evidence: compactEvidence(evidence) });
      });
      child.stdout?.on('data', (chunk) => {
        if (settled || termination) return;
        if (!(chunk instanceof Uint8Array)) return terminate('Codex CLI stdout must supply raw bytes');
        stdoutBytes += chunk.byteLength;
        if (stdoutBytes > maxOutputBytes) return terminate('JSONL output exceeds bounded memory limit');
        try {
          stdout += stdoutDecoder.decode(chunk, { stream: true });
        } catch {
          terminate('invalid UTF-8 in Codex CLI stdout');
        }
      });
      // Drain stderr without retaining it because compact evidence excludes it.
      child.stderr?.on('data', () => {});
      if (context.signal?.aborted) cancel();
      else if (!settled) context.signal?.addEventListener('abort', cancel, { once: true });
    });
  };
}

export const CODEX_CLI_DEFAULT_LIMITS = DEFAULT_LIMITS;
