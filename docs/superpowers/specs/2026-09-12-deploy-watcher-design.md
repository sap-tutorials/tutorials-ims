# Deploy Watcher — Design Spec

**Issue:** [sap-tutorials/tutorials-ims#2266](https://github.com/sap-tutorials/tutorials-ims/issues/2266)
**Date:** 2026-09-12
**Status:** Approved for planning

## Problem

Deploy and publish loops dominate agent token usage. `mbt build`, `cf deploy`,
`npm run build:all`, and test runs each dump tens of thousands of tokens of
scrollback into an agent's context, of which only ~20 lines (the error + the
pass/fail) are actually used. This is the second-highest token-usage win after
retrieval memory, given how much agent work in these repos is deploy/publish.

## Goal

A **Deploy Watcher**: a tool that runs a project's deploy chain, keeps the full
logs on disk, and returns a **compact verdict** (~200 tokens) instead of raw
scrollback. It must:

1. Be a **standalone, team-wide** tool (not baked into any one project), yet
2. **Handle the full deploy complexity of a project as intricate as
   tutorials-ims** (multi-env, blue-green prod, admin-bundle drift gate, QA
   rebuild, OOM thresholds, Windows mtar quirks, cf-target drift), and
3. **Differentiate project-to-project** — the same binary behaves completely
   differently in tutorials-ims vs gameboard vs planner.

Naming: the tool is the **Deploy Watcher**. (The issue's "oracle" term is
dropped per maintainer request.)

## Non-Goals

- It does **not** re-implement or replace any project's deploy chain. It wraps
  the existing orchestrator (e.g. `scripts/deploy-mta.cjs`) and classifies its
  output.
- It does **not** duplicate CLAUDE.md deploy rules as hardcoded logic. Those
  rules already live in each project's orchestrator; the Watcher observes their
  effects (markers, exit codes) and adds structured signal detection on top.
- It does **not** deploy to prod autonomously. Prod is operator-gated.

## Decisions (from brainstorming)

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Home | Standalone repo, proposed `developer-relations/deploy-watcher` on github.tools.sap | Team-wide, mirrors the #2265 → `agentic-memory-service` split. |
| Runtime | **Go** | Matches the team's existing MCP (`sap-devs-cli` is Go with `mcp serve`); single distributable binary, no node_modules; wrapping shell chains is language-agnostic so Go loses nothing. |
| Execution posture | **Exec dev/qa, gate prod** | An autonomous agent must never be able to trigger a prod deploy. |
| Human-in-the-loop | **Strict HITL on every exec** | Even dev/qa require explicit human approval before the chain runs. |
| Project differentiation | **Per-project `deploy-watcher.yaml` descriptor** committed at each repo root | The descriptor version-controls alongside the chain it describes; the Watcher resolves it from cwd. |

## Architecture

```text
Agent (Claude Code)
  │  MCP tool calls
  ▼
deploy-watcher  (Go binary: `deploy-watcher mcp serve`  |  CLI `deploy-watcher plan|run|verdict|logs`)
  ├─ internal/descriptor  load + validate deploy-watcher.yaml (resolved from cwd/repo root)
  ├─ internal/runner      spawn chain, tee full stdout+stderr → ~/.deploy-watcher/runs/<run_id>.log, capture exit code
  ├─ internal/classify    (exit code + last failing "Step N" marker + signal regexes) → Verdict
  ├─ internal/smoke       diff smoke output vs a known-green baseline
  └─ internal/mcpserver   tool wiring (plan / run / verdict / logs)
        │
        ▼
  Verdict (~200 tokens) returned to agent;  full log stays on disk.
```

The CLI and the MCP server share the same engine (descriptor → runner →
classify), exactly as `sap-devs-cli` shares logic between its Cobra commands and
`mcp serve`. Humans and CI can invoke `deploy-watcher run --env dev` directly and
get the same verdict + on-disk log.

### Wrap, don't reimplement

For tutorials-ims the entire chain command is `node scripts/deploy-mta.cjs`.
That orchestrator already emits everything the classifier needs:

- Numbered phase markers: `Step 0` … `Step 5`, including `Step 3.5` (admin-bundle
  drift), `Step 3.6` (QA navigator), `Step 4.5/4.6` (blue-green / stale-static).
- Outcome lines: `  ✓ …`, `[deploy] FAILED: …`, `[deploy] SMOKE GATE FAILED`.
- Exit codes: `1` = build/guard failure, `2` = smoke regressed.

The Watcher never parses CF/mbt internals directly for the pass/fail decision;
it keys off these deterministic markers and the exit code, then layers signal
regexes for root-cause hints.

## Components (units)

Each unit has one purpose, a narrow interface, and is independently testable.

### `internal/descriptor`
- **Does:** Locate `deploy-watcher.yaml` (walk up from cwd to repo root), parse,
  validate against a schema, expand flag templates.
- **Interface:** `Load(cwd string) (*Descriptor, error)`.
- **Depends on:** yaml parser only.

### `internal/runner`
- **Does:** Spawn the resolved chain command with env/strategy flags, tee
  combined stdout+stderr to the run log file while capturing it in memory
  (bounded ring buffer for the tail), return exit code + log path.
- **Interface:** `Run(ctx, cmd []string, logPath string) (RunResult, error)`.
- **Depends on:** os/exec, filesystem.

### `internal/classify`
- **Does:** Pure function. Given the captured log text + exit code + descriptor,
  produce a `Verdict`: overall status, `failed_step` (last `Step N` before
  failure), matched `signal` id, `error_extract` (~20 lines around the failure),
  `mtar_version`, `next_action`.
- **Interface:** `Classify(log string, exit int, d *Descriptor) Verdict`.
- **Depends on:** nothing (regex only) — trivially table-testable.

### `internal/smoke`
- **Does:** Parse the smoke run's pass/fail set, diff against the descriptor's
  baseline, produce `smoke_diff {failed, newly_passing}`.
- **Interface:** `Diff(smokeOut string, baseline SmokeSet) SmokeDiff`.
- **Depends on:** nothing.

### `internal/mcpserver`
- **Does:** Register the four MCP tools, enforce the HITL/plan-nonce/prod-gate
  policy, wire descriptor→runner→classify→smoke.
- **Depends on:** all of the above + the MCP SDK used by sap-devs-cli.

## MCP Tools

### `deploy_plan(env, strategy?)` — read-only
Resolves the descriptor, runs read-only **preflight guards**, returns a plan +
warnings + a `plan_id` nonce. Mutates nothing.

Preflight guards (from descriptor, all read-only):
- `cf_target_matches_env` — `cf target` org/space matches the requested env
  (guards the documented dev→prod drift hazard).
- `git_fresh_origin` — HEAD is not behind `origin/<default>` (never deploy stale).
- `node_auth_token_present` — `NODE_AUTH_TOKEN` set (local mbt needs it for the
  private ANS package).
- Descriptor-declared extras per project.

### `deploy_run(plan_id, env, confirm)` — executes
- **HITL:** This is a non-readonly MCP tool, so **Claude Code's own permission
  prompt is the human gate**. The call echoes `env` + `strategy` so the human
  sees exactly what they are approving in the permission dialog.
- **Plan binding:** Requires a `plan_id` that matches a prior `deploy_plan`, so
  nothing runs un-planned (and the preflight warnings were seen first).
- **Prod gate:** If `env == prod`, the tool **refuses to execute** and returns
  `status: requires_operator` with the exact operator command to run in the
  primary tree. Respects: PROD needs the primary tree, blue-green pauses before
  swap, never deploy from a feature branch, three-project prod deploy order.
- **On exec:** invokes runner → classify → smoke, returns the Verdict.

### `deploy_verdict(run_id)` — poll / re-fetch
Deploys are long (catalog ~5m, full ~10m, prod blue-green longer). Returns the
current Verdict; `status: running` while in flight. Lets a long deploy run in
the background and be checked without re-reading logs.

### `deploy_logs(run_id, step?, grep?)` — bounded escape hatch
On-demand slice of the full on-disk log (by step marker and/or grep pattern),
capped in size. Used when `error_extract` isn't enough — the agent pulls just
the relevant slice instead of the whole scrollback.

## Verdict Schema

```json
{
  "run_id": "2026-09-12T14-03-11-tutorials-ims-dev",
  "project": "tutorials-ims",
  "env": "dev",
  "strategy": "default",
  "status": "success | failed | smoke_regressed | requires_operator | running",
  "failed_step": "Step 3.5: admin-bundle drift",
  "signal": "stale_admin_bundle | cds_deploy_error | mbt_minify | oom | cf_target_drift | null",
  "error_extract": "…~20 lines around the failure…",
  "mtar_version": "1.25.0",
  "smoke_diff": { "failed": ["browse-page"], "newly_passing": [] },
  "duration_s": 512,
  "exit_code": 2,
  "log_path": "~/.deploy-watcher/runs/<run_id>.log",
  "next_action": "Rebuild WITHOUT --skip-build; never -m scope admin changes."
}
```

## Descriptor Schema (`deploy-watcher.yaml`)

The reference descriptor for tutorials-ims (leaner ones for gameboard/planner):

```yaml
project: tutorials-ims
chain:
  command: "node scripts/deploy-mta.cjs"
  env_flag: "--env {env}"
  strategy_flag: "--strategy {strategy}"
envs: [dev, qa, prod]
exec_policy:
  hitl: [dev, qa]          # allowed to execute, but only behind HITL approval
  operator_only: [prod]    # never executed by the tool; returns requires_operator
steps:                     # map orchestrator markers → friendly names / status overrides
  - match: "Step 3.5"
    name: "admin-bundle drift check"
  - match: "Step 3.6"
    name: "QA navigator check"
  - match: "SMOKE GATE FAILED"
    name: "smoke gate"
    status: smoke_regressed
signals:                   # gotcha detectors → root-cause hints
  - id: stale_admin_bundle
    pattern: "stale admin UI|admin-bundle"
    next_action: "Rebuild WITHOUT --skip-build; never -m scope admin changes."
  - id: cds_deploy_error
    pattern: "in cds\\.deploy"
    next_action: "grep the full log for 'in cds.deploy' — CI annotations hide the real error."
  - id: mbt_minify
    pattern: "Minification failed|Unexpected token"
    next_action: "Syntax error in an admin-shell/admin controller — only caught at mbt minify."
  - id: oom
    pattern: "OOM|Insufficient memory|exit status 137"
    next_action: "srv-qa needs >=1536M; prod approuter needs 2048M."
  - id: cf_target_drift
    pattern: "target .* does not match|space_name.*prod"
    next_action: "cf target drifted (sap-devs scheduler?). Re-target before deploying."
thresholds:
  srv_qa_min_mb: 1536
  approuter_prod_min_mb: 2048
smoke:
  command: "npm run test:smoke"
  baseline: "smoke-baseline.dev.json"    # known-green set to diff against
preflight:
  - cf_target_matches_env
  - git_fresh_origin
  - node_auth_token_present
```

## Log Handling

- Full combined stdout+stderr is tee'd to `~/.deploy-watcher/runs/<run_id>.log`
  (configurable root). Retained; never returned wholesale to the agent.
- The Verdict carries only `error_extract` (~20 lines) + `log_path`.
- `deploy_logs` serves bounded slices on demand.

## Testing Strategy

- **Classifier** (`internal/classify`) is a pure function → the bulk of coverage
  is fixture-driven table tests. Capture real logs as fixtures: a clean success,
  a `cds.deploy` failure, an `mbt` minify failure, an OOM, a smoke regression, a
  cf-target-drift. Each fixture asserts the exact Verdict.
- **Descriptor** — valid/invalid yaml, flag-template expansion, cwd resolution.
- **Runner** — run a fake chain script (fixture shell/node script) that emits
  known markers and a chosen exit code; assert log tee + captured tail + exit.
- **Smoke** — diff fixtures (regression, newly-passing, all-green).
- **mcpserver** — plan→run nonce binding; prod gate returns `requires_operator`;
  missing/mismatched `plan_id` refused.
- No live Cloud Foundry required for CI.

## Open Questions / Follow-ups

- Exact MCP SDK/version reused from `sap-devs-cli` (to keep tool-registration
  idiomatic) — confirm during planning.
- Where the on-disk run-log root should live cross-platform (Windows is a
  first-class dev environment here).
- Whether `smoke-baseline.*.json` is committed per project or generated from the
  last known-green run.
```
