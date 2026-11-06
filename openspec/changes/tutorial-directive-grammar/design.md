## Context

Tutorial markdown is fetched from `sap-tutorials` repos and transformed by `scripts/parsers/compose.ts` through a chain of string pre-passes (blockquote-fence healing → images → attachment links → slug links → `wrapTokens` for `{{var:x}}` → `convertOptionBlocks` → branches → `parseV2Steps`) before Goldmark renders it in Hugo with render hooks (`hugo/layouts/_default/_markup/`) and shortcodes (`hugo/layouts/shortcodes/`). `md-grammar.ts` `classifyLines` already gives a CommonMark-faithful line classification (fence open/close, fenced content, indented code), which `parseV2Steps` uses.

Each existing feature marker has its own regex and its own (sometimes buggy) fence awareness. Raw tutorial source is also consumed outside Hugo: the MCP server (`srv-mcp/`, `get_tutorial_step`), AUTOAUTHOR quiz generation, the freshness detector (`ContentFiles.sourceContent`), and the KG step slicer.

## Goals / Non-Goals

**Goals:**
- One grammar, one parser, one validation path, one plain-text fallback for all future authoring features.
- Readable in raw GitHub markdown preview (degrades to visible, understandable text).
- Zero output change for existing tutorials that don't use directives.
- Safe by construction (no HTML injection through attributes).
- Machine-readable registry for editor tooling.

**Non-Goals:**
- Shipping any concrete directive (done by follow-up changes).
- Migrating legacy markers (`[OPTION BEGIN]`, `[BRANCH_BEGIN]`, `[CODECHECK_N]`, `[ASSERT_N]`, `[AUTOAUTHOR_N]`, `{{var:x}}`) — they remain the canonical syntax for their features.
- Switching the pipeline to remark/unified.

## Decisions

### D1 — Syntax: CommonMark generic directives
```
Inline:     Open :menu[Connectivity > Destinations] and press :kbd[Mod+S].
Leaf:       ::include[btp-trial-setup]{version=2}
Container:  :::details[Why does this work?]{open}
            Any markdown, including code fences.
            :::
Nesting:    ::::compare
            :::figure[Before]
            ![](before.png)
            :::
            ::::
```
- **Name**: `[a-z][a-z0-9-]*` (lowercase; kebab-case).
- **Label** `[...]`: markdown inline content; balanced brackets allowed; `\]` escapes.
- **Attributes** `{...}`: `key="value"`, `key='value'`, `key=value` (no spaces), bare flags (`open` → `true`), `#id`, `.class` (classes restricted to a registry-declared allowlist per directive). Duplicate keys are an error.
- **Container closing**: a line consisting of the same number (or more) of colons as the opener; inner containers must use fewer colons than outer ones.
- *Alternatives considered*: Hugo shortcodes directly (`{{< menu >}}`) — leaks implementation, unreadable on GitHub, already escaped by `hugo-delimiters.ts`; MDX/JSX components — not markdown, unsafe; more `[XXX_BEGIN]` markers — no attribute syntax, not nestable. Generic directives are an emerging CommonMark convention, used by remark/Docusaurus/VitePress, so authors may already know them and tooling exists.

### D2 — False-positive guards
Inline directives only match when: preceded by start-of-line, whitespace, or one of `([{"'`; name starts with a letter; and **the `[` label is present** (`:name{…}` alone is not an inline directive). So `10:30`, `std::vector`, `http://x`, `:smile:`, `a:b` never match. Leaf/container forms must start at column 0–3 of a line (respecting blockquote/list container prefixes via `classifyLines`). Directives inside fenced code, indented code, inline code spans, HTML blocks, and frontmatter are never touched. Unknown names (not in the registry) are left byte-for-byte unchanged and produce a lint **warning** (`directive/unknown`), never an error — prevents breaking prose that coincidentally looks like a directive.

### D3 — Pipeline position
`expandDirectives(body, ctx)` runs in `compose.ts` **after `wrapTokens`** (so `{{var:x}}` inside directive labels/content already became spans/sentinels and works) and **before `convertOptionBlocks`** (so directives inside OPTION panels and branch blocks are expanded once, uniformly, before content is relocated into tab shortcodes). Includes (`::include`, follow-up change) are resolved by the registry's optional `expand` hook in an earlier phase of the same function, before other directives, with cycle detection.

### D4 — Rendering contract: Hugo shortcodes `tut-<name>`
Each registered directive renders to a shortcode in the reserved namespace `hugo/layouts/shortcodes/tut-<name>.html`:
- inline/leaf → `{{< tut-menu label="…" attr="…" >}}` (self-closing form `{{< … />}}` for leaf without body)
- container → `{{% tut-details label="…" open="true" %}}\n<inner markdown>\n{{% /tut-details %}}` using the `%` form so inner markdown is rendered by Goldmark.
A directive may instead declare `render: 'markdown'` and return plain markdown (for directives that are pure sugar). All attribute values are HTML-escaped and quote-escaped before being placed into shortcode params; shortcodes must use `{{ .Get }}` output through Hugo's contextual escaping and never `safeHTML` on attribute values. Interaction with `hugo-delimiters.ts`: directive output is emitted after that escaping step, or uses the existing sentinel mechanism, so author-written `{{<` stays escaped while generated shortcodes survive (the task list verifies the exact ordering).

### D5 — Registry interface
```ts
// scripts/parsers/directive-registry.ts
export interface DirectiveDef {
  name: string                         // 'menu'
  kinds: Array<'inline' | 'leaf' | 'container'>
  summary: string                      // one-line author doc (used for hover + docs table)
  label?: { required: boolean; markdown: boolean }
  attrs: Record<string, {
    type: 'string' | 'number' | 'boolean' | 'enum' | 'duration'
    values?: string[]                  // for enum
    required?: boolean
    default?: unknown
    pattern?: string                   // regex for string
  }>
  classes?: string[]                   // allowed .class tokens
  expand?: (node, ctx) => string       // optional pre-render source expansion (e.g. include)
  render: (node, ctx) => string        // returns shortcode / markdown
  toText: (node, ctx) => string        // plain-text fallback
  since: string                        // registry version for docs/tooling
}
export function registerDirective(def: DirectiveDef): void
export function getRegistry(): ReadonlyMap<string, DirectiveDef>
```
Feature changes add one file per directive family under `scripts/parsers/directives/` that calls `registerDirective`.

### D6 — Errors
Schema violations (missing required label/attr, bad enum value, wrong kind e.g. `:details` inline when only container is allowed, unclosed container, duplicate attr) throw `DirectiveParseError { slug, line, column, directive, code, message }`. `fetch-tutorials` records it in `.tutorial-cache/errors.json` and the tutorial fails the build exactly like `BranchParseError`. `validate-tutorials` runs the same parser in check-only mode so authors see errors before merge.

### D7 — Plain-text fallback
`renderDirectivesAsText(markdown, opts?)` (in `directives.ts`) parses with the same grammar and replaces each directive with its `toText` output (e.g. `:kbd[Mod+S]` → `Ctrl+S / ⌘S`, `:::details[Why]` → `**Why**` + content). Unknown directives are left as-is. Used by: `srv-mcp` step tools, `scripts/lib/expand-ai-authored.ts` (strip step), freshness detector source read, KG step slicer, search-index text extraction. The generated Hugo content is unaffected.

### D8 — Tooling export
`npm run build:directive-schema` writes `schemas/tutorial-directives.schema.json` (names, kinds, attrs, summaries) from the registry; the VS Code / Sage authoring extension consumes it. The author docs table is generated from the same source to avoid drift.

## Risks / Trade-offs

- [Prose that coincidentally matches `:word[...]`] → requires `[`, unknown names are no-ops, corpus regression proves zero diffs across `.tutorial-cache/`.
- [Interplay with existing string pre-passes (options, branches, hugo-delimiters)] → fixed pipeline position + fixture tests that combine directives with OPTION, BRANCH, variables and blockquotes.
- [GitHub raw preview shows `:::details` literally] → acceptable: it stays readable; the authoring extension and QA channel give the rendered preview.
- [Registry becomes a dumping ground] → each directive needs a summary, `toText`, docs entry and tests (enforced by a registry unit test that iterates all definitions).
- [Hand-written parser bugs] → reuse `classifyLines`; property-based tests for label/attr tokenizer.

## Migration Plan

Additive. Ship parser + empty registry behind no flag (zero-diff proven). Follow-up changes register directives. Rollback = revert the compose.ts call; content without directives is unaffected, content with directives falls back to literal text.

## Open Questions

- Should legacy markers get directive aliases later (e.g. `:::option[JSON]`)? Deferred; revisit after follow-ups land.
- Do we want a strict mode where unknown directives are errors in new (v2-only) tutorials? Proposed: warning now, re-evaluate after one quarter of usage.
