## ADDED Requirements

### Requirement: Step heading attributes
The v2 step parser SHALL recognise a trailing `{…}` attribute block on step headings containing `time=<duration>` and/or `optional`, SHALL remove it from the step title, and SHALL compute the step slug from the title without the attribute block. Unrecognised content in braces SHALL be left in the title and reported as a lint warning.

#### Scenario: Slug stability
- **WHEN** a heading changes from `### Deploy the app` to `### Deploy the app {time=5m optional}`
- **THEN** the step title is "Deploy the app" and the slug is unchanged

#### Scenario: Unrecognised braces
- **WHEN** a heading is `### Return {status: ok}`
- **THEN** the title keeps `{status: ok}` and a `step-attr/unknown` warning is reported

#### Scenario: Invalid duration
- **WHEN** a heading has `{time=5x}`
- **THEN** the build fails with a message naming the step

### Requirement: Step time display
Steps with a `time` attribute SHALL show a time chip. The tutorial total time SHALL use frontmatter `time` when present, otherwise the sum of step times. A remaining-time indicator SHALL be shown when at least half of the steps declare a time. A lint warning SHALL be reported when the sum of step times differs from frontmatter `time` by more than 25%.

#### Scenario: Remaining time
- **WHEN** steps 1–4 declare 5, 10, 5, 10 minutes and the reader completed steps 1 and 2
- **THEN** the indicator shows approximately 15 minutes remaining

### Requirement: Optional steps
Steps marked `optional` SHALL show an "Optional" badge and a "Skip" control, and tutorial completion SHALL require only non-optional steps to be done. A tutorial in which every step is optional SHALL fail lint.

#### Scenario: Complete without optional step
- **WHEN** a reader marks all non-optional steps done and skips optional step 3
- **THEN** the tutorial is recorded as completed and group/mission rollups run

### Requirement: Interactive checklists
GFM task list items inside a step SHALL render as enabled, labelled checkboxes whose state persists per reader and tutorial in browser storage, with a visible count of checked items. Item state SHALL be invalidated when the item text changes. Checking all items SHALL visually emphasise the step's Done control but SHALL NOT mark the step done.

#### Scenario: Persist across reload
- **WHEN** a reader checks two of five items and reloads the page
- **THEN** the same two items are checked and the counter shows 2/5

#### Scenario: All checked
- **WHEN** all items in a step are checked
- **THEN** the step's Done button is emphasised and the step remains not done until clicked

### Requirement: Pacing data in machine consumers
MCP step tools SHALL return each step's `time` and `optional` values as metadata and SHALL return titles without the attribute block.

#### Scenario: MCP step metadata
- **WHEN** an MCP client requests a step declared `{time=10m optional}`
- **THEN** the response includes `timeMinutes: 10` and `optional: true`
