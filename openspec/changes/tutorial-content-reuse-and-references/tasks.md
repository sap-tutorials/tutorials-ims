## 1. Snippet includes

- [ ] 1.1 Fetch `_snippets/` per repo and the shared `tutorial-snippets` repo in `parsers/github.ts` / `fetch-tutorials.ts`, cached in `.tutorial-cache/`
- [x] 1.2 Register `include` with `expand` hook: lookup, snippet frontmatter params, `{{param:x}}` substitution, depth/cycle checks, step-heading rejection
- [ ] 1.3 Origin-aware image/attachment resolution for included content
- [ ] 1.4 Error line mapping `snippet:line (included from tutorial:line)`
- [ ] 1.5 Per-repo allow flag for includes during rollout

## 2. Rebuild dependencies

- [x] 2.1 Record `snippet-deps.json` during fetch and publish with the content manifest
- [x] 2.2 Extend the `rebuild-content.yml` classifier to map snippet paths to dependent slugs (full-rebuild fallback)

## 3. Smart links

- [x] 3.1 Register `tutorial`, `note`, `help`, `api`, `since` directives with validation and `toText`
- [x] 3.2 Catalog lookup for `:tutorial`; help.sap.com title fetch with cache/timeout; `api-libs.json` URL templates
- [x] 3.3 Client completion indicator for `.tut-xref` (signed-in, batched)

## 4. Tested-with and prerequisites

- [x] 4.1 Frontmatter `testedWith` and `requires` validation; publish in tutorial metadata
- [x] 4.2 "Tested with" header panel; `:since` tag styling
- [x] 4.3 Freshness detector check for outdated `testedWith` majors (known-version table)
- [x] 4.4 Register `requires`; prerequisite card shortcode; batched progress fetch for signed-in readers; KG prerequisite edges

## 5. Docs and tests

- [x] 5.1 Author docs: includes (snippet authoring guide), smart links, tested-with, prerequisites
- [x] 5.2 Unit tests (include expansion, params, cycles, link validation); e2e for prerequisite status; validate-tutorials integration
