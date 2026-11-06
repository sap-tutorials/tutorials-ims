## ADDED Requirements

### Requirement: Menu path directive
The inline `:menu[...]` directive SHALL split its label on ` > ` or `→` into ordered segments and render them as a breadcrumb of UI chips with decorative separators and a single accessible name describing the sequence.

#### Scenario: Render a menu path
- **WHEN** an author writes `:menu[Connectivity > Destinations > New Destination]`
- **THEN** three chips render in order separated by chevrons
- **AND** screen readers announce "Connectivity, then Destinations, then New Destination"

#### Scenario: Plain-text fallback
- **WHEN** MCP returns the step
- **THEN** the text reads `**Connectivity → Destinations → New Destination**`

### Requirement: OS-aware keyboard shortcuts
The inline `:kbd[...]` directive SHALL render key combinations as keyboard keys, resolving `Mod` to `Ctrl` on Windows/Linux and `⌘` on macOS (and `Alt` to `⌥`) according to the reader's OS preference or detected OS, updating live when the OS picker changes. Explicit `win`, `mac`, and `linux` attributes SHALL override the computed value. Without JavaScript the Windows/Linux form SHALL render.

#### Scenario: macOS reader
- **WHEN** a reader whose OS preference is macOS views `:kbd[Mod+Shift+P]`
- **THEN** the keys render as `⌘ ⇧ P` with accessible name "Command Shift P"

#### Scenario: Picker change
- **WHEN** the reader switches the OS picker from macOS to Windows
- **THEN** every keyboard directive on the page updates to `Ctrl+Shift+P` without reload

#### Scenario: Explicit override
- **WHEN** an author writes `:kbd[Mod+T]{mac="Ctrl+Option+T"}` and the reader is on macOS
- **THEN** `⌃ ⌥ T` is shown

#### Scenario: Unknown key token
- **WHEN** an author writes `:kbd[Mod+Foo]`
- **THEN** the build fails with `directive/invalid-attr` naming the unknown key

### Requirement: SAP icon directive
The inline `:icon[name]` directive SHALL render the named SAP icon with an accessible name, and SHALL fail validation with a suggestion when the name is not in the SAP icon set.

#### Scenario: Valid icon
- **WHEN** an author writes `:icon[add]{label="Create"}`
- **THEN** the add icon renders with accessible name "Create"

#### Scenario: Unknown icon
- **WHEN** an author writes `:icon[plusss]`
- **THEN** the build fails and the message suggests `add` or `sys-add`

### Requirement: UI element label directive
The inline `:ui[...]` directive SHALL render a UI element name with consistent control styling and an optional `type` attribute of `button`, `field`, `tab`, or `link`.

#### Scenario: Button label
- **WHEN** an author writes `Choose :ui[Save]{type=button}`
- **THEN** "Save" renders with button styling and falls back to `**Save**` in plain text

### Requirement: Ask-Joule prompt directive
The inline `:ask[prompt]` directive SHALL render an "Ask Joule" button that opens Joule with the prompt pre-filled and the current step context attached, without sending automatically. The button SHALL be hidden when Joule is disabled and SHALL NOT render on the QA channel or in preview mode. Prompts longer than 300 characters SHALL fail validation.

#### Scenario: Reader asks Joule
- **WHEN** Joule is enabled and a reader clicks the button for `:ask[Explain CDS projections]` in step 3
- **THEN** Joule opens with "Explain CDS projections" in the input and step 3 context attached

#### Scenario: QA channel
- **WHEN** the tutorial is rendered for `/tutorials-qa/`
- **THEN** no Ask-Joule button is present in the HTML
