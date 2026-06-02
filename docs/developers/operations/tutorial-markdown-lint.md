# Tutorial markdown lint

Author-side smell detector for tutorial source markdown. Catches patterns that the markdown parser tolerates but renders awkwardly downstream — the kind of bug that prompted [#168](https://github.com/sap-tutorials/tutorials-ims/issues/168) / [PR #190](https://github.com/sap-tutorials/tutorials-ims/pull/190).

## What it does

Runs against the raw tutorial markdown cached in `.tutorial-cache/<slug>.md` (the unmodified author input from the `sap-tutorials/*` repos), not against parsed Hugo output. The lint emits a structured report and optionally fails the build.

The detector is **deliberately narrow** — false positives erode trust and the warnings get ignored. Each rule should fire on a specific structural smell, not a stylistic preference.

## Rules

### `indented-numbered-list-item`

Fires when an ordered list item with number > 1 is indented at least 2 columns past its originating `1.`.

CommonMark interprets indented `2.`, `3.`, etc. under a flush-left `1.` as a **nested** `<ol start="N">`, which renders with extra rhythm and the indented number disappearing under the parent's marker. This is the [#168](https://github.com/sap-tutorials/tutorials-ims/issues/168) fingerprint.

The detector does **not** fire on:

- A whole list indented uniformly (e.g., everything at 2 columns) — author convention, renders consistently.
- Single-column off-by-one (likely typo, renders OK).
- Numbered patterns inside fenced code blocks.
- Legitimate nested outlines (sub-list at deeper indent with its own `1.` start).

## Running it

Locally, against the prod cache:

```bash
npm run fetch-tutorials          # populate .tutorial-cache/
npm run lint:tutorial-markdown
```

Against the QA cache:

```bash
npm run fetch-tutorials:qa
npm run lint:tutorial-markdown -- --channel qa
```

Strict mode (exits non-zero on any finding — for one-off blocking checks):

```bash
npm run lint:tutorial-markdown -- --strict
```

## Output

- **Stdout:** a per-tutorial summary grouped by slug.
- **`.tutorial-cache/lint-report.json`** (or `.tutorial-cache-qa/`): structured report consumed by CI for trend tracking. Shape:

```json
{
  "generatedAt": "2026-06-01T22:14:13.000Z",
  "channel": "prod",
  "fileCount": 1391,
  "findingCount": 17,
  "affectedSlugs": 12,
  "findings": [
    {
      "rule": "indented-numbered-list-item",
      "slug": "abap-environment-create-cds-mde",
      "file": "abap-environment-create-cds-mde.md",
      "line": 49,
      "message": "Item `2.` indented 4 columns; sibling `1.` is at column 0. ...",
      "excerpt": "    2. Enter the following ..."
    }
  ]
}
```

## CI wiring

The lint runs in two workflows:

- **`rebuild-content.yml`** — between `Fetch tutorials` and `Validate tutorials`. `continue-on-error: true` keeps the build going; the JSON report is uploaded as artifact `tutorial-markdown-lint-<env>-<run>` (30-day retention).
- **`rebuild-content-qa.yml`** — same pattern against the QA `-Contribution` cache, where author-side smells originate before they're merged to public sources.

The lint is **non-blocking by default**. Author-side smells should not break a content rebuild — we have CSS-side hardening (PR #190) that makes the catalogue resilient to malformed nesting. The lint surfaces the smell so we can chase the source repo for a fix.

## Adding a new rule

1. Add a new `Rule` object in [scripts/lint-tutorial-markdown.ts](../../../scripts/lint-tutorial-markdown.ts) following the existing pattern. The `scan(slug, lines, rawLines)` callback should return `LintFinding[]`.
2. Push it onto the `RULES` array.
3. Add a test case in [test/unit/lint-tutorial-markdown.test.js](../../../test/unit/lint-tutorial-markdown.test.js): one `it()` for the positive case, at least one for a non-trivial false-positive case it should NOT flag.
4. Run `npx vitest run test/unit/lint-tutorial-markdown.test.js` to lock the behaviour.
5. Run `npm run lint:tutorial-markdown` against the live cache and inspect — confirm the finding count is tractable. If a new rule produces > ~50 findings, refine before committing.

## Why we don't quarantine on findings

`scripts/validate-tutorials.ts` quarantines tutorials with malformed Hugo frontmatter — those would crash the build. The markdown lint is different: every finding is **content that already shipped** (the legacy AEM site rendered the same DOM for years). Blocking the build would freeze content updates while authors fix smells we've tolerated since day one. Non-blocking + visible in CI summary is the right balance.
