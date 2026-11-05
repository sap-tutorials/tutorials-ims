## Why

The same setup instructions ("Get a BTP trial account", "Install the cf CLI", "Create a HANA Cloud instance") are copy-pasted across hundreds of tutorials and drift independently, so fixing one leaves dozens stale. References are hand-written URLs that rot: SAP Notes, Help Portal pages, API docs and other tutorials are linked by raw URL with no title check. Readers can't tell which product versions a tutorial was tested with, and prerequisite tutorials are plain links that don't show whether the reader already completed them.

## What Changes

- **Snippet includes**: `::include[btp-trial-account]{vars="region=us10"}` inlines a shared markdown fragment from the tutorial repo's `_snippets/` folder (or a central `sap-tutorials/tutorial-snippets` repo with `repo:` prefix, e.g. `::include[shared:install-cf-cli]`). Snippets can take parameters (`{{param:region}}`), may contain other includes (depth ≤ 3, cycles rejected), and changes to a snippet trigger rebuilds of all tutorials that include it.
- **Smart reference links** (inline directives with auto-filled titles, build-time validation):
  - `:tutorial[hana-cloud-mission-trial-2]` — title from catalog; build fails if slug unknown; shows completion check for signed-in readers.
  - `:note[2471802]` — SAP Note link `me.sap.com/notes/<n>` with "SAP Note 2471802" label (title fetched when available).
  - `:help[<product>/<path>]` — help.sap.com link with title resolved at build (cached), dead links reported.
  - `:api[cds.ql.SELECT]{lib=cap-node}` — API reference link via a curated library map (CAP, UI5, SAP Cloud SDK…).
- **Tested-with badges**: frontmatter `testedWith: { "@sap/cds": "9.x", node: "22", "SAP BTP CLI": "2.78" }` renders a "Tested with" panel; inline `:since[CAP 9]` marks version-specific instructions. Data feeds the freshness detector (stale when a listed major is superseded).
- **Prerequisite-aware links**: `::requires[slug]{optional}` in the Prerequisites section renders a card with title, time and the reader's completion state (✓ / not started / in progress), with "Start" CTA; frontmatter `requires: [slug…]` alternative; recommended order passed to navigation.

## Capabilities

### New Capabilities
- `tutorial-content-reuse-and-references`: snippet includes, validated smart reference links, tested-with metadata, and progress-aware prerequisites.

### Modified Capabilities
<!-- none -->

## Impact

- Directive registrations (`include` with `expand` hook, `tutorial`, `note`, `help`, `api`, `since`, `requires`) on `tutorial-directive-grammar`.
- `scripts/fetch-tutorials.ts` + `scripts/parsers/github.ts`: fetch `_snippets/` and the shared snippets repo; dependency graph (snippet → tutorials) persisted for slug-targeted rebuilds (`rebuild-content.yml` classifier must map snippet changes to dependent slugs).
- Catalog lookup via existing `/build/catalog` (`scripts/parsers/cap.ts`); link-title cache in `.tutorial-cache/`.
- Progress state for `:tutorial`/`::requires` via the progress API used by `hugo/assets/js/tutorial.ts` (`API_BASE`), signed-in only.
- Freshness detector (`srv/jobs/freshness-*`) consumes `testedWith`.
- `scripts/validate-tutorials.ts` reports unknown slugs, broken help links, include errors.
