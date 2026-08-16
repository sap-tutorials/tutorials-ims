# Author access to the Admin UI (#1837)

## Symptom

Authors report the **Author Console does not load**. The browser network tab
shows:

```
GET https://developers.sap.com/admin/$metadata?sap-language=EN  403 (Forbidden)
```

## Root cause — this is by design, not a bug

`AdminService` is declared `@requires: 'Admin'` at the **service level**
(`srv/admin-service.cds`). CAP enforces service-level auth **first** for every
request to that service — including the initial `GET /admin/$metadata` the Fiori
runtime issues on load. A user must carry the `Admin` XSUAA scope or the request
is rejected with 403 before any entity is touched.

The `Tutorials Author` role collection grants only:

| Role collection            | Scopes granted (from `xs-security.json`) |
| -------------------------- | ---------------------------------------- |
| `Tutorials Author`         | `Tutorial.Author`, `Everyone`            |
| `Tutorials Admin`          | `Admin`, `KnowledgeGraph.Admin`, `DisplayApp`, `DeveloperApp`, `Everyone` |

So a user holding **only** `Tutorials Author` (the QA author-preview role that
gates `/tutorials-qa/*`) has no `Admin` scope and cannot reach the Admin UI.
The code comment at `srv/admin-service.cds` (~line 138) states this explicitly:

> "A Tutorial.Author-only user (without Admin) cannot reach this service …
> the admin user is provisioned (Admin + Tutorial.Author roles together)."

The `Admin` scope also gates sensitive surfaces (Secrets, Feature Flags, Data
Inspector, NGDS), so admin access is **granted individually**, not bundled into
the author role.

> **Note:** On PROD the collections are `(Prod)`-suffixed — `Tutorials Author
> (Prod)`, `Tutorials Admin (Prod)` — in the same `Tutorial System` subaccount
> (`3c6fa3f1-db8c-4e47-9048-fa8c84b867cb`). DEV/QA use the unsuffixed names.

## Fix — assign the `Tutorials Admin` role collection

No code or deploy is required. Grant the affected author(s) the `Tutorials
Admin` role collection in BTP. Granted users must **log out and back in** to
refresh their JWT before the console works.

### Manual (single author)

```bash
btp login
btp target -sa 3c6fa3f1-db8c-4e47-9048-fa8c84b867cb    # Tutorial System

# PROD:
btp assign security/role-collection "Tutorials Admin (Prod)" \
  --to-user someone@sap.com --of-idp sap.default
# DEV/QA: drop the (Prod) suffix.
```

Verify (per-user read is the source of truth — collection member counts lag):

```bash
btp --format json get security/user someone@sap.com | jq '.roleCollections'
```

### Repeatable helper — `scripts/grant-admin-to-authors.js`

Enumerates authors who are **not** already admins (the "affected-user list")
and — with `--commit` — grants them Admin. **Dry-run by default.**

```bash
# Preview the affected-user list, PROD collections, with a target sanity check:
node scripts/grant-admin-to-authors.js --prod --subaccount tutorial-system

# Grant a single named author individually:
node scripts/grant-admin-to-authors.js --prod --user someone@sap.com --commit

# Grant every author currently missing Admin (bulk):
node scripts/grant-admin-to-authors.js --prod --subaccount tutorial-system --commit
```

It refuses to run if the live `btp target` subdomain doesn't match
`--subaccount`, or if either role collection is absent (wrong subaccount /
forgot `--prod`). Assignments are idempotent, so re-running after a partial
failure is safe.

## Related

- 2026-07-23 PROD incident: `Tutorials Author (Prod)` was near-empty; same class
  of fix (assign the collections). The infinite-refresh-loop symptom of a 403
  was a separate app bug fixed in PR #1649.
- Cross-subaccount migration uses a different tool: `scripts/migrate-btp-roles.js`.
