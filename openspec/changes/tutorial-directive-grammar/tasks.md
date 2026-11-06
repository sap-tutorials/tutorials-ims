## 1. Parser core

- [x] 1.1 Create `scripts/parsers/directive-registry.ts` with `DirectiveDef`, `registerDirective`, `getRegistry`, and a test-only reset helper
- [x] 1.2 Implement the label/attribute tokenizer (quoted/unquoted values, flags, `#id`, `.class`, `\]` escapes, balanced brackets) with unit + property-based tests
- [x] 1.3 Implement `scripts/parsers/directives.ts` `parseDirectives()` using `md-grammar.ts` `classifyLines` to skip fenced/indented code, HTML blocks and inline code spans
- [x] 1.4 Implement inline, leaf and container recognition with false-positive guards (preceding char, required `[` for inline, column/prefix rules for blocks)
- [x] 1.5 Implement container nesting by colon count and unclosed-container detection
- [x] 1.6 Implement `DirectiveParseError` with codes `unknown` (warning), `missing-attr`, `invalid-attr`, `duplicate-attr`, `invalid-kind`, `unclosed`, `invalid-class`

## 2. Rendering

- [x] 2.1 Implement `expandDirectives(body, ctx)` that runs `expand` hooks (with cycle detection) then `render` hooks, emitting `tut-<name>` shortcodes or markdown
- [x] 2.2 Implement shared escaping for shortcode params and verify ordering against `hugo-delimiters.ts` so generated shortcodes survive and author-written `{{<` stays escaped
- [x] 2.3 Wire `expandDirectives` into `scripts/parsers/compose.ts` after `wrapTokens` and before `convertOptionBlocks`
- [x] 2.4 Surface `DirectiveParseError` through `fetch-tutorials.ts` into `.tutorial-cache/errors.json` like `BranchParseError`
- [x] 2.5 Add a test-only `tut-echo` directive + shortcode fixture proving end-to-end render through Hugo

## 3. Plain-text fallback

- [x] 3.1 Implement `renderDirectivesAsText()` and unit tests
- [x] 3.2 Use it in `srv-mcp` step tools (`get_tutorial_step` and related) when returning raw source
- [x] 3.3 Use it in `scripts/lib/expand-ai-authored.ts`, the freshness detector source read, the KG step slicer, and search text extraction

## 4. Validation & tooling

- [x] 4.1 Add lint rule `directive/*` in `scripts/lint-rules/` and run the parser in check-only mode from `scripts/validate-tutorials.ts`
- [x] 4.2 Add a registry conformance test that iterates all definitions and asserts summary, `toText`, docs entry and at least one fixture exist
- [x] 4.3 Add `npm run build:directive-schema` writing `schemas/tutorial-directives.schema.json`
- [x] 4.4 Generate the author-docs directive reference table from the registry

## 5. Regression & docs

- [x] 5.1 Corpus regression script: render all of `.tutorial-cache/` with and without the pre-pass (empty registry) and assert byte-identical output
- [x] 5.2 Fixture tests combining directives with OPTION blocks, BRANCH blocks, variables, blockquotes and lists
- [x] 5.3 Add "Directives" section to `docs/authors/writing-tutorials.md` (forms, attributes, escaping, unknown-name behaviour)
- [x] 5.4 Add a gotcha entry to `docs/developers/reference/tutorials-ims-gotchas.md` on pipeline position and the `tut-` shortcode namespace
- [x] 5.5 Run `npm test` and `openspec validate tutorial-directive-grammar --strict`
