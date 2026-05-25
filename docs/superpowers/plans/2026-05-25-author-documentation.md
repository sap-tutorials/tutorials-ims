# Author and Operator Documentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the meta-tutorials run-book with a persona-organized operational manual under `docs/authors/`, plus a `docs/historic/` folder for decommissioned task mappings.

**Architecture:** Five markdown files under `docs/authors/` (one per persona plus a README index), one markdown file under a new `docs/historic/` folder, and a redirect stub replacing the existing `docs/author-instructions.md`. No code changes — pure documentation. Each persona file follows the source run-book's task template (heading, **Interval**, **Status**, **Purpose**, numbered steps, **Related**), augmented with a **Prerequisites** field for new-system access requirements.

**Tech Stack:** Markdown, GitHub-flavored. No build step; the `docs/` tree is not deployed (per CLAUDE.md). Verification is via `grep`/`Read` against the live codebase.

**Spec:** [docs/superpowers/specs/2026-05-25-author-documentation-design.md](../specs/2026-05-25-author-documentation-design.md)

**Source material:** `D:/projects/meta-tutorials/run-book/run-book.md` (read-only reference)

---

## Working conventions for every task in this plan

- **Verify before writing.** Whenever a task's content references the live system (admin UI app names, service `@path:` values, env vars, role-collection scopes, BTP cockpit URLs, CF app names), read the source-of-truth file before writing the doc claim. If verification contradicts the spec, trust the codebase, update the doc to match reality, and note the contradiction in the commit message.
- **Forbidden tokens.** No `docs/authors/` file may mention AEM, IMS, or CircleCI as live systems. The only place those names belong is `docs/historic/decommissioned-tasks.md`. After each write, run `grep -ni 'AEM\|IMS\|CircleCI' <file>` and confirm zero hits in `docs/authors/` files.
- **Task template.** Every task in `repo-group-owners.md`, `center-admin.md`, and `analytics-admin.md` uses this shape verbatim:
  ```markdown
  ### Task: <verb-led title>
  - **Interval:** <Daily / Weekly / As needed / As requested>
  - **Status:** Active
  - **Purpose and Objective:** <one sentence>
  - **Prerequisites:** <tools, access, env vars>

  1. <step>
  2. <step>

  **Related:** <links>
  ```
- **Cross-links.** Use relative paths inside `docs/authors/` (e.g., `[Center Admin](center-admin.md)`). Use `../historic/decommissioned-tasks.md` for the historic doc. Use `../<file>.md` for siblings of `docs/authors/`.
- **Commit cadence.** One commit per file (see each task's commit step). Keep the working tree clean between tasks so a subagent can pick up cleanly.

---

## File structure

```
docs/
├── authors/
│   ├── README.md                Persona index, system landmarks, undocumented-task workflow
│   ├── writing-tutorials.md     Author-facing markdown guide (moved + refined from author-instructions.md)
│   ├── repo-group-owners.md     PR review, planning-outline review, retiring tutorials, owner list, dispatch wiring
│   ├── center-admin.md          Groups, missions, events, tags, pipeline ops, content rollback, access, support, backup
│   └── analytics-admin.md       AnalyticsService, /analytics-ui/, ad-hoc SQL, exports, key event metrics
├── historic/
│   └── decommissioned-tasks.md  Maps source run-book tasks no longer applicable (AEM/IMS/CircleCI) to replacement or "removed"
└── author-instructions.md       One-line redirect stub pointing at docs/authors/writing-tutorials.md
```

---

## Task 1: Set up isolated worktree and feature branch

**Files:** None (workflow only)

- [ ] **Step 1: Verify clean main**

```bash
git status
git rev-parse --abbrev-ref HEAD
```

Expected: working tree clean, branch is `main`.

- [ ] **Step 2: Create worktree on a fresh feature branch**

Per project memory `feedback_parallel_agents_worktrees.md`, doc work that may overlap with other in-flight work should be isolated.

```bash
git worktree add .worktrees/author-docs -b docs/authors-runbook origin/main
cd .worktrees/author-docs
```

Expected: new worktree at `.worktrees/author-docs`, branch `docs/authors-runbook` tracking `origin/main`.

- [ ] **Step 3: Verify the worktree is independent**

```bash
git status
git log -1 --oneline
```

Expected: clean tree, HEAD matches `origin/main`.

> All subsequent tasks run inside `.worktrees/author-docs`. Paths in this plan are relative to that worktree root.

---

## Task 2: Move and refine `docs/author-instructions.md` → `docs/authors/writing-tutorials.md`

**Files:**
- Read: [docs/author-instructions.md](../../author-instructions.md) (309 lines, current author guide)
- Create: `docs/authors/writing-tutorials.md`

This is a **move-and-edit** (the old path is replaced by a redirect stub in Task 3, not preserved as a duplicate).

- [ ] **Step 1: Create the `docs/authors/` directory and seed the new file from the existing one**

```bash
mkdir -p docs/authors
cp docs/author-instructions.md docs/authors/writing-tutorials.md
```

- [ ] **Step 2: Apply refinements (per spec § writing-tutorials.md)**

Edit `docs/authors/writing-tutorials.md`:

1. **Where to ask for help table (§10).** Update the rows so:
   - "Is my Markdown structured correctly?" stays as-is, but adds a link to `repo-group-owners.md` ("repo group owner can review a draft PR").
   - "How do I add a new tag / category?" now points at `center-admin.md` § "Import a new tag".
   - "I need a preview before merging" gains a sub-bullet linking to `qa-channel-bootstrap.md` (Tutorial.Author scope required).

2. **Rollback section (§8).** Replace the bash `curl POST /content/rollback` snippet with: "Production content is versioned. If a published change is broken, ask a Center Admin to roll back — see [center-admin.md § Content rollback](center-admin.md). Rollback reverts the manifest pointer; you still need to follow up with a corrective PR."

3. **TODO callouts.** Collapse all the inline `> **TODO (...)**:` blockquotes into a single trailing subsection `## 11. Known gaps and near-term improvements`. Each entry becomes a row in a table (`| Gap | Current state | Tracked in |`), with the third column linking to `../TODO.md`.

4. **QA channel preview.** Add a new subsection `## 5.1 Previewing on the QA channel`, ~15 lines, after §5 (Local preview). Content: the QA channel renders `*-Contribution` repo content at `/tutorials-qa/*` behind the `Tutorial.Author` BTP scope; setup is in [qa-channel-bootstrap.md](../qa-channel-bootstrap.md); your local Hugo dev server (`npm run dev`) does not need any QA flag — that's only for deployed previews.

5. **"Reference: related docs" trailing list.** Add three entries:
   - `[../authors/repo-group-owners.md](repo-group-owners.md)` — for repo owners reviewing your PRs
   - `[../authors/center-admin.md](center-admin.md)` — for taxonomy, tag onboarding, and rollback
   - `[../qa-channel-bootstrap.md](../qa-channel-bootstrap.md)` — author-preview channel

6. **Section numbering.** Keep existing §1–§10 numbering. Insert §5.1 (QA preview) and §11 (Known gaps) without renumbering the others.

7. **Path adjustments.** Any link of the form `[content-pipeline.md](content-pipeline.md)` becomes `[content-pipeline.md](../content-pipeline.md)`. Same for `hugo-migration.md`, `TODO.md`, `tutorial-repo-dispatch.yml`. Run a grep after editing to confirm no bare-filename links remain that point at peers of the old `docs/` location.

- [ ] **Step 3: Verify**

```bash
grep -ni 'AEM\|IMS\|CircleCI' docs/authors/writing-tutorials.md
```

Expected: no matches. (The author guide already avoids these terms; this is a sanity check.)

```bash
grep -nE '\]\([^)]+\)' docs/authors/writing-tutorials.md | grep -v '://' | grep -v '\.\./' | grep -v 'authors/' | grep -v '#'
```

Expected: no relative links pointing at peers of the old `docs/` location (would show as bare `name.md` references). If any appear, fix with `../` prefix.

- [ ] **Step 4: Commit**

```bash
git add docs/authors/writing-tutorials.md
git commit -m "docs(authors): move author-instructions.md to authors/writing-tutorials.md

Refined during the move: rollback redirected to center-admin, TODO
callouts consolidated into §11, QA preview subsection added, links
rewritten for the new docs/authors/ location."
```

---

## Task 3: Replace `docs/author-instructions.md` with a redirect stub

**Files:**
- Modify: `docs/author-instructions.md` (currently 309 lines → 5 lines)

- [ ] **Step 1: Overwrite with redirect stub**

Replace the entire file contents with:

```markdown
# Author Instructions (moved)

This document moved to [docs/authors/writing-tutorials.md](authors/writing-tutorials.md) as part of the run-book consolidation (2026-05-25).

The new structure adds operational manuals for repo group owners, center admins, and analytics admins under [docs/authors/](authors/README.md).
```

- [ ] **Step 2: Verify the link resolves**

```bash
ls docs/authors/writing-tutorials.md
```

Expected: file exists (created in Task 2).

- [ ] **Step 3: Commit**

```bash
git add docs/author-instructions.md
git commit -m "docs(authors): redirect author-instructions.md to authors/writing-tutorials.md"
```

---

## Task 4: Write `docs/authors/repo-group-owners.md`

**Files:**
- Create: `docs/authors/repo-group-owners.md`
- Read: `D:/projects/meta-tutorials/run-book/run-book.md` lines 230–256 (Repository Owners section + References)
- Read: [.github/workflows/rebuild-content.yml](../../../.github/workflows/rebuild-content.yml) — to confirm dispatch wiring details
- Read: [docs/tutorial-repo-dispatch.yml](../../tutorial-repo-dispatch.yml) — the dispatch workflow that owners drop into their repos
- Verify: `grep -n 'sap-tutorials/tutorial-checker' docs/` — confirm any other docs that reference the owner registry

- [ ] **Step 1: Verify facts before writing**

For each claim the doc will make, read the source:

```bash
# Confirm dispatch workflow exists at the path users will be told to copy
ls docs/tutorial-repo-dispatch.yml
```

Expected: file exists.

```bash
# Confirm rebuild-content workflow accepts a slug input (mentioned in spec)
grep -A2 'slug:' .github/workflows/rebuild-content.yml | head -20
```

Expected: workflow has an `inputs.slug` definition with description.

- [ ] **Step 2: Write the file**

Structure (~200 lines):

```markdown
# Repo Group Owners

Operational manual for owners of a tutorial repository in the [`sap-tutorials`](https://github.com/sap-tutorials) GitHub organization.

## Persona summary

- **Role:** Editorial and review authority for one or more tutorial repos under `sap-tutorials`.
- **Tools and access:**
  - GitHub admin on the repos you own
  - Optional: `Tutorial.Author` BTP role-collection scope for the QA author-preview channel — request from a [Center Admin](center-admin.md)
  - Local clone of [`tutorials-poc`](https://github.com/sap-tutorials/tutorials-poc) for reviewing renders before merge

## Canonical owner registry

`sap-tutorials/tutorial-checker/data/repository.owner.json` is the canonical list of repository group owners. It is a CircleCI-era artifact that survives in the new system because it is the only place the owner-name → SAP-email mapping is held; the [Center Admin](center-admin.md) cross-references it with the `Accounts` records in the admin UI.

If you change role, update this file (Task: Designate or change a repository group owner below).

---

### Task: Wire your repo for auto-publish
- **Interval:** Once per repo
- **Status:** Active
- **Purpose and Objective:** When a tutorial PR merges to `main`, trigger a rebuild of the published site so the change goes live within minutes.
- **Prerequisites:** GitHub admin on the source repo; a `DISPATCH_TOKEN` repo secret obtained from a [Center Admin](center-admin.md).

1. Copy [`docs/tutorial-repo-dispatch.yml`](../tutorial-repo-dispatch.yml) from `tutorials-poc` into your repo at `.github/workflows/tutorial-repo-dispatch.yml`.
2. In the source repo's Settings → Secrets and variables → Actions, add a secret named `DISPATCH_TOKEN` with the value supplied by the Center Admin.
3. Commit the workflow file on `main`.
4. Verify: push a small change (e.g., a typo fix) and watch the `tutorials-poc` repo's Actions tab for a triggered run within ~10 seconds.
5. If the run does not appear, check the source repo's Actions log for the dispatch step. The most common failure is a stale or missing `DISPATCH_TOKEN`.

**Related:** [Center Admin: Force-rebuild content](center-admin.md), [content-pipeline.md](../content-pipeline.md)

---

### Task: Review and merge pull requests
- **Interval:** Daily
- **Status:** Active
- **Purpose and Objective:** Catch frontmatter, structure, and metadata issues before they reach the build pipeline.
- **Prerequisites:** GitHub admin on the source repo; optional local `tutorials-poc` clone.

Review checklist (verify each PR before merge):

- [ ] Frontmatter is valid YAML (no tabs, quoted tags with colons).
- [ ] `parser: v2` is set.
- [ ] `primary_tag`, `tags`, `time` (integer minutes), and an H1 title are present.
- [ ] A `<!-- description -->` line follows the H1.
- [ ] Every step is an `### H3`. No H1/H2 inside step bodies.
- [ ] All images referenced from Markdown exist in the slug-named folder alongside the .md file.
- [ ] Image paths are relative, not absolute `https://github.com/...` URLs.
- [ ] Code fences carry a language tag.
- [ ] If `OPTION` blocks are used, every `BEGIN` has a matching `END`.
- [ ] The slug (filename without `.md`) does not collide with any existing tutorial across the org. If unsure, search the `sap-tutorials` org for the slug.

For larger or higher-risk changes, render locally:

```bash
cd tutorials-poc
npm run fetch-tutorials
npm run dev
```

Open `http://localhost:1313/tutorials/<slug>` and walk through the rendered tutorial.

Escalate to a [Center Admin](center-admin.md) if:
- Slug collision with another repo's tutorial.
- A new tag is needed that is not yet in the platform taxonomy.
- The author asks for a preview deploy beyond local Hugo or the QA channel.

**Related:** [writing-tutorials.md § 6 Pre-submit checklist](writing-tutorials.md), [Center Admin: Import a new tag](center-admin.md)

---

### Task: Triage repo issues
- **Interval:** Bi-weekly
- **Status:** Active
- **Purpose and Objective:** Keep the repo's open-issue queue moving; route platform issues to `tutorials-poc`.
- **Prerequisites:** GitHub triage permission on the source repo.

1. Sweep all open issues with no recent activity. Apply labels: `bug`, `enhancement`, `question`, `tutorial-needs-fix`, `platform`.
2. **Tutorial content issues** (a step is wrong, a screenshot is outdated, etc.) — assign to the author or a relevant reviewer.
3. **Platform issues** (rendering bug, build failure, infrastructure question) — re-file as a new issue in `sap-tutorials/tutorials-poc` and close the source-repo issue with a link.
4. **Stale questions** older than 30 days with no author response — close with a polite "please reopen if still relevant" message.

**Related:** [tutorials-poc Issues](https://github.com/sap-tutorials/tutorials-poc/issues)

---

### Task: Review tutorial planning outlines
- **Interval:** As requested by authors
- **Status:** Active
- **Purpose and Objective:** Catch structural issues before authoring effort is spent.
- **Prerequisites:** Familiarity with the tutorial navigator's group and mission structure.

When an author proposes a new tutorial or set of tutorials:

1. **Logical chunking.** Each tutorial should be 10–30 minutes. If the proposed scope is bigger, suggest splitting into a Group; if smaller, suggest folding into an existing tutorial as a step.
2. **Time estimates.** Reality-check the `time` value against the proposed step count. ~3–5 minutes per substantive step is typical.
3. **Group vs Mission.** A **Group** is a topical collection (e.g., "ABAP cloud development basics"). A **Mission** is a sequenced learning path with completion certificates (e.g., "Build your first SAP BTP app"). If the author wants completion tracking with a fixed order, recommend Mission.
4. **Tag check.** Verify the proposed `primary_tag` and `tags` are in the existing taxonomy. If new tags are needed, route the author to a [Center Admin](center-admin.md).
5. **Duplication check.** Search the navigator for similar existing tutorials. If significant overlap, suggest extending the existing tutorial instead.
6. Provide written feedback. Approve or request revisions before authoring begins.

**Related:** [Center Admin: Add / revise / delete a Mission](center-admin.md), [Center Admin: Add / revise / delete a Group](center-admin.md)

---

### Task: Retire a tutorial
- **Interval:** As needed
- **Status:** Active
- **Purpose and Objective:** Remove a tutorial that is no longer correct or no longer relevant.
- **Prerequisites:** GitHub write access to the source repo.

1. Open a PR in the source repo that deletes:
   - The tutorial's `.md` file under `tutorials/`.
   - The slug-named image folder alongside it.
   - Any `rules.vr` file with the same slug in the matching `-Contribution` repo (separate PR).
2. Mention "retires `<slug>`" in the PR description and link any successor tutorial.
3. Merge after review.
4. The publish pipeline marks the slug `RETIRED` in the next manifest. Hugo no longer builds the page.
5. **If the slug had production traffic** (check with the [Analytics Admin](analytics-admin.md) if in doubt), notify a [Center Admin](center-admin.md) so a redirect can be set up — otherwise readers hit a 404.

**Related:** [Center Admin: Retire a tutorial (admin side)](center-admin.md), [historic/decommissioned-tasks.md](../historic/decommissioned-tasks.md)

---

### Task: Migrate a tutorial to another repository
- **Interval:** As needed
- **Status:** Active
- **Purpose and Objective:** Move a tutorial when topical scope shifts (e.g., moves from "abap-core" to "abap-environment").
- **Prerequisites:** GitHub write access to both repos.

1. Coordinate with the destination repo's owner. Agree on the slug (it should not change — slug uniqueness is org-wide and link-stable).
2. In the destination repo, open a PR that adds the `.md` file and image folder.
3. In the source repo, open a separate PR that deletes them.
4. Merge the destination PR **first** so there is no window where the slug renders nothing.
5. The publish pipeline picks up both changes; manifest version increments once.

**Related:** [Retire a tutorial](#task-retire-a-tutorial)

---

### Task: Designate or change a repository group owner
- **Interval:** When work assignments change
- **Status:** Active
- **Purpose and Objective:** Keep the canonical owner registry current.
- **Prerequisites:** GitHub write access to `sap-tutorials/tutorial-checker`.

1. Open a PR against `sap-tutorials/tutorial-checker` that updates `data/repository.owner.json`. The top-level keys are repo group names (e.g., `"Tutorials"`); the value is `{ "name": "<github-handle>", "email": "<sap-email>" }`.
2. After merge, notify a [Center Admin](center-admin.md) so they can update the `Accounts` records in the admin UI.
3. The new owner needs GitHub admin on the affected repos — the existing owner or a Center Admin grants this.

**Related:** [Center Admin: Maintain the repo group owner list](center-admin.md)

---

### Task: Office hours and author support intake
- **Interval:** As needed
- **Status:** Active
- **Purpose and Objective:** First-line support for authors of repos you own.
- **Prerequisites:** None.

Handle locally:
- "How do I structure a step?" / "Why doesn't my image render?" — point at [writing-tutorials.md](writing-tutorials.md).
- "My PR was rejected by the linter" — review the validation error in the PR check.
- "Can I add a quiz?" — direct to the `*-Contribution` repo for `rules.vr`.

Forward to a [Center Admin](center-admin.md):
- Tag taxonomy questions or new-tag requests.
- BTP scope or access questions.
- Anything involving the published catalog (groups, missions, redirects).

**Related:** [Center Admin: Handle author support requests](center-admin.md)
```

- [ ] **Step 3: Verify**

```bash
grep -ni 'AEM\|IMS\|CircleCI' docs/authors/repo-group-owners.md | grep -v 'CircleCI-era artifact'
```

Expected: no matches except the one allowed mention in the "Canonical owner registry" paragraph (the historical context note).

```bash
# Verify all relative links resolve
for link in $(grep -oE '\]\([^)]+\)' docs/authors/repo-group-owners.md | grep -v '://' | sed 's/](//;s/)$//' | grep -v '^#'); do
  base=$(echo "$link" | sed 's/#.*//')
  if [ -n "$base" ] && [ ! -e "docs/authors/$base" ] && [ ! -e "docs/$base" ] && [ ! -e "$base" ]; then
    echo "BROKEN: $link"
  fi
done
```

Expected: links to peers in `docs/authors/` (which don't exist yet) will appear as BROKEN. Note them as forward references — they'll resolve as later tasks land. Links to `../*` files outside `docs/authors/` should resolve.

- [ ] **Step 4: Commit**

```bash
git add docs/authors/repo-group-owners.md
git commit -m "docs(authors): add repo group owners run-book"
```

---

## Task 5: Write `docs/authors/center-admin.md`

**Files:**
- Create: `docs/authors/center-admin.md`
- Read: `D:/projects/meta-tutorials/run-book/run-book.md` lines 11–227 (admin section)
- Read: [app/admin-shell/](../../../app/admin-shell/) — admin UI structure
- Read: [app/admin/](../../../app/admin/) — Fiori Elements component names
- Read: [srv/admin-service.cds](../../../srv/admin-service.cds) — confirm AdminService `@path:`
- Read: [xs-security.json](../../../xs-security.json) — role-collection scopes
- Read: [srv/lib/content-store.js](../../../srv/lib/content-store.js) — confirm rollback endpoint shape
- Read: [.github/workflows/rebuild-content.yml](../../../.github/workflows/rebuild-content.yml) — confirm slug input
- Read: [CLAUDE.md](../../../CLAUDE.md) §Architecture, §Gotchas — for env vars and admin UI surface

This is the largest file (~450 lines). Verification is critical — almost every paragraph references a live system fact.

- [ ] **Step 1: Verify facts before writing**

```bash
# Admin UI app names
ls app/admin/
```

Expected: directories matching the spec list (events, missions, groups, accomplishments, prizes, tutorials, tags, operations, accounts, changelog).

```bash
# Service paths
grep -n '@path' srv/*.cds
```

Expected: confirm `AdminService @path: '/admin'`, `DeveloperService @path: '/api'`, `AnalyticsService @path: '/admin/analytics'`, `ExportsService @path: '/admin/exports'`.

```bash
# Role-collection scopes
grep -nE '"name":|"value":' xs-security.json | head -40
```

Expected: list of scopes including `Admin`, `Tutorial.Author`, `Tutorial.Analytics`, `DisplayApp`, and any others. Use the actual names in the doc, not memory.

```bash
# Content rollback endpoint
grep -n 'rollback' srv/lib/content-store.js srv/server.js | head
```

Expected: confirm `POST /content/rollback` is the active route and `CONTENT_API_KEY` is the auth header.

```bash
# Rebuild workflow
cat .github/workflows/rebuild-content.yml | head -40
```

Expected: confirm the workflow exists, that `slug` is an input, that it runs on `workflow_dispatch`.

```bash
# CF / BTP cockpit context
mcp__sap-devs-server__cf_target
mcp__sap-devs-server__btp_target
```

Use to capture the production CF API endpoint and BTP subaccount GUID for the BTP cockpit URL.

Record the verified facts in a scratch note (in your head or a temporary file — not committed) and use them in Step 2.

- [ ] **Step 2: Write the file**

Top-of-file structure:

```markdown
# Center Admin

Operational manual for the developer center administrator — the operator role responsible for the catalog (groups, missions, events), content publishing, taxonomy, BTP user access, and pipeline health for the tutorial system.

## Persona summary

- **Role:** Day-to-day operator of the tutorial platform after the AEM and IMS decommission.
- **Tools and access:**
  - BTP subaccount admin in `<subaccount-name-from-cf-target>`
  - CF Space Developer in the `prod` space
  - GitHub admin in the `sap-tutorials` organization (granted via SAP OSPO)
  - `Admin` role-collection scope on the deployed app (assigned in BTP cockpit)
  - `CONTENT_API_KEY` env var value (held by the Center Admin team; used for `POST /content/publish` and `POST /content/rollback`)
  - Local clone of `tutorials-poc` for emergency operations and rebuilds

## Layout of this guide

The tasks below are grouped by concern:

- [Content & catalog ops](#content--catalog-ops) — adding and revising the things authors and readers see
- [Pipeline & operations](#pipeline--operations) — keeping publishes flowing, recovering from incidents
- [Access & identity](#access--identity) — onboarding users, GDPR
- [Author support & coordination](#author-support--coordination) — keeping the author community moving

A short [Decommissioned tasks](../historic/decommissioned-tasks.md) appendix maps tasks from the AEM/IMS-era run-book to their replacements (or notes that they are gone).

---

## Content & catalog ops
```

Then write the 15 tasks in spec order. Each task uses the standard template. Concretely:

1. **Add / revise / delete a Group** — admin UI `/admin-ui/groups`, slug rules (carry forward the source's slug-prefix table for `btp`, `integration`, `abap`, `cap`, `kyma`, `ai`, `joule`, `build`), how `/build/catalog` reflects changes, the slug-population check from CLAUDE.md ("DEV Database Setup").
2. **Add / revise / delete a Mission** — admin UI `/admin-ui/missions`, completion-path setup (multiple paths per mission), slug rules, how missions surface on the navigator.
3. **Define an App Space event** — admin UI `/admin-ui/events`, theme variants (Joule / Sapphire / TechEd / default — verify against `app/display-app/` themes), QR code generation via `/api/qrcode`, switching the event display via `EventStreamService` WebSocket.
4. **Retire a tutorial (admin side)** — manifest-level retirement happens automatically when the source PR deletes the file (Task 5 in repo-group-owners.md). The admin's residual job is to set up a redirect via `/admin-ui/operations` if the slug had production traffic. Cross-link the author-side task.
5. **Import a new tag from the SAP taxonomy** — admin UI `/admin-ui/tags`, what the entry looks like (id, name, parent, taxonomy URL), how it surfaces to authors (next `npm run fetch-tutorials` reads the catalog feed).
6. **Force-rebuild content** — Actions tab → `rebuild-content.yml` → "Run workflow" → optionally fill `slug` for a single tutorial. Note that single-slug runs skip the `RepoCatalog` upload (per CLAUDE.md), so don't use them when group/mission metadata changed.
7. **Content rollback** — the `curl POST /content/rollback` snippet (moved here from the author guide), what it reverts (manifest pointer, not source markdown), and the follow-up corrective PR expectation. Include exact bash with `Authorization: Bearer $CONTENT_API_KEY`.

---

## Pipeline & operations

8. **Monitor the publish pipeline** — admin UI Pipeline Logs (with `cfLogsUrl` link per memory `project_cf_logs_url_shipped`), the `tutorials-poc` Actions tab, smoke tests. Note daily content GC at 03:00.
9. **Pipeline incident playbook** — table of common failure modes:
   | Symptom | Likely cause | First check | Fix |
   | --- | --- | --- | --- |
   | Author's PR merged but content not live | Dispatch token stale | Source repo's Actions tab | Rotate `DISPATCH_TOKEN` |
   | All publishes failing with HANA errors | LOB locator expiry pattern | `cfLogsUrl` for `tutorials-srv` | Check whether a recent change SELECTed BLOB + metadata in one CDS QL — restore raw `db.run()` |
   | Manifest stuck in `PUBLISHING` | Crashed mid-publish | `SELECT status FROM ContentManifest` | `POST /content/rollback` |
   | GitHub rate-limit during fetch | Too many cold builds without `GITHUB_TOKEN` | Actions log | Set `GITHUB_TOKEN` secret on `tutorials-poc` |
10. **Backup & recovery** — HANA Cloud automated backups (point-in-time recovery from BTP cockpit; retention window per the HANA Cloud plan). `ExportsService` (`/admin/exports`) for logical exports — list endpoints, what they cover. Restore-test cadence: quarterly. Replaces the source's "IMS Production Backup / Recovery" stubs.

---

## Access & identity

11. **Add an author / repo group owner / admin to the system** — for each scope (`Tutorial.Author`, `Admin`, `DisplayApp`, `Tutorial.Analytics`, plus any others verified in xs-security.json), step-by-step: BTP cockpit → users → search → assign role collection. Include the role-collection name verified against the deployed `xsuaa` instance.
12. **Anonymize a user (GDPR)** — admin UI Accounts app, what gets anonymized (name, email, account number) vs preserved (anonymized completion records for analytics), audit-log expectations (`SecurityEvent` emitted per CLAUDE.md § Audit Logging).

---

## Author support & coordination

13. **Handle author support requests** — intake channels (verify with team — placeholder text says "internal Slack and GitHub issues on tutorials-poc"), common questions (taxonomy, access, preview deploys), escalation paths.
14. **Maintain the repo group owner list** — `sap-tutorials/tutorial-checker/data/repository.owner.json` plus admin UI Accounts records; reconcile the two when an owner changes (cross-link to repo-group-owners.md Task: Designate or change).
15. **Conduct author office hours** — running them, suggested cadence (monthly), agenda template (catalog status, upcoming releases, author Q&A).

---

## See also

- [historic/decommissioned-tasks.md](../historic/decommissioned-tasks.md) — what tasks from the old AEM/IMS run-book have been replaced or removed
- [content-pipeline.md](../content-pipeline.md), [mta-deployment.md](../mta-deployment.md), [authentication-architecture.md](../authentication-architecture.md), [testing-endpoints.md](../testing-endpoints.md)
```

When writing each numbered task, populate the Prerequisites field with verified scope/env-var requirements. Do not invent BTP cockpit URLs — use the pattern observed via `mcp__sap-devs-server__btp_target`.

- [ ] **Step 3: Verify**

```bash
grep -ni 'AEM\|IMS\|CircleCI' docs/authors/center-admin.md
```

Expected: no matches. Center Admin doc is the strictest — old-system references must live exclusively in `historic/`.

```bash
# Confirm every admin-UI route mentioned actually exists
for route in groups missions events accomplishments prizes tutorials tags operations accounts changelog analytics; do
  if [ ! -d "app/admin/$route" ] && [ "$route" != "analytics" ]; then
    echo "Mentioned route does not exist: $route"
  fi
done
```

Expected: every route mentioned in the doc resolves to a directory in `app/admin/` (or `app/admin-shell/` for the shell itself, or `app/analytics-explorer/` for analytics — adjust per what's actually verified).

- [ ] **Step 4: Commit**

```bash
git add docs/authors/center-admin.md
git commit -m "docs(authors): add center admin run-book"
```

---

## Task 6: Write `docs/authors/analytics-admin.md`

**Files:**
- Create: `docs/authors/analytics-admin.md`
- Read: [srv/analytics-service.js](../../../srv/analytics-service.js) — confirm runSelectQuery shape
- Read: [srv/lib/analytics-sql-validator.cjs](../../../srv/lib/analytics-sql-validator.cjs) — confirm validator constraints
- Read: [app/analytics-explorer/](../../../app/analytics-explorer/) — UI surface
- Read: `srv/analytics-service.cds` (or whatever defines `AnalyticsService`) — confirm `@analytics.exposed` annotation usage
- Read: [srv/exports-service.cds](../../../srv/exports-service.cds) and [srv/exports-service.js](../../../srv/exports-service.js) — endpoint inventory

- [ ] **Step 1: Verify facts before writing**

```bash
grep -n '@analytics.exposed' srv/*.cds db/*.cds | head -20
```

Expected: list of entities/views exposed to analytics. The doc will name 2–3 starting points.

```bash
grep -n 'LIMIT' srv/lib/analytics-sql-validator.cjs srv/analytics-service.js | head
```

Expected: confirm `LIMIT 5001` wrap and the SELECT-only constraint.

```bash
ls app/analytics-explorer/src/
```

Expected: Vue 3 SPA structure with Entity tab and SQL tab components.

- [ ] **Step 2: Write the file (~150 lines)**

```markdown
# Analytics Admin

Operational manual for tutorial platform analytics — the operator role that explores user behavior, monitors live events, and exports data for downstream reporting.

## Persona summary

- **Role:** Read-only analyst of the tutorial system. Sees per-user completion data; never modifies content or accounts.
- **Tools and access:**
  - `Tutorial.Analytics` BTP role-collection scope (or `Admin` which includes it — confirm via [Center Admin](center-admin.md))
  - Web access to `/analytics-ui/` on the deployed app
  - `cf login` and Space Developer access in `prod` for any `cds bind` operations against HANA (rare — only for queries the SPA cannot handle)

---

### Task: Browse exposed entities
- **Interval:** As needed
- **Status:** Active
- **Purpose and Objective:** Discover what data is available without writing SQL.
- **Prerequisites:** `Tutorial.Analytics` scope.

1. Open `/analytics-ui/` on the deployed app.
2. Click the "Entities" tab.
3. The list is gated by the `@analytics.exposed` CDS annotation — only entities marked exposed appear. Common starting points:
   - `<verified-entity-1>` — <description>
   - `<verified-entity-2>` — <description>
   - `<verified-entity-3>` — <description>
4. Click an entity to see its columns and a paged sample.

**Related:** `srv/analytics-service.cds`

---

### Task: Run an ad-hoc SQL query
- **Interval:** As needed
- **Status:** Active
- **Purpose and Objective:** Answer a question that doesn't fit the entity browser.
- **Prerequisites:** `Tutorial.Analytics` scope. Familiarity with the schema (browse entities first).

1. Open `/analytics-ui/` and click the "SQL" tab.
2. Paste your query. Constraints (enforced by `srv/lib/analytics-sql-validator.cjs`):
   - SELECT only — no DDL, DML, or multi-statement.
   - Tables must be on the allowlist (the exposed entities plus a few read-only views).
   - Every query is automatically wrapped with `LIMIT 5001` — anything that would return more rows is truncated.
3. Run. Results render in a virtualized grid; export as CSV from the toolbar.
4. Save useful queries via the "Save" button (saved per-user, not globally).

**Related:** [analytics-sql-validator.cjs](../../srv/lib/analytics-sql-validator.cjs)

---

### Task: Export data via ExportsService
- **Interval:** As needed
- **Status:** Active
- **Purpose and Objective:** Pull bulk data out of the platform for downstream tooling (PowerBI, Excel, archival).
- **Prerequisites:** `Tutorial.Analytics` scope. For PII-bearing exports, also `Admin`.

The `ExportsService` at `/admin/exports` exposes:
- <verified-export-endpoint-1> — <description>
- <verified-export-endpoint-2> — <description>

GDPR considerations:
- Exports of `Users` and `UserMetaData` carry PII — see the audit-logging expectations in [center-admin.md § Anonymize a user](center-admin.md).
- Treat exported files as confidential; do not store on shared drives.

**Related:** [center-admin.md § Anonymize a user (GDPR)](center-admin.md)

---

### Task: Monitor a live event
- **Interval:** During an event
- **Status:** Active
- **Purpose and Objective:** Real-time view of activity at a developer event with a deployed App Space.
- **Prerequisites:** `Tutorial.Analytics` scope, optional `DisplayApp` scope to view the event display directly.

Watch (one query each, refreshed every 1–5 minutes via the SQL tab):

| Metric | What it tells you | Example query |
| --- | --- | --- |
| Active users in last 5 min | Foot traffic at the booth | `SELECT count(*) FROM ... WHERE lastSeen > ...` (verify entity name) |
| Completions per minute | Are tutorials too long / short / broken? | `SELECT ... FROM TaskRecords WHERE completedAt > now() - interval ...` |
| Prize claim rate | Reward funnel health | `SELECT count(*) FROM PrizeRecords WHERE status = 'CLAIMED' ...` |
| Error rate | Pipeline or content issue surfacing | check `tutorials-poc` Actions + admin UI Pipeline Logs |

The [DisplayService WebSocket](../testing-endpoints.md) (`/ws/display`) provides a live dashboard that complements ad-hoc queries.

**Related:** [DisplayService dashboards](../testing-endpoints.md), [center-admin.md § Pipeline incident playbook](center-admin.md)

---

## Known gaps

| Gap | Current state | Tracked in |
| --- | --- | --- |
| Author-facing PowerBI views | Available to platform admins only | [TODO.md §21](../TODO.md) |
| Streaming dashboards (other than DisplayService) | Not built | [TODO.md §21](../TODO.md) |

## See also

- [historic/decommissioned-tasks.md](../historic/decommissioned-tasks.md)
```

Replace each `<verified-...>` placeholder with the actual entity, endpoint, or column name read in Step 1.

- [ ] **Step 3: Verify**

```bash
grep -ni 'AEM\|IMS\|CircleCI' docs/authors/analytics-admin.md
```

Expected: no matches.

```bash
grep -n '<verified' docs/authors/analytics-admin.md
```

Expected: no matches. Every placeholder must be filled in before commit.

- [ ] **Step 4: Commit**

```bash
git add docs/authors/analytics-admin.md
git commit -m "docs(authors): add analytics admin run-book"
```

---

## Task 7: Write `docs/historic/decommissioned-tasks.md`

**Files:**
- Create: `docs/historic/` (directory)
- Create: `docs/historic/decommissioned-tasks.md`
- Read: `D:/projects/meta-tutorials/run-book/run-book.md` (full)

- [ ] **Step 1: Create directory**

```bash
mkdir -p docs/historic
```

- [ ] **Step 2: Write the file (~120 lines)**

```markdown
# Decommissioned Tasks

This document maps tasks from the historical `meta-tutorials` run-book that no longer apply to the new system to their replacement (or notes that the task is gone). It exists so people who knew the old workflows can find the new home.

This folder (`docs/historic/`) is intended to grow as other historical documents from the AEM/IMS era are consolidated. As of 2026-05-25, this is the only file.

## AEM-era tasks

| Old task | Status | Replacement |
| --- | --- | --- |
| Update Developer Center Home Page (AEM Quick Publish) | Removed | The landing page is now built by Hugo from `tutorials-poc` and deploys automatically on merge — no manual publish step. |
| AEM Tutorial Pipeline / Tutorial Import Admintool | Replaced | [GitHub Actions `rebuild-content.yml`](../../.github/workflows/rebuild-content.yml) plus the admin UI Pipeline Logs — see [center-admin.md § Monitor the publish pipeline](../authors/center-admin.md). |
| AEM Log Harvester (`bin/systemReport.this.html`) | Replaced | Cloud Foundry logs via the admin UI's `cfLogsUrl` link, or `cf logs <app>` directly. |
| AEM Tutorial Import plugin (tagAdmin / gitHubAdmin) | Replaced | Admin UI Tags app at `/admin-ui/tags` — see [center-admin.md § Import a new tag](../authors/center-admin.md). |
| AEM Group Admin (`Tools > Developers > Group Admin`) | Replaced | Admin UI Groups app at `/admin-ui/groups` — see [center-admin.md § Add / revise / delete a Group](../authors/center-admin.md). |
| AEM Sites Console redirect tree (`/etc/redirect`) | Replaced | Admin UI Operations app — see [center-admin.md § Retire a tutorial (admin side)](../authors/center-admin.md). |
| AEM author access (QA-Blue / Production) | Removed | No AEM in the new stack. The Author preview is the QA channel — see [qa-channel-bootstrap.md](../qa-channel-bootstrap.md). |

## IMS-era tasks

| Old task | Status | Replacement |
| --- | --- | --- |
| IMS Production Backup | Replaced | HANA Cloud automated backups via BTP cockpit (point-in-time recovery), plus logical exports via `ExportsService` — see [center-admin.md § Backup & recovery](../authors/center-admin.md). |
| IMS Production Recovery | Replaced | Same — HANA Cloud point-in-time recovery. |
| Add an Author to the IMS Application (BTP `IMS_Content_Author_dev` role) | Replaced | BTP role-collection assignment for `Tutorial.Author` (and other scopes) — see [center-admin.md § Add an author / repo group owner / admin](../authors/center-admin.md). |
| IMS Production URL (`https://imsprod-approuter.cfapps.us30.hana.ondemand.com/`) | Removed | The new endpoints are documented in [testing-endpoints.md](../testing-endpoints.md). |

## CircleCI-era tasks

| Old task | Status | Replacement |
| --- | --- | --- |
| Administer CircleCI (lint pipeline) | Replaced | The Sage VS Code extension provides equivalent linting at author time. The `tutorials-poc` test suite runs in CI via [GitHub Actions](../../.github/workflows/). |
| `tutorial-checker` repository (CircleCI lint script) | Partially retained | The lint script is no longer run, but `data/repository.owner.json` is still the canonical owner registry — see [repo-group-owners.md § Canonical owner registry](../authors/repo-group-owners.md). |

## Concept changes

| Old concept | What replaced it |
| --- | --- |
| AEM as the frontend for `developers.sap.com/tutorials` | Hugo static site behind an XSUAA-protected AppRouter, content stored in HANA BLOBs and served by CAP. |
| AEM editorial workflow ("Quick Publish") | GitHub PR merge → repo dispatch → `tutorials-poc` CI → Hugo rebuild → HANA upload (under one minute end-to-end). |
| IMS as the progress-tracking backend | CAP Node.js service (`srv/`) backed by HANA Cloud. |
| Repository Group Curator (separate persona in old run-book) | Collapsed into Repo Group Owner and Center Admin — the new system has no distinct curator role. |

## See also

- [authors/README.md](../authors/README.md) — current operational manual
- [authors/center-admin.md](../authors/center-admin.md) — successor for most decommissioned admin tasks
- [authors/repo-group-owners.md](../authors/repo-group-owners.md) — successor for editorial tasks
- [authors/analytics-admin.md](../authors/analytics-admin.md) — successor for tutorial analytics
```

- [ ] **Step 3: Verify**

```bash
# All forward references must resolve
for link in docs/authors/README.md docs/authors/center-admin.md docs/authors/repo-group-owners.md docs/authors/analytics-admin.md docs/developers/operations/qa-channel-bootstrap.md docs/developers/operations/testing-endpoints.md; do
  test -e "$link" || (echo "REFERENCED FILE MISSING: $link"; exit 1)
done
```

Expected: README.md will not yet exist (Task 8 creates it). Note as forward reference; will resolve.

- [ ] **Step 4: Commit**

```bash
git add docs/historic/decommissioned-tasks.md
git commit -m "docs(historic): add decommissioned-tasks mapping for AEM/IMS/CircleCI"
```

---

## Task 8: Write `docs/authors/README.md`

**Files:**
- Create: `docs/authors/README.md`
- Verify: peer files exist

This task runs **last** because the README indexes the others.

- [ ] **Step 1: Confirm peer files exist**

```bash
for f in docs/authors/writing-tutorials.md docs/authors/repo-group-owners.md docs/authors/center-admin.md docs/authors/analytics-admin.md docs/historic/decommissioned-tasks.md; do
  test -e "$f" && echo "OK: $f" || echo "MISSING: $f"
done
```

Expected: all OK.

- [ ] **Step 2: Write the file (~60 lines)**

```markdown
# Authors and Operators

This folder is the operational manual for everyone working with the SAP Developers tutorial system. It replaces the historical `meta-tutorials` run-book.

## Pick your persona

| If you are a... | Read | What you do |
| --- | --- | --- |
| **Tutorial author** writing markdown | [writing-tutorials.md](writing-tutorials.md) | Write, preview, and publish tutorials |
| **Repo group owner** in `sap-tutorials` | [repo-group-owners.md](repo-group-owners.md) | Review PRs, plan tutorials, manage your repos |
| **Center admin** running the platform | [center-admin.md](center-admin.md) | Catalog, taxonomy, pipeline, access, support |
| **Analytics admin** exploring usage | [analytics-admin.md](analytics-admin.md) | Run queries, monitor events, export data |

## System landmarks

- **Source repos** — [`sap-tutorials`](https://github.com/sap-tutorials) GitHub organization (one repo per topical group)
- **Platform repo** — [`sap-tutorials/tutorials-poc`](https://github.com/sap-tutorials/tutorials-poc) (this repo)
- **Admin UI** — `/admin-ui/` on the deployed app (XSUAA-gated, `Admin` scope)
- **Analytics UI** — `/analytics-ui/` on the deployed app (`Tutorial.Analytics` scope)
- **Public site** — `https://developers.sap.com/tutorials/<slug>`
- **HANA Cloud** — managed instance bound to the CAP `srv` app; backups via BTP cockpit
- **Cloud Foundry** — `dev` and `prod` spaces in the `tutorial-system` subaccount

## Adding a task that isn't here yet

If you find yourself doing something operationally important that isn't documented:

1. Decide which persona file it belongs in (or whether it's a historic mapping for `../historic/`).
2. Use the standard task template — heading with verb-led title, **Interval**, **Status**, **Purpose and Objective**, **Prerequisites**, numbered steps, **Related** links.
3. Open a PR against this folder.

## Tools that complement these docs

- [Sage VS Code extension](../sage-extension-migration.md) — author-time linting and preview, replaces the old CircleCI lint pipeline.
- [QA channel](../qa-channel-bootstrap.md) — author-preview for `*-Contribution` repo content (`Tutorial.Author` scope required).

## Deeper technical references

- [content-pipeline.md](../content-pipeline.md) — fetch → parse → Hugo → HANA in detail
- [mta-deployment.md](../mta-deployment.md) — how the MTA is structured and deployed
- [authentication-architecture.md](../authentication-architecture.md) — XSUAA, role collections, IAS
- [testing-endpoints.md](../testing-endpoints.md) — canonical endpoint reference for smoke testing

## Historic context

- [historic/decommissioned-tasks.md](../historic/decommissioned-tasks.md) — what the old AEM/IMS/CircleCI run-book covered and where each task lives now
```

- [ ] **Step 3: Verify**

```bash
grep -ni 'AEM\|IMS\|CircleCI' docs/authors/README.md
```

Expected: no matches. Old systems are referenced only by linking to `historic/decommissioned-tasks.md`.

- [ ] **Step 4: Commit**

```bash
git add docs/authors/README.md
git commit -m "docs(authors): add README index"
```

---

## Task 9: Final verification pass and PR

**Files:** all files in `docs/authors/` and `docs/historic/`

- [ ] **Step 1: Forbidden-token sweep**

```bash
grep -rni 'AEM\|IMS\|CircleCI' docs/authors/
```

Expected: zero matches. The only allowed mention of these terms in `docs/authors/` is the contextual line in `repo-group-owners.md` describing `repository.owner.json` as a CircleCI-era artifact — anything else is a bug.

```bash
grep -rni 'AEM\|IMS\|CircleCI' docs/historic/
```

Expected: many matches — that's the whole point of the historic doc.

- [ ] **Step 2: Cross-link sweep**

For each markdown file in `docs/authors/` and `docs/historic/`, verify every relative link resolves:

```bash
fd '\.md$' docs/authors docs/historic | while read f; do
  dir=$(dirname "$f")
  grep -oE '\]\(([^)]+)\)' "$f" | sed 's/](//;s/)$//' | while read link; do
    case "$link" in
      *://*) ;;  # external
      \#*) ;;    # in-page anchor
      *) target="${link%%#*}"
         if [ -n "$target" ] && [ ! -e "$dir/$target" ]; then
           echo "BROKEN in $f: $link"
         fi ;;
    esac
  done
done
```

Expected: zero "BROKEN" lines. Fix any that appear.

- [ ] **Step 3: Author redirect stub still works**

```bash
cat docs/author-instructions.md
```

Expected: 5-line redirect stub pointing at `authors/writing-tutorials.md`.

- [ ] **Step 4: Confirm CLAUDE.md references the old path are still functional**

```bash
grep -n 'author-instructions.md' CLAUDE.md
```

Expected: any references continue to resolve via the redirect stub. Update CLAUDE.md only if a reference is now misleading (rare — the redirect stub takes care of most cases). If updated, include in the same commit.

- [ ] **Step 5: Push and open PR**

Per project memory `feedback_pr_over_direct_merge.md`, default to opening a PR rather than merging directly.

```bash
git push -u origin docs/authors-runbook
gh pr create --title "docs(authors): consolidate run-book into per-persona docs" --body "$(cat <<'EOF'
## Summary
- Move `docs/author-instructions.md` to `docs/authors/writing-tutorials.md` and refine for the new file location
- Add `docs/authors/repo-group-owners.md`, `center-admin.md`, `analytics-admin.md`, and `README.md`
- Add `docs/historic/decommissioned-tasks.md` mapping AEM/IMS/CircleCI tasks to their replacements
- Replace `docs/author-instructions.md` with a one-line redirect stub

Replaces the meta-tutorials run-book. Spec: docs/superpowers/specs/2026-05-25-author-documentation-design.md.

## Test plan
- [ ] Reviewer reads each persona file; confirms tasks reflect the actual admin UI / CAP service surface
- [ ] Forbidden-token sweep: `grep -rni 'AEM\|IMS\|CircleCI' docs/authors/` returns no unexpected matches
- [ ] Cross-link sweep: every relative link in `docs/authors/` and `docs/historic/` resolves
- [ ] `docs/author-instructions.md` redirect stub renders correctly on GitHub
EOF
)"
```

Expected: PR created, URL printed.

- [ ] **Step 6: Surface contradictions to the user**

If any verification step in Tasks 4–6 turned up a contradiction with the spec (a service path differs, an admin UI app name was renamed, a scope was removed), call them out in a final message to Tom. The doc reflects reality; the spec is now stale on those points.

---

## Done criteria

- All five files in `docs/authors/` exist with content per spec.
- `docs/historic/decommissioned-tasks.md` exists.
- `docs/author-instructions.md` is a redirect stub.
- Every relative link inside `docs/authors/` and `docs/historic/` resolves.
- Zero unexpected references to AEM, IMS, or CircleCI in `docs/authors/`.
- PR opened against `main` for Tom's review.
