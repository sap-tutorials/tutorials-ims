# Sage Backend Gaps — Design Spec

**Date:** 2026-05-24
**Status:** Draft (pending review)
**Related:** [docs/sage-extension-migration.md](../../sage-extension-migration.md), [docs/superpowers/specs/2026-05-23-vscode-author-preview-design.md](2026-05-23-vscode-author-preview-design.md)

## Background

The Sage VS Code extension ([`sap-tutorials/sage-tutorial-extension`](https://github.com/sap-tutorials/sage-tutorial-extension)) currently depends on the legacy IMS backend (`https://imsprod.cfapps.us30.hana.ondemand.com`) and a per-workspace SQLite cache. The migration analysis in [docs/sage-extension-migration.md](../../sage-extension-migration.md) identified five hard gaps and three soft gaps in `tutorials-poc` that block Sage from moving off IMS.

This spec closes all eight gaps in a single MTA deploy with a minimal, additive schema change. Sage repointing itself at the new endpoints is out of scope for this spec — that work happens in the Sage repo after this lands.

## Goals

1. Give Sage an authenticated, scope-gated read surface for the data it needs (Tutorials catalog, Tags, "my tutorials").
2. Let authors invoke `reviewTutorial` and `snoozeTutorial` without admin scope.
3. Provide cheap auth diagnostics and incremental-sync primitives so Sage can drop or shrink its SQLite cache.
4. Avoid the destructive `Association to Users` migration on `TutorialMeta.owner` — the existing string column stays as the display name.

## Non-goals

- Rewriting `imsClient.ts` in Sage. (Separate effort in the Sage repo.)
- Decommissioning Sage's SQLite cache. (Strategic decision deferred to the Sage migration.)
- Adding `/author/slugs`. (Deferred until a draft-reservation use case appears; `/content/hashes` answers slug-uniqueness today.)
- Decommissioning IMS. (Tracked separately; this spec just removes Sage's dependency on it.)
- Mirroring GitHub issues / PRs into CAP. (Wrong layer — they're GitHub-native and stay there.)

## Locked decisions

| Decision | Choice | Rationale |
|---|---|---|
| Backend gap scope | All hard + soft gaps | Single coherent feature; one deploy. |
| Author API surface | New `AuthorService` at `@path: '/author'` | Keeps admin surface untouched; clean scope boundary. |
| Owner→user join | Email-based view, not `Association to Users` | Avoids large schema migration on `TutorialMeta`. |
| Email source | New `ownerEmail : String(255)` column on `TutorialMeta` | Additive; backfilled by one-off script. |
| Slug uniqueness | Reuse `/content/hashes` | Endpoint already exists; revisit `/author/slugs` only if draft reservation appears. |
| PR strategy | One PR with everything | Reversible at every layer; one HDI deploy avoids runtime/schema drift windows. |

## Architecture

### Section 1 — Schema change (additive)

Add a single nullable column to `TutorialMeta` so `Users` can be joined by email without converting `owner` to an Association. Existing data is untouched. Going forward, the IMS-import path and `syncTutorialMetadata` populate `ownerEmail` from `IMSTutorialMeta._links.owner.href`. A one-off backfill script resolves existing rows.

```cds
// db/schema.cds — TutorialMeta
entity TutorialMeta : cuid, managed, LegacyKeyed {  // `managed` added (Section 3c)
  tutorial             : Association to Tutorials;
  reviewedDate         : Timestamp;
  owner                : String(255);              // unchanged — display name
  ownerEmail           : String(255);              // NEW — join key to Users.email
  monitoredStatus      : String(50);
  notificationNumber   : Integer default 0;
  lastNotificationDate : Timestamp;
}
```

**Backfill:** `scripts/backfill-tutorial-meta-email.js`. Best-effort name match against `Users` (firstName + lastName, displayName). Unresolved rows logged to `.migration-data/ownerEmail-unresolved.csv` for human review. Idempotent — safe to re-run.

**Why a column, not a calculated element:** HANA can't index calculated elements. The view filters on this field on every read of `MyTutorials`. A real column is cheap and indexable.

**Why keep `owner` as free text:** display name and routing identity have different lifecycle requirements. Display names change (marriage, preferred-name updates); email is stable.

### Section 2 — AuthorService + email-joined view

A new service at `@path: '/author'`, gated on the `Tutorial.Author` scope (same scope `tutorials-srv-qa` already uses).

```cds
// srv/author-service.cds
using { com.sap.developers.ims as ims } from '../db/schema';

@path: '/author'
@requires: 'Tutorial.Author'
service AuthorService {

  // Read-only catalog projections
  @readonly entity Tutorials as projection on ims.Tutorials {
    ID, slug, title, primaryTag, status
  };
  @readonly entity Tags as projection on ims.Tags;

  // "My tutorials" — filtered to the calling user via before-READ handler
  @readonly entity MyTutorials as projection on ims.MyTutorialsView;

  // Author-scoped clones of the admin actions
  action reviewTutorial(tutorialId : UUID) returns {
    reviewedDate       : Timestamp;
    notificationNumber : Integer;
  };
  action snoozeTutorial(tutorialId : UUID, days : Integer) returns {
    lastNotificationDate : Timestamp;
    notificationNumber   : Integer;
  };
}
```

The view that powers `MyTutorials`:

```cds
// db/views.cds — additions
view MyTutorialsView as
  select from Tutorials as t
    inner join TutorialMeta as m on m.tutorial.ID = t.ID
    inner join Users        as u on u.email       = m.ownerEmail
  {
    key t.ID,
        t.slug,
        t.title,
        t.primaryTag,
        t.status,
        m.reviewedDate,
        m.monitoredStatus,
        m.notificationNumber,
        m.lastNotificationDate,
        m.owner       as ownerName,
        m.ownerEmail  as ownerEmail,
        u.ID          as ownerUserId
  };
```

**`$user` binding:** `srv/author-service.js` registers a `before('READ', 'MyTutorials')` handler that appends `where ownerEmail = req.user.id`. (XSUAA puts the email in `req.user.id` for SAP IDP users.) Sage's call stays clean: `GET /author/MyTutorials?$top=50`.

**Action ownership check:** The `reviewTutorial` and `snoozeTutorial` handlers validate that `tutorialId` belongs to `req.user.id` via the same view before delegating. The shared action implementation moves to `srv/lib/tutorial-review.js`; AdminService and AuthorService both call it. Admin behavior is unchanged.

**`inner join Users` is intentional:** Tutorials whose `ownerEmail` doesn't resolve to a known `Users` row are orphaned data and shouldn't appear in any author's `MyTutorials`. The backfill CSV surfaces them for human cleanup.

### Section 3 — Soft gaps

#### 3a. OData delta tracking

Annotate the high-volume read projections so Sage can opt into incremental sync via `Prefer: odata.track-changes`:

```cds
@Capabilities.ChangeTracking : { Supported: true }
@readonly entity Tutorials   as projection on ims.Tutorials { ID, slug, title, primaryTag, status };

@Capabilities.ChangeTracking : { Supported: true }
@readonly entity Tags        as projection on ims.Tags;

@Capabilities.ChangeTracking : { Supported: true }
@readonly entity MyTutorials as projection on ims.MyTutorialsView;
```

First response includes a `@odata.deltaLink`; Sage stores it (replacing `sync_status.last_sync_*`) and uses it for the next refresh. Clients that don't ask for `Prefer: odata.track-changes` get normal pagination — zero impact on existing consumers of `/admin/Tutorials`.

#### 3b. `/health/auth`

```js
// srv/server.js — bootstrap-time route, mounted before CAP services
app.get('/health/auth', cds.middlewares.before, (req, res) => {
  if (!req.user || req.user.id === 'anonymous') {
    return res.status(401).json({ authenticated: false });
  }
  res.json({
    authenticated: true,
    user:          req.user.id,
    scopes:        Array.from(req.user.roles ?? []),
    serverTime:    new Date().toISOString()
  });
});
```

No DB hit; replaces the current `getAllTutorials(0, 1)` in Sage's `testConnection()`. Returns granted scopes so Sage can detect "signed in but missing `Tutorial.Author`" and show actionable UI.

#### 3c. ETag / `managed` on `TutorialMeta`

Adding `managed` (Section 1) gives `createdAt`, `createdBy`, `modifiedAt`, `modifiedBy` for free. CAP emits `ETag` headers on managed entities, enabling `If-None-Match` / `304 Not Modified` for per-record polling. Side benefit: real audit trail for review actions (IMS lacked this — `reviewedDate` is what an author *says*, `modifiedAt` is what actually happened).

#### 3d. GitHub caches stay out of CAP

Recorded as a deliberate non-goal. Sage's `github_issues` / `github_prs` / `tutorial_issues` are GitHub-native; mirroring them server-side is the wrong layer. The Sage migration decides whether to keep them client-cached or call GitHub live.

## Testing

### Unit (`test/unit/author-service.test.js`)

In-memory SQLite. Cases:
- `MyTutorials` filters by `req.user.id` — seed two users, two metas; user A sees only their row.
- `MyTutorials` excludes orphaned data — meta with `ownerEmail` not in `Users` returns zero rows for any caller.
- `reviewTutorial` succeeds for owner, returns 403 for non-owner.
- `snoozeTutorial` accepts `days ∈ [1, 365]`, rejects out-of-range.
- `Tags` readable by `Tutorial.Author`, denied for anonymous.
- `/health/auth` returns 401 anonymous, 200 with scopes authenticated.

### Hybrid (`test/hybrid/author-service.test.js`)

Real HANA via `cds bind --exec`. Guarded by `ALLOW_HYBRID_WRITES=true`. `__TEST__` prefix; `afterAll` cleanup.
- `MyTutorialsView` returns rows for a seeded `__TEST__` user/email/meta triple on HANA.
- `Prefer: odata.track-changes` returns a `@odata.deltaLink` (smoke that delta is wired through to HANA).
- `managed` on `TutorialMeta` populates `modifiedAt` after `reviewTutorial` invocation.

### Smoke (`test/smoke/author-service.test.js`)

HTTP against deployed.
- `GET /author/Tutorials` → 401 without auth, 403 with auth but no `Tutorial.Author`.
- `GET /author/MyTutorials?$top=1` → returns the calling user's row when authenticated as a known author.
- `GET /health/auth` → returns calling user's scopes.

## Deployment

Single PR, single MTA deploy. File order in the PR (so the runtime sees the column when the service starts):

1. `db/schema.cds` — add `ownerEmail`, add `managed` to `TutorialMeta`
2. `db/views.cds` — add `MyTutorialsView`
3. `srv/lib/tutorial-review.js` — extract shared action logic
4. `srv/admin-service.js` — refactor to call shared module (no behavior change)
5. `srv/author-service.cds` + `srv/author-service.js`
6. `srv/server.js` — `/health/auth` route
7. `scripts/backfill-tutorial-meta-email.js` — one-off; checked-in dry-run output at `.migration-data/ownerEmail-unresolved.csv`
8. Tests (unit + hybrid + smoke)

`cds build` regenerates HDI artifacts; `mbt build && cf deploy` from `.deploy/` picks them up. The new column is nullable — `cf deploy` won't fail on existing rows.

**Role collection:** `Tutorial.Author` already exists in `xs-security.json` (used by `tutorials-srv-qa`). Authors who already have it for QA preview get `/author/*` access automatically. No xsuaa update needed.

## Rollback

Additive at every layer; rollback is staged:

- **Code rollback:** revert the PR. AdminService keeps `reviewTutorial`/`snoozeTutorial`. AuthorService disappears. `MyTutorialsView` becomes orphaned (harmless). Sage falls back to IMS until repointed.
- **Schema rollback:** leave `ownerEmail` and `managed` columns. They become inert (no code reads them post-revert). We do *not* drop columns on rollback — unnecessary risk for a successful failure.
- **Backfill rollback:** backfill writes only to the new `ownerEmail` column. Reverted deploy leaves backfilled data in place; harmless and saves work if we re-deploy.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Backfill resolves wrong `Users` row (name collision) | Match strictly: full firstName + lastName + displayName. Conflicts logged to CSV, not auto-resolved. Manual review before merging. |
| HANA `inner join` performance on `MyTutorialsView` | `ownerEmail` is small-cardinality (~50 authors) and `Users.email` is already indexed (used for login lookup). View runs on read of `/author/MyTutorials` only — not in any hot path. |
| `before('READ', 'MyTutorials')` filter bypassed via `$apply` or aggregate | CAP's before-handler runs for all read variants including `$apply`. Covered by unit test "user A sees only their row" using `$apply` query. |
| Action ownership check race (tutorial reassigned mid-call) | Re-resolve owner inside the action handler from the live view, not from a cached value. Same transaction. |
| Author has stale `Tutorial.Author` scope from removed access | `/health/auth` returns current scopes; Sage UI uses that to gate write affordances. No server-side change needed — XSUAA refreshes scopes on token refresh. |

## Out of scope (explicit non-goals, repeated for the reviewer)

- Sage-side rewrite of `imsClient.ts`.
- Dropping Sage's SQLite cache.
- `Association to Users` migration on `TutorialMeta.owner`.
- `/author/slugs` endpoint.
- IMS decommissioning.
- Mirroring GitHub issues/PRs into CAP.

## References

- Migration analysis: [docs/sage-extension-migration.md](../../sage-extension-migration.md)
- Preview endpoint design: [docs/superpowers/specs/2026-05-23-vscode-author-preview-design.md](2026-05-23-vscode-author-preview-design.md)
- QA channel bootstrap: [docs/qa-channel-bootstrap.md](../../qa-channel-bootstrap.md)
- Sage repo: [`sap-tutorials/sage-tutorial-extension`](https://github.com/sap-tutorials/sage-tutorial-extension)
