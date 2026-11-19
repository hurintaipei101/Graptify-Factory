import { appendFileSync } from 'node:fs';
import { observeMergedGitHubEvidence } from './github-evidence.mjs';

const repository = 'hurintaipei101/Graptify-Factory';
const { GITHUB_ACTIONS, GITHUB_EVENT_NAME, GITHUB_REF, GITHUB_REPOSITORY, GITHUB_TOKEN, GITHUB_STEP_SUMMARY } = process.env;

async function run() {
  if (GITHUB_ACTIONS !== 'true' || GITHUB_EVENT_NAME !== 'workflow_dispatch' ||
      GITHUB_REF !== 'refs/heads/main' || GITHUB_REPOSITORY !== repository || !GITHUB_TOKEN) {
    return {
      evidence_read: 'BLOCKED', authorization: 'BLOCKED',
      reason: 'A manual dispatch from trusted main with its Actions job token is required',
    };
  }
  return observeMergedGitHubEvidence({
    repository, pullRequest: 4, requiredCheck: 'Node 22 Tests',
    revision: '905907b9bf228b2304784c87a095572fa7fb994e',
    mergeCommit: '36b717c786bc03e55007a978442b527871f67345',
  });
}

try {
  const report = await run();
  const json = JSON.stringify(report);
  console.log(json);
  if (GITHUB_STEP_SUMMARY) appendFileSync(GITHUB_STEP_SUMMARY, `### PR #4 GitHub evidence\n\n\`\`\`json\n${json}\n\`\`\`\n`);
  if (report.evidence_read !== 'PASS') process.exitCode = 1;
} catch {
  console.error('GitHub evidence smoke could not complete or write its sanitized summary');
  process.exitCode = 1;
}
