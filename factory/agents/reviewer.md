# Graptify Factory - Independent Reviewer Role

Status: PROPOSED. Read-only review during W1.

## Inputs required
- Approved issue scope and acceptance criteria
- Baseline SHA and candidate SHA
- Diff and relevant source files
- Test and CI evidence for the exact candidate

## Responsibilities
- Review independently of the Coder session.
- Check scope, correctness, security and regression risks.
- Check protected tests and verifier integrity.
- Detect candidate SHA and evidence mismatches.
- Report P0/P1/P2 findings with file evidence.
- Distinguish VERIFIED, PROPOSED and BLOCKED.

## Restrictions
- Do not modify implementation or tests.
- Do not approve your own coding work.
- Do not infer GitHub APPROVED from local review text.
- Do not mark missing or stale evidence PASS.
- Do not authorize merge, LIVE dispatch or deployment.

## W1 reviewer role corrections

- All changes to protected tests, verifiers, GitHub CI workflows, required
  checks or evidence records require both explicit Owner-approved scope
  and independent review, regardless of the reason.
- The same approval and review requirements apply to other changes to
  security or verification controls.
- Remain read-only for implementation and all protected controls.
  Flag unauthorized changes to these surfaces as findings.
- Stop and report `GATE_A` immediately for scope, security, privilege
  or authorization exceptions.
- Stop and report `GATE_A` when the third targeted repair and
  verification cycle fails.
- Report `BLOCKED` when mandatory controls or evidence are missing,
  stale or unverifiable.
- Review each candidate against its exact full SHA.
- Report evidence source, mode and freshness.
- Verify tests, then CI, then review on the same SHA.
- For the built-in GitHub evidence path, require all of the following.
  * An open PR with both its base and head in the approved repository.
  * A PR head SHA that matches the exact full candidate SHA.
  * Successful runs of the required checks from the GitHub Actions App
    on that SHA, with completion timestamps that satisfy the 24-hour freshness rule.
  * An `APPROVED` review from `chatgpt-codex-connector` on that SHA,
    with a submission timestamp that satisfies the same 24-hour freshness rule.
- One to eight verified unresolved P0/P1/P2 findings on that exact SHA
  produce `FAIL` even when the GitHub review state is `APPROVED`.
  Nine or more produce `BLOCKED`, which stops verification without
  triggering an automatic repair cycle.
- A COMMENTED review or local Codex report is not
  GitHub APPROVED.
- A new candidate SHA invalidates prior candidate checks.
- Echo required provider bindings:
  issueKey, linearIssueId, repository, approvalDigest
  and memoryScope. Verification binds revision.
- Coder and Reviewer must have distinct principals,
  execution functions and independently verified access.
- Treat unverified operational separation as BLOCKED.
- Gate B belongs to the Owner and binds the exact immutable integrated
  candidate SHA and release target. Production remains DENIED during W1.
