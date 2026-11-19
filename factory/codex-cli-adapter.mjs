import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_LIMITS = Object.freeze({ timeoutMs: 120_000, maxEvents: 256, maxEventBytes: 16_384, maxOutputBytes: 32_768 });
const FORBIDDEN_CAPABILITIES = new Set(['merge', 'deploy', 'production']);

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
  let bytes = 0; const events = []; let lastEventType = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    bytes += Buffer.byteLength(line);
    if (bytes > limits.maxOutputBytes) throw new Error('JSONL output exceeds bounded memory limit');
    if (Buffer.byteLength(line) > limits.maxEventBytes) throw new Error('JSONL event exceeds bounded memory limit');
    let event; try { event = JSON.parse(line); } catch { throw new Error('malformed JSONL event'); }
    if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('JSONL event must be an object');
    if (events.length < limits.maxEvents) events.push(event);
    lastEventType = typeof event.type === 'string' ? event.type : null;
  }
  return { eventCount: events.length, lastEventType, events };
}

/** Create a bounded, injectable adapter. Real execution is opt-in and isolation is fail-closed. */
export function createCodexCliAdapter(options = {}) {
  const { spawn = null, allowedWorkspaces = [], realExecution = false, runtimeIsolation = {}, mcpAccess = {}, timeoutMs = DEFAULT_LIMITS.timeoutMs, maxEvents = DEFAULT_LIMITS.maxEvents, maxEventBytes = DEFAULT_LIMITS.maxEventBytes, maxOutputBytes = DEFAULT_LIMITS.maxOutputBytes } = options;
  const limits = { timeoutMs, maxEvents, maxEventBytes, maxOutputBytes };
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
    const args = ['exec', '--json', '--sandbox', 'read-only', '--skip-git-repo-check', String(context.prompt ?? issue.prompt ?? '')];
    const env = { PATH: process.env.PATH ?? '', CODEX_HOME: context.codexHome ?? path.join(workspace, '.codex-isolated') };
    return new Promise((resolve) => {
      let settled = false; let stdout = ''; let stderr = ''; let timer;
      const finish = (result) => { if (settled) return; settled = true; clearTimeout(timer); resolve(result); };
      let child;
      try { child = spawn('codex', args, { cwd: workspace, env, windowsHide: true }); } catch (error) { finish(fail(`spawn failed: ${error.message}`)); return; }
      const cancel = () => { if (!settled) { child.kill?.('SIGTERM'); finish(fail('execution cancelled', { cancelled: true })); } };
      if (context.signal) { if (context.signal.aborted) return cancel(); context.signal.addEventListener('abort', cancel, { once: true }); }
      child.stdout?.on('data', (chunk) => { stdout += String(chunk); if (Buffer.byteLength(stdout) > maxOutputBytes) child.kill?.('SIGTERM'); });
      child.stderr?.on('data', (chunk) => { stderr += String(chunk).slice(0, maxOutputBytes); });
      timer = setTimeout(() => { child.kill?.('SIGTERM'); finish(fail('execution timed out', { timedOut: true })); }, timeoutMs);
      child.on('error', (error) => finish(fail(`process error: ${error.message}`)));
      child.on('close', (exitCode, signal) => {
        if (settled) return;
        let parsed; try { parsed = parseJsonl(stdout, limits); } catch (error) { finish(fail(error.message, { exitCode, signal })); return; }
        const evidence = { ...parsed, exitCode, signal, stderr: stderr.slice(0, 512) };
        finish(exitCode === 0 ? { status: 'PASS', passed: true, evidence: compactEvidence(evidence) } : fail(`Codex CLI exited with code ${exitCode}`, evidence));
      });
    });
  };
}

export const CODEX_CLI_DEFAULT_LIMITS = DEFAULT_LIMITS;
