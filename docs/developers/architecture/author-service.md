# AuthorService architecture

> Service path: `/author`. Auth: `@requires: 'Tutorial.Author'`. Source: `srv/author-service.cds`.

## Overview

`AuthorService` is the OData V4 surface for tutorial authors. It exposes a read-only view of the author's own tutorials (`MyTutorials`), the tag taxonomy (`Tags`), branch analytics, and a handful of actions (review/snooze/OS-variant generation/slug-availability check).

The service is consumed by:

- The Sage VS Code extension (primary consumer).
- The admin shell at `/admin-ui/` (indirectly — most admin reads go through `AdminService`).

## Entities

| Entity | Shape | Notes |
|---|---|---|
| `Tutorials` | projection on `Tutorials` (ID, slug, title, primaryTag, status) | Read-only. Lightweight metadata only. |
| `Tags` | projection on `Tags` with virtual `actualTag` | `actualTag` is HANA-native `SUBSTR_AFTER(name, '>')`. |
| `MyTutorials` | projection on `MyTutorialsView` | Filtered to `ownerUserId == req.user.id` by a before-handler. |
| `AnalyticsBranchPerformance` / `AnalyticsBranchTopPick` | aggregated branch analytics | See `srv/analytics-service.cds` for the canonical definition. |

## Actions

| Action | Inputs | Returns | Notes |
|---|---|---|---|
| `reviewTutorial` | `tutorialId : UUID` | `{ reviewedDate, notificationNumber }` | Owner-only. Resets the 4-nag state. |
| `snoozeTutorial` | `tutorialId, days` | `{ notificationDate, notificationNumber }` | Owner-only. Pushes the next nag out. |
| `generateOsVariants` | `sourceMarkdown, sourceOS, targetOSes, context` | `{ variants, model, tokensUsed, requestId }` | Per-user rate-limited (60/hr). |
| `isSlugAvailable` | `slug : String` | `Boolean` | Server-side case-insensitive uniqueness check. UX hint, not a lock. |

## #385 PR-3 field renames (2026-06-21)

The `MyTutorials` entity in `AuthorService` underwent renames as part of unifying field names with Sage's expectations. Consumers migrating from the previous schema can use this table:

| Old name (pre-PR-3) | New name (post-PR-3) | Notes |
|---|---|---|
| `ownerName` | `owner` | Pure rename; underlying `TutorialMeta.owner` column unchanged. |
| `lastNotificationDate` | `notificationDate` | Pure rename; applies to `MyTutorials` AND `snoozeTutorial` action return. Underlying `TutorialMeta.lastNotificationDate` column unchanged. |
| `outdated` | _(deleted)_ | Use `daysSinceReview` with a client-side threshold (Sage owns the UX). |
| _(none — new)_ | `repositoryName` | Repo group name from `TutorialRepositories` (#385 PR-1 schema, PR-2 backfill). NULL until backfill runs. |
| _(none — new)_ | `monitored` | Boolean: `true` iff `monitoredStatus === 'ACTIVE'`. |
| _(none — new)_ | `daysSinceReview` | Integer: `DAYS_BETWEEN(reviewedDate, NOW)`. Server-side `$filter`/`$orderby` supported. NULL when `reviewedDate` is NULL. |
| _(none — new on `Tags`)_ | `actualTag` | `Tags` virtual; HANA-native `SUBSTR_AFTER(name, '>')`. Leaf after last `>`. |

### New action: `isSlugAvailable`

`isSlugAvailable(slug : String) returns Boolean` — server-side case-insensitive uniqueness check across all `Tutorials.slug`. Use before creating a new tutorial to surface conflicts to the user; the write-side `@assert.unique.slug` remains the source of truth at insert time.

The check is intentionally a UX hint, not a lock. A benign TOCTOU window exists between the check and a subsequent insert; the write-side constraint catches any race condition.

## Authorization

Service-level `@requires: 'Tutorial.Author'` is the only gate. All entities, actions, and read paths require the caller's `req.user.roles['Tutorial.Author']` to be true.

The `MyTutorials` projection additionally filters by `ownerUserId == req.user.id` via a `this.before('READ', ...)` handler. The ownership assertion for `reviewTutorial` and `snoozeTutorial` is enforced in handlers (`srv/author-service.js`).
