# Author and Operator Documentation — Design

**Status:** Approved (pending spec review)
**Date:** 2026-05-25
**Owner:** Tom

## Background

The `meta-tutorials` repo (D:\projects\meta-tutorials) was the historical home of admin/operator documentation for developers.sap.com. Its `run-book/run-book.md` (257 lines, ~25 tasks) targets four personas — Developer Center Administrator, Tutorial Repository Group Owner, Repository Group Curator, Tutorial Analytics Administrator — and is roughly 50% AEM/IMS/CircleCI-specific (now decommissioned in this project) and 50% reusable principles. About half the task headings are stubs with no body.

This project (`tutorials-poc`) replaced AEM and is in the process of replacing IMS with a CAP backend. The existing `docs/author-instructions.md` (309 lines) covers the tutorial author's writing workflow well, but there is no equivalent operational manual for repo group owners, center admins, or analytics admins on the new system.

## Goal

Produce `docs/authors/` as the single operational manual for everyone touching the tutorial system, replacing the meta-tutorials run-book. Each of the four personas gets one file; cross-cutting historic mappings live in a separate `docs/historic/` folder.

## Non-goals

- Porting the `task-interview-coach` skill from meta-tutorials — covered by a short note in `docs/authors/README.md` instead.
- Moving the existing AEM/IMS analysis docs (`aem-current-state.md`, `aem-gap-analysis.md`, `ims-api-reference.md`, `ims-uncovered-features.md`) into `docs/historic/`. The folder is created for them and similar future docs but they remain in place in this change.
- Author-facing PowerBI views, per-PR preview deploys, formal editorial review gate — tracked in `docs/TODO.md §21`. Documented as known gaps; not built here.

## File layout

```
docs/
├── authors/
│   ├── README.md                Persona index, system landmarks, undocumented-task workflow
│   ├── writing-tutorials.md     Author-facing markdown writing guide (derived from author-instructions.md)
│   ├── repo-group-owners.md     PR review, planning-outline review, retiring tutorials, owner list, dispatch wiring
│   ├── center-admin.md          Groups, missions, events, tags, pipeline ops, content rollback, access, support, backup
│   └── analytics-admin.md       AnalyticsService, /analytics-ui/, ad-hoc SQL, exports, key event metrics
├── historic/
│   └── decommissioned-tasks.md  Maps source run-book tasks that no longer apply (AEM, IMS, CircleCI) to their replacement or "removed"
└── author-instructions.md       One-line redirect stub pointing at docs/authors/writing-tutorials.md
```

## Per-file content

### docs/authors/README.md (~60 lines)

- One-paragraph framing: operational manual for the tutorial system after the AEM/IMS decommission.
- Persona table — for each of the four personas: which file to read, BTP role-collection scope(s) needed, GitHub access needed, primary tools.
- System landmarks: GitHub `sap-tutorials` org, `tutorials-poc` repo, admin UI at `/admin-ui/`, analytics UI at `/analytics-ui/`, BTP cockpit subaccount, Cloud Foundry spaces (`dev` / `prod`), HANA Cloud instance.
- "When you find an undocumented task" — paragraph explaining the contribution flow: open a PR against the relevant persona file, follow the existing task template (purpose, interval, prerequisites, steps, links).
- Cross-links to deeper technical docs: `content-pipeline.md`, `mta-deployment.md`, `qa-channel-bootstrap.md`, `testing-endpoints.md`, `authentication-architecture.md`.

### docs/authors/writing-tutorials.md (~310 lines)

This is a **move-and-edit**, not a copy: the existing `docs/author-instructions.md` content is relocated to this path and then refined; the original file is replaced by a redirect stub (see below). Refinements applied during the move:

- **Where to ask for help table** — update to point at `repo-group-owners.md` (for PR review questions) and `center-admin.md` (for taxonomy/access questions).
- **Rollback section** — leave only "ask a Center Admin to roll back; see `center-admin.md`"; move the `curl POST /content/rollback` snippet into `center-admin.md`.
- **Known gaps subsection** — collapse the inline `> TODO` callouts into one section near the end, each with a `docs/TODO.md §21` link.
- **QA channel preview** — add a short subsection (~15 lines) referencing `qa-channel-bootstrap.md` and noting that `Tutorial.Author` scope is required.
- **Section headings** — keep the existing 1–10 numbering; only the subsections change.

### docs/authors/repo-group-owners.md (~200 lines)

Persona summary block — tools/access required (GitHub admin on owned repos in `sap-tutorials`, optional `Tutorial.Author` scope for QA preview). The persona summary also names the **canonical owner registry**: `sap-tutorials/tutorial-checker/data/repository.owner.json`. This is a CircleCI-era artifact that survived the decommission because both the new system and human contact-resolution still use it; tasks 6 and the historic mapping reinforce this. Tasks (each in the source run-book template: heading, **Interval**, **Status**, **Purpose**, numbered steps, links):

1. **Wire your repo for auto-publish** — drop `tutorial-repo-dispatch.yml` (link to existing in repo) into `.github/workflows/`, set the `DISPATCH_TOKEN` secret (Center Admin generates), verify the first push triggers a `tutorials-poc` Action run.
2. **Review and merge pull requests** — checklist: frontmatter valid, parser v2, slug uniqueness, image presence, time estimate sane, `<!-- description -->` line present. Optional local test: `npm run fetch-tutorials && npm run dev`. When to escalate (slug collision across repos, taxonomy questions).
3. **Issue triage (bi-weekly)** — labels in source repos, when to file against `tutorials-poc` vs the source repo, escalation paths.
4. **Review tutorial planning outlines** — carries the source's planning-outline review (logical chunking, time estimates, mission-vs-group judgment, tag check) with wording updates.
5. **Retire a tutorial** — open a PR that deletes the markdown and image folder, the publish pipeline marks the slug `RETIRED` in the next manifest. Notify the Center Admin if the slug had production traffic so a redirect can be set up via the Operations app.
6. **Designate or change a repository group owner** — update `repository.owner.json` in `sap-tutorials/tutorial-checker`, notify the Center Admin so the `Accounts` records align.
7. **Office hours / author support intake** — what to handle locally, what to forward to Center Admin.

### docs/authors/center-admin.md (~450 lines, the largest file)

Persona summary block — tools/access required (BTP subaccount admin in `tutorial-system`, CF Space Developer in `prod`, GitHub admin in `sap-tutorials` org, `Admin` scope on the deployed app, `CONTENT_API_KEY` for content ops). Tasks grouped into four subsections:

**Content & catalog ops**
1. **Add / revise / delete a Group** — admin UI `/admin-ui/groups`, slug conventions table (carried from source: `btp`, `integration`, `abap`, `cap`, `kyma`, `ai`, `joule`, `build`), how the catalog refresh propagates, validation that text slugs (not numeric IDs) appear in `/build/catalog`.
2. **Add / revise / delete a Mission** — admin UI `/admin-ui/missions`, completion-path setup, slug rules, how missions surface on the navigator and event spaces.
3. **Define an App Space event** — admin UI `/admin-ui/events`, theme variant selection (Joule / Sapphire / TechEd / default), QR code generation via `/api/qrcode`, switching the event display.
4. **Retire a tutorial (admin side)** — manifest-level retirement, redirect rules in the Operations app.
5. **Import a new tag from the SAP taxonomy (Semaphore)** — admin UI `/admin-ui/tags`, entry shape, how it surfaces to authors via the catalog feed.
6. **Force-rebuild content** — `Actions → rebuild-content.yml`, optional single-slug input, when to use vs let auto-dispatch handle it.
7. **Content rollback** — `POST /content/rollback` with `CONTENT_API_KEY` (curl snippet moved here from author doc), what it reverts (manifest pointer, not source markdown), and follow-up corrective PR expectation.

**Pipeline & operations**
8. **Monitor the publish pipeline** — admin UI Pipeline Logs (with `cfLogsUrl` link), `tutorials-poc` Actions tab, smoke-test endpoints in `testing-endpoints.md`.
9. **Pipeline incident playbook** — common failure modes (bad frontmatter from author, GitHub rate limit, HANA LOB locator expiry, stuck `PUBLISHING` manifest). For each, where to look first and how to clear it.
10. **Backup & recovery** — HANA Cloud automated backups (point-in-time recovery from BTP cockpit, retention window), `ExportsService` (`/admin/exports`) for logical exports, restore-test cadence recommendation. Replaces the source's "IMS Production Backup / Recovery" stubs.

**Access & identity**
11. **Add an author / repo group owner / admin to the system** — BTP role-collection assignments (`Tutorial.Author`, `Admin`, `DisplayApp`, `Tutorial.Analytics`, `Sage` for VS Code extension), where they're defined in `xs-security.json`, how to assign in BTP cockpit.
12. **Anonymize a user (GDPR)** — admin UI Accounts app, what gets anonymized vs preserved, audit-log expectations (SecurityEvent emitted on anonymization).

**Author support & coordination**
13. **Handle author support requests** — intake channels (email, internal Slack, GitHub issues on `tutorials-poc`), common questions, escalation.
14. **Maintain the repo group owner list** — `sap-tutorials/tutorial-checker/data/repository.owner.json` plus admin UI Accounts records.
15. **Office hours** — running them, suggested cadence, agenda template.

Cross-link to `docs/historic/decommissioned-tasks.md` at the bottom.

### docs/authors/analytics-admin.md (~150 lines)

Persona summary block — tools/access required (`Tutorial.Analytics` scope; optional `Admin` for cross-checking). Sections:

1. **The analytics surface** — `/analytics-ui/` SPA, `AnalyticsService` at `/admin/analytics`, what `@analytics.exposed` controls (entity-level allowlist).
2. **Browsing entities** — entity tab in the SPA, suggested starting points: `UserCompletions`, `TaskRecords`, `MissionStats`, `EventStats`.
3. **Ad-hoc SQL** — the SQL tab, validator constraints (`SELECT`-only, allowlisted tables, no DDL/DML/multi-statement), `LIMIT 5001` wrap, how to save and share queries.
4. **Export pipelines** — `ExportsService` (`/admin/exports`) endpoints, what's safe to extract, GDPR considerations (no PII columns).
5. **Key event-time metrics** — what to watch during a live event (active users, completions/min, prize claim rate, error rate). One worked example query per metric.
6. **Known gaps** — author-facing PowerBI views still pending (point at `docs/TODO.md §21`), no streaming dashboards yet (DisplayService is a partial substitute).

### docs/historic/decommissioned-tasks.md (~120 lines)

A two-column mapping table grouped by source system:

- **AEM** — Update Developer Center Home Page (gone — landing page now in Hugo), AEM Tutorial Pipeline / Log Harvester (gone — replaced by GitHub Actions + admin UI Pipeline Logs), AEM Tutorial Import plugin (replaced by admin UI Tags app), Quick Publish (automatic on merge), AEM Group Admin (replaced by admin UI Groups app), AEM Sites Console / redirect tree (replaced by admin UI Operations app).
- **IMS** — Production Backup/Recovery (replaced by HANA Cloud backups + ExportsService), IMS Add Author (replaced by BTP role-collection assignment), IMS-specific URLs (deprecated; new endpoints in `testing-endpoints.md`).
- **CircleCI** — `tutorial-checker` lint runs (replaced by Sage VS Code extension and the `tutorials-poc` test suite). Note that `tutorial-checker/data/repository.owner.json` is still used as the owner registry.

Each row links to the new task in the appropriate `docs/authors/<persona>.md`. Folder header notes that other historic docs (existing `aem-*.md`, `ims-*.md`) can be moved here over time.

### docs/author-instructions.md → redirect stub

Replace contents with:
```markdown
# Author Instructions (moved)

This document moved to [docs/authors/writing-tutorials.md](authors/writing-tutorials.md) as part of the run-book consolidation (2026-05-25).
```

## Cross-cutting decisions

### Task template (used in all persona files except writing-tutorials.md)

Every task uses the source run-book's template so future contributors recognize the shape:

```markdown
### Task: <verb-led title>
- **Interval:** <Daily / Weekly / As needed / As requested>
- **Status:** Active
- **Purpose and Objective:** <one sentence>
- **Prerequisites:** <tools, access, env vars> (added; not in source template)

1. <step>
2. <step>

**Related:** <links to other tasks or docs>
```

The **Prerequisites** field is added because new-system tasks frequently require specific BTP scopes or env vars (`CONTENT_API_KEY`, `cf login`, etc.).

### Filling in the source's stub tasks

For each header-only task in the source run-book, the design assigns it to a persona file and writes a real procedure based on the new system. The mapping:

| Source stub | New home | Approach |
| --- | --- | --- |
| Rename a Repository Group | center-admin.md | GitHub repo rename + update `repository.owner.json` + admin UI cleanup |
| Revise / Delete a Group | center-admin.md (Task 1 covers all three) | admin UI Groups app |
| Add / Revise / Delete a Mission | center-admin.md (Task 2 covers all three) | admin UI Missions app |
| Retiring a Tutorial | repo-group-owners.md (Task 5) and center-admin.md (Task 4) | author-side delete vs admin-side redirect |
| Define a New App Space Event | center-admin.md (Task 3) | admin UI Events app + theme variant selection |
| Monitor Tutorial Analytics | analytics-admin.md (Tasks 1–5) | the whole file |
| Designate or Change a Repository Group Owner | repo-group-owners.md (Task 6) and center-admin.md (Task 14) | both perspectives |
| IMS Production Backup / Recovery | center-admin.md (Task 10) | HANA Cloud automated backups + ExportsService |
| Migrate Existing Tutorial(s) to Another Repository | repo-group-owners.md (sub-section under Task 5) | git mv between repos + slug coordination |
| Administer CircleCI | historic/decommissioned-tasks.md | gone, replaced |
| Conduct Office Hours Sessions | center-admin.md (Task 15) | unchanged in spirit |
| Office Hours Sessions for Authors (curator role) | center-admin.md (Task 15) | curator role collapsed into Center Admin scope |

The source's separate "Repository Group Curator" persona has no documented tasks distinct from Owner/Admin; it's collapsed into those two personas.

### Verifying claims about the new system

Where the design references admin-UI screens, CAP services, env vars, or workflows, those must be verified against the codebase before being written into the docs (see [feedback_check_plugin_versions.md] in memory — the spirit applies here too: don't write from training data when the source of truth is the live code). Specifically:
- Admin UI app names and routes — verify against `app/admin-shell/` and `app/admin/`.
- Service paths (`@path:`) — verify against `srv/*-service.cds`.
- Env vars (`CONTENT_API_KEY`, `SUBMISSION_SALT_SECRET`, etc.) — verify against `srv/server.js` and `package.json`.
- Role-collection scopes — verify against `xs-security.json`.
- BTP cockpit URLs — use the production URL pattern from `cf_target` MCP if needed.

**If verification contradicts this spec:** trust the codebase, update the doc to match reality, and note the contradiction in the implementation plan output. Do not modify the system to fit the spec — this work is documentation, not behavior change.

## Out of scope

- Building any of the missing features the docs reference as gaps (PowerBI views, per-PR previews, formal review gate).
- Reorganizing or moving existing AEM/IMS analysis docs into `docs/historic/`. They stay where they are; the folder is created for future use.
- Updating CLAUDE.md to point at the new doc locations (will happen as a small follow-up after the docs land).

## Acceptance criteria

- All five files in `docs/authors/` exist with the content described above.
- `docs/historic/decommissioned-tasks.md` exists and maps every removed source task.
- `docs/author-instructions.md` is a one-line redirect.
- Every cross-link inside `docs/authors/` resolves.
- Every claim about the live system (admin UI app names, service paths, env vars, scopes) was verified against the codebase before being written.
- No references to AEM, IMS, or CircleCI as live systems anywhere in `docs/authors/`. Historical mentions are confined to `docs/historic/decommissioned-tasks.md`.
