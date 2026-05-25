# Documentation Reorganization Design

**Date:** 2026-05-25
**Author:** Tom (with Claude as scribe)
**Status:** Design — pending implementation plan

## Goal

Reorganize the `docs/` directory into persona-aligned folders so the documentation set can serve as the source for a future VitePress + Fiori Fundamentals documentation site. Sort 26 root-level Markdown files plus extract architectural content from the project `README.md` into four persona folders: authors (already done), end-users (new), developers (new), and historic (existing, expanded). Author a small consumer-facing manual under `end-users/` since almost no consumer-facing documentation exists today.

## Out of scope

- Setting up the VitePress site itself (theme, build, deploy). This reorg picks paths that work with VitePress, but the site bootstrap is a separate piece of work.
- Rewriting the *content* of any moved file. Moves are surgical: `git mv` plus path-fix edits only. Content rewrites are deferred.
- Updating the `superpowers/` working-notes folder (specs, plans). That's internal process scratch, not user-facing documentation.
- Building per-page frontmatter for files we're only moving. New files get minimal VitePress-friendly frontmatter (`title`, `description`); moved files keep their existing headings.

## Final folder layout

```
docs/
├── README.md                          (NEW — persona index, doc-site landing)
├── improvements.md                    (stays — cross-cutting roadmap)
├── TODO.md                            (stays — cross-cutting backlog)
├── pilot-status.md                    (stays — cross-cutting status snapshot)
│
├── authors/                           (already done — untouched)
│   ├── README.md
│   ├── writing-tutorials.md
│   ├── repo-group-owners.md
│   ├── center-admin.md
│   ├── analytics-admin.md
│   └── tutorial-repo-dispatch.yml     (MOVED from docs/ root — referenced from authors only)
│
├── end-users/                         (NEW — 6 files)
│   ├── README.md
│   ├── getting-started.md
│   ├── using-joule-chat.md
│   ├── progress-and-completions.md
│   ├── privacy-and-cookies.md
│   └── accessibility.md
│
├── developers/                        (NEW)
│   ├── README.md
│   ├── getting-started.md             (NEW — Quick Start + Folder Map + Scripts + Env Vars
│   │                                   extracted from project README; expanded with hybrid steps)
│   ├── architecture/
│   │   ├── authentication.md          (MOVED + merged: authentication-architecture.md
│   │   │                               + authentication-primer.md → one consolidated page)
│   │   ├── runtime.md                 (NEW — extracted from README §Runtime Architecture)
│   │   ├── build.md                   (NEW — extracted from README §Build Architecture
│   │   │                               + content-pipeline.md merged in)
│   │   ├── joule.md                   (MOVED + merged: joule-chat.md + README §Joule Architecture)
│   │   ├── cap-backend.md             (NEW — extracted from README §CAP Backend (srv/))
│   │   └── frontend-apps.md           (NEW — extracted from README §Frontend Apps)
│   ├── operations/
│   │   ├── mta-deployment.md          (MOVED from docs/)
│   │   ├── testing-endpoints.md       (MOVED from docs/)
│   │   ├── testing-guide.md           (NEW — extracted from README §Testing)
│   │   ├── production-ready.md        (MOVED from docs/)
│   │   ├── qa-channel-bootstrap.md    (MOVED from docs/)
│   │   ├── joule-chat-admin-settings.md (MOVED from docs/)
│   │   ├── deployment.md              (NEW — extracted from README §Deployment)
│   │   ├── github-app-setup.md        (MOVED from docs/ — still actionable runbook)
│   │   └── ias-setup.md               (MOVED + renamed from ias-migration-setup.md)
│   └── reference/
│       ├── theme-variants.md          (MOVED from docs/)
│       ├── ai-consumption.md          (MOVED from docs/)
│       ├── cookie-and-storage-analysis.md (MOVED from docs/ — auditor reference)
│       ├── sage-extension-migration.md (MOVED from docs/ — coupling analysis)
│       ├── external-integrations.md   (NEW — extracted from README §External Integrations)
│       └── design-decisions.md        (NEW — extracted from README §Key Design Decisions)
│
├── historic/                          (existing + 8 additions)
│   ├── README.md                      (NEW — landing for historic context)
│   ├── decommissioned-tasks.md        (already there)
│   ├── aem-current-state.md           (MOVED)
│   ├── aem-gap-analysis.md            (MOVED)
│   ├── ims-api-reference.md           (MOVED)
│   ├── ims-uncovered-features.md      (MOVED)
│   ├── data-migration.md              (NEW — extracted from README §Data Migration)
│   ├── hugo-migration.md              (MOVED — migration is complete)
│   ├── vitepress-2x-upgrade-assessment.md (MOVED — assesses the legacy site/.vitepress install,
│   │                                   not the planned future docs-site VitePress)
│   └── github-app-migration.md        (MOVED — workflow merged; activation tracked elsewhere)
│
└── superpowers/                       (untouched — internal process artifacts)
```

**Deletions:**
- `docs/author-instructions.md` (5-line redirect stub; CLAUDE.md was already pointed to `authors/README.md` in the previous reorg PR, so the only remaining purpose is gone). Verify zero referrers via grep before deleting.

**Categorization nuances** (where I deviate from the simple "all migrations to historic" rule):
- `github-app-setup.md` and `ias-migration-setup.md`/`ias-setup.md` are *runbooks for current/future setup tasks*, not migration writeups. They live in `developers/operations/`.
- `github-app-migration.md` (the *writeup* describing the move from PAT to App) is genuinely historic and goes to `historic/`.
- `tutorial-repo-dispatch.yml` is a workflow template referenced only by author docs. It moves into `docs/authors/` so its referrers (`repo-group-owners.md`, `writing-tutorials.md`, `TODO.md`) get cleaner paths. The `.yml` extension means doc-site builds (markdown-only) won't render it as a page; it's a downloadable asset.
- `vitepress-2x-upgrade-assessment.md` goes to `historic/` even though Tom plans to use VitePress for the future docs site. The doc assesses upgrading the *legacy* `site/.vitepress/` install (called out in CLAUDE.md gotchas). The new docs-site VitePress is a separate concern; that doc would be misleading if read out of context.

## End-user content scope

Five new pages plus a landing README. Each is short (200–500 words) — orientation, not deep manuals. Tone: second-person, plain English, no SAP-internal jargon, no code. These pages will derive from existing engineering reference docs but in consumer-friendly language.

| Page | Source content |
|---|---|
| `README.md` | Persona landing — quick links to the five pages plus help/community pointer |
| `getting-started.md` | New content — site overview, finding tutorials, account sign-in (in user terms), tutorial UI tour |
| `using-joule-chat.md` | Derived from `joule-chat.md`, simplified to consumer language |
| `progress-and-completions.md` | Derived from `srv/lib/accomplishment-evaluator.js` concepts + scanner UI behaviour |
| `privacy-and-cookies.md` | Derived from `cookie-and-storage-analysis.md` (which stays in `developers/reference/` as the auditor's deep-dive). References the SAP corporate CMP categories per memory `reference_sap_corporate_cmp.md`. |
| `accessibility.md` | Stub — placeholder accessibility statement, target standards (WCAG 2.1 AA pending confirmation), how to report issues |

## Project README extraction

The project `README.md` shrinks from 1391 lines to ~300 lines. Eight architectural sections move into `docs/developers/` as separate pages.

| README section | Lines (approx.) | Lands at |
|---|---|---|
| §Runtime Architecture | 311–396 | `developers/architecture/runtime.md` |
| §Build Architecture | 397–521 | `developers/architecture/build.md` (merged with `content-pipeline.md`) |
| §Joule Architecture | 522–654 | `developers/architecture/joule.md` (merged with `joule-chat.md`) |
| §CAP Backend (srv/) | 655–917 | `developers/architecture/cap-backend.md` |
| §Build Pipeline | 918–1084 | merged into `developers/architecture/build.md` |
| §Frontend Apps | 1085–1152 | `developers/architecture/frontend-apps.md` |
| §Deployment | 1153–1256 | `developers/operations/deployment.md` |
| §Data Migration | 1257–1284 | `historic/data-migration.md` (cutover-era; complete) |
| §Testing | 1285–1319 | `developers/operations/testing-guide.md` |
| §External Integrations | 1320–1338 | `developers/reference/external-integrations.md` |
| §Key Design Decisions | 1339–1370 | `developers/reference/design-decisions.md` |
| §Documentation | 1371–1388 | replaced by single line pointing to `docs/README.md` |

**What stays in README** (~300 lines):

1. Project intro paragraph + production-system callout
2. Stack one-liner
3. Folder Map (the orientation map; first thing engineers want)
4. Quick Start condensed to 5 commands + link to `docs/developers/getting-started.md`
5. Scripts (operationally critical day-to-day reference)
6. Environment Variables (operationally critical)
7. Documentation index — replaces the old §Documentation block; links to `docs/README.md`
8. License

**Provenance and back-links:**
- Each extracted page opens with a single-line note: `> Source: extracted from project README, 2026-05-25.` Provides traceability without polluting the page.
- Each extracted README section is replaced with a one-line pointer: `> See [docs/developers/architecture/runtime.md](docs/developers/architecture/runtime.md) for the full runtime architecture.` — preserves discoverability for anyone scanning the README.

## Index pages

### `docs/README.md` — persona index (doc-site landing)

Four-persona table with one-paragraph intros, plus a cross-cutting section linking to `improvements.md`, `TODO.md`, `pilot-status.md`, plus a working-notes pointer to `superpowers/`. The full content is captured in the implementation plan; the structure is:

```
# SAP Tutorial Platform — Documentation
[Intro: pick the persona that matches what you're doing]

## I'm learning from tutorials → end-users/
## I'm writing tutorials → authors/
## I'm building or operating the platform → developers/
## I'm researching how something used to work → historic/

## Cross-cutting
- improvements.md — forward-looking enhancement roadmap
- TODO.md — gap analysis and outstanding work
- pilot-status.md — production scope lock as of 2026-05-24

## Working notes (internal)
- superpowers/ — specs and plans for in-flight engineering work; not user-facing
```

### `docs/developers/README.md` — developer landing + sub-folder index

Three sub-folder sections (Architecture / Operations / Reference) with bulleted links to every page in each, plus a "Start here" pointer to `developers/getting-started.md`. Acts as the developer-persona TOC.

### `docs/historic/README.md` — historic landing

Short page (~50 lines) with three groupings:
- AEM-era: `aem-current-state.md`, `aem-gap-analysis.md`
- IMS-era: `ims-api-reference.md`, `ims-uncovered-features.md`, `data-migration.md`
- Completed migrations: `hugo-migration.md`, `vitepress-2x-upgrade-assessment.md`, `github-app-migration.md`

Plus a pointer to `decommissioned-tasks.md` for the task-level mapping. Frames the folder as "context that no longer reflects the running system but matters for understanding why current code looks the way it does."

### `docs/end-users/README.md`

Per the End-user content scope section above.

## Cross-link update strategy

Before the move, an earlier grep showed 26 files referencing old `docs/` paths (markdown, CDS, JS, TS, JSON, YAML). After every batch of moves, run a sweep:

```bash
grep -rn "docs/<old-path>" --include="*.md" --include="*.cds" --include="*.js" \
  --include="*.ts" --include="*.json" --include="*.yaml" --include="*.yml"
```

Update every match. Files known to contain references that will need updates:
- `CLAUDE.md` (project memory — references `docs/testing-endpoints.md`, `docs/improvements.md`, `docs/TODO.md`, `docs/theme-variants.md`, `docs/qa-channel-bootstrap.md`, `docs/content-pipeline.md`, `docs/authentication-architecture.md`, `docs/mta-deployment.md`, `docs/hugo-migration.md`, `docs/authors/README.md`)
- `README.md` (project) — Documentation section
- `mta.yaml`, `.deploy/mta.yaml` (deploy descriptors)
- `.github/workflows/rebuild-content.yml`
- `approuter/server.js`
- `db/schema.cds`, `db/_content-shape.cds`
- `test/a11y/*.js`
- `scripts/build-admin-docs-index.ts`
- `docs/TODO.md`, `docs/cookie-and-storage-analysis.md`, `docs/sage-extension-migration.md`
- `docs/superpowers/specs/*.md` and `docs/superpowers/plans/*.md` — internal references; updated for accuracy though `superpowers/` itself is not user-facing

**Anchor-link verification:** when files merge (e.g., `authentication-primer.md` + `authentication-architecture.md` → `architecture/authentication.md`), other docs may link to `docs/authentication-primer.md#some-heading`. The grep sweep catches the path; a separate scan for `authentication-primer.md#`, `authentication-architecture.md#`, `joule-chat.md#`, `content-pipeline.md#` patterns catches anchor links into the merged files. Anchors get rewritten to point at headings in the merged page.

## Future-proofing for VitePress

Tom plans to set up a VitePress + Fiori Fundamentals docs site against this folder structure. Choices made with that in mind:

- **`README.md` as folder index, not `index.md`** — keeps GitHub rendering legible. VitePress reads `README.md` correctly with `cleanUrls: true` set in config; no rename needed at site bootstrap.
- **Persona folders map cleanly to sidebar groups** — the sidebar config will mirror the folder structure (`authors/`, `end-users/`, `developers/`, `historic/`).
- **Sub-folders inside `developers/` (architecture / operations / reference)** become collapsible sidebar sections.
- **No persona-bleed in cross-links** — links between personas always go through the persona's README so the doc-site nav stays predictable.
- **Frontmatter** added to new pages only: `title:` and `description:` minimum. Moved pages keep their existing structure (which is fine for VitePress).
- **The Fiori Fundamentals theme choice** doesn't constrain content shape — code blocks, tables, and admonitions render the same regardless of theme.

## Execution sequencing

Six batches in the implementation plan. Each batch is a focused commit; the full reorg is one feature branch with one PR.

| Batch | Description | Risk |
|---|---|---|
| 1 | Move 7 files into `historic/` + write `historic/README.md` + fix referrers | Low |
| 2 | Create `developers/{architecture,operations,reference}/` + move 11 simple files + fix referrers | Low |
| 3 | Extract 8 sections from project README into `developers/` pages; merge 3 files; trim README to ~300 lines | High (most content work) |
| 4 | Write `developers/README.md` and `developers/getting-started.md` | Low |
| 5 | Write 6 `end-users/` files | Medium (content authoring) |
| 6 | Root `docs/README.md`, move `tutorial-repo-dispatch.yml` to `authors/`, delete `author-instructions.md`, update `CLAUDE.md`, final cross-link sweep | Low |

Per the worktree-isolation rule from memory `feedback_parallel_agents_worktrees.md`, the entire reorg runs in its own worktree. Per `feedback_pr_over_direct_merge.md`, the result lands as a PR via `gh pr create`, not a direct merge.

## Validation

- After each batch: `git status` to verify only intended files changed; spot-check 3–5 random links from the touched files.
- After Batch 6: full link audit — walk every persona README, click every link, verify nothing 404s; run the grep sweep one final time and confirm zero hits for old paths.
- Smoke check: `head` every new page to verify it has a heading and renders as Markdown.
- No code or test changes; CI smoke tests remain unaffected.

## Risks and mitigations

- **Cross-link bit-rot inside merged files** — mitigated by the anchor-link scan described in Cross-link update strategy.
- **README extraction is the riskiest batch** — mitigated by surgical copy (no rewrite), provenance lines on extracted pages, one-line pointers in trimmed README. Each extracted section gets its own commit so review diff is bounded.
- **Hidden referrers in tools or workflows** — mitigated by the multi-extension grep sweep (md, cds, js, ts, json, yaml, yml). Anything missed surfaces in CI smoke tests if it's a deploy-affecting reference, or in author/dev workflows shortly after merge.
- **VitePress pivot before merge** — if Tom decides to start the doc-site work mid-flight, the folder structure already supports it; the docs-site bootstrap is additive.

## Success criteria

- `docs/` root contains only: 4 cross-cutting Markdown files (`README.md`, `improvements.md`, `TODO.md`, `pilot-status.md`) plus 5 sub-directories (`authors/`, `end-users/`, `developers/`, `historic/`, `superpowers/`).
- Project `README.md` is between 280 and 320 lines.
- Every link in every persona README resolves.
- The grep sweep for old `docs/<filename>` paths returns zero non-historical results (i.e., references inside the moved files themselves are fine; references from elsewhere pointing to old paths are zero).
- The new doc set reads top-down: a reader can land on `docs/README.md` and reach every page in ≤3 clicks.
