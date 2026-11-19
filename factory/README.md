# Graptify AI Software Factory - Week 1 execution pack

Version: 2026-11-17 | Target window: 17-23 Nov 2026 (Asia/Ho_Chi_Minh)
Status: PLAN READY; EXTERNAL EXECUTION NOT VERIFIED

## Fixed decisions
- Codex is the primary coding engine.
- Linear tracks tasks; GitHub is the source of truth for code; n8n-style rule-based event routing controls the workflow; Hindsight supports long-term engineering memory; VS Code/Cursor provides final local UX inspection.
- Specialized roles have separate agent profiles and model settings. Roles need not run different model families if capabilities/access do not permit it.
- One up-front architecture/product plan authorization precedes the autonomous issue workflow.
- After that authorization, only TWO primary human gates: (A) issue exception when 3 deliberate repair+verification cycles fail or scope/security exceeds authorization; (B) integrated product and UI acceptance before a specific release.
- Automatic merges ONLY within explicitly authorized scope with branch protection, required checks and least-privilege credentials enforced. Never turn policy text into a substitute for permission enforcement.
- Production cannot deploy without final release authorization for an immutable version. The week-one pilot targets TEST/Staging; production authorization must be simulated, not granted.
- Do not add new tools, platforms, architectures, or optional features. Prioritize delivery evidence over speculative optimization.

## Existing evidence baseline (last supplied 11 Nov 2026)
FACAPP technical pilot achieved frontend/backend/Supabase RLS, GitHub CI, Staging and rollback-drill success. HIE-12 monitoring evidence and protection issues remained open. End-to-end autonomous multi-agent orchestration had NOT been demonstrated. FACTORY-10 had been proposed but not confirmed created.

## Files
- 01_WEEK_RUNBOOK.md: strict seven-day sequence and gates.
- 02_WORK_ITEMS.md: ready-to-create Linear epic and child tasks, IDs intentionally not assigned.
- 03_MINI_PROJECT_SPEC.md: mini product, three modules and acceptance tests.
- 04_EXECUTION_GATES.md: state machine, autonomy controls, failure and release gates.
- 05_SCORECARD.md: evidence-first factory acceptance scorecard.
- 06_OPERATOR_HANDOFF.md: exact user-facing actions, blockers and next work.
- contracts/issue_execution_profile.example.json: standard data contract between planner, agents and orchestrator.
- contracts/issue_run_report.example.json: end-of-issue telemetry structure.
- skills/graptify-solution-architect/: initial source of the architecture skill.

## Execution ownership
The packet is a planning and bootstrap deliverable. It is not a claim that tasks were created in Linear, code was pushed to GitHub, Hindsight was configured, or Staging/Production was deployed. Record those facts only after the external systems provide evidence.

## F2-08 issue loop

Call `runIssueLoop({ profile, approval, evidence, providers, stateDirectory })` from `factory/issue-loop.mjs`. Use the issue execution profile contract and a trusted operator-supplied approval containing `approved: true`, `profileDigest: issueProfileDigest(profile)`, `repository`, `environment`, the full `baseline` SHA, and nonempty `requiredChecks`. Pass fresh Linear and GitHub baseline evidence through the existing adapter format. The absolute state directory must be writable, trusted, and shared by all workers for the issue on a filesystem that supports atomic directory creation and rename.

Register simulation providers with `mode: 'SIMULATION'`, a distinct coding and reviewer `principal`, and `run(input, { signal })`. Use these roles and result contracts.

| Provider | Kind | Result |
| --- | --- | --- |
| `coding` | `agent` | Match the authorized `role_profile` in the provider's `profile` field. Return `PASS` and a new full candidate `revision`. |
| `tests` | `deterministic` | Run the scoped acceptance tests without an AI call. Return a verdict for the requested `revision`. |
| `ci` | `read-only` | Inspect the named checks for the requested `revision`. Return `PENDING` while checks are in flight. `inspectGitHubChecks` supports read-only observation through the existing `gh` CLI or a fixture transport. |
| `review` | `agent` | Review the candidate against the approved baseline and acceptance criteria. Return a verdict for that `revision`. |

Verification providers return `{ status, revision }`. A repairable `FAIL` must include one to eight `findings` with an `id` and a short `summary`. Use `BLOCKED` for unavailable controls and `GATE_A` for scope, security or privilege exceptions. The loop gives coding only the approved criteria and the previous attempt's findings. It checks tests, CI, and review in that order with at most three reads of pending CI per candidate and one initial attempt plus three repairs.

The loop returns a compact `factory.issue_run_report.v1` with `READY`, `BLOCKED`, or `GATE_A`. Identical invocations replay the stored report. Concurrent calls, interrupted claims, and changed inputs for a claimed issue block dispatch. Reconcile an interrupted claim before authorizing any new execution. Keep simulation evidence labeled as such. Live dispatch remains disabled even when requested, pending verified write isolation, CI access, and independent review. This entry point exposes no merge or deployment operations.

## F2-09A GitHub evidence

Add `githubPullRequest` (the same-repository PR number) to the operator-supplied `approval` to select the built-in CI and Codex review providers. Keep the existing simulated coding and test providers. The report's top-level `mode` describes execution. Each GitHub check's `evidence.mode` describes its transport. An injected `githubEvidenceFetch` marks API evidence as `SIMULATION` and sends no credentials.

Identical replay can refresh GitHub evidence for a `READY` claim or a `BLOCKED` candidate with passing tests and pending, expired, or temporarily unavailable GitHub evidence. Each refresh reads CI once and, if CI passes, reads review once. If fresh evidence verifies a repairable failure for the stored SHA, the loop checks the execution gates again and claims the next simulated repair against that SHA. Refresh itself consumes no repair cycle. After three repairs, another verified failure raises Gate A. A durable claim excludes concurrent refreshes and repair dispatches, and refreshes start at least five seconds apart. A replay during an active refresh or cooldown can return `BLOCKED` while current evidence is unavailable. Reconcile an interrupted claim before retrying.

The live providers use GitHub.com's API and the existing repository-scoped Actions job token. An eligible job needs `checks: read` and `pull-requests: read` and can expose `${{ github.token }}` as `GITHUB_TOKEN` or `GH_TOKEN`. The current Node 22 job declares `contents: read` for checkout. Jobs without the evidence permissions or token return `BLOCKED`.

Successful verification requires a matching open PR head, the approved check names from the GitHub Actions App, and an explicit `APPROVED` review by `chatgpt-codex-connector` bound to that full SHA. Check completions and submitted reviews expire after 24 hours. The provider reads thread resolution and records exact-candidate Codex P0/P1 findings for targeted repair. A `COMMENTED` receipt supplies findings when verifiable. It supplies no approval. A thumbs-up on the PR lacks a candidate SHA and leaves the verdict blocked. The report stores GitHub identifiers, source, and timestamps without review bodies or credentials.

## F2-09B Codex dispatch

The issue loop accepts an optional `signal` for cancellation. To exercise the Codex CLI protocol in a test, pass `codexSimulation` with an absolute `workspace`, `allowedWorkspaces`, fixture `runtimeIsolation` and `mcpAccess` settings, and a `spawnFixture({ command, args, options })` callback that returns a child-process fixture. Use a separate workspace and trusted claim directory. GitHub evidence in this mode must also use simulation providers or an injected fixture transport. The fixture coding provider supplies the simulated candidate and echoes the issue key, repository, and base SHA as `issueKey`, `repository`, and `baseRevision`.

Each simulated dispatch uses the existing issue claim and repair budget. The optional `attempts[].dispatch` record binds the process verdict to the issue, approved profile digest, repository, base SHA, and candidate SHA when available. It records process closure, bounded event count, exit code, and the reason for a failed dispatch. Prompts and raw process output stay out of the report. Cancellation and timeout wait for the adapter's bounded cleanup result and preserve the claim.

`realExecution` defaults to false. A live request returns `BLOCKED` while a write-isolated worker, containment of descendant processes, permissions, and separation from privileged credentials remain unverified. The GitHub job token check establishes presence for the approved repository only. Live operation would also require verification of its read permissions and a trusted handoff of the candidate SHA. The fixture controls and local child-process tests provide simulated dispatch and process lifecycle evidence.

### F2-09B LIVE-02 isolation smoke

The **Safe Coding Dispatch Isolation Smoke** workflow is a manual dispatch on this repository's `main`. It checks out the triggering main SHA and runs a fixed Node 22 probe from that revision in a disposable Linux container. The worker never downloads PR source. The separate evidence job reads the historical PR #4 candidate using the existing GitHub evidence reader. The smoke bypasses the issue loop and leaves `realExecution: false` and `authorization: BLOCKED`.

Download `isolation-evidence.json` from the run or read the same report in the run summary. It includes the workflow SHA, run and attempt IDs, status per control, and sanitized GitHub evidence when available. A failure or blocked control keeps the run unsuccessful. Missing prerequisites also leave affected controls blocked.

| Control | Hosted live observation | Simulated or local coverage |
| --- | --- | --- |
| Credentials and write boundary | The container has no network, Docker socket, checkout, inherited Actions environment, or host canary. It can write under `/work`. The probe attempts direct, traversal and symlink writes outside it and attempts to modify a canary on the read-only source mount. The negative probe adds a synthetic credential and a writable container-only `/tmp` and must detect both. | Unit fixtures cover adapter environment and workspace admission. Local Docker can exercise the same probes. |
| Timeout, cancellation and descendants | The adapter reaches its deadline or receives an abort after a detached grandchild starts. The driver kills the container and checks adapter closure and Docker exit state. Runner-visible process identities independently confirm that the detached child and grandchild stopped. | Fixture and local process tests exercise lifecycle behavior. Local Docker can exercise the same container teardown. |
| GitHub job cancellation | `BLOCKED`. The canceled job cannot independently attest to cleanup after GitHub ends the job and reclaims its runner. This needs an external observer that can see both the Actions cancellation and post-cancellation process state. | The live adapter cancellation probe exercises the worker's abort path. |
| Candidate SHA and stale negative | The worker hands off the fixed PR #4 candidate SHA as data. GitHub REST, Actions check provenance and GraphQL must match it. A different historical revision must be rejected by GitHub-backed validation. The recorded historical review carries no dispatch authorization. | Existing evidence fixtures test SHA mismatch and provenance without contacting GitHub. |
| GitHub read permissions and invalid-permission negative | The evidence job uses `contents: read`, `checks: read` and `pull-requests: read`. A separate job with only `contents: read` must get an explicit permission denial before the negative control can pass. If public reads or an ambiguous API failure prevent proving the permission boundary, the control stays `BLOCKED`. | Existing evidence fixtures cover HTTP and GraphQL failures. |

After the change is reviewed and merged by a maintainer, manually dispatch the smoke from trusted main and retain the artifact. Keep live coding dispatch disabled while the remaining controls are blocked.
