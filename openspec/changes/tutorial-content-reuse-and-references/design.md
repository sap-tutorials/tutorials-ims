## Context

`fetch-tutorials.ts` discovers tutorials per repo (`parsers/github.ts`) and caches markdown in `.tutorial-cache/`; `compose.ts` transforms each tutorial independently. `rebuild-content.yml` supports slug-targeted rebuilds inferred from changed files (`slug-targeted-delta-rebuild` change). The CAP backend exposes `/build/catalog` (titles, times, slugs) consumed by `parsers/cap.ts`. Bare-slug links are already rewritten by `tutorial-slug-links.ts`. Prerequisites are markdown under `## Prerequisites`, processed by `prerequisites-markup.ts`. The freshness detector reads tutorial source from `ContentFiles.sourceContent`.

## Goals / Non-Goals

**Goals:** single-source shared steps; links that can't silently rot; machine-readable version metadata; prerequisites that reflect reader progress — all authorable in markdown.

**Non-Goals:** cross-repo snippet *editing* UI, automatic version bumping, enforcing prerequisite order (gating content).

## Decisions

### D1 — Include resolution
`include` registers an `expand` hook (runs before other directives, per grammar D3). Lookup: `name` → `<repo>/_snippets/<name>.md`; `shared:<name>` → `sap-tutorials/tutorial-snippets/<name>.md` (pinned to `main`, cached). Snippet files may have frontmatter declaring `params: [{name, required, default}]`; `{{param:x}}` is substituted textually (escaped for markdown) before the included content is parsed. Included content may contain directives, OPTION blocks, images (resolved relative to the **snippet's** location — image resolver receives an origin override), but **not** step headings (`###`) — an include lives inside a step (validation error otherwise, to keep step numbering/slugs stable). Depth ≤ 3; cycles → `directive/include-cycle`. Line numbers in errors reference `snippet:line (included from tutorial:line)`. *Alternative*: Hugo `readFile`-based include shortcode — rejected; parser stages (variables, options, validation, MCP fallback) would never see the content.

### D2 — Rebuild dependency graph
During fetch, record `snippetDeps: { "<repo>/_snippets/x.md": [slug…] }` into `.tutorial-cache/snippet-deps.json` and publish it with the content manifest. The rebuild classifier maps a changed snippet path to its dependent slugs (slug-targeted) or falls back to full rebuild for the shared repo when the graph is unavailable.

### D3 — Smart links
- `:tutorial[slug]{label}` — resolved at build against the catalog (lowercased slug, per platform convention); unknown → build error; label defaults to catalog title. Renders `<a class="tut-xref" href="/tutorials/<slug>" data-slug>`; client adds ✓ for completed (signed-in, batched progress request).
- `:note[n]` — digits only; href `https://me.sap.com/notes/<n>`; label "SAP Note n" (no remote fetch at build — SAP Notes require login).
- `:help[path]` — href `https://help.sap.com/docs/<path>`; title fetched once at build with timeout, cached 7 days in `.tutorial-cache/link-titles.json`; HTTP 404 → lint warning (not error, external flakiness).
- `:api[symbol]{lib}` — `lib` from a curated map `scripts/parsers/directives/api-libs.json` (`cap-node`, `cap-java`, `ui5`, `cloud-sdk-js`, `cloud-sdk-java`) providing URL templates; unknown lib → error. Renders as inline code link.
All produce standard `<a>` going through the render-link XSS guard.

### D4 — Tested-with
Frontmatter `testedWith` map (string → version string), validated (≤ 10 entries). Rendered in the tutorial header as a collapsible "Tested with" panel. `:since[label]` renders a small tag. The freshness detector gains a check: a `testedWith` major older than the current major in a known-version table → finding "tested with outdated version". Published in tutorial metadata for MCP/search.

### D5 — Prerequisite cards
`::requires[slug]{optional}` (leaf) renders a card (title, time, level from catalog). Frontmatter `requires:` list renders the same cards at the top of Prerequisites. Client fetches progress for listed slugs (signed-in only; anonymous sees no state, no request). Status: completed / in progress (any step done) / not started. Data also feeds the KG/recommendations as explicit prerequisite edges. Unknown slugs → build error.

## Risks / Trade-offs

- [Snippet change fans out widely] → dependency graph + slug-targeted rebuild; validate-tutorials runs for all dependents in the snippet repo's CI.
- [Hidden content in snippets surprises reviewers] → QA channel preview + PR comment listing dependents (follow-up workflow task).
- [External link-title fetch slows builds] → cache + concurrency cap + timeout; failure leaves label as path.
- [Progress requests per page] → single batched request; signed-in only.

## Migration Plan

Additive. Ship smart links + tested-with first; includes require the dependency graph in the rebuild workflow before being announced. Rollback: unregister directives (renders literal text) — includes would then break content, so includes stay behind a per-repo allow flag until stable.

## Open Questions

- Versioned shared snippets (`shared:install-cf-cli@v2`)? Proposed later if drift becomes a problem.
