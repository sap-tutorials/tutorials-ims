## Why

Authors and reviewers collaborate in the markdown itself, but today they have nowhere safe to leave notes: HTML comments (`<!-- -->`) are invisible on the QA preview where review happens, and text left in by mistake ships to developers.sap.com. Work-in-progress content (a step still being validated, a reviewer question) can't be previewed on the QA channel without risking it reaching PROD when the file is promoted. CLI commands go stale silently — `cf` v6 flags, `btp` subcommands, `cds` options renamed between majors — and readers hit errors that the freshness detector only discovers much later.

## What Changes

- **Author-only notes**: `%% reviewer: please verify the region list %%` (inline or multi-line, Obsidian-style comment syntax). Stripped from PROD builds entirely; rendered on the QA channel as highlighted sticky notes with a page-level "N author notes" counter and toggle. Never sent to MCP, search, AI pipelines, or published source content.
- **QA-only blocks**: `:::qa-only[Reason]` … `:::` container. Rendered with a "QA only" frame on the QA channel; stripped from PROD. The QA→PROD promotion skill (`tutorial-qa-to-prod`) and PROD CI warn (lint) when promoted files still contain QA-only blocks or author notes.
- **CLI freshness lint**: a lint rule that scans console/shell code blocks for commands and flags known deprecated or removed `cf`, `btp`, `cds`, `mbt`, `npm`, and `hana-cli` commands/flags from a maintained rules file, with suggested replacements and a docs link per rule. Findings appear in `validate-tutorials`, PR lint output and the freshness detector's dashboard.

## Capabilities

### New Capabilities
- `tutorial-authoring-aids`: author-only notes, QA-only content blocks, and deprecated-CLI linting.

### Modified Capabilities
<!-- none -->

## Impact

- New fence-aware pre-pass `scripts/parsers/author-notes.ts` (runs first in `compose.ts`, before any content extraction, so notes never reach steps/intro/MCP sources); channel-aware via the existing `Channel = 'prod' | 'qa'` in `fetch-tutorials.ts`.
- `qa-only` container directive registered on `tutorial-directive-grammar` with channel-aware render.
- Stored source content (`ContentFiles.sourceContent`) for PROD is stripped of notes/QA blocks before publish.
- New lint rules `scripts/lint-rules/author-notes-in-prod.ts`, `deprecated-cli.ts` + `scripts/lint-rules/data/cli-deprecations.json`; freshness detector imports the same rules file.
- `.claude/skills/tutorial-qa-to-prod` promotion flow: warning step.
- QA layout: notes toggle UI and CSS.
