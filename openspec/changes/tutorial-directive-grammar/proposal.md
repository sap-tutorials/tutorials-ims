## Why

Every rich tutorial feature today invents its own markdown marker and its own regex pre-pass — `[OPTION BEGIN [x]]`, `[BRANCH_BEGIN …]`, `[CODECHECK_N]`, `[ASSERT_N]`, `[AUTOAUTHOR_N]`, `{{var:x}}`. Each new feature costs a new parser, new fence-awareness bugs, new lint rules, and a new thing authors must memorise. We are about to add ~30 authoring features (menu paths, keyboard keys, collapsible sections, snippet includes, media, …); without a shared grammar that cost multiplies and the authoring surface becomes incoherent.

## What Changes

- Introduce one **generic directive grammar** for tutorial markdown, modelled on the CommonMark generic-directives proposal (as implemented by `remark-directive`):
  - inline: `:name[content]{attrs}`
  - leaf block: `::name[label]{attrs}` on its own line
  - container block: `:::name[label]{attrs}` … `:::` (nest by using more colons on the outer fence)
- Add a single fence-aware pre-pass (`scripts/parsers/directives.ts`) that rewrites directives into Hugo shortcodes named `tut-<name>`, driven by a **directive registry** (name → kind, attribute schema, renderer, plain-text fallback).
- Validate directive usage against the registry at build time; schema violations fail the tutorial build with file/line context, unknown directive names are left as literal text with a lint warning.
- Provide a shared `renderDirectivesAsText()` fallback so the MCP server, AI pipelines (AUTOAUTHOR, freshness detector, KG step slicer), search indexing and step slicing see readable plain markdown instead of raw directive syntax.
- Export the registry as a JSON Schema artifact for the VS Code authoring extension (completion, hover docs, validation).
- Keep all existing legacy markers working unchanged; no migration in this change.
- Document the grammar for authors in `docs/authors/writing-tutorials.md`.
- No concrete user-facing directive ships in this change — follow-up changes (`tutorial-code-block-enhancements`, `tutorial-ui-instruction-directives`, `tutorial-callout-enhancements`, `tutorial-rich-media-and-tables`, `tutorial-content-reuse-and-references`, `tutorial-authoring-aids`) register their directives on top of it.

## Capabilities

### New Capabilities
- `tutorial-directive-grammar`: syntax, parsing, validation, rendering contract, plain-text fallback and tooling export for generic markdown directives in tutorials.

### Modified Capabilities
<!-- none: no existing specs in openspec/specs/ cover the parser pipeline -->

## Impact

- **Code**: new `scripts/parsers/directives.ts` + `scripts/parsers/directive-registry.ts`; one new call in `scripts/parsers/compose.ts`; reuse of `scripts/parsers/md-grammar.ts` line classification; new lint rule in `scripts/lint-rules/`; `scripts/validate-tutorials.ts` reports directive errors; Hugo shortcode namespace `hugo/layouts/shortcodes/tut-*.html` reserved.
- **Consumers**: `srv-mcp/` step tools and AI pipelines in `scripts/lib/` switch to the plain-text fallback when they read raw source.
- **Authors**: new optional syntax; zero change for tutorials that don't use it (proven by corpus regression).
- **Dependencies**: none new at runtime (hand-written parser, no remark dependency in the Goldmark pipeline).
