# Graptify Factory - Agent Instructions

Status: W1 DRAFT. This file does not authorize LIVE execution.

## Source of truth
- factory/README.md
- factory/contracts/issue_execution_profile.example.json
- factory/issue-loop.mjs
- factory/codex-cli-adapter.mjs

## General rules
- Use the approved issue profile and exact revision/SHA.
- Never treat sample profiles as approved execution requests.
- Never treat SIMULATION READY as LIVE authorization.
- Never bypass LIVE locks, required checks, review or security controls.
- No production deploy or production-data changes.
- Do not read, expose or copy unapproved credentials.
- Do not relax protected tests or verifiers to obtain PASS.
- Do not call unapproved MCP tools.
- Keep Coder and Reviewer responsibilities separate.
- Report VERIFIED, PROPOSED and BLOCKED with evidence.

## Current W1 limits
- Documentation and read-only review are allowed.
- Coding dispatch LIVE, auto-merge and deployment remain disabled.
- GitHub main protection and isolation controls are unresolved.
- Production is DENIED.

## Role definitions
- Coder: factory/agents/coder.md
- Reviewer: factory/agents/reviewer.md

These documents are instructions, not technical permission enforcement.

## W1 reviewer corrections

### Gate A and Gate B
- Gate A: Stop and report GATE_A immediately for scope,
  security, privilege or authorization exceptions.
- Stop at GATE_A when the third targeted repair and
  verification cycle fails.
- Use BLOCKED when required evidence or enforcement
  is missing, stale or unverifiable.
- READY means candidate verification only, not release
  authorization. SIMULATION READY is not LIVE approval.
- Gate B belongs to the Owner and is bound to an exact
  immutable integrated candidate SHA and release target.
- Production remains DENIED throughout W1, even if a
  candidate receives product acceptance.

### Protected controls
- All changes to protected tests, verifiers, GitHub CI workflows,
  required checks or evidence records require both explicit
  Owner-approved scope and independent review, regardless of the reason.
- The same approval and review requirements apply to other changes to
  security or verification mechanisms.
- Coder must not modify these surfaces outside explicit Owner-approved scope.
- Reviewer remains read-only for all protected controls.
- A prompt prohibition does not replace enforceable
  filesystem, process, GitHub or credential permissions.

### MCP authorization
- An operator must explicitly approve each MCP tool,
  operation, repository/data scope and session.
- No approval means no MCP invocation.
- If an unapproved MCP operation is necessary to proceed,
  return BLOCKED. Never expand permissions silently.

### Contracts and evidence
- The example JSON is a schema example, not an approval.
- Approval comes from a trusted operator and binds the profile digest,
  repository, environment, full baseline SHA and nonempty required checks.
  A digest is not a cryptographic signature.
- Consult factory/README.md and the F2-08/F2-09B
  contracts before configuring providers.
- Every result must distinguish SIMULATION from LIVE.
- Preserve source, candidate SHA and evidence provenance.
