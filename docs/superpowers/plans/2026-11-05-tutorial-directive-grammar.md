# Tutorial Directive Grammar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one generic CommonMark-style directive grammar (`:name[label]{attrs}` inline / `::name` leaf / `:::name` container) to the tutorial markdown pipeline, with a registry, build-time validation, a Hugo `tut-<name>` shortcode rendering contract, and a shared plain-text fallback — shipping zero concrete directives so existing tutorials render byte-identically.

**Architecture:** A fence-aware pre-pass (`scripts/parsers/directives.ts`) parses directives using the existing `md-grammar.ts` `classifyLines` classifier, validates each against a registry (`directive-registry.ts`), and rewrites them into `tut-<name>` Hugo shortcodes. It slots into `compose.ts` after `wrapTokens` and before `convertOptionBlocks`. A separate `renderDirectivesAsText()` entrypoint gives MCP/AI consumers readable text. The registry starts empty; follow-up changes register directives.

**Tech Stack:** TypeScript, vitest (`--project unit`), Hugo/Goldmark shortcodes, tsx CLI harnesses, markdown-it (via existing md-grammar).

**Spec:** `openspec/changes/tutorial-directive-grammar/` (proposal.md, design.md, specs/tutorial-directive-grammar/spec.md, tasks.md)

## Global Constraints

- Directive names match `[a-z][a-z0-9-]*` (lowercase kebab-case). Copied verbatim from spec D1.
- No new runtime dependency — hand-written parser, reuse `md-grammar.ts classifyLines`; no remark/unified. (proposal Impact, design Non-Goals)
- Pipeline position is fixed: `expandDirectives` runs **after `wrapTokens`** (compose.ts ~line 154) and **before `convertOptionBlocks`** (compose.ts ~line 184). (spec "Pipeline compatibility", design D3)
- Zero output change for tutorials with no directives — proven by a byte-identical corpus regression with an empty registry. (spec "Legacy markers unchanged")
- All attribute/label values HTML- and quote-escaped before entering shortcode params; shortcodes never `safeHTML` attribute values. (spec "Shortcode rendering contract", design D4)
- Unknown directive names are left byte-for-byte unchanged and emit a `directive/unknown` **warning**, never an error. (spec "False-positive protection", design D2)
- The existing `escapeHugoDelimiters` (in `render-frontmatter.ts`, downstream of compose) must not mangle generated `tut-*` shortcodes — they use the same `{{% %}}`/`{{< >}}` delimiters it already preserves via sentinel. (design D4)
- CDS/backend not touched by this change; foundation is parser + Hugo + MCP/AI read-path only.

## Review Focus

- **Attribute-value HTML/quote injection** (`:ui[x]{title="\" onmouseover=alert(1)"}`) → escaped text only, no event-handler attribute reaches HTML. Test in Task 2.
- **Directive syntax inside fenced/indented code and inline code spans** → emitted byte-for-byte unchanged, never parsed. Test in Task 1 (code), Task 4 (via compose integration).
- **Unclosed container at end of step** → `directive/unclosed` error pointing at the opening line, not a silent swallow of the rest of the step. Test in Task 1.
- **Prose that coincidentally looks inline** (`10:30`, `std::vector`, `http://x`, `:smile:`, `:foo{x=1}` with no `[` label) → no match, text unchanged. Test in Task 1.
- **Variable token inside a directive label** (`:menu[dev-{{var:n}}]`) → the live variable span survives because directives run after `wrapTokens`. Test in Task 4.

---

## Task 1: Registry + tokenizer + core parser

**Files:**
- Create: `scripts/parsers/directive-registry.ts`
- Create: `scripts/parsers/directives.ts` (parser half: `parseDirectives`, `DirectiveParseError`, node types)
- Test: `scripts/parsers/__tests__/directive-registry.test.ts`
- Test: `scripts/parsers/__tests__/directives-parse.test.ts`

**Interfaces:**
- Consumes: `classifyLines(md): LineClass[]` and `isNonDelimiterLine` from `./md-grammar.js` (LineClass = `{ kind: 'code'|'heading'|'html'|'other'; level: number }`, one per line).
- Produces:
  - `interface DirectiveDef { name; kinds: Array<'inline'|'leaf'|'container'>; summary; label?: {required; markdown}; attrs: Record<string, {type:'string'|'number'|'boolean'|'enum'|'duration'; values?; required?; default?; pattern?}>; classes?: string[]; expand?(node, ctx): string; render(node, ctx): string; toText(node, ctx): string; since: string }`
  - `registerDirective(def: DirectiveDef): void`, `getRegistry(): ReadonlyMap<string, DirectiveDef>`, `resetRegistry(): void` (test-only)
  - `interface DirectiveNode { name; kind: 'inline'|'leaf'|'container'; label?: string; attrs: Record<string,string|number|boolean>; id?: string; classes: string[]; body?: string; line: number; column: number }`
  - `class DirectiveParseError extends Error { slug; line; column; directive; code } ` — codes: `unknown`(warning) `missing-attr` `invalid-attr` `duplicate-attr` `invalid-kind` `unclosed` `invalid-class`
  - `parseDirectives(md: string, opts: { slug: string; registry?: ReadonlyMap<string,DirectiveDef> }): { nodes: DirectiveNode[]; warnings: Array<{code; line; message}> }` — returns structural parse (no rendering); throws `DirectiveParseError` on schema violations.
  - `tokenizeAttrs(raw: string): { attrs; id?; classes: string[] }` (exported for unit test)

- [ ] **Step 1: Write failing registry tests** in `directive-registry.test.ts`: `registerDirective` then `getRegistry().get(name)` round-trips; duplicate registration of same name throws; `resetRegistry()` empties it; name not matching `/^[a-z][a-z0-9-]*$/` throws.

- [ ] **Step 2: Write failing tokenizer + parser tests** in `directives-parse.test.ts`. Register a fixture `echo` def (kinds `['inline','leaf','container']`, optional label, attrs `{n:{type:'number'}, flag:{type:'boolean'}}`, classes `['big']`). Assert:
  - `tokenizeAttrs('n=2 flag #setup-block .big')` → `{attrs:{n:2, flag:true}, id:'setup-block', classes:['big']}`
  - duplicate key `os=mac os=win` → throws `DirectiveParseError` code `duplicate-attr` with the line
  - `.class` not in allowlist → code `invalid-class`
  - inline `:echo[hi]{n=1}` in prose → one node kind `inline` label `hi`
  - leaf `::echo[x]` alone on a line → node kind `leaf`
  - container `:::echo[t]\nbody\n:::` → node kind `container`, body `body`
  - nested `::::echo\n:::echo\ninner\n:::\n::::` → outer body contains inner container in source order
  - false positives: `10:30`, `std::vector`, `http://x`, `:smile:`, `:echo{n=1}` (no `[`) → **zero** nodes
  - unknown `:foo[bar]` → zero nodes + one `directive/unknown` warning with line
  - fenced code ` ```js\n:::echo\n``` ` → zero nodes (byte-for-byte skip)
  - inline code span `` `:echo[x]` `` → zero nodes
  - `:::echo` with no closing fence before EOF → throws code `unclosed` at the opening line
  - wrong kind: register `only-container` as `kinds:['container']`, use it inline → code `invalid-kind`
  - missing required attr → code `missing-attr`

- [ ] **Step 3: Run tests, verify they fail** — `npx vitest run --project unit scripts/parsers/__tests__/directive-registry.test.ts scripts/parsers/__tests__/directives-parse.test.ts` → FAIL (modules/exports absent).

- [ ] **Step 4: Implement `directive-registry.ts`** — Map-backed registry with the signatures above; validate name on register; `resetRegistry` for tests.

- [ ] **Step 5: Implement the tokenizer and `parseDirectives` in `directives.ts`.** Use `classifyLines` to mask `kind==='code'`/`'html'` lines and frontmatter; track inline-code spans within `'other'` lines; apply D2 false-positive guards (preceding char in `([{"'`+line start, required `[` for inline, columns 0–3 for leaf/container respecting list/blockquote prefix); container nesting by colon count; validate each node against its registry def, throwing `DirectiveParseError` (or pushing a warning for unknown).

- [ ] **Step 6: Run tests, verify they pass.** Same command as Step 3 → PASS.

- [ ] **Step 7: Commit** — `git add scripts/parsers/directive-registry.ts scripts/parsers/directives.ts scripts/parsers/__tests__/directive-registry.test.ts scripts/parsers/__tests__/directives-parse.test.ts && git commit -m "feat(directives): registry + fence-aware directive parser (openspec: tutorial-directive-grammar)"`

---

## Task 2: Rendering (`expandDirectives`) + escaping

**Files:**
- Modify: `scripts/parsers/directives.ts` (add `expandDirectives`, `escapeShortcodeParam`)
- Test: `scripts/parsers/__tests__/directives-render.test.ts`

**Interfaces:**
- Consumes: `parseDirectives`, `DirectiveNode`, `getRegistry` from Task 1.
- Produces:
  - `expandDirectives(body: string, ctx: { slug: string; variables?: TutorialVariable[]; registry?: ReadonlyMap<string,DirectiveDef> }): string` — runs `expand` hooks first (with cycle detection, max-depth guard), then replaces each node with its `render` output. Inline/leaf → `{{< tut-<name> label="…" k="…" >}}`; container → `{{% tut-<name> label="…" %}}\n<body>\n{{% /tut-<name> %}}`; defs declaring `render:'markdown'` return raw markdown.
  - `escapeShortcodeParam(v: string): string` — HTML-escapes `& < > "` and the param quote so no value breaks out of `"…"` or injects an attribute.

- [ ] **Step 1: Write failing tests** in `directives-render.test.ts`, registry reset + fixture `echo` (container → `{{% %}}`, inline → `{{< >}}`) and a `sugar` def with `render:'markdown'`:
  - inline `:echo[hi]{n=1}` → `{{< tut-echo label="hi" n="1" >}}`
  - container `:::echo[t]\n**b**\n:::` → `{{% tut-echo label="t" %}}\n**b**\n{{% /tut-echo %}}`
  - `render:'markdown'` def returns its markdown unwrapped (no shortcode)
  - **injection**: `:echo[Save]{title="\" onmouseover=alert(1) x=\""}` → rendered shortcode param contains the value HTML-escaped, with no bare `onmouseover=` token and no unescaped `"` closing the param
  - cycle: a fixture `expand` hook that re-emits itself → throws (depth guard), does not hang

- [ ] **Step 2: Run, verify fail** — `npx vitest run --project unit scripts/parsers/__tests__/directives-render.test.ts` → FAIL.

- [ ] **Step 3: Implement `escapeShortcodeParam` and `expandDirectives`** per the signatures. Replace nodes back-to-front by source offset to keep positions stable.

- [ ] **Step 4: Run, verify pass.**

- [ ] **Step 5: Commit** — `git commit -m "feat(directives): expandDirectives rendering + param escaping"`

---

## Task 3: Plain-text fallback (`renderDirectivesAsText`)

**Files:**
- Modify: `scripts/parsers/directives.ts` (add `renderDirectivesAsText`)
- Test: `scripts/parsers/__tests__/directives-text.test.ts`

**Interfaces:**
- Consumes: `parseDirectives`, `getRegistry` from Task 1.
- Produces: `renderDirectivesAsText(markdown: string, opts?: { registry? }): string` — replaces each registered node with its `toText(node, ctx)` output; unknown directives left as-is; code/fence contexts untouched.

- [ ] **Step 1: Write failing tests** in `directives-text.test.ts`, fixture `details` (container, `toText` → `**<label>**\n\n<body>`) and `kbd` (inline, `toText` → the key combo):
  - `:::details[Why]\ncontent\n:::` → `**Why**\n\ncontent`, with no `:::` present
  - `:kbd[Mod+S]` → readable combo, no `:kbd[` present
  - unknown `:foo[x]` → left verbatim
  - directive inside a code fence → unchanged

- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement `renderDirectivesAsText`.**
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** — `git commit -m "feat(directives): renderDirectivesAsText plain-text fallback"`

---

## Task 4: Wire into compose.ts + pipeline-interaction fixtures

**Files:**
- Modify: `scripts/parsers/compose.ts` (call `expandDirectives` after `wrapTokens` ~line 154, before `convertOptionBlocks` ~line 184)
- Test: `scripts/parsers/__tests__/directives-compose.test.ts`

**Interfaces:**
- Consumes: `expandDirectives` (Task 2); `composeTutorial(rawMd, opts: ComposeOpts)` where `ComposeOpts = {repo,branch,slug,target,rewriteImages,rulesVr?}`; frontmatter variables available inside compose.
- Produces: no new export; directives are expanded as part of `composeTutorial`.

- [ ] **Step 1: Write failing integration tests** in `directives-compose.test.ts` using `composeTutorial` with `parser: v2` frontmatter and a fixture directive registered in `beforeEach`:
  - directive in a plain step → rendered `tut-*` shortcode appears in `result.body`
  - **variable in label**: `variables:` block with `groupNumber`, body `:echo[dev-{{var:groupNumber}}]` → the emitted shortcode param contains the `tut-var` span (proves directives run AFTER `wrapTokens`)
  - **directive inside OPTION panel**: `[OPTION BEGIN [Windows]]` … directive … `[OPTION END]` → directive renders inside the Windows tab shortcode only (proves it runs BEFORE `convertOptionBlocks`)
  - directive inside a code fence in a step → unchanged
  - empty registry + a corpus-like step with no directives → body unchanged vs. a run with the pre-pass disabled (local byte-identical check)

- [ ] **Step 2: Run, verify fail** — `npx vitest run --project unit scripts/parsers/__tests__/directives-compose.test.ts` → FAIL.

- [ ] **Step 3: Insert the `expandDirectives(body, { slug, variables })` call** in `compose.ts` between the `wrapTokens` block and the `convertOptionBlocks` block.

- [ ] **Step 4: Run, verify pass.** Also run the existing `scripts/parsers/__tests__/variables.test.ts` and `scripts/__tests__/v2.test.ts` to confirm no regression.

- [ ] **Step 5: Commit** — `git commit -m "feat(directives): wire expandDirectives into compose pipeline"`

---

## Task 5: Error surfacing + end-to-end Hugo fixture

**Files:**
- Modify: `scripts/fetch-tutorials.ts` (confirm `DirectiveParseError.message` includes slug:line via its `Error` message — it is caught by the generic `catch (err)` at ~line 1624 and recorded to `.tutorial-cache/errors.json`; add slug/line to the message if not already)
- Create: `hugo/layouts/shortcodes/tut-echo.html` (test-only end-to-end fixture shortcode using `{{ .Get }}` default escaping)
- Test: `scripts/parsers/__tests__/directives-error-surface.test.ts`

**Interfaces:**
- Consumes: `DirectiveParseError` (Task 1), the fetch-tutorials catch/record site `{ slug, repo, error, timestamp }`.

- [ ] **Step 1: Write failing test** asserting a `DirectiveParseError` thrown from `composeTutorial` carries a `.message` containing both the slug and the line number (so the fetch-tutorials generic catch records a useful `error` string).

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Ensure `DirectiveParseError`'s `super()` message embeds `(${slug}:${line})`** like `BranchParseError` does; create `tut-echo.html` rendering `<span class="tut-echo">{{ .Get "label" }}</span>` (default-escaped, no `safeHTML`).

- [ ] **Step 4: Run, verify pass.**

- [ ] **Step 5: Commit** — `git commit -m "feat(directives): slug:line in DirectiveParseError + tut-echo fixture shortcode"`

---

## Task 6: MCP + AI read-path fallback adoption

**Files:**
- Modify: `packages/mcp/tutorial-step-slicer.js` (`sliceStepMarkdown` → pass step markdown through `renderDirectivesAsText` before returning)
- Modify: `srv/lib/freshness-detector.js` (apply fallback to `getTutorialSource` markdown before model read)
- Modify: `scripts/lib/expand-ai-authored.ts` (apply fallback to step bodies in `countSubstantiveWords`/consumption path) — only if directives could appear; else document why skipped
- Test: `scripts/parsers/__tests__/directives-text.test.ts` (extend) + a slicer unit test if one exists under `packages/mcp`

**Interfaces:**
- Consumes: `renderDirectivesAsText` (Task 3). Note the slicer is `.js` (ESM) — import the compiled/`.ts`-via-tsx path the package already uses, or add a small JS re-export; match how the package imports other `scripts/parsers` helpers.

- [ ] **Step 1: Write a failing test** that a step markdown containing `:::details[Why]` and `:kbd[Mod+S]`, run through the slicer's text path, returns text with `**Why**` and the readable combo and no `:::`/`:kbd[`.

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Apply `renderDirectivesAsText` at the three read sites.** Keep it a no-op for content without directives (empty registry → identity). If a consumer can't import it cleanly, note the blocker in the commit body rather than forcing a bad import.

- [ ] **Step 4: Run, verify pass** + re-run `scripts/__tests__/expand-ai-authored.test.ts`.

- [ ] **Step 5: Commit** — `git commit -m "feat(directives): MCP/AI read paths use plain-text directive fallback"`

---

## Task 7: Lint rule + validate check-mode

**Files:**
- Create: `scripts/lint-rules/directive-unknown.ts` (matches the `{ id, describe, scan(slug, lines, rawLines) }` shape of `iframe-non-allowlisted-host.ts`, emits `severity:'warning'` for unregistered directive names)
- Modify: `scripts/lint-tutorial-markdown.ts` (register the new rule)
- Test: `scripts/lint-rules/__tests__/directive-unknown.test.ts`

**Interfaces:**
- Consumes: `parseDirectives` warnings (Task 1), `LintFinding` type from `../lint-tutorial-markdown.js`.

- [ ] **Step 1: Write failing test** — a tutorial with `:foo[bar]` (unregistered) yields one `directive-unknown` warning at the right line; a registered directive yields none; a `:::details` inside a code fence yields none.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement the rule** delegating to `parseDirectives` warnings; register it.
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** — `git commit -m "feat(directives): directive-unknown lint rule"`

---

## Task 8: Schema export + author-docs table codegen

**Files:**
- Create: `scripts/emit-directive-schema.ts` (dual export: `emitDirectiveSchema(registry?): string` + direct-invoke CLI guarded by `import.meta.url === pathToFileURL(process.argv[1]).href`, writing `schemas/tutorial-directives.schema.json`) — mirrors `scripts/emit-graphql-sdl.ts`
- Modify: `package.json` (add `"build:directive-schema": "tsx scripts/emit-directive-schema.ts"`)
- Test: `scripts/__tests__/emit-directive-schema.test.ts`

**Interfaces:**
- Consumes: `getRegistry` (Task 1). Registry is empty at foundation time, so the schema's `directives` map is `{}` but the document shape (version, `$schema`, `directives`) is asserted.

- [ ] **Step 1: Write failing test** — `emitDirectiveSchema()` returns JSON with top-level `directives` object; registering one fixture def makes it appear with its name, kinds, summary, attrs.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement `emit-directive-schema.ts` + add the npm script.**
- [ ] **Step 4: Run, verify pass**; run `npm run build:directive-schema` and confirm `schemas/tutorial-directives.schema.json` is written.
- [ ] **Step 5: Commit** — `git commit -m "feat(directives): build:directive-schema registry export"`

---

## Task 9: Registry conformance test + corpus regression

**Files:**
- Create: `scripts/parsers/__tests__/directive-registry-conformance.test.ts`
- Create: `scripts/check-directive-corpus-regression.ts` (renders every `.tutorial-cache/*` tutorial with and without the pre-pass under an empty registry; asserts byte-identical composed output; CLI, skips gracefully if `.tutorial-cache/` absent)

**Interfaces:**
- Consumes: `getRegistry` (Task 1), `composeTutorial`, `expandDirectives`.

- [ ] **Step 1: Write the conformance test** — iterate `getRegistry()` and assert every def has a non-empty `summary`, a `toText`, and (when follow-ups add them) at least one fixture; at foundation time the registry is empty so this asserts "iterates with no failures" and the invariant helper is exercised against a registered fixture.
- [ ] **Step 2: Write `check-directive-corpus-regression.ts`** so that, with an empty registry, `composeTutorial` output is identical whether or not `expandDirectives` ran. Run it against `.tutorial-cache/` if present; otherwise assert on a bundled multi-construct fixture (OPTION + BRANCH + variables + blockquote + lists + code fences).
- [ ] **Step 3: Run both; verify pass.**
- [ ] **Step 4: Commit** — `git commit -m "test(directives): registry conformance + empty-registry corpus regression"`

---

## Task 10: Author + developer docs

**Files:**
- Modify: `docs/authors/writing-tutorials.md` (add a "Directives" section: the three forms, attribute syntax, escaping, unknown-name warning behaviour — generated/anchored to match the registry table)
- Modify: `docs/developers/reference/tutorials-ims-gotchas.md` (add a gotcha: directive pre-pass pipeline position between `wrapTokens` and `convertOptionBlocks`; the reserved `tut-` shortcode namespace; empty-registry byte-identical invariant)

- [ ] **Step 1: Write the author "Directives" section** — forms, attrs, `#id`/`.class`, escaping guarantee, "unknown names stay literal + warn".
- [ ] **Step 2: Write the gotcha entry** — pipeline position, `tut-` namespace reservation, and the regression invariant.
- [ ] **Step 3: Commit** — `git commit -m "docs(directives): author grammar reference + pipeline gotcha"`

---

## Task 11: Verify + openspec validate + mark tasks

**Files:**
- Modify: `openspec/changes/tutorial-directive-grammar/tasks.md` (check off completed items)

- [ ] **Step 1: Run `npm test`** (`vitest run --project unit`) and confirm the full unit suite is green (note any pre-existing unrelated flake explicitly).
- [ ] **Step 2: Run `openspec validate tutorial-directive-grammar --strict`** → "is valid".
- [ ] **Step 3: Check off `tasks.md`** items now done; leave genuinely deferred ones unchecked with a one-line note.
- [ ] **Step 4: Commit** — `git commit -m "chore(directives): check off completed openspec tasks"`

---

## Notes for follow-up (fan-out) changes

Each dependent change (code-block-enhancements, ui-instruction-directives, callout-enhancements, rich-media-and-tables, content-reuse-and-references, authoring-aids) adds one file per directive family under `scripts/parsers/directives/` calling `registerDirective`, one `hugo/layouts/shortcodes/tut-<name>.html` per directive, a `docs/authors/` section, and a **sample tutorial in `sap-tutorials/meta-tutorials`** (the `v2-example-tutorial` reference tutorial is the natural home for syntax samples; new author-facing features may warrant their own meta tutorial). `tutorial-synced-option-tabs` is independent of the grammar and can proceed in parallel.
