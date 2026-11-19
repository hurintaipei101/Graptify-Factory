# Autonomous execution and human gate contract

## Gate zero (initial authorization, before autonomous phase)
Owner accepts the architecture, app scope, environments, data policy and risk limits. These decisions are versioned. Architecture changes outside this envelope trigger exception Gate A.

## Gate A - Exception decision
Invoke ONLY when a bounded issue cannot progress after exactly 3 deliberate repair+verification cycles, a material architecture/scope change is needed, sensitive-data/permission incident is detected, or a privileged operation is required.

A repair cycle is: identify a specific failure -> make focused change -> run appropriate checks -> record evidence. Multiple failed assertions in one check do not count as multiple cycles. Restarts, agents or model switches do not reset the counter. Quota/outage pauses must not falsely count as code-repair cycles.

Stop immediately for security/permission risks instead of trying 3 times. Keep unaffected tasks running. Show owner three short fields: issue, what was tried/evidence, precise decision options. Never auto-approve own escalation.

## Gate B - Final product and UI acceptance
Owner receives one immutable, versioned integrated release candidate on VS Code/local. UI changes requested here are implemented by the ordinary agent workflow, re-tested and produce a NEW candidate hash. The release approval binds to that hash and the allowed release target.

## Autonomous auto-merge safety
Allowed only if: initial permission exists; scope remains approved; independent reviewer passes; CI and security checks pass; protected branch rules are enforced in reality; required tests have not been removed/loosened; no privileged schema/auth change; current artifact matches reviewed artifact. Otherwise STOP with a report.

## Production rule
Week-1 mini project must use TEST/Staging. Production release must be denied in the drill if no owner approval exists. An approved final candidate in future can trigger automated production deployment without a third routine approval, provided privileges and safeguards were configured beforehand.

## Failure state and receipts
Each action has run_id, issue_key, attempt, version, evidence URL/path, responsible actor and next state. Replayed events never duplicate merge or deployment. Any inability to guarantee this blocks autonomous execution.
