## ADDED Requirements

### Requirement: Console prompt and output separation
Code fences tagged `console`, `shell-session`, or `terminal-session`, or carrying the `{prompt}` attribute, SHALL render prompt-prefixed lines as commands and all other lines as visually distinct output. The copy action SHALL copy only command lines, without their prompts, preserving line-continuation groups.

#### Scenario: Copy a console block
- **WHEN** a reader copies a `console` fence containing `$ cf login`, an output line `API endpoint: …`, and `$ cf target -s dev`
- **THEN** the clipboard contains `cf login\ncf target -s dev`

#### Scenario: Multi-line command
- **WHEN** a command line ends with `\` and the next line has no prompt
- **THEN** both lines are treated as one command and copied together

#### Scenario: Existing bash fences unchanged
- **WHEN** a fence is tagged `bash` without `{prompt}`
- **THEN** it renders exactly as before

### Requirement: Diff and focus markers
Trailing comment markers `[!code ++]`, `[!code --]`, `[!code focus]`, and `[!code highlight]` SHALL be removed from the displayed code and SHALL mark the line as added, removed, focused, or highlighted. A fence with `{diff}` SHALL interpret leading `+`/`-` columns the same way while keeping language highlighting. Copy SHALL produce the final code without removed lines or markers unless `{copy=raw}` is set.

#### Scenario: Added and removed lines
- **WHEN** a `js` fence has one line ending `// [!code --]` and the next ending `// [!code ++]`
- **THEN** the first renders as removed, the second as added, neither shows the marker
- **AND** copying yields only the added line's code

#### Scenario: Focus
- **WHEN** any line carries `[!code focus]`
- **THEN** non-focused lines are dimmed until the reader hovers or focuses the block

### Requirement: Fill-in placeholders
When a tutorial's frontmatter sets `placeholders: auto` or lists placeholders, matching `<TOKEN>` occurrences in code fences and inline code SHALL render as fillable chips backed by the variables runtime. Filling a placeholder SHALL update all its occurrences and persist like a variable. Unfilled placeholders SHALL display and copy as the original token.

#### Scenario: Fill once, update everywhere
- **WHEN** a reader enters `my-subaccount` for `<YOUR_SUBACCOUNT>`
- **THEN** every occurrence on the page shows `my-subaccount` and copy buttons copy the filled value

#### Scenario: Not opted in
- **WHEN** frontmatter has no `placeholders` key
- **THEN** `<YOUR_SUBACCOUNT>` renders as literal code text

### Requirement: File tree fences
A fence tagged `tree` SHALL render as an accessible, collapsible tree, using indentation or box-drawing characters for hierarchy, a trailing `/` for folders, `+`/`~`/`-` prefixes for new/modified/deleted state, and `# text` for annotations. Copy SHALL produce a plain ASCII tree.

#### Scenario: New file marker
- **WHEN** a tree contains `+ srv/cat-service.js  # new service`
- **THEN** the file renders with a "new" indicator and the annotation text

### Requirement: Code walkthrough
The `:::walkthrough` directive SHALL pair one code fence with an ordered list of notes whose items start with a line range in braces. Activating a note SHALL highlight its line range in the code. Invalid structure or out-of-range lines SHALL fail the build.

#### Scenario: Activate a note
- **WHEN** a reader activates note `{3-5} Defines the entity`
- **THEN** lines 3–5 are highlighted and scrolled into view

#### Scenario: Range out of bounds
- **WHEN** a note references `{40}` in a 20-line fence
- **THEN** the build fails with `directive/invalid-attr` and the line number

### Requirement: Plain-text fallbacks for code features
MCP and AI consumers SHALL receive console blocks with prompts intact, code with diff markers removed and removed lines prefixed `-`, placeholders as their original tokens, trees as ASCII, and walkthrough notes as a list with line references.

#### Scenario: MCP walkthrough
- **WHEN** `get_tutorial_step` returns a step containing a walkthrough
- **THEN** the output contains the code fence followed by notes prefixed `(lines 3–5)`
