# Authoring Aids

Three lightweight tools for annotating tutorial source during development and review cycles.
They are design to be non-destructive: the annotations are stripped (or rendered as callouts) at
publish time, so readers never see them and they cannot change page structure.

---

## 1. Author Notes (`%% … %%`)

A way to embed comments, reviewer flags, and working notes directly in tutorial markdown without
affecting the published output.

### Syntax

**Inline note** — opens and closes on the same line:

```markdown
Follow the steps below %% @reviewer: confirm this still works with SDK v4 %% to deploy your app.
```

**Block note** — a line containing only `%%` opens the block; the next bare `%%` closes it.

```markdown
%%
@author: The following screenshot is from the OLD tenant. Needs refresh once #123 is resolved.
%%
```

The leading `@name:` attribution prefix is optional. Without it the note body stands on its own.

### QA vs PROD behavior

| Channel | What happens |
|---------|--------------|
| QA | Notes render as styled inline `<span>` or block `<div>` callouts with the author name visible. Unterminated notes throw a parse error so you see the problem immediately. |
| PROD | Notes are stripped entirely before the HTML is built. An unterminated note logs a warning and the content from the opening `%%` to end-of-step is discarded rather than leaking. |

Author notes are **never visible to end readers** regardless of channel.

### When to use

Use author notes to:
- Flag a step that needs a screenshot refresh (`@author: screenshot outdated`)
- Leave a message for a co-author or reviewer (`@reviewer: should this mention X?`)
- Document a pending decision inline so it travels with the content
- Note a dependency on an issue or PR number

Do **not** use author notes to:
- Write content that readers should see — use a regular callout or note directive instead
- Leave notes permanently — treat them as temporary annotations, remove them before the final PROD promotion
- Mark entire steps as draft — a whole step as a block note will produce a blank step on QA

---

## 2. QA-only blocks (`:::qa-only[…]`)

A container directive that renders content exclusively on the QA author-preview channel and is
removed entirely before the tutorial reaches production readers.

### Syntax

```markdown
:::qa-only[Reason this content is QA-only]
Content that appears only on QA.

You can include **bold**, lists, and inline code here.

    But not step headings (### Step N) — those alter step numbering on PROD when stripped.
:::
```

The label (inside `[…]`) is required and should briefly explain why the block is QA-only. It is
shown as a callout header on QA so reviewers understand the context.

### QA vs PROD behavior

| Channel | What happens |
|---------|--------------|
| QA | Renders as a styled `tut-qa-only` callout with the reason label. All body content is visible and fully rendered. |
| PROD | Stripped entirely — the block and its contents produce no HTML output. |

**Restriction:** step headings (`### Step N — Title`) inside a `:::qa-only` block are rejected at
parse time with an error. Because the block is stripped on PROD, a heading inside it would silently
renumber subsequent steps, causing step-count mismatches between QA and PROD. If you need a
QA-only step, restructure the tutorial so the step exists conditionally at a higher level.

### When to use

Use `:::qa-only` for:
- Reviewer instructions that must not appear in the published tutorial
- Placeholder content for a section not yet ready for PROD
- Author-facing checklists or sign-off criteria embedded in the document
- Temporary context about why a tutorial is in a certain state

Do **not** use `:::qa-only` for:
- Content that readers need on PROD — use a regular callout directive instead
- Hiding steps that should just be removed — delete the step instead
- Large structural sections; prefer targeted notes for small annotations

---

## 3. CLI Freshness Lint

An automated rule in `lint-tutorial-markdown` that scans bash/sh/shell/console fences for
deprecated CLI commands and flags.

The rule checks each shell code block against a versioned catalog in
`scripts/lint-rules/data/cli-deprecations.json`. When a command matches a deprecated pattern, it
emits a `warning` finding with the deprecated flag, the version it was removed in, the recommended
replacement, and a link to the relevant documentation.

### What it catches

| Pattern | Removed in | Replacement |
|---------|-----------|-------------|
| `cf push … --hostname <h>` | cf CLI v8 | `routes:` block in `manifest.yml` |
| `cf push … --no-hostname` | cf CLI v8 | `no-route: true` in `manifest.yml` |
| `cds serve --in-memory` | `@sap/cds` 7 | `cds watch` |
| `npm install --save` | npm 5 | `npm install <package>` (flag is now the default) |

Shell fences with these language identifiers are scanned: `bash`, `sh`, `shell`, `console`,
`terminal`, `powershell`, `cmd`. Prompt prefixes (`$ `, `PS> `, `> `, `# `) are stripped before
matching so findings are not missed.

### How to respond to a finding

A finding looks like:

```
[deprecated-cli] tutorial-deploy-cf.md:42
  The `--hostname` flag was removed in cf CLI v8. Use `routes:` in the application manifest instead.
  Replacement: Add `routes:\n  - route: <hostname>.<domain>` to manifest.yml
  Docs: https://docs.cloudfoundry.org/devguide/deploy-apps/manifest-attributes.html#routes
  Excerpt: cf push myapp --hostname myhost
```

To resolve:
1. Update the command in the tutorial to use the recommended replacement.
2. Re-run `npx tsx scripts/lint-tutorial-markdown.ts <slug>` to confirm the finding clears.
3. If the deprecated form is intentional (e.g., demonstrating migration from an old version), use
   a non-shell fence language (`text` or `diff`) so the rule does not scan it, and add an inline
   author note explaining the exception.

The lint runs automatically as part of `npm run build:all`. Pass `--strict` to make findings
fail the build with a non-zero exit code.
