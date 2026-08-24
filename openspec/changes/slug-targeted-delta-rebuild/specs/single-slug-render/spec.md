## ADDED Requirements

### Requirement: Slug-targeted render is scoped to changed slug plus aggregates
On a slug-targeted rebuild, the Hugo render SHALL produce the changed tutorial's page and the always-regenerated aggregate pages, and SHALL NOT depend on re-rendering unchanged tutorial pages for correctness of the changed page.

#### Scenario: Changed tutorial renders correctly in isolation
- **WHEN** a single tutorial is rendered without re-rendering the other tutorials
- **THEN** its breadcrumb, prerequisites, steps, and prev/next links are correct (baked from its own frontmatter)
- **AND** mission side-nav, related concepts, and recommendations render their hydration hooks for client-side population

### Requirement: Required precomputed inputs are present for a scoped render
A scoped render SHALL ensure the precomputed inputs the tutorial page reads at render time are current — specifically `hugo/data/author_index.json` — so author links and the "More from this author" rail are correct.

#### Scenario: Author rail correct on scoped render
- **WHEN** a tutorial is rendered with a current `author_index.json`
- **THEN** the author link resolves to the internal author page (or degrades to GitHub only when the author is not indexed) and the author rail lists the correct sibling tutorials

### Requirement: Aggregate pages are regenerated on every content-producing run
The homepage, `/browse/`, `/topics/`, verb pages, `/tutorial-navigator/`, and sitemap SHALL be regenerated on a slug-targeted run from the always-run fetcher data files, independently of the per-tutorial render scoping.

#### Scenario: Aggregates reflect the change
- **WHEN** a slug-targeted rebuild completes
- **THEN** the aggregate pages reflect the current catalog and are published, not left stale
