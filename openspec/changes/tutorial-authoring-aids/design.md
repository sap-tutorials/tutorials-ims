## Context

Tutorials build for two channels: `prod` and `qa` (`Channel` in `scripts/fetch-tutorials.ts`; QA uses `hugo.qa.toml`, `content-qa/`, `site.Params.qa`). Authors preview on `/tutorials-qa/` from the private `-Contribution` repos and promote to the public `Tutorials` repo (skill `tutorial-qa-to-prod`). `compose.ts` runs pre-passes over the body; raw source is also published (`ContentFiles.sourceContent`) and read by MCP, the freshness detector and AI pipelines. Lint rules live in `scripts/lint-rules/` (`{id, describe, scan(slug, lines, rawLines) → LintFinding[]}`) and run in CI with `continue-on-error`.

## Goals / Non-Goals

**Goals:** zero risk of author notes reaching PROD readers or machine consumers; visible review aids on QA; actionable CLI deprecation feedback before readers hit errors.

**Non-Goals:** threaded review comments/UI (GitHub PRs cover that); executing commands to verify them (ASSERT/CODECHECK cover that); automatic rewriting of deprecated commands.

## Decisions

### D1 — `%% … %%` syntax
Chosen because it is plain text, unlikely in tutorial prose, familiar from Obsidian, and visible (not hidden) in GitHub's raw view so reviewers see notes there too. Inline `%%text%%` and block (lines between `%%` alone on a line). Fence-aware (never inside code — `%%` appears in SQL/Jupyter magic). Optional author prefix `%% @jdoe: … %%` is displayed as attribution. *Alternative*: HTML comments `<!-- -->` — rejected; Goldmark drops them and existing tutorials already contain thousands of non-review comments (licence headers, disabled content) that must not suddenly appear on QA.

### D2 — Strip early, channel-aware
`stripAuthorNotes(body, channel)` runs **first** in `compose.ts`, before frontmatter-derived extraction, intro, steps, variables and directives. PROD: remove notes (collapse resulting blank lines). QA: replace with a `<span class="tut-author-note" data-author>`/block marker that the QA layout styles. The published PROD `sourceContent` is the stripped body, so MCP/AI/freshness never see notes on PROD; on QA, `renderDirectivesAsText` drops notes. Unterminated `%%` → build error on QA, lint error on PROD (and stripping stops at end of step to avoid swallowing content).

### D3 — `:::qa-only`
Container directive, label = reason. In the QA build renders a dashed frame with "QA only: <reason>"; in PROD the whole container (incl. nested content) is removed before step parsing, so a QA-only step-internal block never affects PROD step numbering. Step headings inside `qa-only` are rejected (keeps step slugs/progress stable across channels). Lint `qa-only-in-prod-source` (warning) fires on files in PROD source repos; the `tutorial-qa-to-prod` skill reports the count and asks the author to resolve before opening the PROD PR.

### D4 — CLI deprecation rules
`cli-deprecations.json`: entries `{ tool, match (regex on a normalised command line), severity (warn|error), since, message, replacement, docs }`. The rule scans fenced blocks tagged `bash|sh|shell|console|terminal|powershell|cmd` and inline code starting with a known tool name; strips prompts (`$ `, `PS> `) and continuations. Severity defaults to warning (CI non-blocking, consistent with existing rules). The initial set is curated with the CLI owners (Cloud Foundry, BTP CLI, CAP, MBT teams) — e.g. `cf` v6-era push flags replaced by manifest `routes:` — and every entry must cite a release note or docs link in `docs`; no rule ships without one. The freshness detector imports the same JSON to create findings, so the dashboard and lint agree.

## Risks / Trade-offs

- [Note syntax collides with content] → fence-aware; `%%` in prose is rare; corpus scan before rollout lists every existing `%%` occurrence for manual triage.
- [QA/PROD divergence confuses authors] → QA notes counter shows "Hidden on PROD"; QA-only frame states it explicitly.
- [Deprecation list rots] → owned file with `since` + docs link; quarterly review task; false positives are warnings only.

## Migration Plan

Corpus scan for `%%` and `:::qa-only` before enabling; enable strip in both channels at once; lint rules start as warnings. Rollback: revert pre-pass (QA notes would then render as literal text; PROD unaffected if no notes were promoted — the PROD lint guards that).

## Open Questions

- Should PROD builds hard-fail on leftover notes instead of stripping silently? Proposed: strip + warning, because stripping is safe and a failure would block unrelated hotfixes.
