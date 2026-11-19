import { execFileSync } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { observeMergedGitHubEvidence } from './github-evidence.mjs';
import { mergedEvidenceTarget as target } from './github-evidence-smoke.mjs';
import { blockedWorker, observeWorkerIsolation } from './isolation-worker.mjs';

const staleSha = 'd0bcca1ce19b5c3d8758d950ad791b7199df74e5';
const mismatch = 'GitHub merged PR does not match the repository, candidate and main merge';
const statuses = new Set(['PASS', 'FAIL', 'BLOCKED']);
const sha = (value) => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const status = (value) => statuses.has(value) ? value : 'BLOCKED';

async function verifyCurrentMain(env) {
  const compared = {
    dispatched_sha: sha(env.GITHUB_SHA) ? env.GITHUB_SHA : null,
    checked_out_sha: null,
    current_main_sha: null,
  };
  const result = (status, reason_code) => ({ status, reason_code, ...compared });
  if (env.GITHUB_ACTIONS !== 'true' || env.RUNNER_ENVIRONMENT !== 'github-hosted' ||
      env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || env.GITHUB_REF !== 'refs/heads/main' ||
      env.GITHUB_REPOSITORY !== target.repository || !compared.dispatched_sha ||
      compared.dispatched_sha !== env.GITHUB_WORKFLOW_SHA) {
    return result('BLOCKED', 'DISPATCH_IDENTITY_UNVERIFIED');
  }
  try {
    const checkedOut = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], {
      encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    if (sha(checkedOut)) compared.checked_out_sha = checkedOut;
  } catch {
    return result('BLOCKED', 'CHECKOUT_UNVERIFIED');
  }
  if (!compared.checked_out_sha) return result('BLOCKED', 'CHECKOUT_UNVERIFIED');
  if (compared.checked_out_sha !== compared.dispatched_sha) return result('FAIL', 'CHECKOUT_SHA_MISMATCH');
  if (!env.GITHUB_TOKEN?.trim()) return result('BLOCKED', 'MAIN_LOOKUP_TOKEN_MISSING');

  try {
    const response = await fetch(`https://api.github.com/repos/${target.repository}/git/ref/heads/main`, {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${env.GITHUB_TOKEN}`,
        'cache-control': 'no-cache',
        'x-github-api-version': '2022-11-28',
      },
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    });
    if ([401, 403, 404].includes(response.status)) return result('BLOCKED', 'MAIN_LOOKUP_DENIED_OR_UNAVAILABLE');
    if (!response.ok) return result('BLOCKED', 'MAIN_LOOKUP_FAILED');
    const ref = await response.json();
    if (ref?.ref !== 'refs/heads/main' || ref.object?.type !== 'commit' || !sha(ref.object.sha)) {
      return result('BLOCKED', 'MAIN_RESPONSE_UNVERIFIED');
    }
    compared.current_main_sha = ref.object.sha;
  } catch {
    return result('BLOCKED', 'MAIN_LOOKUP_FAILED');
  }
  return compared.current_main_sha === compared.dispatched_sha
    ? result('PASS', 'CURRENT_MAIN_VERIFIED') : result('FAIL', 'CURRENT_MAIN_SHA_MISMATCH');
}

export async function verifyHandoff(candidateSha, read = observeMergedGitHubEvidence) {
  const controls = { github_permissions: 'BLOCKED', candidate_sha: 'BLOCKED', stale_sha_negative: 'BLOCKED' };
  if (!sha(candidateSha)) return { controls };
  const report = await read({ ...target, revision: candidateSha });
  if (report.mode !== 'LIVE') return { controls };
  if (report.evidence_read !== 'PASS') {
    if (report.reason === mismatch) controls.candidate_sha = 'FAIL';
    return { controls, github_evidence: report };
  }
  if (report.candidate_sha !== candidateSha || candidateSha !== target.revision ||
      report.merge_sha !== target.mergeCommit) {
    controls.candidate_sha = 'FAIL';
    return { controls };
  }
  controls.github_permissions = 'PASS';
  controls.candidate_sha = 'PASS';

  const stale = await read({ ...target, revision: staleSha });
  if (stale.mode === 'LIVE') {
    if (stale.evidence_read === 'BLOCKED' && stale.reason === mismatch) controls.stale_sha_negative = 'PASS';
    if (stale.evidence_read === 'PASS') controls.stale_sha_negative = 'FAIL';
  }
  // Use the existing sanitized, read-only provenance report.
  return { controls, github_evidence: report };
}

export function permissionNegative(report) {
  return report.mode === 'LIVE' && report.evidence_read === 'BLOCKED' && report.permission_denied === true
    ? 'PASS' : 'BLOCKED';
}

function parseControls(serialized) {
  const controls = blockedWorker();
  try {
    const supplied = JSON.parse(serialized);
    for (const key of Object.keys(controls)) controls[key] = status(supplied?.[key]);
  } catch {
    // An unavailable worker result leaves these controls blocked.
  }
  return controls;
}

async function main(env, mode) {
  const admission = await verifyCurrentMain(env);
  const admitted = admission.status === 'PASS';
  const output = (key, value) => appendFileSync(env.GITHUB_OUTPUT, `${key}=${value}\n`);
  if (mode === 'worker') {
    // The short-lived read token belongs to the host admission check only.
    delete env.GITHUB_TOKEN;
    console.log(JSON.stringify({ main_verification: admission }));
    const worker = admitted ? await observeWorkerIsolation(target.revision) : { controls: blockedWorker() };
    output('controls', JSON.stringify(worker.controls));
    if (worker.candidate_sha) output('candidate_sha', worker.candidate_sha);
    return;
  }
  if (mode === 'denied') {
    console.log(JSON.stringify({ main_verification: admission }));
    const result = admitted ? await observeMergedGitHubEvidence(target) : {};
    output('permission_negative', permissionNegative(result));
    return;
  }
  if (mode !== 'report') throw new Error('Unknown smoke mode');

  const worker = admitted ? parseControls(env.WORKER_CONTROLS) : blockedWorker();
  let handoff = await verifyHandoff(admitted && worker.credentials === 'PASS' && worker.workspace === 'PASS'
    ? env.WORKER_CANDIDATE_SHA : undefined);
  // Recheck after the GitHub evidence reads so a concurrent main update cannot bless stale evidence.
  const recording = admitted ? await verifyCurrentMain(env) : admission;
  const trusted = recording.status === 'PASS';
  if (!trusted) handoff = await verifyHandoff(undefined);
  const controls = {
    trusted_main: recording.status,
    ...(trusted ? worker : blockedWorker()),
    ...handoff.controls,
    invalid_permissions_negative: trusted && handoff.controls.github_permissions === 'PASS' ? status(env.PERMISSION_NEGATIVE) : 'BLOCKED',
    github_job_cancellation: 'BLOCKED',
  };
  const report = {
    schema: 'factory.isolation_smoke.v1',
    mode: trusted ? 'LIVE' : 'UNVERIFIED',
    repository: target.repository,
    workflow_sha: trusted ? recording.dispatched_sha : null,
    main_verification: recording,
    run_id: /^\d+$/.test(env.GITHUB_RUN_ID) ? env.GITHUB_RUN_ID : null,
    run_attempt: /^\d+$/.test(env.GITHUB_RUN_ATTEMPT) ? env.GITHUB_RUN_ATTEMPT : null,
    realExecution: false,
    authorization: 'BLOCKED',
    controls,
    overall: Object.values(controls).includes('FAIL') ? 'FAIL' :
      Object.values(controls).includes('BLOCKED') ? 'BLOCKED' : 'PASS',
    github_evidence: handoff.github_evidence,
    blockers: {
      github_job_cancellation: 'Requires a post-cancellation observer outside the canceled runner job.',
      ...(controls.descendants === 'BLOCKED' ? {
        descendants: 'Requires runner-visible process identities before and after container teardown.',
      } : {}),
      ...(controls.invalid_permissions_negative === 'BLOCKED' ? {
        invalid_permissions_negative: 'Requires a successful read and an explicit denial with the restricted job token.',
      } : {}),
    },
  };
  const json = JSON.stringify(report, null, 2);
  writeFileSync('isolation-evidence.json', json + '\n');
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `### F2-09B LIVE-02 evidence\n\n\`\`\`json\n${json}\n\`\`\`\n`);
  console.log(json);
  if (report.overall !== 'PASS') process.exitCode = 1;
}

if (import.meta.main) {
  try {
    await main(process.env, process.argv[2]);
  } catch {
    console.error('The isolation smoke could not finish or emit its sanitized evidence.');
    process.exitCode = 1;
  }
}
