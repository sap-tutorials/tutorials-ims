## ADDED Requirements

### Requirement: Snippet includes
The `::include[name]` directive SHALL replace itself with the content of `_snippets/<name>.md` from the tutorial's repository, or from the shared snippets repository when prefixed with `shared:`, before other directives are processed. Snippet parameters declared in snippet frontmatter SHALL be substituted from the directive's attributes. Includes SHALL support nesting up to depth 3, SHALL reject cycles, and SHALL reject snippets containing step headings.

#### Scenario: Parameterised include
- **WHEN** a step contains `::include[btp-trial-account]{region=us10}` and the snippet uses `{{param:region}}`
- **THEN** the rendered step contains the snippet content with `us10` substituted

#### Scenario: Include cycle
- **WHEN** snippet A includes B and B includes A
- **THEN** the build fails with `directive/include-cycle` listing the chain

#### Scenario: Images in snippets
- **WHEN** a snippet references `![](cockpit.png)` relative to `_snippets/`
- **THEN** the image URL resolves relative to the snippet's location

### Requirement: Snippet dependency rebuilds
The build SHALL record which tutorials include each snippet, and a change to a snippet SHALL trigger a rebuild of every tutorial that includes it.

#### Scenario: Snippet edited
- **WHEN** `_snippets/install-cf-cli.md` changes in a repository and three tutorials include it
- **THEN** the rebuild workflow rebuilds exactly those three tutorials plus aggregate pages

### Requirement: Validated tutorial cross-references
The `:tutorial[slug]` directive SHALL link to the tutorial with that slug using its catalog title as the default label, and the build SHALL fail when the slug does not exist. For signed-in readers, completed targets SHALL show a completion indicator.

#### Scenario: Unknown slug
- **WHEN** an author writes `:tutorial[hana-cloud-typo]`
- **THEN** the build fails naming the unknown slug and line

### Requirement: SAP Note, Help Portal and API links
`:note[n]` SHALL link to the SAP Note with label "SAP Note n" and accept digits only. `:help[path]` SHALL link to help.sap.com with a build-time resolved and cached title, reporting unreachable pages as lint warnings. `:api[symbol]{lib}` SHALL link to the API reference via a curated library map and fail the build for unknown libraries.

#### Scenario: SAP Note
- **WHEN** an author writes `:note[2471802]`
- **THEN** a link to `https://me.sap.com/notes/2471802` labelled "SAP Note 2471802" renders

#### Scenario: Unknown API library
- **WHEN** an author writes `:api[foo]{lib=unknown}`
- **THEN** the build fails with `directive/invalid-attr`

### Requirement: Tested-with metadata
Frontmatter `testedWith` SHALL render a "Tested with" panel listing tools and versions, SHALL be published in tutorial metadata, and SHALL be evaluated by the freshness detector. The inline `:since[label]` directive SHALL render a version tag.

#### Scenario: Outdated version finding
- **WHEN** a tutorial declares `testedWith: {"@sap/cds": "7.x"}` and the known current major is 9
- **THEN** the freshness detector reports a "tested with outdated version" finding for the tutorial

### Requirement: Progress-aware prerequisites
The `::requires[slug]` directive and frontmatter `requires` list SHALL render prerequisite cards with title and time from the catalog, and for signed-in readers SHALL show completed, in-progress, or not-started status using a single batched progress request. Anonymous readers SHALL see cards without status and without a progress request. Unknown slugs SHALL fail the build.

#### Scenario: Signed-in reader
- **WHEN** a signed-in reader who completed prerequisite A but not B opens the tutorial
- **THEN** A's card shows a completed indicator and B's card shows a "Start" call to action

#### Scenario: Anonymous reader
- **WHEN** an anonymous reader opens the tutorial
- **THEN** cards render without status and no progress request is made
