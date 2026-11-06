## ADDED Requirements

### Requirement: Author-only notes
Text enclosed in `%% … %%` outside code SHALL be treated as an author note. Notes SHALL be removed from PROD builds and from all PROD-published source content before any other parsing, and SHALL render as highlighted notes with a page-level counter and visibility toggle on the QA channel. Notes SHALL never appear in MCP output, AI pipeline input, or search indexes.

#### Scenario: PROD build
- **WHEN** a step contains `Choose a region. %% @jdoe: is eu10 still default? %%`
- **THEN** the PROD page and published source contain "Choose a region." without the note

#### Scenario: QA preview
- **WHEN** the same tutorial renders on `/tutorials-qa/`
- **THEN** the note appears highlighted with attribution "jdoe" and the page shows "1 author note"

#### Scenario: Inside code
- **WHEN** a SQL fence contains `%%`
- **THEN** the fence content is unchanged in both channels

#### Scenario: Unterminated note
- **WHEN** a `%%` note is never closed
- **THEN** the QA build fails with the line number and PROD lint reports an error

### Requirement: QA-only blocks
The `:::qa-only[Reason]` container SHALL render its content inside a labelled "QA only" frame on the QA channel and SHALL be removed, including nested content, from PROD builds before step parsing. Step headings inside a QA-only block SHALL fail the build.

#### Scenario: Stripped on PROD
- **WHEN** a step contains a QA-only block with a draft verification command
- **THEN** the PROD page for that step does not contain the block and step numbering is unchanged

#### Scenario: Step heading inside
- **WHEN** a QA-only block contains `### Extra step`
- **THEN** the build fails with `directive/invalid-content`

### Requirement: Promotion safeguards
The QA-to-PROD promotion flow and PROD source lint SHALL report remaining author notes and QA-only blocks in files being promoted.

#### Scenario: Promoting with notes
- **WHEN** an author promotes a tutorial containing two author notes and one QA-only block
- **THEN** the promotion reports all three locations and asks the author to resolve them before the PROD pull request is opened

### Requirement: Deprecated CLI lint
A lint rule SHALL scan shell-type code fences and CLI inline code for commands matching a maintained deprecation rules file covering at least `cf`, `btp`, `cds`, and `mbt`, ignoring prompts and joining continuation lines, and SHALL report the message, replacement, and documentation link for each match. The freshness detector SHALL use the same rules file.

#### Scenario: Deprecated flag
- **WHEN** a console block contains `$ cf push myapp --hostname myhost`
- **THEN** lint reports a warning with the suggested replacement and docs link

#### Scenario: Non-shell fence
- **WHEN** a JavaScript fence contains the string `cf push --hostname`
- **THEN** no finding is reported

#### Scenario: Shared with freshness detector
- **WHEN** a new rule is added to the rules file
- **THEN** both lint and the freshness detector report matches without further code changes
