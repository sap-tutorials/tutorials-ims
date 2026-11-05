## ADDED Requirements

### Requirement: Sync key syntax
An OPTION block opener MAY carry `sync=<key>` after the label (`[OPTION BEGIN [Java] sync=runtime]`). All OPTION groups on a page with the same sync key SHALL switch together. OPTION blocks without a sync key and without auto-classification SHALL render exactly as before. Conflicting sync keys within one group SHALL fail the build.

#### Scenario: Synchronised switch
- **WHEN** steps 2, 4 and 6 contain OPTION groups with `sync=runtime` and the reader selects Java in step 2
- **THEN** steps 4 and 6 also show their Java tab

#### Scenario: Unchanged legacy tabs
- **WHEN** a tutorial uses `[OPTION BEGIN [JSON]]` without `sync=` and without `syncTabs: auto`
- **THEN** each step's tabs remain independent and the generated HTML structure is unchanged except for accessibility attributes

### Requirement: Cross-tutorial persistence and deep links
The selected value per sync key SHALL persist across pages and browser tabs. A URL query parameter matching a sync key (e.g. `?runtime=java`) SHALL select and persist that value. Resolution order SHALL be URL parameter, stored choice, detection, group default, first tab.

#### Scenario: Next tutorial remembers
- **WHEN** a reader chose Java in one tutorial and opens another tutorial with a `runtime` group
- **THEN** the Java tab is preselected

#### Scenario: Deep link
- **WHEN** a reader opens `/tutorials/x?runtime=nodejs`
- **THEN** all `runtime` groups show Node.js

### Requirement: Built-in presets with label aliasing
The system SHALL provide `runtime`, `account`, and `ide` presets whose alias tables map author labels to canonical values, so groups labelled `Node` and `CAP Node.js` select the same value. BAS SHALL be auto-detected for the `ide` key using the existing BAS detection.

#### Scenario: Alias match
- **WHEN** step 1 labels a tab `Node.js` and step 3 labels it `CAP Node.js`, both `sync=runtime`
- **THEN** selecting either selects the other

#### Scenario: BAS detection
- **WHEN** the tutorial is opened from SAP Business Application Studio and no `ide` choice is stored
- **THEN** `ide` groups show the BAS tab

### Requirement: Opt-in auto-classification and overrides
With frontmatter `syncTabs: auto`, the build SHALL assign a preset key to every OPTION group whose labels all resolve to that preset. Frontmatter `syncOverrides` keyed by step slug SHALL force a key or `none`. Without `syncTabs: auto`, no group SHALL be classified automatically.

#### Scenario: Auto assigned
- **WHEN** `syncTabs: auto` is set and a group's tabs are `Trial` and `Enterprise`
- **THEN** the group is synced under `account`

#### Scenario: Override to none
- **WHEN** `syncOverrides: { configure-java-agent: none }` is set
- **THEN** that step's group is not synced

### Requirement: Custom sync groups
Frontmatter `syncGroups` SHALL declare custom keys with a display label, allowed values, optional aliases, and default value; OPTION groups referencing an undeclared non-preset key SHALL fail the build.

#### Scenario: Undeclared key
- **WHEN** a block uses `sync=db` and `db` is neither a preset nor declared in `syncGroups`
- **THEN** the build fails naming the key and line

### Requirement: Page picker bar and missing variants
When a sync key is used by two or more groups on a page, a picker bar SHALL show a control for that key. When a group lacks the selected value, it SHALL show a placeholder stating that the variant is unavailable and SHALL list the available tabs, without substituting another variant.

#### Scenario: Missing variant
- **WHEN** the reader selected Python and step 5 offers only Node.js and Java
- **THEN** step 5 shows "No Python instructions for this step" with Node.js and Java tabs available

### Requirement: Unified selection runtime
The OS picker, codetabs, and synced OPTION groups SHALL share one client runtime and storage format, and existing stored OS and codetabs preferences SHALL be honoured after the change.

#### Scenario: Preference migration
- **WHEN** a returning reader has `os-preference=Linux` from before the change
- **THEN** OS content shows Linux and the value is available under the unified `os` key

### Requirement: Accessible tabs and machine consumers
OPTION tab strips SHALL implement WAI-ARIA tabs (selected state, controls relationship, roving focus, arrow-key navigation). MCP step tools SHALL accept a variant preference per sync key and return only matching variants, and otherwise return all variants labelled.

#### Scenario: MCP preference
- **WHEN** an MCP client requests step 2 with `variants: {runtime: "java"}`
- **THEN** only the Java variant content is returned for runtime-synced groups
