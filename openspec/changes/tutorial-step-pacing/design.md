## Context

`parseV2Steps` (scripts/parsers/v2.ts) splits the body on `###` headings using `md-grammar.ts` line classification; the heading text becomes `TutorialStep.title`, and step slugs are `slugify(title)` (used by `osOverrides`, anchors and branch parents). Readers mark steps done via `[data-action="mark-done"]` in `hugo/assets/js/tutorial.ts`, which calls the CAP progress API; tutorial completion triggers rollup of groups/missions in `srv/lib/completion-rollup.js`. Frontmatter `time:` is a single integer of minutes. Goldmark renders GFM task lists as disabled `<input type="checkbox">`.

## Goals / Non-Goals

**Goals:** markdown-native syntax (heading attribute style already used by Goldmark/Pandoc); stable slugs; privacy-clean persistence; no change for tutorials that don't use it.

**Non-Goals:** per-step difficulty levels, time tracking of real reader durations (analytics exists separately), checklists outside steps.

## Decisions

### D1 — Heading attribute parsing in v2.ts
Match a trailing `\s*\{([^}]*)\}\s*$` on step headings only (h3 step headings in v2). Accept tokens `time=<duration>` and `optional` (others → lint warning `step-attr/unknown`, ignored). Duration grammar: `(\d+h)?(\d+m)?(\d+s)?` non-empty, max 8h. The attribute block is removed **before** title/slug computation, so `### Deploy {time=5m}` and `### Deploy` produce the same slug — existing progress, deep links and `osOverrides` are unaffected. *Alternative*: a directive `::step{time=5m}` on the next line — rejected, separates metadata from the heading and is less discoverable. *Alternative*: frontmatter map keyed by step slug — rejected, drifts when headings change.

### D2 — Rendering and remaining time
Step header shows `⏱ 5 min` chip and `Optional` badge (`ui5-tag`). Tutorial header total becomes: frontmatter `time` if set, else sum of step times. A remaining-time indicator ("≈ 12 min left") is computed client-side from incomplete, non-optional steps that have times; hidden if fewer than half of steps have times.

### D3 — Optional steps and completion
Tutorial metadata published to HANA includes `optionalSteps: number[]`. Tutorial completion requires all **non-optional** steps done. Optional steps show "Skip" next to "Done"; skip is client-side UI state only (not a completion record) and collapses the step. Rollup logic (`completion-rollup.js`) is unaffected because it consumes tutorial completion, but the tutorial-level completion check in the progress service must read `optionalSteps`. Validation questions inside optional steps remain optional. Edge case: all steps optional → treated as none optional (lint error).

### D4 — Checklists
Goldmark already emits `<li><input type="checkbox" disabled>`, and Hugo has no list-item render hook. Decision: client-side progressive enhancement in `task-lists.ts` — find task lists inside step bodies, enable inputs, assign stable IDs `slug:step:list:item-index` + text hash (so edits invalidate stale checks), persist in `localStorage["tasklist:<slug>"]`. Signed-in sync is **not** included (privacy + backend scope); revisit later. Counter "2/5" in the list header; `aria-live="polite"` announcements. Pre-checked `[x]` items render checked and are not counted toward the reader's progress.

### D5 — Plain text / MCP
`get_tutorial_step` returns `time` and `optional` as metadata fields, title without `{…}`. Checklists remain GFM `- [ ]` lines (already plain markdown).

## Risks / Trade-offs

- [Headings that legitimately end in `{…}` (e.g. a title mentioning a JSON object)] → only recognised when every token is a known key or matches the duration grammar; otherwise left in the title with lint warning.
- [Inaccurate author time estimates] → lint vs frontmatter total; future: compare with real median durations from analytics.
- [localStorage loss] → acceptable for checklists (non-critical aid).
- [Completion semantics change for tutorials marking steps optional] → only affects tutorials that opt in; existing completions remain valid.

## Migration Plan

Additive. Deploy backend completion change (reads `optionalSteps`, default empty) before content using `optional` is published. Rollback: revert parser; content falls back to titles containing literal `{…}`, so ship the parser before announcing the syntax.

## Open Questions

- Should optional steps' time be shown separately ("+5 min optional")? Proposed yes in the header total.
