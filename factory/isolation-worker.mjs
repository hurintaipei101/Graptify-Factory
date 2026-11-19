import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { createCodexCliAdapter } from './codex-cli-adapter.mjs';

const image = 'docker.io/library/node@sha256:47725aca53d3295ec2d3be8f62726599b3033cc262edc2c7e429909b3ac599fc';
const scratchPrefix = 'factory-isolation-';
const workerControls = ['credentials', 'workspace', 'isolation_negative', 'timeout', 'cancellation', 'descendants'];
export const blockedWorker = () => Object.fromEntries(workerControls.map((name) => [name, 'BLOCKED']));
const verdict = (passed) => passed ? 'PASS' : 'FAIL';

function processIdentity(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const end = stat.lastIndexOf(')');
    const fields = stat.slice(end + 2).split(' ');
    return {
      pid, command: stat.slice(stat.indexOf('(') + 1, end), state: fields[0],
      parent: Number(fields[1]), session: Number(fields[3]), start: fields[19],
    };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function witnessDescendants(initPid) {
  const init = processIdentity(initPid);
  if (init?.command !== 'docker-init') return;
  const rows = execFileSync('ps', ['-eo', 'pid=,ppid='], {
    encoding: 'utf8', timeout: 2000, maxBuffer: 262_144, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim().split('\n').map((row) => row.trim().split(/\s+/).map(Number));
  const childOf = (parent) => {
    if (!parent) return;
    const children = rows.filter(([, ppid]) => ppid === parent.pid);
    if (children.length !== 1) return;
    const child = processIdentity(children[0][0]);
    if (child?.parent === parent.pid && child.command === 'node') return child;
  };
  const worker = childOf(init);
  const child = childOf(worker);
  const grandchild = childOf(child);
  if (child && grandchild && child.session === child.pid && grandchild.session === grandchild.pid) {
    return [child, grandchild];
  }
}

export async function observeWorkerIsolation(candidateSha) {
  const controls = blockedWorker();
  const scratch = mkdtempSync(join(tmpdir(), scratchPrefix));
  const config = join(scratch, 'docker');
  const adapterWorkspace = join(scratch, 'adapter');
  const probe = join(scratch, 'probe');
  const canary = join(scratch, 'host-canary');
  const abort = new AbortController();
  const interrupt = () => abort.abort();
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  const dockerEnv = { PATH: '/usr/local/bin:/usr/bin:/bin', GITHUB_TOKEN: 'synthetic-probe',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'synthetic-probe', AWS_SESSION_TOKEN: 'synthetic-probe' };
  const dockerArgs = ['--config', config, '--host', 'unix:///var/run/docker.sock'];
  const docker = (...args) => execFileSync('docker', [...dockerArgs, ...args], {
    encoding: 'utf8', timeout: 10_000, maxBuffer: 32_768, env: dockerEnv, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

  async function run(name, { negative = false, lifecycle = false, cancel = false } = {}) {
    if (abort.signal.aborted) return {};
    const container = `${basename(scratch)}-${name}`;
    const controller = new AbortController();
    const signal = AbortSignal.any([abort.signal, controller.signal]);
    let observation;
    let attached;
    let descendants;
    let killed = false;
    let ready = false;
    try {
      docker('create', '--name', container, '--pull=never', '--platform=linux/amd64', '--init',
        '--network=none', '--ipc=none', '--read-only', '--user=65534:65534', '--cap-drop=ALL',
        '--security-opt=no-new-privileges', '--pids-limit=32', '--memory=128m',
        '--tmpfs=/work:rw,noexec,nosuid,nodev,mode=1777', '--workdir=/work', '--env=HOME=/work',
        '--mount', `type=bind,src=${probe},dst=/probe,readonly`,
        ...(negative ? ['--env=GITHUB_TOKEN=synthetic-probe', '--tmpfs=/tmp:rw,noexec,nosuid,nodev,mode=1777'] : []),
        '--entrypoint=/usr/local/bin/node', image, '/probe/probe.mjs',
        ...(lifecycle ? ['hold'] : ['boundary', candidateSha, canary]));

      const adapter = createCodexCliAdapter({
        simulation: true, realExecution: false, allowedWorkspaces: [adapterWorkspace],
        runtimeIsolation: { verified: true }, mcpAccess: { verified: true, allowed: true },
        timeoutMs: cancel ? 10_000 : 4_000,
        spawnFixture() {
          const child = spawn('docker', [...dockerArgs, 'start', '--attach', container], {
            env: dockerEnv, stdio: ['ignore', 'pipe', 'pipe'],
          });
          attached = child;
          child.kill = () => {
            if (!killed) {
              docker('kill', '--signal=KILL', container);
              killed = true;
            }
          };
          let output = '';
          child.stdout.on('data', (chunk) => {
            if (output.length > 4096) return;
            output += chunk.toString();
            if (ready || !output.includes('\n')) return;
            try {
              const event = JSON.parse(output.split('\n', 1)[0]);
              if (!lifecycle && event.type === 'probe.boundary') observation = event;
              if (lifecycle && event.type === 'probe.ready') {
                ready = true;
                const initPid = Number(docker('inspect', '--format', '{{.State.Pid}}', container));
                descendants = witnessDescendants(initPid);
              }
            } catch {
              // A missing host PID witness leaves descendant verification blocked.
            }
            if (cancel && ready) controller.abort();
          });
          return child;
        },
      });
      const result = await adapter({}, { workspace: adapterWorkspace, signal });
      if (!lifecycle) return { result, observation };
      const state = JSON.parse(docker('inspect', '--format', '{{json .State}}', container));
      const stopped = killed && state.Status === 'exited' && state.Pid === 0 && state.ExitCode === 137 && !state.OOMKilled;
      const terminated = descendants?.every(({ pid, start }) => {
        const current = processIdentity(pid);
        return !current || current.start !== start || current.state === 'Z';
      });
      return { result, ready, stopped, terminated };
    } finally {
      try {
        docker('rm', '--force', container);
      } finally {
        if (attached?.exitCode === null && attached.signalCode === null) {
          // Release an attach client whose daemon connection outlasted the container.
          process.kill(attached.pid, 'SIGKILL');
        }
      }
    }
  }

  let handoff;
  try {
    mkdirSync(config);
    mkdirSync(adapterWorkspace);
    mkdirSync(probe);
    copyFileSync(new URL('./isolation-worker-probe.mjs', import.meta.url), join(probe, 'probe.mjs'));
    chmodSync(probe, 0o755);
    chmodSync(join(probe, 'probe.mjs'), 0o444);
    writeFileSync(canary, 'synthetic host credential\n', { mode: 0o600 });
    const mountedCanary = join(probe, 'write-canary');
    writeFileSync(mountedCanary, 'read-only mount canary\n');
    chmodSync(mountedCanary, 0o666);
    docker('image', 'inspect', image);
    const attempt = (name, options) => run(name, options).catch(() => ({}));
    const normal = await attempt('boundary');
    if (normal.result) {
      controls.credentials = verdict(normal.result.passed && normal.observation?.credentials === true);
      controls.workspace = verdict(normal.result.passed && normal.observation?.workspace === true &&
        readFileSync(canary, 'utf8') === 'synthetic host credential\n' &&
        readFileSync(mountedCanary, 'utf8') === 'read-only mount canary\n' && !existsSync(canary + '.outside'));
      if (controls.credentials === 'PASS' && controls.workspace === 'PASS' &&
          normal.observation.candidate_sha === candidateSha) handoff = candidateSha;
    }
    const negative = await attempt('negative', { negative: true });
    if (negative.result) {
      controls.isolation_negative = verdict(negative.result.passed &&
        negative.observation?.credentials === false && negative.observation?.workspace === false);
    }
    const timeout = await attempt('timeout', { lifecycle: true });
    const cancellation = await attempt('cancel', { lifecycle: true, cancel: true });
    if (timeout.result) {
      controls.timeout = verdict(timeout.ready && timeout.stopped && timeout.result.evidence.timedOut &&
        !timeout.result.evidence.cancelled && timeout.result.evidence.closeConfirmed);
    }
    if (cancellation.result) {
      controls.cancellation = verdict(cancellation.ready && cancellation.stopped && cancellation.result.evidence.cancelled &&
        !cancellation.result.evidence.timedOut && cancellation.result.evidence.closeConfirmed);
    }
    if (timeout.terminated !== undefined && cancellation.terminated !== undefined) {
      controls.descendants = verdict(timeout.stopped && cancellation.stopped && timeout.terminated && cancellation.terminated);
    }
  } catch {
    // Host or container setup was unavailable. Preserve completed controls.
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    rmSync(scratch, { recursive: true, force: true });
  }
  return { controls, candidate_sha: handoff };
}
