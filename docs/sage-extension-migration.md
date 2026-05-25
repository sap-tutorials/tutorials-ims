# Sage VS Code Extension — Backend Coupling & Migration Analysis

**Subject:** [`sage-tutorial-extension`](https://github.com/sap-tutorials/sage-tutorial-extension) (codename "Sage") — VS Code extension for SAP Developer Tutorial authors.
**Question:** What does Sage need from a backend, what does `tutorials-poc` already provide, and what's the gap to fully retire its local SQLite cache and the legacy IMS dependency?
**Source repo analyzed:** `D:/projects/sage-tutorial-extension` at the time of writing (Sage v0.10.7+).
**Last updated:** 2026-05-24.

---

## Executive Summary

The CAP backend in `tutorials-poc` is **~80% of the way to replacing IMS for Sage**. The data shapes match, the entities (`Tutorials`, `Tags`, `TutorialMeta`) already exist, and the new `POST /preview/render` endpoint on `tutorials-srv-qa` directly replaces Sage's local markdown renderer.

The five remaining gaps are small additions to existing services rather than new infrastructure:

1. Author-scoped variant of `reviewTutorial` / `snoozeTutorial` actions (currently `Admin` only).
2. A "my tutorials" projection bound to the JWT subject.
3. A slug-list endpoint for create-time uniqueness checks (or reuse `/content/hashes`).
4. Sage repointed at `GET /build/repo-catalog` instead of GitHub raw.
5. Sage repointed at `POST /preview/render` instead of its in-process renderer.

Total backend work: ~1 focused day. The longer pole is the Sage-side rewrite of [`src/lib/sync/imsClient.ts`](https://github.com/sap-tutorials/sage-tutorial-extension/blob/main/src/lib/sync/imsClient.ts) and the strategic decision of what (if anything) the local cache should still hold.

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

## Gaps — What Would Have to Be Added

### Hard gaps (no current API)

#### 1. Author scope for write operations

`reviewTutorial` and `snoozeTutorial` are gated on `@requires: 'Admin'` ([admin-service.cds:6](../srv/admin-service.cds#L6)). Sage's user is an *Author*, not an admin. Two options:

- **Widen** these actions to also accept `Tutorial.Author` (the scope already used by `tutorials-srv-qa`); or
- **Clone** them into a new lightweight `AuthorService` at `@path: '/author'` that exposes only the actions/projections an author needs. This is the cleaner option — it lets the admin UI keep its full-fidelity view while authors get a constrained surface.

#### 2. "My tutorials" surface

Today Sage calls `tutorialMeta/search` with the user's name as a free-text query, then filters client-side for exact owner-name match (see [`searchTutorialsByOwner`](https://github.com/sap-tutorials/sage-tutorial-extension/blob/main/src/lib/sync/imsClient.ts#L292)). A clean OData approach would be:

```
GET /author/Tutorials?$expand=meta&$filter=meta/any(m: m/owner eq @me)
```

…but `@me` resolution against the JWT subject doesn't exist yet. Add either:

- A virtual `myTutorials` projection that auto-filters on `req.user.id` in a `@before('READ')` handler, or
- An action `getAssignedTutorials() returns array of {…}`.

#### 3. Slug-uniqueness check on create

The current `/build/catalog` is unauth and returns missions/groups but not the full slug list. Either:

- Add a `GET /author/slugs` (lightweight `select slug from Tutorials`); or
- **Reuse `/content/hashes`** — this already returns the slug→hash map for *active* content. If the actual question is "is this slug already in production?", the hash endpoint answers it for free.

#### 4. Repo-group catalog from CAP, not GitHub raw

Sage hits `https://raw.githubusercontent.com/sap-tutorials/Tutorials/.../repository-groups.json` directly. `tutorials-poc` already has `RepoCatalog` + `GET /build/repo-catalog` ([repo-catalog.js:5](../srv/lib/repo-catalog.js#L5)). Sage just needs to point at it. **Zero backend work.**

#### 5. Validation rules (`rules.vr`) for tags

Tag-format validation in [`tutorialValidator.ts`](https://github.com/sap-tutorials/sage-tutorial-extension/blob/main/src/lib/validation/tutorialValidator.ts) checks tag *existence* against IMS. Once Sage moves to `GET /admin/Tags` (or `/author/Tags`), this just works. **No new endpoint needed.**

### Soft gaps (would improve ergonomics)

#### 6. Etag / Last-Modified support on `/admin/Tutorials` and `/admin/Tags`

Sage's whole reason for the SQLite cache is that paging through ~3000 tutorials is slow. CAP/OData supports `$count`, `$top`, `$skip`, `$select` natively, but a delta link (`Prefer: odata.track-changes`) would let Sage do incremental sync without full re-fetch. CAP supports OData delta but the services don't currently advertise it.

#### 7. A diagnostic ping

Sage's `testConnection()` uses `getAllTutorials(0, 1)` which is heavyweight. A `/health/auth` (or reusing the existing `/auth/user` endpoint) would be cheaper and gives a clearer signal.

#### 8. Owner identity bridge

`IMSTutorialMeta.ownerName` is a free-text string ("Riley Rainey"). The CAP `Users` entity has `firstName`, `lastName`, `displayName`. Migration scripts populate `TutorialMeta.owner` as a string today, but if we want robust owner filtering, swapping that to `Association to Users` would let `$filter=meta/any(m: m/owner_ID eq <jwt-sub>)` work without name-string fuzziness. **This is a schema change, not just an API addition.**

### Things to keep cached (or stop caching entirely)

- **`github_issues` / `github_prs` / `tutorial_issues`** — these are GitHub-native. The right move is *not* to mirror them into CAP. Either:
  - keep them server-side cached, but in the CAP DB rather than per-developer SQLite; or
  - given the volume is small per author, just stop caching and call GitHub live (the GitHub API is fast and rate limits are per-token, so each Sage user has their own quota).
- **`assigned_tutorials`** — this is a *derived* view that joins `ims_tutorials` with local repo state to produce statuses like `New-Unpublished` and `Revision-In-Progress`. The "local repo state" half can never come from a server. Either keep this table as a thin local cache *of derived state only*, or compute it on the fly each session.

---

## Suggested Migration Order

Ordered for minimum risk and earliest user-visible payoff:

1. **Repoint preview** to `POST /preview/render`. Drops `parseMarkdown.ts`, `tutorialStyles.ts`, `tutorialScripts.ts` from the webview path. Smallest, safest change. No backend work — endpoint already exists.
2. **Repoint repo-groups** from GitHub raw to `GET /build/repo-catalog`. One-line URL change. No backend work.
3. **Widen scope** on `reviewTutorial` / `snoozeTutorial` (or create an `AuthorService`) so authors can call them. Backend work.
4. **Add `myTutorials` projection** (or action) bound to the JWT subject. Backend work.
5. **Replace IMS calls 1–6** in [`imsClient.ts`](https://github.com/sap-tutorials/sage-tutorial-extension/blob/main/src/lib/sync/imsClient.ts) with OData calls to `/admin/Tutorials`, `/admin/Tags`, `/admin/TutorialMeta` (or their `/author/*` equivalents). Drop `imsAuth.ts` once Sage authenticates against the same XSUAA subaccount it already uses for the preview endpoint.
6. **Decide on the SQLite cache.** Either:
   - Keep it as a pure read-through cache pointed at CAP — changes nothing user-visible, low effort. Useful if authors work offline.
   - Rip it out — Sage becomes a thin client. Less code, simpler upgrades, no schema migration headaches. The fact that Sage already has an in-memory fallback ([`fallback.ts`](https://github.com/sap-tutorials/sage-tutorial-extension/blob/main/src/lib/db/fallback.ts)) for when SQLite can't load suggests SQLite has been a pain point — that's a vote for "thin Sage."

---

## Bottom Line

Sage's IMS surface is small (six calls). The CAP backend already covers the data shapes and most of the operations; the remaining work is mostly **scope + filter** plumbing rather than new functionality. The preview endpoint just shipped on `tutorials-srv-qa` and is the single biggest piece — once Sage repoints at it, half the migration is done.

The strategic question worth answering before writing code is whether SQLite stays at all. If it does, Sage's architecture barely changes; if it goes, Sage gets noticeably simpler. Either way, the backend gaps are the same five small items listed above.

---

## References

- Sage source: [`D:/projects/sage-tutorial-extension`](https://github.com/sap-tutorials/sage-tutorial-extension) (also available on disk).
- Sage architecture overview: [`D:/projects/sage-tutorial-extension/CLAUDE.md`](https://github.com/sap-tutorials/sage-tutorial-extension/blob/main/CLAUDE.md).
- IMS API reference (legacy): [docs/ims-api-reference.md](ims-api-reference.md).
- Preview endpoint design: [docs/superpowers/specs/2026-05-23-vscode-author-preview-design.md](superpowers/specs/2026-05-23-vscode-author-preview-design.md).
- QA channel context (where the preview endpoint lives): [docs/qa-channel-bootstrap.md](qa-channel-bootstrap.md).
- Tutorials-poc CAP services: [`srv/admin-service.cds`](../srv/admin-service.cds), [`srv/server.js`](../srv/server.js).
- Schema: [`db/schema.cds`](../db/schema.cds).
