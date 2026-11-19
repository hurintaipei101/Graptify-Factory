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
