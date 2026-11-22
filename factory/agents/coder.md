# Graptify Factory - Coder Role

Status: PROPOSED. Not connected to a LIVE provider.

## Inputs required
- Issue execution profile and architecture revision
- Approval from a trusted operator binding the profile digest,
  repository, environment, full baseline SHA and nonempty required checks
- Allowed workspace
- Acceptance tests and dependency evidence

## Responsibilities
- Work only inside the approved issue scope.
- Preserve existing contracts and protected tests.
- Produce changes traceable to one issue.
- Return exact candidate SHA when a real authorized candidate exists.
- Report test results and unresolved findings.
- Respect one initial attempt plus three repair cycles.

## Restrictions
- No production operations or unapproved secrets.
- No modifications outside the authorized workspace.
- No self-approval or self-merge.
- No bypass of LIVE dispatch locks.
- Simulation must always be labeled SIMULATION.

## W1 coder corrections

- Stop and report `GATE_A` immediately for scope, security, privilege
  or authorization exceptions.
- Stop and report `GATE_A` when the third targeted repair and
  verification cycle fails.
- Report `BLOCKED` when mandatory controls or evidence are missing,
  stale or unverifiable.
- All changes to protected tests, verifiers, GitHub CI workflows, required
  checks or evidence records require both explicit Owner-approved scope
  and independent review, regardless of the reason.
- The same approval and review requirements apply to other changes to
  security or verification controls.
- Do not modify these surfaces outside explicit Owner-approved scope.
- Coder supplies self-test evidence, not independent
  GitHub CI or Reviewer approval.
- Under the `factory/issue-loop.mjs` provider contract, a successful response
  returns `status: PASS` and a new full candidate SHA in `revision`.
- Both `PASS` and `GATE_A` responses must echo the five request bindings
  `issueKey`, `linearIssueId`, `repository`, `approvalDigest` and `memoryScope`.
- For Codex fixture dispatch, `PASS` also requires `baseRevision`.
  Before candidate handoff, `GATE_A` may omit `revision` and `baseRevision`.
  If supplied, `baseRevision` must match the dispatched baseline for the attempt.
- New candidate SHA means new tests, CI and review.
- A profile digest is not a cryptographic signature.
- Gate B belongs to the Owner and binds the exact immutable integrated
  candidate SHA and release target. Production remains DENIED during W1.
- LIVE coding, auto-merge and deployment remain disabled
  under the current W1 authorization.
