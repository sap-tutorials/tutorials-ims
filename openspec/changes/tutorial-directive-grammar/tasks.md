## 1. Parser core

- [ ] 1.1 Create `scripts/parsers/directive-registry.ts` with `DirectiveDef`, `registerDirective`, `getRegistry`, and a test-only reset helper
- [ ] 1.2 Implement the label/attribute tokenizer (quoted/unquoted values, flags, `#id`, `.class`, `\]` escapes, balanced brackets) with unit + property-based tests
- [ ] 1.3 Implement `scripts/parsers/directives.ts` `parseDirectives()` using `md-grammar.ts` `classifyLines` to skip fenced/indented code, HTML blocks and inline code spans
- [ ] 1.4 Implement inline, leaf and container recognition with false-positive guards (preceding char, required `[` for inline, column/prefix rules for blocks)
- [ ] 1.5 Implement container nesting by colon count and unclosed-container detection
- [ ] 1.6 Implement `DirectiveParseError` with codes `unknown` (warning), `missing-attr`, `invalid-attr`, `duplicate-attr`, `invalid-kind`, `unclosed`, `invalid-class`

## 2. Rendering

- [ ] 2.1 Implement `expandDirectives(body, ctx)` that runs `expand` hooks (with cycle detection) then `render` hooks, emitting `tut-<name>` shortcodes or markdown
- [ ] 2.2 Implement shared escaping for shortcode params and verify ordering against `hugo-delimiters.ts` so generated shortcodes survive and author-written `{{<` stays escaped
- [ ] 2.3 Wire `expandDirectives` into `scripts/parsers/compose.ts` after `wrapTokens` and before `convertOptionBlocks`
- [ ] 2.4 Surface `DirectiveParseError` through `fetch-tutorials.ts` into `.tutorial-cache/errors.json` like `BranchParseError`
- [ ] 2.5 Add a test-only `tut-echo` directive + shortcode fixture proving end-to-end render through Hugo

## 3. Plain-text fallback

- [ ] 3.1 Implement `renderDirectivesAsText()` and unit tests
- [ ] 3.2 Use it in `srv-mcp` step tools (`get_tutorial_step` and related) when returning raw source
- [ ] 3.3 Use it in `scripts/lib/expand-ai-authored.ts`, the freshness detector source read, the KG step slicer, and search text extraction

## 4. Validation & tooling

- [ ] 4.1 Add lint rule `directive/*` in `scripts/lint-rules/` and run the parser in check-only mode from `scripts/validate-tutorials.ts`
- [ ] 4.2 Add a registry conformance test that iterates all definitions and asserts summary, `toText`, docs entry and at least one fixture exist
- [ ] 4.3 Add `npm run build:directive-schema` writing `schemas/tutorial-directives.schema.json`
- [ ] 4.4 Generate the author-docs directive reference table from the registry

## 5. Regression & docs

- [ ] 5.1 Corpus regression script: render all of `.tutorial-cache/` with and without the pre-pass (empty registry) and assert byte-identical output
- [ ] 5.2 Fixture tests combining directives with OPTION blocks, BRANCH blocks, variables, blockquotes and lists
- [ ] 5.3 Add "Directives" section to `docs/authors/writing-tutorials.md` (forms, attributes, escaping, unknown-name behaviour)
- [ ] 5.4 Add a gotcha entry to `docs/developers/reference/tutorials-ims-gotchas.md` on pipeline position and the `tut-` shortcode namespace
- [ ] 5.5 Run `npm test` and `openspec validate tutorial-directive-grammar --strict`
