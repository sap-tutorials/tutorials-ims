# Author Instructions

How to write, preview, and publish tutorials on the SAP Developers tutorial platform.

This document describes the **current** authoring workflow and flags **planned improvements** in §11 below. If you have edit access to a repo under the [`sap-tutorials`](https://github.com/sap-tutorials) GitHub organization, you are the audience.

---

## 1. The big picture

```text
You write Markdown            Platform fetches & rebuilds        Readers see HTML
─────────────────────         ────────────────────────────       ─────────────────
sap-tutorials/<repo>/   ──▶   tutorials-poc CI               ──▶ developers.sap.com
   *.md + images               (fetch → Hugo → publish)            /tutorials/<slug>
```

You never touch the rendering pipeline, the Hugo site, or the database. You write Markdown in a tutorial repo, open a pull request, and after it is merged the platform takes over.

---

## 2. Where tutorials live

Tutorials are stored in repos under the [`sap-tutorials`](https://github.com/sap-tutorials) GitHub organization. Each repo holds one tutorial set (typically grouped by product or topic). A single Markdown file in that repo represents one tutorial and becomes one URL on the platform.

Naming convention:

| File | Becomes |
|------|---------|
| `sap-tutorials/abap-core-development/tutorials/abap-cloud-ui-from-interface.md` | `/tutorials/abap-cloud-ui-from-interface` |
| `sap-tutorials/abap-core-development/tutorials/abap-cloud-ui-from-interface/001-find-interface.png` | image referenced from the tutorial |

The filename (without `.md`) becomes the **slug** — the public URL segment. Slugs must be unique across the entire `sap-tutorials` org.

### Quiz / validation files

If your tutorial has a quiz, validation rules live in a parallel `<repo>-Contribution` repo (private) under the same org as a `rules.vr` file with the same slug. The platform fetches it automatically when the build runs.

---

## 3. Anatomy of a tutorial

A tutorial Markdown file has three required parts: **frontmatter**, an **introduction**, and **steps**.

### 3.1 Frontmatter

YAML block at the very top of the file, fenced with `---`:

```yaml
---
parser: v2
auto_validation: true
primary_tag: programming-tool>abap-development
tags: [tutorial>beginner, programming-tool>abap-development, software-product>sap-business-technology-platform]
time: 15
author_name: Jane Doe
author_profile: https://github.com/janedoe
---
```

| Field | Required | Notes |
|-------|----------|-------|
| `parser` | Yes | Always `v2` for new tutorials. V1 (`[ACCORDION-BEGIN]` markers) is legacy. |
| `primary_tag` | Yes | One tag from the platform taxonomy — drives categorization. |
| `tags` | Yes | Array. First tag should be `tutorial>beginner`, `tutorial>intermediate`, or `tutorial>advanced`. |
| `time` | Yes | Estimated minutes to complete. Integer. |
| `auto_validation` | No | Set `true` if the tutorial has quiz rules in the `-Contribution` repo. |
| `author_name`, `author_profile` | Recommended | Shown on the tutorial page. |

A canonical taxonomy of allowed `primary_tag` and `tags` values is maintained in the platform's `Tags` entity. To add a new tag or category, see [Center Admin](center-admin.md) § "Import a new tag".

### 3.2 Title and introduction

Immediately after the frontmatter:

```markdown
# Generate your own custom UI Service based on a Business Object Interface
<!-- description -->Business Object Interfaces are provided by SAP in order to release business objects...

## You will learn
- How to generate a custom UI Service based on a C1-released Business Object Interface
- How to identify the authorization objects required to consume it

## Prerequisites
- SAP BTP, ABAP Environment
- A package located in the software component ZLOCAL

---
```

- **`# Title`** (single H1) — the tutorial title.
- **`<!-- description -->...`** — a comment marker followed by the short description shown in catalog pages and search results.
- **`## You will learn`** and **`## Prerequisites`** — H2 sections, conventional and recommended.
- The standalone `---` after Prerequisites separates the introduction from the steps.

### 3.3 Steps (V2 parser)

Each step is a `### H3 heading` followed by content:

```markdown
### Find the released Business Object Interface

1. In the Project Explorer, select **Released Objects** → `USE_IN_CLOUD_DEVELOPMENT`.
2. Right-click on the interface `I_BankTP` and select **Generate ABAP Repository Objects**.

   ![generator wizard](002-start-generator.png)

### Configure the generated artifacts

Continue with the next step...
```

Rules of thumb:

- One H3 per step. Avoid H4/H5 inside a step — they don't render as nested navigation.
- Step titles become the table of contents on the right of the rendered page.
- Step content is plain Markdown: lists, code fences, images, links, bold/italic.
- Inline HTML is escaped for safety. Stick to Markdown.

### 3.4 Images

Place images alongside the Markdown file in a folder named after the slug:

```text
abap-cloud-ui-from-interface.md
abap-cloud-ui-from-interface/
  001-find-interface.png
  002-start-generator.png
```

Reference them with **relative paths**:

```markdown
![interface](001-find-interface.png)
```

The platform automatically resolves these to `raw.githubusercontent.com` URLs at build time. Do not hardcode `https://github.com/...` URLs.

### 3.5 Option blocks

When a step has variants (e.g. JSON vs XML, Java vs Node), wrap each variant in an `OPTION` block:

```markdown
[OPTION BEGIN [JSON]]
...content for the JSON path...
[OPTION END]

[OPTION BEGIN [XML]]
...content for the XML path...
[OPTION END]
```

The platform renders these as tabs.

### 3.6 Code blocks

Use fenced code blocks with a language tag. Supported languages include `abap`, `js`, `ts`, `java`, `cds`, `sql`, `bash`, `yaml`, `json`, `xml`, `html`, `css`. CDS code uses dedicated highlighting (see `npm run build:highlight`).

```markdown
\`\`\`cds
entity Books : managed {
  key ID : Integer;
  title  : localized String(111);
}
\`\`\`
```

---

## 4. The author workflow today

```text
1. Fork or branch in sap-tutorials/<repo>
2. Add or edit a .md file under tutorials/
3. Commit any new images in the slug-named folder
4. Open a PR against main
5. PR review + merge (current review is informal — see §11)
6. Push to main → repo dispatch event → tutorials-poc CI
7. CI re-fetches your tutorial, rebuilds Hugo, publishes to HANA
8. Live at developers.sap.com/tutorials/<your-slug> within a few minutes
```

The notification step (6) is wired by adding a small workflow file to your tutorial repo — see [tutorial-repo-dispatch.yml](../tutorial-repo-dispatch.yml). Org admins typically handle this once per repo.

---

## 5. Local preview

To see your tutorial render exactly the way it will on production:

```bash
git clone https://github.com/sap-tutorials/tutorials-poc.git
cd tutorials-poc
npm install
npm run fetch-tutorials      # Pulls every tutorial from the org (cached after first run)
npm run dev                  # Hugo dev server at http://localhost:1313
```

Open `http://localhost:1313/tutorials/<your-slug>` to see your page.

To force a re-fetch of just-merged content, delete `.tutorial-cache/<your-slug>.sha` and re-run `npm run fetch-tutorials`. To force a full re-fetch, delete the entire `.tutorial-cache/` directory.

A `GITHUB_TOKEN` environment variable with `repo:read` scope is recommended; without it you may hit GitHub rate limits.

---

## 5.1 Previewing on the QA channel

The QA channel is a deployed author-preview environment separate from production. It renders content sourced exclusively from `*-Contribution` repos at `/tutorials-qa/*`, gated by the `Tutorial.Author` BTP scope.

Key points:

- **What it shows** — only content from your `<repo>-Contribution` repo (the private companion that holds quiz rules and draft tutorial content). It is not a copy of the production channel.
- **Access requirement** — you must hold the `Tutorial.Author` role collection in the BTP subaccount. Ask a Center Admin ([center-admin.md](center-admin.md)) to assign it.
- **Setup** — the one-time infrastructure setup (CI secrets, dispatch-token distribution, HDI binding, role-collection creation) is documented in [../qa-channel-bootstrap.md](../qa-channel-bootstrap.md). You do not need to repeat this; it is done once per environment.
- **Local dev server** — your local `npm run dev` does **not** use any QA flag. The QA flag (`hugo.qa.toml`) only applies to the deployed QA build. Running locally is always sufficient for layout and step rendering checks.
- **Triggering a QA rebuild** — push a change to the `*-Contribution` repo. The same repo-dispatch mechanism used for production fires a QA-specific CI workflow that fetches from `-Contribution` repos only, builds with the QA Hugo config, and publishes to the QA HANA instance.
- **URL pattern** — `https://<approuter>/tutorials-qa/<your-slug>` (requires `Tutorial.Author` scope; access is denied to unauthenticated users).

---

## 6. Pre-submit checklist

Run through this before opening your PR:

- [ ] Frontmatter is valid YAML (no tab characters, no missing quotes around tags with `:`).
- [ ] `parser: v2` is set.
- [ ] `primary_tag`, `tags`, `time`, and the H1 title are present.
- [ ] Tutorial has a `<!-- description -->` line right after the H1.
- [ ] Every step is an `### H3`. No H1/H2 inside the step body.
- [ ] All images referenced in the Markdown exist in the slug-named folder.
- [ ] Image paths are relative, not absolute GitHub URLs.
- [ ] Code fences have a language tag.
- [ ] Inline HTML is avoided (or limited to allowed tags only).
- [ ] If you used `OPTION` blocks, each `BEGIN` has a matching `END`.
- [ ] Tutorial renders cleanly in `npm run dev` with no warnings.

---

## 7. What happens after merge

| Step | Where | Duration |
|------|-------|----------|
| GitHub Action sends repo dispatch | Your tutorial repo | seconds |
| `tutorials-poc` CI checks out, fetches all tutorials (cached) | GitHub Actions runner | ~3 s cached / ~2 min cold |
| Hugo rebuilds the static site | Runner | 5–10 s |
| Delta publish: only changed slugs upload to HANA | CAP backend | 2–4 s |
| LRU cache invalidates; next request serves new content | Production | immediate |

Total: **typically under a minute** for incremental edits, a few minutes for a full rebuild. See [build.md](../developers/architecture/build.md) for details.

If the build fails, the dispatch run will be red in the `tutorials-poc` GitHub Actions tab. Common causes:

- Bad YAML in frontmatter
- Missing image referenced from Markdown
- Unbalanced `OPTION` blocks or HTML tags
- Slug collision with an existing tutorial

---

## 8. Updating and rolling back

### Quick edits

Push a change to `main` of the source repo. The pipeline picks it up automatically — no manual step.

### Rollback

Production content is versioned. If a published change is broken, ask a Center Admin to roll back — see [center-admin.md § Content rollback](center-admin.md). Rollback reverts the manifest pointer; you still need to follow up with a corrective PR.

---

## 9. (Reserved)

_This section number is reserved for future use. See §11 for known gaps._

---

## 10. Where to ask for help

| Question type | Where |
|---------------|-------|
| "Is my Markdown structured correctly?" | Open a draft PR; a [repo group owner](repo-group-owners.md) can review a draft PR and flag issues |
| "Why didn't my change appear on production?" | Check the `tutorials-poc` GitHub Actions runs; look for the failed dispatch |
| "How do I add a new tag / category?" | See [Center Admin](center-admin.md) § "Import a new tag" — taxonomy is centrally managed |
| "I need a preview before merging" | Run locally per §5, or request QA channel access (§5.1) — see [../qa-channel-bootstrap.md](../qa-channel-bootstrap.md) (Tutorial.Author scope required) |
| Anything else | Platform team channel (internal) |

---

## 11. Known gaps and near-term improvements

These items are tracked in [../TODO.md](../TODO.md) and are listed here so authors know what to expect — and what *not* to expect — from the current workflow.

| Gap | Current state | Tracked in |
|-----|---------------|------------|
| Editorial review gate | Informal PR review in source repo; no formal Author QA lane | [../TODO.md](../TODO.md) §21 "System QA vs. Author QA" |
| Approval / sign-off workflow | None — merge equals publish; no reviewer roles | [../TODO.md](../TODO.md) §21 |
| PR preview deploys | None — preview requires local clone (§5) or QA channel (§5.1) | [../TODO.md](../TODO.md) §21 "PR preview URL" |
| VS Code authoring extension | None — live preview, frontmatter validation, link checking are planned | [../TODO.md](../TODO.md) §21 "VS Code Extension (esp. Preview)" |
| Reporting / analytics for authors | Available to platform admins only; author/management views not yet published | [../TODO.md](../TODO.md) §21 |
| Tag taxonomy reference | Not yet author-facing; copy tags from a similar existing tutorial for now | [../TODO.md](../TODO.md) §21 |
| Tag bulk import | Manual via Center Admin; CSV / API import planned | [../TODO.md](../TODO.md) §21 |
| Per-tutorial rollback | Whole content-set rollback only; per-slug rollback not yet available | [../TODO.md](../TODO.md) §21 |
| Precommit validation | Build errors land in `.tutorial-cache/errors.json`; author-facing `npm run validate-tutorials` partially in place but not published | [../TODO.md](../TODO.md) §21 |

If any of these items become a blocker for your work, mention it on the tracking issue rather than working around it.

---

## Reference: related docs

- [build.md](../developers/architecture/build.md) — the full technical pipeline (fetch → parse → Hugo → HANA)
- [../hugo-migration.md](../hugo-migration.md) — why Hugo, layout conventions
- [../tutorial-repo-dispatch.yml](../tutorial-repo-dispatch.yml) — the GitHub Action your repo needs in order to trigger rebuilds
- [../TODO.md §21 Future Work](../TODO.md) — open items relevant to authors
- [repo-group-owners.md](repo-group-owners.md) — for repo owners reviewing your PRs
- [center-admin.md](center-admin.md) — for taxonomy, tag onboarding, and rollback
- [../qa-channel-bootstrap.md](../qa-channel-bootstrap.md) — author-preview channel
