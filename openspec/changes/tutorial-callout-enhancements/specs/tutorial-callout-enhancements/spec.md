## ADDED Requirements

### Requirement: Alert titles and icons
Alerts written as `> [!TYPE] Title` SHALL render the text after the designator as the alert title. Every alert type SHALL render an icon and a visually hidden type label so its meaning does not depend on color. Plain blockquotes without a designator SHALL render unchanged.

#### Scenario: Titled warning
- **WHEN** an author writes `> [!WARNING] Costs money` followed by body lines
- **THEN** the alert shows a warning icon, the title "Costs money", and the body
- **AND** screen readers announce "Warning: Costs money"

#### Scenario: Plain blockquote unchanged
- **WHEN** a blockquote has no `[!TYPE]` designator
- **THEN** the HTML is byte-identical to the current output

### Requirement: Collapsible details and troubleshooting
`[!DETAILS]` and `[!TROUBLESHOOT]` alerts SHALL render as collapsible sections that are closed by default and work without JavaScript. A `+` suffix (`[!DETAILS]+`) SHALL render the section open. A title SHALL be required for `[!DETAILS]`. Collapsed sections SHALL print expanded.

#### Scenario: Collapsed by default
- **WHEN** a step contains `> [!DETAILS] Why does this work?`
- **THEN** only the summary "Why does this work?" is visible until the reader expands it

#### Scenario: Missing title
- **WHEN** `> [!DETAILS]` has no title
- **THEN** the build fails with a message naming the step and line

### Requirement: Troubleshooting index
The system SHALL collect all `[!TROUBLESHOOT]` titles in a tutorial and render a Troubleshooting section after the final step linking to each entry, and SHALL include each step's troubleshooting entries in Joule step context and MCP step output.

#### Scenario: Index rendered
- **WHEN** steps 2 and 5 each contain a troubleshoot alert
- **THEN** a Troubleshooting section lists both titles linking to their anchors in steps 2 and 5

#### Scenario: No entries
- **WHEN** a tutorial has no troubleshoot alerts
- **THEN** no Troubleshooting section is rendered

### Requirement: Result checkpoints
`[!RESULT]` alerts SHALL render with success styling and a default title of "You should see" when no title is given. When the step has ASSERT specs, the alert SHALL include a link to run the automatic verification.

#### Scenario: Result with assert
- **WHEN** step 4 has `[ASSERT_4]` specs and a `> [!RESULT]` alert
- **THEN** the result alert includes a "Verify automatically" control linked to the step's assert UI

### Requirement: Hints and solutions
`[!HINT]` and `[!SOLUTION]` alerts SHALL render collapsed with "Show hint" / "Show solution" summaries. Consecutive hints in one step SHALL be numbered and, with JavaScript, revealed progressively so that hint N+1 becomes available only after hint N was opened.

#### Scenario: Progressive hints
- **WHEN** a step contains three consecutive `[!HINT]` alerts
- **THEN** they are labelled Hint 1, Hint 2, Hint 3 and Hint 2 is disabled until Hint 1 is opened

### Requirement: Inline spoilers
The inline `:spoiler[text]` directive SHALL render the text obscured until the reader activates it by click, Enter, or Space, and SHALL be printed revealed.

#### Scenario: Keyboard reveal
- **WHEN** a reader focuses a spoiler and presses Enter
- **THEN** the text becomes visible and `aria-pressed` is `true`

### Requirement: Directive equivalents and fallbacks
Container directives `details`, `troubleshoot`, `result`, `hint`, and `solution` SHALL render identically to their blockquote forms. Plain-text fallbacks SHALL include a bold type/title prefix and the full body for every callout type.

#### Scenario: Container with code fence
- **WHEN** an author writes `:::details[Full config]` containing a YAML fence
- **THEN** it renders as a collapsible details section with a highlighted YAML block

#### Scenario: MCP fallback
- **WHEN** MCP returns a step with `> [!HINT]` content
- **THEN** the output contains `**Hint:**` followed by the hint body
