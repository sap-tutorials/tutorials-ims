## ADDED Requirements

### Requirement: Directive syntax forms
The tutorial parser SHALL recognise three directive forms: inline `:name[label]{attrs}`, leaf `::name[label]{attrs}` alone on a line, and container `:::name[label]{attrs}` … closing `:::` line. Directive names SHALL match `[a-z][a-z0-9-]*`. Containers SHALL nest when the outer fence uses more colons than the inner fence.

#### Scenario: Inline directive in prose
- **WHEN** a step contains `Open :menu[Connectivity > Destinations] now` and `menu` is registered
- **THEN** the directive is rewritten to the `tut-menu` shortcode with label `Connectivity > Destinations`
- **AND** surrounding prose is unchanged

#### Scenario: Nested containers
- **WHEN** a `::::compare` container encloses two `:::figure` containers
- **THEN** both inner containers are expanded inside the outer container's body in source order

### Requirement: Attribute syntax
Directive attributes SHALL support `key="value"`, `key='value'`, unquoted `key=value`, bare boolean flags, `#id`, and `.class` tokens. Duplicate keys SHALL be rejected. `.class` tokens SHALL only be accepted when listed in the directive's allowed classes.

#### Scenario: Mixed attributes
- **WHEN** an author writes `::include[setup]{version=2 optional #setup-block}`
- **THEN** the parsed node has attrs `{version: 2, optional: true}` and id `setup-block`

#### Scenario: Duplicate key
- **WHEN** an author writes `:kbd[S]{os=mac os=win}`
- **THEN** the build fails with a `directive/duplicate-attr` error naming the line

### Requirement: Code and literal contexts are never parsed
The parser SHALL NOT interpret directive syntax inside fenced code blocks, indented code blocks, inline code spans, HTML blocks, or frontmatter.

#### Scenario: Directive syntax inside a code fence
- **WHEN** a ```` ```js ```` fence contains `:::details`
- **THEN** the fence content is emitted byte-for-byte unchanged

### Requirement: False-positive protection
Inline directives SHALL only match when the name is preceded by line start, whitespace, or an opening bracket/quote and is immediately followed by a `[` label. Directives with unregistered names SHALL be left unchanged and reported as a lint warning, not an error.

#### Scenario: Ordinary colon text
- **WHEN** prose contains `10:30`, `std::vector`, `http://example.com`, or `:smile:`
- **THEN** no directive is recognised and the text is unchanged

#### Scenario: Unknown directive name
- **WHEN** prose contains `:foo[bar]` and `foo` is not registered
- **THEN** the text is emitted unchanged
- **AND** `validate-tutorials` reports a `directive/unknown` warning with line number

### Requirement: Registry-driven validation
Each directive SHALL be defined in a registry with its allowed kinds, label rules, attribute schema (type, enum values, required, default, pattern), allowed classes, renderer, and plain-text fallback. Usage violating the schema SHALL fail the tutorial build with a `DirectiveParseError` that carries slug, line, column, directive name, error code, and message, and SHALL be recorded in `.tutorial-cache/errors.json`.

#### Scenario: Missing required attribute
- **WHEN** a registered directive declares `src` required and an author omits it
- **THEN** the tutorial fails to build with `directive/missing-attr` and the source line number

#### Scenario: Wrong kind
- **WHEN** a directive registered only as `container` is used inline
- **THEN** the build fails with `directive/invalid-kind`

#### Scenario: Unclosed container
- **WHEN** a `:::details` container reaches the end of the step without a closing fence
- **THEN** the build fails with `directive/unclosed` pointing at the opening line

### Requirement: Shortcode rendering contract
Registered directives SHALL render to Hugo shortcodes in the reserved `tut-<name>` namespace (container directives using the markdown-rendering `{{% %}}` form) or to plain markdown when the definition declares markdown rendering. Attribute and label values SHALL be escaped so that no author input can inject raw HTML or break out of a shortcode parameter.

#### Scenario: Attribute injection attempt
- **WHEN** an author writes `:ui[Save]{title="\" onmouseover=alert(1) x=\""}`
- **THEN** the rendered HTML contains the value as escaped text only and no event-handler attribute

### Requirement: Pipeline compatibility
Directive expansion SHALL run after variable-token wrapping and before OPTION-block conversion and branch extraction, so that variables work inside directive labels and directives work inside OPTION panels and branch blocks.

#### Scenario: Variable inside a directive label
- **WHEN** an author writes `:menu[Spaces > dev-{{var:groupNumber}}]` with `groupNumber` declared
- **THEN** the rendered menu chip contains the live variable span

#### Scenario: Directive inside an OPTION panel
- **WHEN** a directive appears inside `[OPTION BEGIN [Windows]] … [OPTION END]`
- **THEN** it renders inside the Windows panel only

### Requirement: Plain-text fallback
The system SHALL provide `renderDirectivesAsText()` that replaces each registered directive with its readable plain-text/markdown fallback. The MCP step tools, AI-authoring pipelines, freshness detector, knowledge-graph step slicer, and search text extraction SHALL use it when reading raw tutorial source.

#### Scenario: MCP step output
- **WHEN** an MCP client calls `get_tutorial_step` for a step containing `:::details[Why]` and `:kbd[Mod+S]`
- **THEN** the returned markdown contains `**Why**` followed by the content and a readable key combination, and no `:::` or `:kbd[` syntax

### Requirement: Legacy markers unchanged
Existing markers (`[OPTION BEGIN]`, `[BRANCH_BEGIN]`, `[CODECHECK_N]`, `[ASSERT_N]`, `[AUTOAUTHOR_N]`, `{{var:x}}`) SHALL keep their current syntax and behaviour.

#### Scenario: Corpus regression
- **WHEN** the full `.tutorial-cache/` corpus is rendered with the directive pre-pass enabled and an empty registry
- **THEN** the generated `hugo/content/tutorials/*.md` output is byte-identical to the output without the pre-pass

### Requirement: Tooling schema export
The build SHALL export the directive registry as a JSON Schema document consumable by authoring tools, including each directive's name, kinds, summary, and attribute schema.

#### Scenario: Schema generation
- **WHEN** `npm run build:directive-schema` runs
- **THEN** `schemas/tutorial-directives.schema.json` lists every registered directive with its attributes
