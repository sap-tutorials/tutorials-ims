# Documentation Reorganization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reorganize `docs/` into persona folders (authors / end-users / developers / historic), extract architectural sections from the project root `README.md` into `developers/`, and author a small consumer-facing manual under `end-users/`. Set the documentation set up so it can serve as the source for a future VitePress + Fiori Fundamentals docs site.

**Architecture:** ~35 file moves via `git mv` (preserves history), 12 new files (6 persona/sub-folder index pages + 6 end-user content pages), 8 README sections extracted into separate developer-facing pages, 3 file merges (authentication primer+architecture, joule chat+architecture, content-pipeline+build), and ~150 cross-link path updates across `*.md`, `*.cds`, `*.js`, `*.ts`, `*.json`, `*.yaml`, `*.yml`. Project `README.md` shrinks from 1391 lines to ~300 lines. No code or test changes.

**Tech Stack:** Markdown (GitHub-flavored), `git mv`, `grep`/`sd` for cross-link rewrites, `gh pr create` for the final pull request. The `docs/` tree is not deployed (per CLAUDE.md); validation is via grep + Read + spot-checking links.

**Spec:** [docs/superpowers/specs/2026-05-25-docs-reorganization-design.md](../specs/2026-05-25-docs-reorganization-design.md)

---

## Working conventions for every task in this plan

- **Use `git mv`, never `mv`.** Every file relocation must preserve history. After every `git mv`, run `git status` and confirm the change shows as `renamed:`, not as `deleted:` + `new file:`.
- **Surgical edits only.** Moves are *not* a license to rewrite. The only edits to a moved file are: (a) fixing relative links that broke because the file's location changed, and (b) for merged files, stitching the two sources together. No prose rewrites, no reflowing, no restructuring.
- **Provenance line for new pages extracted from README.** Every new file created by extracting from project `README.md` opens with this exact line right after the H1 heading:
  ```markdown
  > Source: extracted from project README, 2026-05-25.
  ```
- **One-line pointer in trimmed README.** Each extracted section in `README.md` is replaced with one line pointing to the new home. Format:
  ```markdown
  ## <Section Title>

  See [docs/developers/<path>](docs/developers/<path>) for full details.
  ```
- **Cross-link sweep pattern.** After every task that moves or renames a file, run:
  ```bash
  grep -rn "<old-path>" --include="*.md" --include="*.cds" --include="*.js" \
    --include="*.ts" --include="*.json" --include="*.yaml" --include="*.yml" \
    --include="CLAUDE.md" --include="README.md"
  ```
  Update every match to the new path. Confirm zero hits before commit.
- **Anchor-link awareness.** When merging files (Tasks 9, 11, 19), other docs may link with anchors like `docs/joule-chat.md#tools`. After the merge, grep for `<old-filename>.md#` and rewrite anchors to point at the merged page's heading.
- **Commit cadence.** One commit per task. Keep the working tree clean between tasks so subagents can pick up independently. Commit messages follow the project's `docs(<scope>): ...` style.
- **No content changes for moved files.** A moved file's content stays byte-for-byte identical except for link path fixes. Spec compliance reviewer should reject any moved file whose word count differs from the source by more than is justified by link rewrites.
- **VitePress-friendly frontmatter for new pages only.** Every newly authored markdown file (not moved files) opens with minimal frontmatter:
  ```markdown
  ---
  title: <page title matching the H1>
  description: <one-line summary, ≤140 chars>
  ---
  ```
  Below the frontmatter comes the H1, then content. Moved pages do NOT get retroactive frontmatter — that's a separate, future concern.
- **README line numbers shift between tasks.** Tasks 6–16 each reference an absolute README line range *as it stands on `main`* (the pre-trim layout). After Task 6 replaces lines 311–396 with a 3-line pointer, every subsequent line range is wrong by ~80 lines, and the drift compounds with each extraction. Therefore: **always locate the source section by its H2 heading first**, then read from that heading to the next H2. The line numbers in tasks below are advisory anchors against the original file, useful for double-checking the heading match — they are not addresses to read from. Concretely, every "Read README.md lines X–Y" step in Tasks 6–16 should be executed as:
  ```bash
  grep -n '^## <Section Name>' README.md
  grep -n '^## ' README.md   # to find the next H2 boundary
  ```
  Then `Read` the file with offset/limit derived from the current line numbers, not from the table.

---

## File structure

```
docs/
├── README.md                          NEW persona index
├── improvements.md                    stays
├── TODO.md                            stays
├── pilot-status.md                    stays
├── authors/                           untouched (already complete from PR #53)
│   ├── README.md
│   ├── writing-tutorials.md
│   ├── repo-group-owners.md
│   ├── center-admin.md
│   ├── analytics-admin.md
│   └── tutorial-repo-dispatch.yml     MOVED here from docs/ root (Task 22)
├── end-users/                         NEW (6 files)
│   ├── README.md
│   ├── getting-started.md
│   ├── using-joule-chat.md
│   ├── progress-and-completions.md
│   ├── privacy-and-cookies.md
│   └── accessibility.md
├── developers/
│   ├── README.md                      NEW
│   ├── getting-started.md             NEW (extracted from README)
│   ├── architecture/
│   │   ├── authentication.md          MERGED (primer + architecture)
│   │   ├── runtime.md                 NEW (from README §Runtime)
│   │   ├── build.md                   MERGED (content-pipeline + README §Build §BuildPipeline)
│   │   ├── joule.md                   MERGED (joule-chat + README §Joule)
│   │   ├── cap-backend.md             NEW (from README §CAP Backend)
│   │   └── frontend-apps.md           NEW (from README §Frontend Apps)
│   ├── operations/
│   │   ├── mta-deployment.md          MOVED
│   │   ├── testing-endpoints.md       MOVED
│   │   ├── testing-guide.md           NEW (from README §Testing)
│   │   ├── production-ready.md        MOVED
│   │   ├── qa-channel-bootstrap.md    MOVED
│   │   ├── joule-chat-admin-settings.md MOVED
│   │   ├── deployment.md              NEW (from README §Deployment)
│   │   ├── github-app-setup.md        MOVED
│   │   └── ias-setup.md               MOVED + renamed (was ias-migration-setup.md)
│   └── reference/
│       ├── theme-variants.md          MOVED
│       ├── ai-consumption.md          MOVED
│       ├── cookie-and-storage-analysis.md MOVED
│       ├── sage-extension-migration.md MOVED
│       ├── external-integrations.md   NEW (from README §External Integrations)
│       └── design-decisions.md        NEW (from README §Key Design Decisions)
├── historic/
│   ├── README.md                      NEW
│   ├── decommissioned-tasks.md        already there
│   ├── aem-current-state.md           MOVED
│   ├── aem-gap-analysis.md            MOVED
│   ├── ims-api-reference.md           MOVED
│   ├── ims-uncovered-features.md      MOVED
│   ├── data-migration.md              NEW (from README §Data Migration)
│   ├── hugo-migration.md              MOVED
│   ├── vitepress-2x-upgrade-assessment.md MOVED
│   └── github-app-migration.md        MOVED
└── superpowers/                       untouched
```

**Deletions:** `docs/author-instructions.md` (5-line redirect stub, no remaining referrers after the previous reorg PR).

---

## Task 1: Set up isolated worktree and feature branch

**Files:** None (workflow only)

- [ ] **Step 1: Verify clean main**

```bash
git status
git branch --show-current
```
Expected: `nothing to commit, working tree clean` and branch `main`.

- [ ] **Step 2: Create worktree**

```bash
git worktree add .worktrees/docs-reorg -b docs/persona-reorg
cd .worktrees/docs-reorg
```
Expected: `Preparing worktree (new branch 'docs/persona-reorg')`.

- [ ] **Step 3: Verify worktree**

```bash
git branch --show-current
ls docs/
```
Expected: branch `docs/persona-reorg`, docs listing shows the same 26 files + 3 folders as main.

All subsequent tasks run inside `.worktrees/docs-reorg`. No other concurrent agent should touch this worktree.

---

## Task 2: Move 7 historic files into `docs/historic/`

**Files:**
- Move: `docs/aem-current-state.md` → `docs/historic/aem-current-state.md`
- Move: `docs/aem-gap-analysis.md` → `docs/historic/aem-gap-analysis.md`
- Move: `docs/ims-api-reference.md` → `docs/historic/ims-api-reference.md`
- Move: `docs/ims-uncovered-features.md` → `docs/historic/ims-uncovered-features.md`
- Move: `docs/hugo-migration.md` → `docs/historic/hugo-migration.md`
- Move: `docs/vitepress-2x-upgrade-assessment.md` → `docs/historic/vitepress-2x-upgrade-assessment.md`
- Move: `docs/github-app-migration.md` → `docs/historic/github-app-migration.md`

- [ ] **Step 1: Move all 7 files**

```bash
git mv docs/aem-current-state.md docs/historic/
git mv docs/aem-gap-analysis.md docs/historic/
git mv docs/ims-api-reference.md docs/historic/
git mv docs/ims-uncovered-features.md docs/historic/
git mv docs/hugo-migration.md docs/historic/
git mv docs/vitepress-2x-upgrade-assessment.md docs/historic/
git mv docs/github-app-migration.md docs/historic/
```

- [ ] **Step 2: Verify renames in git**

```bash
git status
```
Expected: 7 lines starting with `renamed: docs/<file>.md -> docs/historic/<file>.md`.

- [ ] **Step 3: Sweep for referrers and update**

```bash
for old in aem-current-state aem-gap-analysis ims-api-reference ims-uncovered-features hugo-migration vitepress-2x-upgrade-assessment github-app-migration; do
  echo "=== $old ==="
  grep -rn "docs/${old}\.md" --include="*.md" --include="*.cds" --include="*.js" \
    --include="*.ts" --include="*.json" --include="*.yaml" --include="*.yml" \
    --include="CLAUDE.md" --include="README.md"
done
```
Update every match. Old `docs/<file>.md` → new `docs/historic/<file>.md`. Inside `docs/historic/<file>.md` itself, sibling links of the form `[x](other.md)` may need to remain as-is (they still point to peers in the same folder); only fix paths that traverse out of the historic folder.

- [ ] **Step 4: Verify zero stale references**

Re-run the sweep from Step 3. Expected: zero hits outside the moved files themselves.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "docs(historic): move 7 AEM/IMS/migration files into historic/

Relocate aem-current-state, aem-gap-analysis, ims-api-reference,
ims-uncovered-features, hugo-migration, vitepress-2x-upgrade-assessment,
github-app-migration from docs/ root to docs/historic/. Update all
cross-references."
```

---

## Task 3: Write `docs/historic/README.md`

**Files:**
- Create: `docs/historic/README.md`

- [ ] **Step 1: Read peer files to confirm what's there**

```bash
ls docs/historic/
```
Expected: 8 files (the 7 just moved + `decommissioned-tasks.md`).

- [ ] **Step 2: Write the landing page**

Write `docs/historic/README.md` with this exact content:

```markdown
---
title: Historic — Decommissioned Context
description: AEM, Java IMS, and completed-migration documentation kept for historical reference. Does not reflect the running system.
---

# Historic — Decommissioned Context

This folder holds documentation that no longer reflects the running system but matters for understanding why current code looks the way it does. Read these files when investigating legacy decisions, debugging migrated data, or onboarding to areas that still carry historical baggage.

> **Not a runbook.** None of these files describe how the platform works today. For the current system, start at [docs/README.md](../README.md) and pick a persona.

## AEM era

Adobe Experience Manager hosted developers.sap.com tutorials before the cutover to this platform.

- [aem-current-state.md](aem-current-state.md) — snapshot of how AEM served developers.sap.com at decommission time
- [aem-gap-analysis.md](aem-gap-analysis.md) — functional gaps between AEM and the current platform

## IMS era

The Information Management System was the Java/Spring Boot backend that tracked tutorial progress before the CAP rewrite.

- [ims-api-reference.md](ims-api-reference.md) — IMS REST API surface
- [ims-uncovered-features.md](ims-uncovered-features.md) — IMS capabilities not yet replicated in the current platform
- [data-migration.md](data-migration.md) — cutover-era data migration scripts and procedures

## Completed migrations

Writeups of platform-level migrations that are now finished. Useful when the resulting code reads strangely without context.

- [hugo-migration.md](hugo-migration.md) — VitePress → Hugo migration
- [vitepress-2x-upgrade-assessment.md](vitepress-2x-upgrade-assessment.md) — assessment of upgrading the legacy `site/.vitepress/` install (note: not about the planned future docs-site VitePress, which is a separate concern)
- [github-app-migration.md](github-app-migration.md) — PAT → GitHub App auth migration writeup

## Task-level mapping

[decommissioned-tasks.md](decommissioned-tasks.md) — maps every task from the legacy meta-tutorials run-book to its replacement (or marks it as no longer applicable).
```

- [ ] **Step 3: Verify links resolve**

```bash
for f in aem-current-state.md aem-gap-analysis.md ims-api-reference.md ims-uncovered-features.md hugo-migration.md vitepress-2x-upgrade-assessment.md github-app-migration.md decommissioned-tasks.md; do
  test -f "docs/historic/$f" && echo "OK: $f" || echo "MISSING: $f"
done
```
Expected: 8 `OK:` lines. Note that `data-migration.md` is not yet created (Task 14 creates it); the link will resolve later.

- [ ] **Step 4: Commit**

```bash
git add docs/historic/README.md
git commit -m "docs(historic): add landing README for historic folder"
```

---

## Task 4: Create `developers/` skeleton and move 11 simple files

**Files:**
- Create: `docs/developers/architecture/`, `docs/developers/operations/`, `docs/developers/reference/` (directories)
- Move: 11 files (6 to `operations/`, 4 to `reference/`, 1 renamed)

- [ ] **Step 1: Create directories**

`git` doesn't track empty directories, but the next steps populate all three with `git mv` immediately, so the directories will be tracked once the moved files are committed.

```bash
mkdir -p docs/developers/architecture docs/developers/operations docs/developers/reference
```

- [ ] **Step 2: Move 6 files into `operations/`**

```bash
git mv docs/mta-deployment.md docs/developers/operations/mta-deployment.md
git mv docs/testing-endpoints.md docs/developers/operations/testing-endpoints.md
git mv docs/production-ready.md docs/developers/operations/production-ready.md
git mv docs/qa-channel-bootstrap.md docs/developers/operations/qa-channel-bootstrap.md
git mv docs/joule-chat-admin-settings.md docs/developers/operations/joule-chat-admin-settings.md
git mv docs/github-app-setup.md docs/developers/operations/github-app-setup.md
```

- [ ] **Step 3: Move + rename `ias-migration-setup.md` to `ias-setup.md`**

The file is a setup guide, not a migration writeup. Renaming for clarity.

```bash
git mv docs/ias-migration-setup.md docs/developers/operations/ias-setup.md
```

- [ ] **Step 4: Move 4 files into `reference/`**

```bash
git mv docs/theme-variants.md docs/developers/reference/theme-variants.md
git mv docs/ai-consumption.md docs/developers/reference/ai-consumption.md
git mv docs/cookie-and-storage-analysis.md docs/developers/reference/cookie-and-storage-analysis.md
git mv docs/sage-extension-migration.md docs/developers/reference/sage-extension-migration.md
```

- [ ] **Step 5: Verify renames in git**

```bash
git status
```
Expected: 11 `renamed:` lines.

- [ ] **Step 6: Commit (without referrer fixes — those come next)**

```bash
git add -A
git commit -m "docs(developers): move 11 operational and reference docs into developers/

Relocate mta-deployment, testing-endpoints, production-ready, qa-channel-bootstrap,
joule-chat-admin-settings, github-app-setup, ias-migration-setup (renamed to
ias-setup) into developers/operations/. Relocate theme-variants, ai-consumption,
cookie-and-storage-analysis, sage-extension-migration into developers/reference/.
Cross-references updated in next commit."
```

---

## Task 5: Fix cross-references for the 11 simple developer moves

**Files:**
- Modify: any file containing `docs/<moved-filename>.md`

- [ ] **Step 1: Sweep for stale references**

```bash
for old in mta-deployment testing-endpoints production-ready qa-channel-bootstrap joule-chat-admin-settings github-app-setup ias-migration-setup theme-variants ai-consumption cookie-and-storage-analysis sage-extension-migration; do
  echo "=== $old ==="
  grep -rn "docs/${old}\.md" --include="*.md" --include="*.cds" --include="*.js" \
    --include="*.ts" --include="*.json" --include="*.yaml" --include="*.yml" \
    --include="CLAUDE.md" --include="README.md" 2>/dev/null
done
```

- [ ] **Step 2: Update every match**

For each file with stale references, use `sd` (preferred) or `Edit`:

```bash
# Example for mta-deployment:
sd -F 'docs/mta-deployment.md' 'docs/developers/operations/mta-deployment.md' <file>
```

Note: `ias-migration-setup.md` becomes `developers/operations/ias-setup.md` (filename also changed).

Files known to contain references (from earlier grep): `CLAUDE.md`, `README.md`, `docs/TODO.md`, `docs/superpowers/specs/*.md`, `docs/cookie-and-storage-analysis.md` (now in `reference/`), `docs/sage-extension-migration.md` (now in `reference/`), `docs/authors/*.md`, `db/schema.cds`, `db/_content-shape.cds`, `mta.yaml`, `.deploy/mta.yaml`, `.github/workflows/rebuild-content.yml`, `approuter/server.js`, `test/a11y/*.js`, `scripts/build-admin-docs-index.ts`.

- [ ] **Step 3: Verify zero stale references**

Re-run the Step 1 sweep. Expected: zero hits outside the moved files themselves.

- [ ] **Step 4: Spot-check 3 referrer files**

Use the `Read` tool on `CLAUDE.md`, `README.md`, and `docs/TODO.md` near any updated lines. Verify the new paths are correct.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "docs(refs): update cross-references for developers/ moves"
```

---

## Task 6: Extract README §Runtime Architecture → `developers/architecture/runtime.md`

**Files:**
- Create: `docs/developers/architecture/runtime.md`
- Modify: `README.md` (replace §Runtime Architecture with one-line pointer)

- [ ] **Step 1: Read the source section**

Use `Read` on `README.md` lines 311–396 (`## Runtime Architecture` to just before `## Build Architecture`).

- [ ] **Step 2: Create `runtime.md` with extracted content**

Write `docs/developers/architecture/runtime.md` with:
- Frontmatter (`title: Runtime Architecture`, `description: How traffic flows once the platform is deployed — AppRouter, CAP services, HANA, WebSocket transport.`)
- H1 `# Runtime Architecture`
- Provenance line: `> Source: extracted from project README, 2026-05-25.`
- Then the verbatim content from README lines 313–396 (the body content under the heading; do not duplicate the H2).

- [ ] **Step 3: Verify line count**

```bash
wc -l docs/developers/architecture/runtime.md
```
Expected: ~85–90 lines (3 frontmatter + 1 H1 + 1 provenance + ~84 source lines).

- [ ] **Step 4: Replace README section with pointer**

Edit `README.md` lines 311–396, replacing them with:

```markdown
## Runtime Architecture

See [docs/developers/architecture/runtime.md](docs/developers/architecture/runtime.md) for full details.
```

- [ ] **Step 5: Commit**

```bash
git add docs/developers/architecture/runtime.md README.md
git commit -m "docs(developers): extract Runtime Architecture from README"
```

---

## Task 7: Extract README §Build Architecture + §Build Pipeline + merge `content-pipeline.md` → `developers/architecture/build.md`

**Files:**
- Create: `docs/developers/architecture/build.md`
- Delete: `docs/content-pipeline.md` (content folded into `build.md`)
- Modify: `README.md` (replace §Build Architecture and §Build Pipeline with one pointer each)

- [ ] **Step 1: Read all three sources**

```bash
wc -l docs/content-pipeline.md
```
Expected: 697 lines.

Use `Read` on `README.md` lines 397–521 (§Build Architecture) and 918–1084 (§Build Pipeline).

- [ ] **Step 2: Create `build.md`**

Write `docs/developers/architecture/build.md`:
- Frontmatter (`title: Build Architecture and Content Pipeline`, `description: How tutorial markdown becomes Hugo HTML and lands in HANA — fetch, parse, build, publish.`)
- H1 `# Build Architecture and Content Pipeline`
- Provenance line: `> Source: extracted from project README and merged with the former docs/content-pipeline.md, 2026-05-25.`
- Section 1 `## Build Architecture` — verbatim content from README lines 399–521
- Section 2 `## Build Pipeline` — verbatim content from README lines 920–1084
- Section 3 `## Detailed Content Pipeline` — verbatim content from `docs/content-pipeline.md` (drop its H1, keep H2 onwards)

- [ ] **Step 3: Delete `docs/content-pipeline.md`**

```bash
git rm docs/content-pipeline.md
```

- [ ] **Step 4: Replace both README sections with pointers**

Edit `README.md`:
- Lines 397–521: replace with `## Build Architecture\n\nSee [docs/developers/architecture/build.md](docs/developers/architecture/build.md) for full details.\n`
- Lines 918–1084: replace with `## Build Pipeline\n\nSee [docs/developers/architecture/build.md#build-pipeline](docs/developers/architecture/build.md#build-pipeline) for full details.\n`

- [ ] **Step 5: Sweep for `content-pipeline.md` referrers**

```bash
grep -rn "docs/content-pipeline\.md" --include="*.md" --include="*.cds" --include="*.js" \
  --include="*.ts" --include="*.json" --include="*.yaml" --include="*.yml" \
  --include="CLAUDE.md" --include="README.md"
```
Replace every match with `docs/developers/architecture/build.md`. If the original referrer pointed to a specific anchor (`#some-heading`), preserve the anchor — anchor links into the merged section will still resolve since headings are kept verbatim.

- [ ] **Step 6: Verify**

```bash
test ! -f docs/content-pipeline.md && echo "OK: content-pipeline.md deleted"
wc -l docs/developers/architecture/build.md
```
Expected: ~990 lines (124 + 167 + 697 + ~5 frontmatter/provenance).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "docs(developers): extract Build sections from README and fold in content-pipeline"
```

---

## Task 8: Extract README §CAP Backend → `developers/architecture/cap-backend.md`

**Files:**
- Create: `docs/developers/architecture/cap-backend.md`
- Modify: `README.md`

- [ ] **Step 1: Read source**

`Read` on `README.md` lines 655–917 (`## CAP Backend (srv/)` through end of section).

- [ ] **Step 2: Create `cap-backend.md`**

Write `docs/developers/architecture/cap-backend.md`:
- Frontmatter (`title: CAP Backend`, `description: Services, entities, jobs, and bootstrap details for the Node.js CAP service under srv/.`)
- H1 `# CAP Backend`
- Provenance line
- Verbatim content from README lines 657–917

- [ ] **Step 3: Replace README section with pointer**

Edit README lines 655–917 with the standard pointer format.

- [ ] **Step 4: Verify and commit**

```bash
wc -l docs/developers/architecture/cap-backend.md
git add -A
git commit -m "docs(developers): extract CAP Backend from README"
```

---

## Task 9: Extract README §Joule Architecture + merge `joule-chat.md` → `developers/architecture/joule.md`

**Files:**
- Create: `docs/developers/architecture/joule.md`
- Delete: `docs/joule-chat.md`
- Modify: `README.md`

- [ ] **Step 1: Read both sources**

`Read` on `docs/joule-chat.md` (388 lines) and `README.md` lines 522–654.

- [ ] **Step 2: Create `joule.md`**

Write `docs/developers/architecture/joule.md`:
- Frontmatter (`title: Joule Chat Architecture`, `description: In-page chat assistant — architecture, tools, RAG, embeddings, and reference.`)
- H1 `# Joule Chat Architecture`
- Provenance line: `> Source: extracted from project README and merged with the former docs/joule-chat.md, 2026-05-25.`
- Section 1 `## Architecture` — verbatim content from README lines 524–654
- Section 2 `## Reference` — verbatim content from `docs/joule-chat.md` (drop its H1, keep H2 onwards)

- [ ] **Step 3: Delete `joule-chat.md` and replace README section**

```bash
git rm docs/joule-chat.md
```
Edit README lines 522–654 with the standard pointer format.

- [ ] **Step 4: Sweep + anchor-link audit**

```bash
grep -rn "docs/joule-chat\.md" --include="*.md" --include="*.cds" --include="*.js" \
  --include="*.ts" --include="*.json" --include="*.yaml" --include="*.yml" \
  --include="CLAUDE.md" --include="README.md"
grep -rn "joule-chat\.md#" --include="*.md"
```
Update plain references to `docs/developers/architecture/joule.md`. For anchor references, verify the heading still exists in the merged file; if it does, just update the path.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "docs(developers): extract Joule Architecture from README and fold in joule-chat.md"
```

---

## Task 10: Extract README §Frontend Apps → `developers/architecture/frontend-apps.md`

**Files:**
- Create: `docs/developers/architecture/frontend-apps.md`
- Modify: `README.md`

- [ ] **Step 1: Read source**

`Read` on `README.md` lines 1085–1152.

- [ ] **Step 2: Create file**

Write `docs/developers/architecture/frontend-apps.md` with frontmatter, H1 `# Frontend Apps`, provenance line, and verbatim source content.

- [ ] **Step 3: Replace README section with pointer + commit**

```bash
git add -A
git commit -m "docs(developers): extract Frontend Apps from README"
```

---

## Task 11: Merge `authentication-primer.md` + `authentication-architecture.md` → `developers/architecture/authentication.md`

**Files:**
- Create: `docs/developers/architecture/authentication.md`
- Delete: `docs/authentication-primer.md`, `docs/authentication-architecture.md`

- [ ] **Step 1: Read both sources**

`Read` on `docs/authentication-primer.md` (375 lines) and `docs/authentication-architecture.md` (264 lines).

- [ ] **Step 2: Create merged file**

Write `docs/developers/architecture/authentication.md`:
- Frontmatter (`title: Authentication and Authorization`, `description: How user identity flows from browser to database — XSUAA, JWT, user resolution, scopes.`)
- H1 `# Authentication and Authorization`
- Provenance line: `> Source: merged from former authentication-primer.md and authentication-architecture.md, 2026-05-25.`
- Section 1 `## Primer` — verbatim content from `authentication-primer.md` (drop H1)
- Section 2 `## Architecture Reference` — verbatim content from `authentication-architecture.md` (drop H1)

- [ ] **Step 3: Delete the two source files**

```bash
git rm docs/authentication-primer.md docs/authentication-architecture.md
```

- [ ] **Step 4: Sweep + anchor audit**

```bash
grep -rn "docs/authentication-primer\.md\|docs/authentication-architecture\.md" \
  --include="*.md" --include="*.cds" --include="*.js" \
  --include="*.ts" --include="*.json" --include="*.yaml" --include="*.yml" \
  --include="CLAUDE.md" --include="README.md"
grep -rn "authentication-primer\.md#\|authentication-architecture\.md#" --include="*.md"
```
Update both paths to `docs/developers/architecture/authentication.md`. Audit any `#anchor` references — confirm the target heading is preserved in the merged file (it should be, since merge keeps H2 onwards verbatim).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "docs(developers): merge authentication primer and architecture into one page"
```

---

## Task 12: Extract README §Deployment → `developers/operations/deployment.md`

**Files:**
- Create: `docs/developers/operations/deployment.md`
- Modify: `README.md`

- [ ] **Step 1: Read, create, replace, commit**

`Read` README lines 1153–1256. Write `developers/operations/deployment.md` with frontmatter, H1 `# Deployment`, provenance, content. Replace README section with pointer.

```bash
git add -A
git commit -m "docs(developers): extract Deployment from README"
```

---

## Task 13: Extract README §Testing → `developers/operations/testing-guide.md`

**Files:**
- Create: `docs/developers/operations/testing-guide.md`
- Modify: `README.md`

- [ ] **Step 1: Read, create, replace, commit**

`Read` README lines 1285–1319. Write `developers/operations/testing-guide.md` with frontmatter, H1 `# Testing Guide`, provenance, content. Replace README section with pointer.

```bash
git add -A
git commit -m "docs(developers): extract Testing from README"
```

---

## Task 14: Extract README §Data Migration → `historic/data-migration.md`

**Files:**
- Create: `docs/historic/data-migration.md`
- Modify: `README.md`

- [ ] **Step 1: Read, create, replace, commit**

`Read` README lines 1257–1284. Write `docs/historic/data-migration.md` with frontmatter (`title: Data Migration (Historic)`, `description: Cutover-era data migration from Java IMS to the CAP backend. Migration is complete; kept for reference.`), H1 `# Data Migration (Historic)`, a callout `> **Status:** complete. This document describes the one-time data migration from Java IMS to the CAP backend during the 2026 cutover. Kept for historical reference.`, then provenance, then content. Replace README section with pointer to the historic location.

```bash
git add -A
git commit -m "docs(historic): extract Data Migration from README"
```

---

## Task 15: Extract README §External Integrations → `developers/reference/external-integrations.md`

**Files:**
- Create: `docs/developers/reference/external-integrations.md`
- Modify: `README.md`

- [ ] **Step 1: Read, create, replace, commit**

`Read` README lines 1320–1338. Write file with frontmatter, H1 `# External Integrations`, provenance, content. Replace README section.

```bash
git add -A
git commit -m "docs(developers): extract External Integrations from README"
```

---

## Task 16: Extract README §Key Design Decisions → `developers/reference/design-decisions.md`

**Files:**
- Create: `docs/developers/reference/design-decisions.md`
- Modify: `README.md`

- [ ] **Step 1: Read, create, replace, commit**

`Read` README lines 1339–1370. Write file with frontmatter (`title: Key Design Decisions`, `description: Why the platform looks the way it does — major architectural choices and trade-offs.`), H1 `# Key Design Decisions`, provenance, content. Replace README section.

```bash
git add -A
git commit -m "docs(developers): extract Key Design Decisions from README"
```

---

## Task 17: Trim README §Documentation block + final README cleanup

**Files:**
- Modify: `README.md` (replace §Documentation block with new index pointing to `docs/README.md`)
- Modify: `README.md` (condense Quick Start to 5 commands + link to `docs/developers/getting-started.md` — the deferred trim from previous tasks)

- [ ] **Step 1: Verify line count and section pointers**

```bash
wc -l README.md
grep -n '^## ' README.md
```
After Tasks 6–16, the README should already show all the extracted sections as one-line pointers. Confirm headers still in correct order.

- [ ] **Step 2: Replace §Documentation section**

Edit `README.md` §Documentation (currently around line 1371). Replace the multi-bullet list with:

```markdown
## Documentation

The full documentation set lives in [docs/](docs/) and is organized by persona:

- [End Users](docs/end-users/README.md) — finding tutorials, using Joule chat, progress and prizes
- [Authors](docs/authors/README.md) — writing tutorials, owning a repo group, running an event center
- [Developers](docs/developers/README.md) — architecture, operations, reference (you're probably here)
- [Historic](docs/historic/README.md) — AEM, IMS, completed migrations

Start at [docs/README.md](docs/README.md) for the full index.
```

- [ ] **Step 3: Condense Quick Start**

Edit `README.md` §Quick Start (locate via `grep -n '^## Quick Start' README.md`). Keep the 5 most useful commands (`npm install`, `npm run fetch-tutorials`, `cds watch`, `npm run dev`, `npm run build:all`) with one-line explanations. End the section with:

```markdown
For full setup including hybrid HANA development, environment variables, and the script reference, see [docs/developers/getting-started.md](docs/developers/getting-started.md).
```

The full Environment Variables block (currently §Environment Variables) is the source for Task 19's "Environment variables" section. **Before trimming, copy the full §Environment Variables block to a scratch file** inside the worktree (e.g. `.scratch/env-vars-from-readme.md`; create the `.scratch/` dir and add it to `.gitignore` for this branch if not already ignored — Windows-native worktree, so do NOT use `/tmp`) so Task 19 can paste it verbatim without recovering it from this commit's diff. Then leave the high-value 5 vars (`CAP_BASE_URL`, `GITHUB_TOKEN`, `CONTENT_API_KEY`, `SUBMISSION_SALT_SECRET`, `IMS_AUTH_TOKEN`) inline in README and link out for the rest:

```markdown
For the full list, see [docs/developers/getting-started.md#environment-variables](docs/developers/getting-started.md#environment-variables).
```

- [ ] **Step 4: Verify final line count**

```bash
wc -l README.md
```
Expected: 280–320 lines.

- [ ] **Step 5: Verify all in-README links resolve**

```bash
grep -oE 'docs/[a-zA-Z0-9_/.-]+\.(md|yml)' README.md | sort -u | while read link; do
  test -f "$link" && echo "OK: $link" || echo "MISSING: $link"
done
```
Expected: all `OK:` lines except for `docs/developers/getting-started.md`, `docs/developers/README.md`, `docs/end-users/README.md`, `docs/historic/README.md`, and `docs/README.md` — those are created in subsequent tasks.

- [ ] **Step 6: Commit**

```bash
git add README.md
git commit -m "docs(readme): trim README to ~300 lines, point at persona docs"
```

---

## Task 18: Write `docs/developers/README.md`

**Files:**
- Create: `docs/developers/README.md`

- [ ] **Step 1: Inventory the developers folder**

```bash
ls docs/developers/architecture/ docs/developers/operations/ docs/developers/reference/
```

- [ ] **Step 2: Write the landing page**

Write `docs/developers/README.md`:

```markdown
---
title: Developers
description: Building and maintaining the SAP Tutorial Platform — architecture, operations, and reference for platform engineers.
---

# Developers — Building and Maintaining the Platform

You're in the right place if you're a platform engineer working on the tutorials-poc codebase: the CAP backend, AppRouter, Hugo site, build pipeline, deployment, or anything else under `srv/`, `app/`, `hugo/`, `approuter/`, or `scripts/`.

## Start here

- **[Getting Started](getting-started.md)** — local dev setup, folder map, scripts reference, environment variables. Read this first if you're new.

## Architecture — how the system is built

How the platform fits together. Read these when you need to understand a subsystem before changing it.

- [Authentication](architecture/authentication.md) — IdP → JWT → user resolution
- [Runtime Architecture](architecture/runtime.md) — request flow, AppRouter, CAP
- [Build Architecture](architecture/build.md) — fetch → parse → Hugo → publish
- [Joule Architecture](architecture/joule.md) — chat, tools, RAG, embeddings
- [CAP Backend](architecture/cap-backend.md) — services, entities, jobs, bootstrap
- [Frontend Apps](architecture/frontend-apps.md) — admin shell, scanner, display

## Operations — how to run it

Runbooks and operational references. Read these when you need to deploy, test, or configure.

- [MTA Deployment](operations/mta-deployment.md) — full deploy procedure
- [Deployment Topology](operations/deployment.md) — what runs where
- [Testing Guide](operations/testing-guide.md) — unit, hybrid, smoke
- [Testing Endpoints](operations/testing-endpoints.md) — UI + API endpoint reference
- [Production Readiness](operations/production-ready.md) — services and entitlements
- [QA Channel Bootstrap](operations/qa-channel-bootstrap.md) — author preview channel
- [Joule Chat Admin Settings](operations/joule-chat-admin-settings.md) — RAG and grounding
- [GitHub App Setup](operations/github-app-setup.md) — sap-tutorials-builder App
- [IAS Setup](operations/ias-setup.md) — Option A/B authentication on a subaccount

## Reference — deep dives and design notes

Topics that aren't on a critical path but matter when you go looking.

- [Theme Variants](reference/theme-variants.md) — building event themes on Fiori Horizon
- [AI Consumption](reference/ai-consumption.md) — making developers.sap.com AI-friendly
- [Cookie & Storage Analysis](reference/cookie-and-storage-analysis.md) — auditor's reference
- [Sage Extension Migration](reference/sage-extension-migration.md) — VS Code extension coupling
- [External Integrations](reference/external-integrations.md) — what we integrate with
- [Key Design Decisions](reference/design-decisions.md) — why the platform looks the way it does
```

- [ ] **Step 3: Verify all linked files exist**

```bash
grep -oE '\([a-zA-Z0-9_/.-]+\.md\)' docs/developers/README.md | sed 's/[()]//g' | while read link; do
  test -f "docs/developers/$link" && echo "OK: $link" || echo "MISSING: $link"
done
```
Expected: all `OK:` lines.

- [ ] **Step 4: Commit**

```bash
git add docs/developers/README.md
git commit -m "docs(developers): add landing README"
```

---

## Task 19: Write `docs/developers/getting-started.md`

**Files:**
- Create: `docs/developers/getting-started.md`

Source material: project `README.md` Quick Start, Folder Map, Scripts, Environment Variables sections (the parts not kept in the trimmed README). Augment with hybrid-dev steps from CLAUDE.md (the "DEV Database Setup" section).

The Environment Variables block specifically comes from the scratch file Task 17 Step 3 wrote (`.scratch/env-vars-from-readme.md` inside the worktree) — paste that verbatim into the `## Environment variables` section here. If the scratch file is missing (e.g., this task is run in a fresh session), recover the content from the diff of Task 17's commit (`git show <task-17-sha> -- README.md`) before deleting it.

- [ ] **Step 1: Write the file**

Structure:
- Frontmatter (`title: Getting Started`, `description: Local dev setup for platform engineers — install, run, test, deploy.`)
- H1 `# Getting Started`
- `## Prerequisites` — Node.js >= 20, npm, optionally CF CLI for hybrid testing
- `## Install and run locally` — `npm install`, `npm run fetch-tutorials`, `cds watch`, `npm run dev`
- `## Folder map` — link back to project README's folder map (canonical home)
- `## Scripts reference` — full table copied from README §Scripts
- `## Environment variables` — full list copied from README §Environment Variables
- `## Hybrid HANA development` — derived from CLAUDE.md §"DEV Database Setup" (Slug Population) + memory `project_local_hybrid_dev.md` patterns
- `## Local deploy process` — derived from memory `project_local_deploy_process.md` (cd .deploy && mbt build && cf deploy)
- `## Testing` — link to `operations/testing-guide.md`
- `## Common pitfalls` — short list of the top 5 from CLAUDE.md gotchas (publish-content needs --force, ignore-scripts blocks native modules, etc.)

- [ ] **Step 2: Verify links**

Standard link-resolves check.

- [ ] **Step 3: Commit**

```bash
git add docs/developers/getting-started.md
git commit -m "docs(developers): add getting-started guide"
```

---

## Task 20: Write all 6 `docs/end-users/` files

**Files:**
- Create: `docs/end-users/README.md`
- Create: `docs/end-users/getting-started.md`
- Create: `docs/end-users/using-joule-chat.md`
- Create: `docs/end-users/progress-and-completions.md`
- Create: `docs/end-users/privacy-and-cookies.md`
- Create: `docs/end-users/accessibility.md`

This task creates 6 new files in one commit. Each is short (200–500 words). Tone is second-person, plain English, no SAP-internal jargon (no "XSUAA", "HDI", "CDS"), no code blocks.

- [ ] **Step 1: Write `docs/end-users/README.md`**

```markdown
---
title: End Users
description: For people learning SAP technologies via tutorials at developers.sap.com.
---

# End Users — Learning from Tutorials

If you're here to learn SAP technologies through tutorials at developers.sap.com, start here. This section is written for tutorial *consumers* — not authors, not platform engineers.

## What you'll find

- **[Getting Started](getting-started.md)** — what the site is, how to find tutorials, how to sign in
- **[Using Joule Chat](using-joule-chat.md)** — the in-page assistant on tutorial pages
- **[Progress and Completions](progress-and-completions.md)** — what counts, how event prizes work
- **[Privacy and Cookies](privacy-and-cookies.md)** — what we store and why
- **[Accessibility](accessibility.md)** — accessibility statement and how to report issues

## Need help?

- Ask in [SAP Community](https://community.sap.com) (tag the tutorial's product)
- Report a tutorial issue via the feedback widget on any tutorial page
- For account or sign-in problems, contact SAP support
```

- [ ] **Step 2: Write `docs/end-users/getting-started.md`**

About 300 words, sections: What is developers.sap.com, Finding tutorials, Signing in, The tutorial UI tour, Next steps. Verify references against memory `reference_sap_corporate_cmp.md` for the cookie banner. Use plain language: "your sign-in" not "XSUAA-protected route", "tutorial database" not "HANA HDI container".

- [ ] **Step 3: Write `docs/end-users/using-joule-chat.md`**

About 300 words. Sections: What Joule chat is (the floating button on tutorial pages), What it's good at (explains steps, suggests next tutorials, knows what step you're on), What it's not (not generic ChatGPT — scoped to tutorial corpus), Privacy (chat history isn't shared with other users). Source: simplify from `developers/architecture/joule.md` (created in Task 9).

- [ ] **Step 4: Write `docs/end-users/progress-and-completions.md`**

About 350 words. Sections: What "completion" means (validation quiz pass + reaching final step), My Completions page, Personalized recommendations, Event mode (prizes, QR scanner, account-number lookup). Concepts derived from `srv/lib/accomplishment-evaluator.js` and the scanner UI behavior — but explained without naming the file or the service.

- [ ] **Step 5: Write `docs/end-users/privacy-and-cookies.md`**

About 250 words. Sections: What we store and why (consumer-language summary), Cookie categories (Required / Functional / Advertising — per memory `reference_sap_corporate_cmp.md`), How to revoke consent / clear data / request anonymization, Link to SAP corporate privacy policy. Source-of-truth deep-dive lives at `developers/reference/cookie-and-storage-analysis.md` — link to it for "the technical version."

- [ ] **Step 6: Write `docs/end-users/accessibility.md`**

About 150 words. Sections: Our commitment, Standards we target (WCAG 2.1 AA — placeholder pending confirmation; mark with `> **Note:** target standards are placeholder pending project owner confirmation.`), Known issues (link to GitHub issues if any), How to report issues. Intentionally a stub — the page exists so the doc-site has the slot filled.

- [ ] **Step 7: Verify all 6 files**

```bash
ls docs/end-users/
wc -w docs/end-users/*.md
```
Expected: 6 files, each between 100 and 500 words.

- [ ] **Step 8: Verify zero engineering jargon**

```bash
grep -in 'XSUAA\|HDI\|CDS\|CAP\|HANA\|approuter\|JWT\|OAuth\|@requires\|@restrict' docs/end-users/*.md
```
Expected: zero hits. (One exception: linking to the developer-facing cookie-and-storage-analysis page is fine; the words shouldn't appear in body prose.)

- [ ] **Step 9: Commit**

```bash
git add docs/end-users/
git commit -m "docs(end-users): add 6-page consumer documentation"
```

---

## Task 21: Write `docs/README.md` (persona index)

**Files:**
- Create: `docs/README.md`

- [ ] **Step 1: Write the persona index**

```markdown
---
title: Documentation
description: Persona-organized documentation for the SAP Tutorial Platform — the system that hosts developers.sap.com.
---

# SAP Tutorial Platform — Documentation

This is the documentation set for the platform that hosts developers.sap.com. Pick the persona that matches what you're doing:

## I'm learning from tutorials

→ **[End Users](end-users/README.md)** — finding tutorials, using Joule chat, progress and completions, privacy, accessibility.

## I'm writing tutorials

→ **[Authors](authors/README.md)** — writing tutorials in markdown, owning a repo group, running an event center, viewing analytics.

## I'm building or operating the platform

→ **[Developers](developers/README.md)** — architecture, operations, reference. Start here if you work on the codebase.

## I'm researching how something used to work

→ **[Historic](historic/README.md)** — AEM, Java IMS, completed migrations, decommissioned tasks.

---

## Cross-cutting

These topics span personas:

- **[Improvements](improvements.md)** — forward-looking enhancement roadmap
- **[TODO](TODO.md)** — gap analysis and outstanding work
- **[Pilot Status](pilot-status.md)** — production scope lock as of 2026-05-24

## Working notes (internal)

- **[Superpowers](superpowers/)** — specs and plans for in-flight engineering work; not user-facing documentation
```

- [ ] **Step 2: Verify all linked files exist**

```bash
grep -oE '\([a-zA-Z0-9_/.-]+(README\.md|\.md|/)\)' docs/README.md | sed 's/[()]//g' | while read link; do
  target="docs/$link"
  test -e "$target" && echo "OK: $link" || echo "MISSING: $link"
done
```
Expected: all `OK:` lines.

- [ ] **Step 3: Commit**

```bash
git add docs/README.md
git commit -m "docs(root): add persona-index README"
```

---

## Task 22: Move `tutorial-repo-dispatch.yml` into `authors/` and delete `author-instructions.md`

**Files:**
- Move: `docs/tutorial-repo-dispatch.yml` → `docs/authors/tutorial-repo-dispatch.yml`
- Delete: `docs/author-instructions.md`

- [ ] **Step 1: Move the YAML template**

```bash
git mv docs/tutorial-repo-dispatch.yml docs/authors/tutorial-repo-dispatch.yml
```

- [ ] **Step 2: Sweep referrers**

```bash
grep -rn "tutorial-repo-dispatch\.yml" \
  --include="*.md" --include="*.yml" --include="*.yaml" \
  --include="CLAUDE.md" --include="README.md" \
  | grep -v '^docs/authors/tutorial-repo-dispatch\.yml:'
```
The trailing `grep -v` excludes the file's new location from the noise; only references *to* it from elsewhere need fixing. Known referrers (from earlier sweep):
- `docs/authors/repo-group-owners.md:27` — already uses `../tutorial-repo-dispatch.yml`; update to `tutorial-repo-dispatch.yml` (now sibling)
- `docs/authors/writing-tutorials.md:183, 315` — same fix
- `docs/TODO.md:81, 83` — update from `docs/tutorial-repo-dispatch.yml` to `docs/authors/tutorial-repo-dispatch.yml`
- `docs/superpowers/specs/2026-05-25-author-documentation-design.md:62` — historical artifact; update for accuracy
- `docs/superpowers/plans/2026-05-25-author-documentation.md:130, 199, 208, 251` — same; update

- [ ] **Step 3: Verify zero stale references**

Re-run the Step 2 sweep (excluding the moved file itself).

- [ ] **Step 4: Confirm `author-instructions.md` is safe to delete**

```bash
grep -rn "author-instructions\.md" \
  --include="*.md" --include="*.cds" --include="*.js" \
  --include="*.ts" --include="*.json" --include="*.yaml" --include="*.yml" \
  --include="CLAUDE.md" --include="README.md"
```
Expected: zero hits (CLAUDE.md was already updated to point at `authors/README.md` in PR #53; verify no other referrers remain).

If any referrers exist, fix them before deletion.

- [ ] **Step 5: Delete the stub**

```bash
git rm docs/author-instructions.md
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "docs: move tutorial-repo-dispatch.yml into authors/, delete author-instructions stub"
```

---

## Task 23: Update `CLAUDE.md` documentation index

**Files:**
- Modify: `CLAUDE.md` (Documentation section, around line 187 area)

- [ ] **Step 1: Read the current Documentation section**

`Read` `CLAUDE.md` to find the Documentation block (currently has bullets pointing to `docs/pilot-status.md`, `docs/testing-endpoints.md`, etc.).

- [ ] **Step 2: Replace with new persona-aware index**

The new section should look like:

```markdown
### Documentation (docs/)

Architecture and reference docs for developers (not deployed). Organized by persona:

- [docs/README.md](docs/README.md) — persona index, start here
- [docs/end-users/README.md](docs/end-users/README.md) — for tutorial consumers
- [docs/authors/README.md](docs/authors/README.md) — for tutorial authors and event operators
- [docs/developers/README.md](docs/developers/README.md) — for platform engineers (you)
- [docs/historic/README.md](docs/historic/README.md) — AEM, IMS, completed migrations

Most-referenced developer docs:

- [docs/developers/getting-started.md](docs/developers/getting-started.md) — local dev setup
- [docs/developers/operations/testing-endpoints.md](docs/developers/operations/testing-endpoints.md) — UI + API endpoint reference
- [docs/developers/operations/qa-channel-bootstrap.md](docs/developers/operations/qa-channel-bootstrap.md) — QA author-preview setup
- [docs/developers/architecture/build.md](docs/developers/architecture/build.md) — content pipeline
- [docs/developers/architecture/authentication.md](docs/developers/architecture/authentication.md) — auth flow
- [docs/developers/operations/mta-deployment.md](docs/developers/operations/mta-deployment.md) — deploy runbook
- [docs/developers/reference/theme-variants.md](docs/developers/reference/theme-variants.md) — building event themes
```

Preserve any other CLAUDE.md content; only rewrite the Documentation block.

- [ ] **Step 3: Verify links resolve**

```bash
grep -oE 'docs/[a-zA-Z0-9_/.-]+\.md' CLAUDE.md | sort -u | while read link; do
  test -f "$link" && echo "OK: $link" || echo "MISSING: $link"
done
```
Expected: all `OK:` lines.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(claude): update Documentation index for persona reorg"
```

---

## Task 24: Final cross-link sweep, anchor audit, and link walk

**Files:** Read-only verification, plus any final fixes

- [ ] **Step 1: Comprehensive sweep for stale `docs/<flat-path>` references**

```bash
for old in aem-current-state aem-gap-analysis ai-consumption authentication-architecture authentication-primer author-instructions content-pipeline cookie-and-storage-analysis github-app-migration github-app-setup hugo-migration ias-migration-setup improvements-OLD ims-api-reference ims-uncovered-features joule-chat joule-chat-admin-settings mta-deployment qa-channel-bootstrap production-ready sage-extension-migration testing-endpoints theme-variants vitepress-2x-upgrade-assessment; do
  hits=$(grep -rn "docs/${old}\.md" \
    --include="*.md" --include="*.cds" --include="*.js" \
    --include="*.ts" --include="*.json" --include="*.yaml" --include="*.yml" \
    --include="CLAUDE.md" --include="README.md" 2>/dev/null | grep -v 'superpowers/plans/2026-05-25-' | grep -v 'superpowers/specs/2026-05-25-')
  if [ -n "$hits" ]; then
    echo "=== $old ==="
    echo "$hits"
  fi
done
```
Excludes references in this plan and the spec from being flagged (they're the planning artifacts and naturally reference the old paths). Expected: zero output otherwise.

- [ ] **Step 2: Anchor audit for merged files**

```bash
grep -rn "joule-chat\.md#\|content-pipeline\.md#\|authentication-primer\.md#\|authentication-architecture\.md#" \
  --include="*.md" --include="*.cds" --include="*.js" \
  --include="*.ts" --include="*.json" --include="*.yaml" --include="*.yml"
```
Expected: zero output. Any hits indicate an anchor link not yet rewritten in earlier tasks.

- [ ] **Step 3: Walk every persona README link**

For each of `docs/README.md`, `docs/authors/README.md`, `docs/end-users/README.md`, `docs/developers/README.md`, `docs/historic/README.md`:

```bash
file=docs/README.md  # repeat for each persona README
grep -oE '\([a-zA-Z0-9_/.-]+\.(md|yml)\)' "$file" | sed 's/[()]//g' | while read link; do
  dir=$(dirname "$file")
  target="$dir/$link"
  # Resolve simple ../ patterns
  target=$(realpath -m --relative-to=. "$target" 2>/dev/null || echo "$target")
  test -e "$target" && echo "OK: $file → $link" || echo "MISSING: $file → $link"
done
```
Expected: all `OK:` lines.

- [ ] **Step 4: Visual scan of trimmed README**

```bash
wc -l README.md
grep -c '^See \[docs/' README.md
```
Expected: 280–320 lines, ~10 pointer lines (one per extracted section).

- [ ] **Step 5: If sweep found anything, fix and amend**

If Steps 1–3 surface stale references, fix each one. Use `Edit` or `sd` per the working conventions. Then:

```bash
git add -A
git commit -m "docs(refs): final cross-link cleanup"
```

If sweeps were clean, no commit is needed for this task.

---

## Task 25: Open the pull request

**Files:** None (workflow only)

- [ ] **Step 1: Final state check**

```bash
git status
git log main..HEAD --oneline
```
Expected: clean working tree, ~22–24 commits ahead of `main`.

- [ ] **Step 2: Push the branch**

```bash
git push -u origin docs/persona-reorg
```

- [ ] **Step 3: Open PR**

```bash
gh pr create --title "docs(personas): reorganize docs/ into authors/end-users/developers/historic" --body "$(cat <<'EOF'
## Summary
- Reorganized `docs/` root from 26 flat files into four persona folders: `authors/` (already existed), `end-users/` (new — 6 consumer-facing pages), `developers/` (new — architecture/operations/reference sub-folders), `historic/` (existing, expanded).
- Extracted ~1,000 lines of architectural content from project `README.md` into developer-facing pages; README shrunk from 1391 to ~300 lines.
- Authored small consumer manual under `end-users/` (no consumer-facing docs existed before).
- Merged 3 file pairs: authentication primer + architecture, joule chat + architecture, content-pipeline + build.
- Updated ~150 cross-references across `*.md`, `*.cds`, `*.js`, `*.ts`, `*.json`, `*.yaml`, `*.yml`.
- Folder structure picked to be VitePress + Fiori Fundamentals-friendly for the future docs site.

Spec: [docs/superpowers/specs/2026-05-25-docs-reorganization-design.md](docs/superpowers/specs/2026-05-25-docs-reorganization-design.md)

## Test plan
- [ ] Walk every link in `docs/README.md` and confirm it resolves
- [ ] Walk every link in each persona README and confirm it resolves
- [ ] Confirm `wc -l README.md` is between 280 and 320
- [ ] Confirm `grep -rn 'docs/aem-current-state.md'` (and other moved files) returns zero hits outside the moved files themselves
- [ ] Confirm `grep -in 'XSUAA\|HDI' docs/end-users/*.md` returns zero hits in body prose
- [ ] CI smoke tests pass (no code changes, but workflows touch some referenced paths)
EOF
)"
```

- [ ] **Step 4: Report PR URL**

The `gh pr create` command prints the PR URL. Report it back so Tom can review.

---

## Out of scope — deferred to follow-up work

- VitePress site bootstrap (theme, build pipeline, deploy)
- Adding frontmatter to *moved* files (only newly-authored files get frontmatter in this PR)
- Rewriting prose for clarity in moved files
- Adding the WCAG audit / accessibility statement substance (only the page slot is created)
- A "What's New" feed on `docs/end-users/`
- Cross-references in test files, scripts, and deploy descriptors that currently use absolute paths inside `docs/` are updated; those that link to *line numbers* in `README.md` will need separate verification (line numbers shift after the trim — only one such reference is known: `docs/superpowers/plans/2026-05-25-author-documentation.md:130` already references `docs/content-pipeline.md` patterns and is updated in Task 22)
