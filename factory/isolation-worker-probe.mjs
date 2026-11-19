import { spawn } from 'node:child_process';
import { existsSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';

const [probe, candidateSha, hostCanary] = process.argv.slice(2);
const emit = (value) => process.stdout.write(JSON.stringify(value) + '\n');

if (probe === 'hold') {
  spawn(process.execPath, [import.meta.filename, 'descendant'], { detached: true, stdio: 'inherit' });
  setInterval(() => {}, 1000);
} else if (probe === 'descendant') {
  spawn(process.execPath, [import.meta.filename, 'grandchild'], { detached: true, stdio: 'inherit' });
  setInterval(() => {}, 1000);
} else if (probe === 'grandchild') {
  emit({ type: 'probe.ready' });
  setInterval(() => {}, 1000);
} else if (probe === 'boundary') {
  const allowed = new Set(['PATH', 'HOSTNAME', 'HOME', 'NODE_VERSION', 'YARN_VERSION']);
  const initEnv = readFileSync('/proc/1/environ', 'utf8').split('\0').filter(Boolean);
  const credentials = [...Object.keys(process.env), ...initEnv.map((entry) => entry.split('=', 1)[0])]
    .every((key) => allowed.has(key)) &&
    !['/work/.git-credentials', '/work/.config/gh/hosts.yml', '/work/.git/config',
      '/work/.ssh', '/work/.aws', '/run/docker.sock', '/var/run/docker.sock', hostCanary].some(existsSync);

  function denied(file, flag = 'wx') {
    try {
      writeFileSync(file, 'isolation probe\n', { flag });
      return false;
    } catch (error) {
      if (['EROFS', 'EACCES', 'EPERM', 'ENOENT'].includes(error.code)) return true;
      throw error;
    }
  }

  writeFileSync('/work/inside', 'isolation probe\n', { flag: 'wx' });
  symlinkSync('/tmp', '/work/outside');
  const deniedWrites = ['/tmp/direct', '/work/../tmp/traversal', '/work/outside/symlink',
    '/etc/isolation-probe', '/probe/isolation-probe', '/dev/isolation-probe', '/dev/shm/isolation-probe',
    hostCanary + '.outside'].map(denied);
  emit({ type: 'probe.boundary', credentials, workspace: process.cwd() === '/work' &&
    process.getuid() === 65534 && denied('/probe/write-canary', 'a') && deniedWrites.every(Boolean), candidate_sha: candidateSha });
  emit({ type: 'turn.completed' });
} else {
  process.exitCode = 1;
}
