# Sage VS Code Extension — Backend Coupling & Migration Analysis

**Subject:** [`sage-tutorial-extension`](https://github.com/sap-tutorials/sage-tutorial-extension) (codename "Sage") — VS Code extension for SAP Developer Tutorial authors.
**Question:** What does Sage need from a backend, what does `tutorials-poc` already provide, and what's the gap to fully retire its local SQLite cache and the legacy IMS dependency?
**Source repo analyzed:** `D:/projects/sage-tutorial-extension` at the time of writing (Sage v0.10.7+).
**Last updated:** 2026-05-25.

> **Status (2026-05-25):** All backend gaps identified below — both hard (1–3) and soft (6–8) — were closed in [PR #54](https://github.com/sap-tutorials/tutorials-ims/pull/54) on `feature/sage-backend-gaps`. Gaps 4 and 5 were always Sage-side repoint work (no backend change). The remaining work is now entirely in the Sage extension. See each gap section for the implementation pointer.

---

## Executive Summary

The CAP backend in `tutorials-poc` now **fully covers the IMS surface that Sage uses**. The data shapes match, the entities (`Tutorials`, `Tags`, `TutorialMeta`) exist with author-scoped projections, the `POST /preview/render` endpoint on `tutorials-srv-qa` replaces Sage's local markdown renderer, and the new `AuthorService` at `/author` exposes the read/write surface Sage needs without giving it admin scope.

The remaining work is entirely on the Sage side:

1. ✅ ~~Author-scoped variant of `reviewTutorial` / `snoozeTutorial`.~~ Shipped — `AuthorService` at `/author` with `Tutorial.Author` scope and same-tx ownership checks.
2. ✅ ~~A "my tutorials" projection bound to the JWT subject.~~ Shipped — `MyTutorialsView` + `AuthorService.MyTutorials` projection auto-filtered by `req.user.id`.
3. ✅ ~~A slug-list endpoint for create-time uniqueness checks.~~ Resolved — reuse existing `GET /content/hashes` (returns slug→hash for active content).
4. Sage repointed at `GET /build/repo-catalog` instead of GitHub raw. *(Sage-side change; backend ready.)*
5. Sage repointed at `POST /preview/render` instead of its in-process renderer. *(Sage-side change; backend ready.)*

The longer pole is the Sage-side rewrite of [`src/lib/sync/imsClient.ts`](https://github.com/sap-tutorials/sage-tutorial-extension/blob/main/src/lib/sync/imsClient.ts) and the strategic decision of what (if anything) the local cache should still hold.

---

## Sage's Current Architecture

Three external dependencies, in priority order:

1. **IMS** ([`imsClient.ts`](https://github.com/sap-tutorials/sage-tutorial-extension/blob/main/src/lib/sync/imsClient.ts), pointing at `https://imsprod.cfapps.us30.hana.ondemand.com`) — every IMS read is mirrored into a SQLite cache at `{workspace}/.sage/sage.db`.
2. **GitHub REST API** — issues, PRs, repo metadata. Not in scope for retirement; GitHub is the system of record.
3. **Local preview** ([`previewCommands.ts`](https://github.com/sap-tutorials/sage-tutorial-extension/blob/main/src/commands/previewCommands.ts) → [`tutorialPreviewPanel.ts`](https://github.com/sap-tutorials/sage-tutorial-extension/blob/main/src/views/tutorialPreviewPanel.ts)) — a webview that runs `parseMarkdown.ts` plus custom CSS/JS to render in-process, with no server round-trip.

### SQLite tables and their source of truth

From [`src/lib/db/schema.ts`](https://github.com/sap-tutorials/sage-tutorial-extension/blob/main/src/lib/db/schema.ts) (schema version 1.6.0):

| SQLite table | Source of truth | Notes |
|---|---|---|
| `ims_tutorials_basic` | IMS `GET /tutorials` | Cache only — used for slug-uniqueness checks at create time. |
| `ims_tutorials` | IMS `POST /tutorialMeta/search` (filtered by owner) | Cache of "tutorials assigned to me" with full metadata. |
| `ims_tags` | IMS `GET /tags` | Cache — used for tag-existence validation in front matter. |
| `assigned_tutorials` | **Derived** (joins `ims_tutorials` with local repo state) | Computes status: `In Production` / `New-Unpublished` / `Revision-In-Progress` / `Needs-Review` / `Publication-Pending` / `Just-Helping`. |
| `github_issues` | GitHub | Cache. |
| `github_prs` | GitHub | Cache. |
| `tutorial_issues` | Derived (issue ↔ tutorial mapping) | Many-to-many bridge table. |
| `sync_status` | Local | Tracks `last_sync_*` timestamps and current operation. |
| `schema_version` | Local | Migration bookkeeping. |

Every IMS-backed table is a *cache* of authoritative state held server-side. The `last_sync_*` columns in `sync_status` are the dead giveaway.

---

## IMS API Surface Used by Sage (Complete List)

All calls are bearer-token authenticated against an OAuth flow ([`imsAuth.ts`](https://github.com/sap-tutorials/sage-tutorial-extension/blob/main/src/lib/sync/imsAuth.ts)) and go through `IMSClient.makeRequest()` in [`imsClient.ts`](https://github.com/sap-tutorials/sage-tutorial-extension/blob/main/src/lib/sync/imsClient.ts):

| # | IMS Call | Purpose | Cached in (SQLite) |
|---|---|---|---|
| 1 | `GET /tutorials?page=&size=` | List **all** published tutorials (basic shape) — drives slug-uniqueness checks during creation | `ims_tutorials_basic` |
| 2 | `GET /tags?page=&size=` | Tag taxonomy — drives front-matter validation | `ims_tags` |
| 3 | `POST /tutorialMeta/search` (text body) | Search tutorial metadata by **owner** or **title** — drives the "My Tutorials" tree | `ims_tutorials` (filtered down) |
| 4 | `GET /tutorialMeta/{id}` | Full meta record for one tutorial | (writes back to `ims_tutorials`) |
| 5 | `GET /tags/{id}` | One tag — rarely used, on-demand | not cached |
| 6 | `POST /tutorialMeta/setReviewedStatus?status=&id=` | Toggle "reviewed in last 120 days" flag | updates `ims_tutorials.is_reviewed` |

That's the entire IMS surface. Six calls.

In addition, Sage hits a public GitHub raw URL for repo-group config:

> `https://raw.githubusercontent.com/sap-tutorials/Tutorials/refs/heads/master/config/repository-groups.json`

…which is also already mirrored into `tutorials-poc` as the `RepoCatalog` entity (see below).

---

## What `tutorials-poc` Already Exposes

The CAP DB schema in [`db/schema.cds`](../db/schema.cds) is a near-complete superset of the IMS shape:

| IMS field/call | CAP equivalent | Source |
|---|---|---|
| `IMSBasicTutorial` (id, title, mdFileUrl, repo, primaryTagName) | `Tutorials` entity (slug, mdFileUrl, primaryTag, repositories) | [db/schema.cds:27](../db/schema.cds#L27) |
| `IMSTutorialMeta` (reviewedAt, monitored, notification*, ownerName) | `TutorialMeta` entity (reviewedDate, monitoredStatus, notificationNumber, lastNotificationDate, owner) | [db/schema.cds:200](../db/schema.cds#L200) |
| `IMSTag` (name, semaphoreId, titlePath, mdFormat, actualTag) | `Tags` entity (name, titlePath, virtual mdFormat) | [db/schema.cds:142](../db/schema.cds#L142) |
| `setReviewedStatus(id, true)` | `action reviewTutorial(tutorialId)` + `snoozeTutorial(tutorialId, days)` | [admin-service.cds:103-110](../srv/admin-service.cds#L103-L110) |
| `searchTutorialsByOwner(name)` | `Tutorials?$filter=meta/any(m: m/owner eq 'Riley Rainey')` (OData query, no custom action needed) | derivable from existing projection |
| repo-group config (currently fetched from GitHub raw) | `RepoCatalog` entity + `GET /build/repo-catalog` | [db/schema.cds:318](../db/schema.cds#L318), [server.js:122](../srv/server.js#L122) |
| local markdown render (Sage in-process) | **`POST /preview/render`** on `tutorials-srv-qa` | [srv-qa/preview-renderer.js](../srv-qa/preview-renderer.js), spec at [docs/superpowers/specs/2026-05-23-vscode-author-preview-design.md](superpowers/specs/2026-05-23-vscode-author-preview-design.md) |

The `TutorialMeta` shape in [`db/schema.cds:200`](../db/schema.cds#L200) keeps the same notification-counter / review-date / monitored-status fields as IMS, so the "Needs-Review" / "In Production" status logic in Sage's `assigned_tutorials` table ports directly. Sage computes `status` client-side from `(reviewedAt + 120 days) vs now`; on the CAP side this could either stay client-side or be moved to a calculated element so all three surfaces (Sage, the admin UI, the public site) agree on the rule.

---

## Gaps — Status

All backend gaps are closed. Each subsection below records the original gap and the implementation that resolved it.

### Hard gaps

#### 1. Author scope for write operations ✅ Resolved (PR #54)

`reviewTutorial` and `snoozeTutorial` were gated on `@requires: 'Admin'` ([admin-service.cds:6](../srv/admin-service.cds#L6)). The Sage user is an *Author*, not an admin.

**Resolution:** New `AuthorService` at `@path: '/author'` ([srv/author-service.cds](../srv/author-service.cds)), gated on `@requires: 'Tutorial.Author'`. Exposes `reviewTutorial` and `snoozeTutorial` actions backed by the shared handler in [srv/lib/tutorial-review.js](../srv/lib/tutorial-review.js), with same-transaction ownership checks (`ownerEmail` must match `req.user.email`) so an author can only act on their own tutorials. The admin surface keeps its full-fidelity view; authors get a constrained one.

#### 2. "My tutorials" surface ✅ Resolved (PR #54)

Sage previously called `tutorialMeta/search` with the user's name as a free-text query and filtered client-side.

**Resolution:** New `MyTutorialsView` ([db/schema.cds](../db/schema.cds)) joins `Tutorials` → `TutorialMeta` → `Users` on `ownerEmail = email` and exposes `ownerUserId` as a UUID. The `AuthorService.MyTutorials` projection adds a `@before('READ')` handler that filters on `req.user.id` (the JWT subject) so OData clients can call `GET /author/MyTutorials` with no filter and get exactly their own tutorials.

#### 3. Slug-uniqueness check on create ✅ Resolved (no new endpoint)

**Resolution:** Reuse the existing `GET /content/hashes` endpoint. It already returns a `{slug: sha256}` map of *active* content, which directly answers "is this slug already in production?" — no `/author/slugs` endpoint needed. Decision recorded in the design spec [docs/superpowers/specs/2026-05-24-sage-backend-gaps-design.md](superpowers/specs/2026-05-24-sage-backend-gaps-design.md).

#### 4. Repo-group catalog from CAP, not GitHub raw

Always a Sage-side change. Backend already provides `GET /build/repo-catalog` ([srv/lib/repo-catalog.js:5](../srv/lib/repo-catalog.js#L5)). **Sage repoint pending.**

#### 5. Validation rules (`rules.vr`) for tags

Always a Sage-side change. Once Sage moves to `GET /admin/Tags` (or `/author/Tags`), tag-existence validation works against the same source the backend uses. **No new endpoint needed.**

### Soft gaps

#### 6. OData delta tracking on Tutorials and Tags ✅ Resolved (PR #54)

**Resolution:** `@Capabilities.ChangeTracking: { Supported: true }` annotations applied to `Tutorials`, `Tags`, and `AuthorService.MyTutorials`. Combined with the new `managed` aspect on `TutorialMeta` (createdAt/modifiedAt), Sage can now advertise `Prefer: odata.track-changes` and do incremental sync instead of re-fetching ~3000 tutorials each session.

#### 7. Diagnostic ping ✅ Resolved (PR #54)

**Resolution:** `GET /health/auth` ([srv/server.js:235](../srv/server.js#L235)) returns `{authenticated, user, scopes, serverTime}` for an authenticated caller, `401 {authenticated: false}` for an anonymous one. Cheap, idempotent, and gives Sage a clear signal that "the token still works and these are my scopes" without paging through tutorials.

#### 8. Owner identity bridge ✅ Resolved (PR #54)

**Resolution:** New `ownerEmail` column on `TutorialMeta` (alongside the existing free-text `owner` field) joins to `Users.email`. Backfill script [scripts/backfill-tutorial-meta-email.js](../scripts/backfill-tutorial-meta-email.js) populates the new column from existing data with ambiguous-name detection (multiple users sharing a display name → `null` + CSV report for manual review). Publish handler in [srv/lib/content-store.js](../srv/lib/content-store.js) writes both fields going forward. `MyTutorialsView` exposes `ownerUserId` (UUID) so OData filters work on a stable identifier rather than a display string.

### Things to keep cached (or stop caching entirely)

- **`github_issues` / `github_prs` / `tutorial_issues`** — these are GitHub-native. The right move is *not* to mirror them into CAP. Either:
  - keep them server-side cached, but in the CAP DB rather than per-developer SQLite; or
  - given the volume is small per author, just stop caching and call GitHub live (the GitHub API is fast and rate limits are per-token, so each Sage user has their own quota).
- **`assigned_tutorials`** — this is a *derived* view that joins `ims_tutorials` with local repo state to produce statuses like `New-Unpublished` and `Revision-In-Progress`. The "local repo state" half can never come from a server. Either keep this table as a thin local cache *of derived state only*, or compute it on the fly each session.

---

## Suggested Migration Order

Backend work is complete (steps 3–4, 6–8 below shipped in PR #54). Remaining steps are all on the Sage side, ordered for minimum risk and earliest user-visible payoff:

1. **Repoint preview** to `POST /preview/render`. Drops `parseMarkdown.ts`, `tutorialStyles.ts`, `tutorialScripts.ts` from the webview path. Smallest, safest change. *Backend ready.*
2. **Repoint repo-groups** from GitHub raw to `GET /build/repo-catalog`. One-line URL change. *Backend ready.*
3. ✅ ~~Widen scope on `reviewTutorial` / `snoozeTutorial`~~ → `AuthorService` shipped with `Tutorial.Author` scope.
4. ✅ ~~Add `myTutorials` projection bound to the JWT subject~~ → `MyTutorialsView` + `AuthorService.MyTutorials` shipped.
5. **Replace IMS calls 1–6** in [`imsClient.ts`](https://github.com/sap-tutorials/sage-tutorial-extension/blob/main/src/lib/sync/imsClient.ts) with OData calls to `/admin/Tutorials`, `/admin/Tags`, `/admin/TutorialMeta` (or their `/author/*` equivalents). Drop `imsAuth.ts` once Sage authenticates against the same XSUAA subaccount it already uses for the preview endpoint. Sage can now use `Prefer: odata.track-changes` for incremental sync (gap 6 closed).
6. **Decide on the SQLite cache.** Either:
   - Keep it as a pure read-through cache pointed at CAP — changes nothing user-visible, low effort. Useful if authors work offline.
   - Rip it out — Sage becomes a thin client. Less code, simpler upgrades, no schema migration headaches. The fact that Sage already has an in-memory fallback ([`fallback.ts`](https://github.com/sap-tutorials/sage-tutorial-extension/blob/main/src/lib/db/fallback.ts)) for when SQLite can't load suggests SQLite has been a pain point — that's a vote for "thin Sage."

---

## Bottom Line

The CAP backend now fully covers the IMS surface Sage uses. Hard gaps 1–3 and soft gaps 6–8 are closed in PR #54; gaps 4–5 were always Sage-side repoint work and are unblocked by existing endpoints. The remaining work is entirely in the Sage extension: rewrite [`imsClient.ts`](https://github.com/sap-tutorials/sage-tutorial-extension/blob/main/src/lib/sync/imsClient.ts) against `/author/*`, repoint preview and repo-groups, and decide whether the SQLite cache stays as a read-through layer or gets ripped out for a thin client.

The strategic question worth answering before writing code is whether SQLite stays at all. If it does, Sage's architecture barely changes; if it goes, Sage gets noticeably simpler.

---

## References

- Sage backend gaps PR (closes hard gaps 1–3 and soft gaps 6–8): [tutorials-poc PR #54](https://github.com/sap-tutorials/tutorials-ims/pull/54).
- Design spec: [docs/superpowers/specs/2026-05-24-sage-backend-gaps-design.md](superpowers/specs/2026-05-24-sage-backend-gaps-design.md).
- Implementation plan: [docs/superpowers/plans/2026-05-24-sage-backend-gaps.md](superpowers/plans/2026-05-24-sage-backend-gaps.md).
- Sage source: [`D:/projects/sage-tutorial-extension`](https://github.com/sap-tutorials/sage-tutorial-extension) (also available on disk).
- Sage architecture overview: [`D:/projects/sage-tutorial-extension/CLAUDE.md`](https://github.com/sap-tutorials/sage-tutorial-extension/blob/main/CLAUDE.md).
- IMS API reference (legacy): [docs/ims-api-reference.md](ims-api-reference.md).
- Preview endpoint design: [docs/superpowers/specs/2026-05-23-vscode-author-preview-design.md](superpowers/specs/2026-05-23-vscode-author-preview-design.md).
- QA channel context (where the preview endpoint lives): [docs/qa-channel-bootstrap.md](qa-channel-bootstrap.md).
- Tutorials-poc CAP services: [`srv/admin-service.cds`](../srv/admin-service.cds), [`srv/author-service.cds`](../srv/author-service.cds), [`srv/server.js`](../srv/server.js).
- Schema: [`db/schema.cds`](../db/schema.cds).
