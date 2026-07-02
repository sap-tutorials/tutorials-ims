# Migrating from the legacy Java IMS

Step-by-step runbook for moving reference data + user progress out of the
legacy `imsprod` system into the CAP backend without polluting
`sap.changelog.Changes` with thousands of bogus migration entries.

## Prerequisites

- `cf login` to the **target** subaccount (DEV / TEST / PROD).
- `IMS_BASE_URL` — usually the production IMS approuter URL.
- `CAP_BASE_URL` — the target CAP srv URL.
- `IMS_AUTH_TOKEN` — bearer token for the source IMS.
- Admin-role XSUAA token for the target CAP srv (e.g. via the bound migration tech user).

## Step 1 — Reference data

Export from IMS, import to CAP. The importer sends `x-migration-mode: true`
so change tracking is automatically suppressed for the duration of each
admin POST/PATCH.

```bash
npm run migrate:reference -- export
npm run migrate:reference -- import
node scripts/migrate-reference-data.js populate-slugs
```

The slug-population pass PATCHes `Missions.slug` and `CompletionPaths.slug` —
both are tracked entities; the same header suppresses changelog entries.

## Step 2 — User progress

```bash
npm run migrate:users -- export
npm run migrate:users -- import
```

Paged + resumable. The header is sent here too as defense-in-depth — none
of the user-progress entities (`Users`, `TaskRecords`, `AccomplishmentRecords`,
`PrizeRecords`) are `@changelog`-tracked today, but if any are added in the
future the migrator is already guarded.

## Step 3 — Direct HANA-to-HANA (alternate to step 1)

```bash
npm run migrate:hana
```

> ⚠️ **Known gap.** On HANA, `@cap-js/change-tracking` deploys
> `AFTER INSERT/UPDATE/DELETE` triggers at the DB level. Direct
> `hdb`-driver writes (which is what `migrate-from-hana.js` does) DO
> fire those triggers — the per-request `x-migration-mode` header
> only protects the REST migrators (Steps 1+2). Until the script is
> updated to set `SESSION_CONTEXT('ct.skip') = 'true'` on its target
> session, prefer Steps 1+2, OR truncate `sap.changelog.Changes`
> after the run with a one-shot SQL `DELETE` scoped by `createdAt` or
> `createdBy`. Followup ticket recommended; explicitly out-of-scope of #394.

### Noise cleanup for un-tracked entities (#658)

Nine entities had their `@changelog` annotation dropped after the admin
Change History tile was flooded with no-delta entries:

- Configuration singletons: `ChatSettings`, `KnowledgeGraphSettings`,
  `UiEventsSettings`, `TenantSettings`, `DisplaySettings`,
  `SearchSettings`, `NavigatorSettings` — each had a `before('READ')`
  auto-init handler that INSERTed a default row on first read, tripping
  the AFTER INSERT trigger.
- AI-generated KG tables: `Concepts`, `ConceptEdges` — the
  extract-concepts cron does delete-then-insert on every run, producing
  thousands of trigger-fired rows per tick.

Historical noise is purged automatically once per deploy via
`autoPurgeOnce` in [srv/lib/purge-stale-changelog.js](../../../srv/lib/purge-stale-changelog.js),
held behind a `JobLocks` sentinel. To re-run the purge ad-hoc (e.g. if
the entity list grows in a future PR), call the
`AdminService.purgeNoiseChangeLog(entities)` OData action.

Spec: [2026-06-26-658-changelog-noise-cleanup-design.md](../../superpowers/specs/2026-06-26-658-changelog-noise-cleanup-design.md).

## Audit logging

`Users` is `@PersonalData`-annotated (`db/audit-logging.cds`). The
`@cap-js/audit-logging` plugin still emits read/write events on personal
data during migration — this runbook does NOT suppress those. Expected
volume is small (one event per user-create); if that becomes a problem,
file a follow-up.

## Verification

After the migration completes, count rows added to `sap.changelog.Changes`
during the migration window. The expected delta for the migrated entities
is **zero** (excluding any concurrent admin UI activity).

```bash
# Snapshot before; run migration; snapshot after; subtract.
# Example (cds bind --exec; uses ESM via --input-type=module):
npx cds bind --exec -- node --input-type=module -e "
  import cds from '@sap/cds';
  await cds.connect.to('db');
  const Changes = cds.entities['sap.changelog.Changes'];
  const since = process.argv[1];
  const rows = await SELECT.from(Changes).where({ createdAt: { '>=': since } });
  console.log(rows.length + ' changelog rows since ' + since);
" -- "$(date -u -Iseconds)"
```

## See also

- [BTP role migration](btp-role-migration.md)
- Spec: `docs/superpowers/specs/2026-06-18-394-disable-change-tracking-during-migration-design.md`
- Hybrid test (proves the suppression works on real HANA): [`test/hybrid/migration-mode.test.js`](../../../test/hybrid/migration-mode.test.js)

## Step 4 — Backfill tutorial authorship

After `migrate-user-progress.js` (Step 2) succeeds, the `Users` table is populated. Step 1 has already loaded `Tutorials`, `TutorialContributors`, and `TutorialMeta`. **Run the authorship backfill so existing tutorials and contributors get linked to the corresponding Users rows.**

Spec: [`docs/superpowers/specs/2026-06-24-tutorial-authorship-fk-design.md`](../../superpowers/specs/2026-06-24-tutorial-authorship-fk-design.md).

```bash
# Dry run — review the orphans report at .migration-data/tutorial-author-backfill-<ts>.json
npx cds bind --exec -- node scripts/backfill-tutorial-authors.cjs

# Commit (npm script alias for --commit)
npm run migrate:authors
```

What the backfill does:

- Builds a `LOWER(TRIM(email)) → Users.ID` map once (warns on duplicate-email Users rows; picks lexicographically-first ID).
- **Phase A** — for every `TutorialContributors` row with `user_ID IS NULL AND email IS NOT NULL`, looks up the email in the map. Hit → `UPDATE … SET user_ID = ? WHERE ID = ? AND user_ID IS NULL`. Miss → orphan entry in the report.
- **Phase B** — for every `Tutorials` row with `author_ID IS NULL`, resolves the primary author via the shared [`srv/lib/resolve-tutorial-author.js`](../../../srv/lib/resolve-tutorial-author.js) resolver: (a) prefer contributors with `role IN ('author','owner')` ordered by `createdAt`, (b) fallback to first contributor, (c) fallback to `TutorialMeta.ownerEmail`. First map-hit wins.
- Writes the full report to `.migration-data/tutorial-author-backfill-<ISO-timestamp>.json` — summary counts, warnings (duplicate user emails), orphan rows by contributor and by tutorial (with the candidate emails tried).

The backfill is **idempotent** and **non-destructive**:

- Every UPDATE is gated by `WHERE …_ID IS NULL`. Re-running with no schema changes produces zero updates.
- Re-running after a fresh `migrate-user-progress.js` batch arrives picks up the new matches automatically.
- Manual admin corrections (a future spec — admin UI for editing authorship) are NEVER overwritten by either the backfill or the live publish path's `linkTutorialAuthorship` step.

Orphans (contributors / tutorials whose email isn't in `Users`) stay null and are listed in the JSON report for manual review.

### See also (Step 4)

- Hybrid test (pins the runbook order on real HANA): [`test/hybrid/migration-runbook-order.test.js`](../../../test/hybrid/migration-runbook-order.test.js)
- Backfill script: [`scripts/backfill-tutorial-authors.cjs`](../../../scripts/backfill-tutorial-authors.cjs)
- Pure resolver (shared with the live publish path): [`srv/lib/resolve-tutorial-author.js`](../../../srv/lib/resolve-tutorial-author.js)

## Step 5 — Full-mirror resync of `TutorialMeta.owner` / `ownerEmail` (#862 reopen)

**When to run:** DEV or PROD's `TutorialMeta.owner`/`ownerEmail` is stale
against live IMS. Symptom Riley reported ([#862 comment
2026-07-02](https://github.com/sap-tutorials/tutorials-ims/issues/862#issuecomment-4867834304)):
`GET /author/MyOwnedTutorials` returns tutorials whose ownership was
reshuffled in legacy IMS since the initial Jan-2025 backfill snapshot.

**What it does:** Re-reads `IMS_TUTORIAL_META JOIN IMS_TUTORIAL_AUTHOR`
from live IMS and OVERWRITES DEV's `OWNER` and `OWNEREMAIL` row-by-row.
Unlike Step 4's [`scripts/backfill-tutorial-meta-from-ims.cjs`][backfill],
this uses a full-mirror UPDATE (not `COALESCE`) — so if IMS reassigned
ownership to a different author, DEV catches up. Admin corrections
made via the admin UI post-migration WILL be overwritten (per Tom's
decision on the reopen thread: live IMS is ground truth until the
July 2026 cutover).

**Tutorials with no IMS row are skipped.** New tutorials published
after Jan-2025 don't have a corresponding IMS entry; the now-fixed
publish path ([PR #920][pr920]) is authoritative for those. No NULL
is invented where IMS is silent.

**Fields NOT touched:** `REVIEWEDDATE`, `NOTIFICATION_*`, `REPOSITORY_ID`.
Those have different provenance; touching them would need its own
authority argument.

```bash
# Prereqs
export IMS_HANA_CREDENTIALS=$(cat .migration-data/ims-creds.json)
export CAP_HANA_CREDENTIALS=$(cat .migration-data/cap-dev-creds.json)

# Dry-run — writes .migration-data/resync-tutorial-meta-from-ims.dryrun.csv
node scripts/resync-tutorial-meta-from-ims.cjs --dry-run --verbose

# Review the CSV (grep for the tutorials you care about, sanity-check the
# "will-overwrite" set, confirm the summary counts feel right for the
# blast radius you expected).

# Commit within 60 minutes of the dry-run — the script enforces the mtime
# gate to prevent stale-CSV commits.
node scripts/resync-tutorial-meta-from-ims.cjs --commit \
  --initiator "scripts/resync-tutorial-meta-from-ims@$(whoami)"
```

The CSV columns:

- `bucket` — `will-overwrite` | `already-matches` | `no-target-row`
- `tut_legacy_id` — the legacy IMS ID (matches the URL pattern `id=<n>` in
  legacy prod IMS's redirect links)
- `target_tutorial_uuid` — the DEV `Tutorials.ID` derived deterministically
  via `uuidv5(String(legacyId), NAMESPACES.tutorial)`
- `current_owner`, `current_ownerEmail` — what DEV had before the resync
- `new_owner`, `new_ownerEmail` — what IMS says today. `NULL` when IMS's
  join returns `EMAIL=NULL`, when the email is a `@sap-tutorials.local`
  synthetic bot address, or when it's a `@users.noreply.github.com`
  placeholder that could NOT be resolved via `Users.githubLogin` (see
  next paragraph)
- `resolved_from_noreply` — `yes` when the new value was derived by
  parsing a `<userid>+<login>@users.noreply.github.com` placeholder,
  looking `<login>` up in `Users.githubLogin`, and writing the matched
  `Users.email`. Blank when the email came through unchanged.
- `ims_raw_email` — the raw value from IMS (useful when the resolver
  chose to null-out or transform: this column shows what was rejected
  or how the transformation was seeded)

**`@users.noreply.github.com` resolution (PR C).** GitHub's default commit
email is `<userid>+<login>@users.noreply.github.com` (modern) or
`<login>@users.noreply.github.com` (pre-2017). Live IMS returns this
verbatim for authors who never set a corporate email in their GitHub
profile — Riley's case for tutorial `15733` was
`10248021+rbrainey@users.noreply.github.com`. The resync parses out the
`<login>` segment (case-insensitive) and looks it up in DEV's
`Users.githubLogin → Users.email` map (built once at script startup from
`COM_SAP_DEVELOPERS_IMS_USERS WHERE githubLogin IS NOT NULL`). Match →
that user's corporate email is written to `TutorialMeta.ownerEmail`; no
match → the row is treated as no-signal (written NULL).

For Riley's `MyOwnedTutorials` to show `tutorial-first-steps` after the
resync, DEV's `Users` row for Riley MUST have `githubLogin = 'rbrainey'`
AND `email = 'riley.rainey@sap.com'`. If either is missing, the resync
NULLs out `ownerEmail` for tutorial 15733 and Riley sees zero rows on
his panel. The `resolved_from_noreply` column in the CSV is what you
audit here — a summary count is also printed at the top.

### Post-commit verification

1. **Riley's list should now be 1 row.** Hit
   `https://tutorial-system-dev-tutorials-srv.cfapps.eu10-005.hana.ondemand.com/author/MyOwnedTutorials`
   as Riley and confirm exactly the tutorial legacy prod IMS attributes to
   him today (currently `tutorial-first-steps` — "Get to Know SAP Tutorials",
   legacyId `15733`).
2. **Any admin who set `ownerEmail` via the admin UI post-migration** may
   see their value gone. If they push back, the correct response is: the
   admin UI edit was inconsistent with live IMS; either update IMS
   upstream or re-apply the correction post-resync (a follow-on cutover
   task will formalize CAP as the source of truth after the July 2026
   PROD cutover).
3. **Users with an unresolved `@users.noreply.github.com` in IMS** will
   see their `MyOwnedTutorials` empty on DEV until either: (a) their
   `Users.githubLogin` gets populated (login-side; new logins auto-set;
   older Users need `scripts/seed-users-github-login.cjs`), OR (b) the
   tutorial gets re-published so the publish path's frontmatter
   resolution fills `ownerEmail` from `author_profile`.

### See also (Step 5)

- Script: [`scripts/resync-tutorial-meta-from-ims.cjs`](../../../scripts/resync-tutorial-meta-from-ims.cjs)
- Unit test (kind-agnostic, pure decision logic): [`scripts/__tests__/resync-tutorial-meta-from-ims.test.ts`](../../../scripts/__tests__/resync-tutorial-meta-from-ims.test.ts)
- Publish-path fix that made the resync safe to run: [PR #920][pr920]
- ADR 0006 §2026-07-02 update: [`docs/decisions/0006-authorship-vs-ownership-semantics.md`](../../decisions/0006-authorship-vs-ownership-semantics.md)

[backfill]: ../../../scripts/backfill-tutorial-meta-from-ims.cjs
[pr920]: https://github.com/sap-tutorials/tutorials-ims/pull/920

## Step 6 — Migrate IMS_DASHBOARD_MONITOR_RECORD to CAP TutorialMonitors (#923)

**When to run:** DEV or PROD is missing the personal watch-list rows that
drive Sage's "My Tutorials" panel. Symptom: users open Sage and see an
empty panel even though they explicitly monitor tutorials in legacy IMS.

**What it does:** Reads `IMS_DASHBOARD_MONITOR_RECORD JOIN IMS_TUTORIAL_META
JOIN IMS_USER` from live IMS, resolves each `(user_id, tutorial_meta_id)`
pair against DEV via `Users.sapId ↔ IMS_USER.SAP_ID` and
`Tutorials.legacyId ↔ IMS_TUTORIAL_META.tutorial_id`, and INSERTs rows
into `TutorialMonitors`. Idempotent via `uuidv5(sourceRowId, NS.tutorialmonitor)`
and the `@assert.unique.userTutorial : [user, tutorial]` constraint.

**Orphan handling (per Tom, 2026-07-02):** if `Users.sapId` or
`Tutorials.legacyId` doesn't resolve on the DEV side, SKIP + log to CSV.
Do NOT create placeholder Users rows. Safer than inventing identities;
users log in via SAP IDP and their row gets JIT-provisioned — after
that, they can toggle monitor status from Sage and the row appears in
`TutorialMonitors` naturally.

**Prereqs:**

- The `TutorialMonitors` table must exist in the target HDI container
  (i.e., PR #923 has been deployed via MTA or `cds deploy`). Otherwise
  the migrator errors with "invalid table name".
- CF login to both the target (`tutorial-system/dev/eu10-005`) for the
  service key AND briefly to the source (`Developer Destination_IMS/PROD`
  in `us30`) to read `imsprod` env vars (`DB_USERNAME=IMSDBUSER`,
  `DB_PASSWORD=<...>`, `DB_URL=...?currentschema=IMSDBUSER`). See Step 4's
  IMS credential paragraph for the standard pattern.

```bash
# Stage creds (same shape as Step 4/5)
cf target -o "Developer Destination_IMS" -s PROD                       # source
cf env imsprod | awk '...extract DB_USERNAME/DB_PASSWORD/DB_URL...'    # to .migration-data/ims-creds.json

cf target -o tutorial-system -s dev                                     # target
cf service-key tutorials-hana tutorials-hana-key                        # to .migration-data/cap-dev-creds.json

# Dry-run — writes .migration-data/migrate-dashboard-monitors.dryrun.csv
export IMS_HANA_CREDENTIALS=$(cat .migration-data/ims-creds.json)
export CAP_HANA_CREDENTIALS=$(cat .migration-data/cap-dev-creds.json)
node scripts/migrate-dashboard-monitors.cjs --dry-run --verbose

# Review the CSV. Sanity-check "will-insert" count against expected row
# count (legacy IMS TutorialMeta grid + "monitor" column has this signal
# but no bulk export; N per active-author is the rough estimate).

# Commit within 60 minutes
node scripts/migrate-dashboard-monitors.cjs --commit \
  --initiator "scripts/migrate-dashboard-monitors@$(whoami)"

# Cleanup
rm .migration-data/ims-creds.json .migration-data/cap-dev-creds.json
```

CSV columns: `bucket`, `source_row_id`, `tut_legacy_id`, `user_sap_id`,
`target_tutorial_uuid`, `target_user_uuid`, `monitor_row_uuid`. Buckets:

- `will-insert` — both sides resolved; row will be created
- `orphan-tutorial` — `IMS_TUTORIAL_META.tutorial_id` has no matching
  `Tutorials.legacyId` in DEV. Common when the source tutorial was
  renamed/deleted between the initial migration and now, or when the
  slug got case-shifted (see [tutorial-slugs-are-lowercase-canonical]
  gotcha in CLAUDE.md).
- `orphan-user` — `IMS_USER.SAP_ID` has no matching `Users.sapId` in
  DEV. Common when a user never logged into DEV via SAP IDP
  post-migration — their row hasn't been JIT-provisioned. Not a bug
  in the migrator; they'll see their monitored tutorials once they
  log in and re-toggle.

### Post-commit verification

1. **Riley's My Tutorials should now match legacy IMS.** Hit
   `https://tutorial-system-dev-tutorials-srv.cfapps.eu10-005.hana.ondemand.com/author/MyOwnedTutorials`
   as Riley and confirm the same row(s) as legacy prod IMS.
2. **Sage adoption:** unchanged. Sage's `imsApiClient.ts` still calls
   `/author/MyOwnedTutorials` — same URL, new semantics, same JSON shape
   (minus the `bestPriority` column which Sage never read).
3. **Toggle test:** any authenticated Tutorial.Author caller can hit
   `POST /author/toggleMonitor` with `{"tutorialId": "<uuid>", "status": true}`
   to opt into watching a tutorial. Returns `true`. Second call same
   args also returns `true` (idempotent). Same call with `status: false`
   returns `false`, DELETEs the row.

### See also (Step 6)

- Script: [`scripts/migrate-dashboard-monitors.cjs`](../../../scripts/migrate-dashboard-monitors.cjs)
- Unit tests (pure decision logic): [`scripts/__tests__/migrate-dashboard-monitors.test.ts`](../../../scripts/__tests__/migrate-dashboard-monitors.test.ts)
- Hybrid test (entity + view + soft-delete filter): [`test/hybrid/tutorial-monitors.test.js`](../../../test/hybrid/tutorial-monitors.test.js)
- Java source that motivated the fix: `D:/projects/com.sap.developers.ims/application/src/main/java/com/sap/developers/ims/specifications/TutorialMetaSpecifications.java` lines 73-76
- ADR 0006 §2026-07-02b update: [`docs/decisions/0006-authorship-vs-ownership-semantics.md`](../../decisions/0006-authorship-vs-ownership-semantics.md)
