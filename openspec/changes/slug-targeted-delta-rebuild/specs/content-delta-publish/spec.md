## ADDED Requirements

### Requirement: Publish writes only changed slugs
The content publish path SHALL write only the slugs present in the publish payload and SHALL NOT copy forward unchanged content BLOBs. Publish cost MUST scale with the number of changed slugs, not the size of the corpus.

#### Scenario: Single-slug publish touches one row
- **WHEN** a publish session commits with exactly one changed slug
- **THEN** exactly one content row is inserted/updated and no other slug's BLOB is read or rewritten
- **AND** the reported server commit time is independent of the total corpus size

#### Scenario: Multi-slug publish touches only its payload
- **WHEN** a publish commits N changed slugs
- **THEN** exactly N content rows are written and unchanged slugs are left untouched

### Requirement: Serve reads from a mutable current table
The serve path SHALL resolve a slug's current content from a single mutable current-content store keyed by slug alone, without joining on an active version. Every slug that is live MUST be served without requiring a full-snapshot version to exist.

#### Scenario: Every live slug serves after a delta publish
- **WHEN** one slug is published as a delta and another slug was published in a prior publish
- **THEN** both slugs serve their latest content with a 200 response
- **AND** no slug returns 404 for being absent from the latest publish

#### Scenario: Special slugs serve from current
- **WHEN** the serve path requests `__nav__`, `__shell__`, `__404__`, a `page-*`, `author-*`, `advocate-*`, or `concept-*` key
- **THEN** it is resolved from the current-content store the same way as tutorial slugs

### Requirement: Caches invalidate on content change without a global version bump
Any content cache keyed on the old global active version (shell, concept-list, step-slicer) SHALL be re-keyed on a monotonic generation token or per-slug source version so that a delta publish that does not bump a global version still invalidates stale cached content.

#### Scenario: Shell/concept/step caches refresh after delta publish
- **WHEN** a slug is delta-published
- **THEN** subsequent reads through the shell, concept-list, and step-slicer caches return the new content, not a stale cached copy

### Requirement: Rollback replays from history
Rollback SHALL restore the current-content store to the state of a target version by replaying that version's content from an append-only history, including re-inserting slugs deleted since and removing slugs added since. Rollback MUST NOT depend on the target version's BLOBs remaining physically present as a separate live snapshot.

#### Scenario: Rollback restores prior content
- **WHEN** an operator rolls back to a prior version
- **THEN** every slug's current content matches what was live at that version
- **AND** slugs added after the target version are removed and slugs deleted after it are restored

### Requirement: Drift detection uses history
The no-revert / drift-detection guard SHALL determine whether an incoming publish reverts previously-published content by consulting per-slug, per-version source-hash history, and MUST continue to reject unintended reverts.

#### Scenario: Revert of stale content is rejected
- **WHEN** a publish payload for a slug matches a source hash older than the current one
- **THEN** the publish is flagged as a revert and rejected unless explicitly overridden per slug

### Requirement: Migration preserves currently-served content
A one-time migration SHALL seed the current-content store from the existing ACTIVE version so that all currently-served content is served identically after cutover, with the legacy snapshot tables retained read-only for one release.

#### Scenario: No content changes across cutover
- **WHEN** the migration runs against the existing ACTIVE snapshot
- **THEN** every slug serves byte-identical content before and after cutover
