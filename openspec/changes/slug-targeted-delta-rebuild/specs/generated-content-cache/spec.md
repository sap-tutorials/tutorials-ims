## ADDED Requirements

### Requirement: Generated content tree is cached across runs
The rebuild pipeline SHALL cache the generated Hugo content tree (`hugo/content/tutorials/`) between CI runs so that unchanged tutorials are not regenerated on a slug-targeted run.

#### Scenario: Unchanged tutorials are not regenerated
- **WHEN** a slug-targeted rebuild runs with a warm generated-content cache and unchanged global inputs
- **THEN** only the changed slug's generated `.md` is re-derived
- **AND** the other tutorials' generated files are restored from cache without re-running the parser on them

### Requirement: Cache key captures every cross-tutorial input
The generated-content cache key SHALL incorporate a hash of all inputs that can change an unchanged tutorial's generated output: the parser/generator source, the CAP `/build/catalog`, `/build/co-completions`, and `/build/tag-labels` feed payloads, and per-slug source (`.tutorial-cache/<slug>.md` and its `rules.vr` ETag). A change to any of these MUST force a full regeneration.

#### Scenario: Catalog/nav change forces full regen
- **WHEN** the `/build/catalog`, `/build/co-completions`, or `/build/tag-labels` payload changes between runs
- **THEN** the cache key misses and every tutorial's frontmatter (prev/next/mission/recommendations/displayTags) is regenerated

#### Scenario: Parser change forces full regen
- **WHEN** any parser/generator source file changes
- **THEN** the cache key misses and all tutorials are regenerated

#### Scenario: Rules-only edit is not missed
- **WHEN** a tutorial's `rules.vr` changes but its `.md` does not
- **THEN** the cache key for that slug misses and its generated output is regenerated

### Requirement: Nav graph is reconstructable without recomposing every tutorial
When unchanged tutorials are served from cache, the pipeline SHALL still assemble the complete nav graph and `browse.json` by reconstructing `navEntries` for cached slugs from a sidecar rather than by recomposing each tutorial.

#### Scenario: browse.json and nav are complete on a cache hit
- **WHEN** a slug-targeted rebuild uses the generated-content cache
- **THEN** `browse.json` and the nav graph contain correct entries for all tutorials, not only the changed one

### Requirement: Caching is opt-in and fail-open
The generated-content cache SHALL be behind a flag and MUST fail open — a cache miss, corruption, or flag-off condition falls back to full regeneration and never ships partial content.

#### Scenario: Cache miss falls back to full build
- **WHEN** the generated-content cache is absent or the flag is off
- **THEN** the pipeline performs a full regeneration with no correctness difference from today
