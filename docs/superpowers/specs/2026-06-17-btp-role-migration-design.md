# BTP Role-Collection Migration

**Date:** 2026-06-17
**Status:** Design — pending implementation
**Author:** Tom (with Claude)
**Related:** [project_btp_subaccount_migration](../../../../C:/Users/I809764/.claude/projects/d--projects-tutorials-poc/memory/project_btp_subaccount_migration.md), [migrate-reference-data.js](../../../scripts/migrate-reference-data.js), [migrate-user-progress.js](../../../scripts/migrate-user-progress.js)

## Why

The data-layer migration from IMS Prod (US/GCP) to the new `tutorial-system` subaccount (EU/AWS, in the DevRel & Community Tools global account) is complete — tutorials, missions, events, user progress have all moved over. **One thing did not move: BTP role-collection assignments.** The new subaccount has the role collections defined (via `xs-security.json` in the MTA deploy), but no users are assigned to them. Without this, admins can't reach `/admin-ui/`, authors can't preview QA content at `/tutorials-qa/*`, and event staff can't use `/scanner-ui/`.

The cutover plan needs a one-shot script that copies role-collection user assignments from IMS Prod to the new subaccount, mirroring the export → import shape of the existing data-migration scripts.

## Scope

**In scope:**

- Read all role collections on the IMS Prod subaccount with their **directly-assigned** users (i.e. what `btp get security/role-collection NAME --show-user-assignments` returns).
- Map IMS-side role-collection names to the new subaccount's role-collection names (`Tutorials Admin`, `Tutorials SuperAdmin`, `Tutorials Author`, `Tutorials Developer`, `Tutorials Display`, `Tutorials Scanner` — see [.deploy/xs-security.json](../../../.deploy/xs-security.json)).
- Write each `(user, role-collection)` assignment to the new subaccount via the BTP CLI.
- Skip BTP-built-in collections (`Subaccount Administrator`, `Cloud Connector Administrator`, etc.) — they are managed independently by the new global account.
- Preserve IDP origin verbatim (both subaccounts use the same SAP IAS tenant on the same `--of-idp` origin per Tom's confirmation).
- Provide dry-run preview, confirm-required writes, and a post-import verify step.

**Out of scope:**

- Group-mapped or attribute-mapped role-collection assignments. `--show-user-assignments` returns only direct assignments. If IMS Prod uses IDP group/attribute mapping for any collection (it shouldn't — admins were assigned by hand for years), those would need separate handling.
- Cross-IDP origin remapping. Not needed.
- Re-implementing the BTP CLI's underlying XSUAA / SCIM API calls. The CLI is the supported boundary.
- Automatic retry/backoff. Re-runs are idempotent (the `assign` CLI returns OK for existing entries).
- A GUI / admin-UI button. One-shot operator action; UI would rot.

## Architecture

One new script — **`scripts/migrate-btp-roles.js`** (ES module, mirrors the style of `migrate-reference-data.js` and `migrate-user-progress.js`) — with three subcommands:

```bash
# Phase 1: pull from IMS Prod global account
btp login                                       # → IMS Prod GA, target the IMS subaccount
node scripts/migrate-btp-roles.js export        # writes .migration-data/btp-roles.json

# Phase 2: push to new tutorial-system subaccount
btp login                                       # → DevRel & Community Tools GA, target tutorial-system
node scripts/migrate-btp-roles.js import --dry-run    # preview only
node scripts/migrate-btp-roles.js import --confirm    # actually write

# Phase 3: peace-of-mind diff
node scripts/migrate-btp-roles.js verify        # re-reads target, diffs against export
```

All three subcommands operate on whatever subaccount `btp target` currently points at. No credentials are stored — auth is the existing interactive `btp login` session, exactly like the other migration scripts and the day-to-day `cf login` flow.

### Data flow

```text
IMS Prod subaccount (US/GCP)
  └─ btp get security/role-collection ... --show-user-assignments --format json
       └─ scripts/migrate-btp-roles.js export
            └─ .migration-data/btp-roles.json    ← gitignored, hand-reviewed

tutorial-system subaccount (EU/AWS)
  └─ btp assign security/role-collection ... --to-user ... --of-idp ... --format json
       └─ scripts/migrate-btp-roles.js import --confirm
            └─ .migration-data/btp-roles-import.log.json   ← per-call status

  └─ btp get security/role-collection ... --show-user-assignments --format json
       └─ scripts/migrate-btp-roles.js verify
            └─ stdout diff (missing-from-target, extra-on-target)
```

### Role-collection mapping

A hard-coded constant at the top of the script:

```js
// IMS Prod role collection name → new tutorial-system role collection name.
// Edit this table if either side renames a collection. The export step
// will fail loudly if a discovered source collection isn't listed here.
const ROLE_COLLECTION_MAP = {
  // Filled in after the first `export` run reveals the actual IMS-side names.
  // Skeleton (to be confirmed against IMS Prod):
  // 'IMS Admin':         'Tutorials Admin',
  // 'IMS SuperAdmin':    'Tutorials SuperAdmin',
  // 'IMS ContentAuthor': 'Tutorials Author',
  // 'IMS Developer':     'Tutorials Developer',
  // 'IMS Display':       'Tutorials Display',
  // 'IMS Scanner':       'Tutorials Scanner',
};

// Built-in BTP collections that the new GA already manages — never copied.
const SKIP_BUILTIN_PREFIXES = [
  'Subaccount ',
  'Cloud Connector ',
  'Connectivity ',
  'Destination ',
];
```

**Discover-first pattern.** The first `export` run dumps every discovered collection into the JSON output with `discoveredButUnmapped: [...]` and exits with a clear message: *"Found N role collections on source. Add mappings to ROLE_COLLECTION_MAP for each one before running import."* This is preferred over guessing IMS-side names up front — once Tom confirms the table, future re-runs (or a different source subaccount) just work.

## Components

### `scripts/migrate-btp-roles.js`

Single-file ES module. Subcommands dispatched by `argv[2]`. Shared helpers:

- **`runBtp(args, { timeoutMs = 30_000 })`** — spawns `btp` via `child_process.spawn`, always with `--format json` injected, returns `{ ok, data, stderr, exitCode }`. Never throws — callers decide how to handle nonzero exits. The binary is `process.env.BTP_BIN || 'btp'` so tests can swap in a fake.
- **`getCurrentTarget()`** — calls `btp --format json target` (or falls back to parsing text output if JSON isn't supported on that command), returns `{ subaccountId, subdomain, globalAccountSubdomain }`.
- **`listRoleCollections()`** — `btp --format json list security/role-collection`, returns `[{ name, description, ... }]`.
- **`getRoleCollectionUsers(name)`** — paginates `btp --format json get security/role-collection NAME --show-user-assignments --page N`, returns `[{ user, origin }]`. Stops when a page has fewer than 500 entries.
- **`assignUser(roleCollection, user, origin)`** — `btp --format json assign security/role-collection NAME --to-user EMAIL --of-idp ORIGIN --create-user-if-missing false`. Returns `{ status: 'ok' | 'already' | 'failed', message }`. The "already assigned" case is detected from the CLI's stdout/stderr message text.

### Subcommand: `export`

1. Capture target context via `getCurrentTarget()`. Record `subaccountId`, `subdomain`, `globalAccountSubdomain` in the output JSON.
2. List collections. For each: skip if matches `SKIP_BUILTIN_PREFIXES`; flag `discoveredButUnmapped` if no entry in `ROLE_COLLECTION_MAP`; otherwise fetch user assignments.
3. Write `.migration-data/btp-roles.json`:
   ```json
   {
     "schemaVersion": 1,
     "exportedAt": "2026-06-17T…Z",
     "source": {
       "globalAccount": "<ga-subdomain>",
       "subaccountId": "…",
       "subaccountSubdomain": "imsprod"
     },
     "roleCollections": [
       {
         "sourceName": "IMS Admin",
         "description": "…",
         "users": [
           { "user": "joe@sap.com", "origin": "sap.default" }
         ]
       }
     ],
     "discoveredButUnmapped": [],
     "skippedBuiltins": ["Subaccount Administrator"]
   }
   ```
4. Print summary: `Exported N collections, M total assignments. K unmapped (see discoveredButUnmapped).`
5. Empty collections (zero assignments) are still recorded with `users: []` — that's information.
6. Read failures (network, expired session) cause an immediate exit-1 with the failing collection name. No retries on the read path; re-run from scratch.

### Subcommand: `import`

Pre-flight checks (all must pass, fail fast on any):

- `.migration-data/btp-roles.json` exists.
- Either `--dry-run` or `--confirm` is set (not both, not neither).
- `getCurrentTarget()` succeeds.
- `target.subaccountId !== source.subaccountId` from the export — guards against the two-`btp login` workflow getting muddled.
- Every mapped target collection name (right-hand side of `ROLE_COLLECTION_MAP`) exists on the target subaccount. Missing mapped target = typo → fail fast with the missing names.

Per-assignment loop:

- For each `roleCollection` in the export:
  - `targetName = ROLE_COLLECTION_MAP[sourceName]`.
  - For each `{user, origin}`:
    - `--dry-run`: print `[dry-run] would assign "<targetName>" to <user> (origin=<origin>)`.
    - `--confirm`: call `assignUser(targetName, user, origin)`. Append `{collection, user, origin, status, message}` to a running log.
  - 100 ms sleep between calls. Sequential — `btp` CLI session/state is not parallel-safe.

End-of-run summary written both to stdout and to `.migration-data/btp-roles-import.log.json`:

```text
Import summary (target subaccount: tutorial-system <id>)
  Collections processed: 6
  Assignments OK:        47
  Already-assigned:       3
  Failed:                 2     ← see .migration-data/btp-roles-import.log.json for details
```

Exit code: 0 if zero failures; 1 if any failed.

### Subcommand: `verify`

1. Read `.migration-data/btp-roles.json` (the source export).
2. Run the same export logic against the **current** `btp target` (which should be the *target* subaccount).
3. For each mapped collection, compute three sets:
   - **In source, not in target** — assignments that didn't make it.
   - **In target, not in source** — extra assignments (likely fine, but flagged).
   - **In both** — successfully migrated.
4. Print a per-collection diff. Exit 0 if every "in source, not in target" set is empty; exit 1 otherwise.
5. Pure read; no writes.

## Error handling

Two failure classes:

| Class | Examples | Behavior |
|---|---|---|
| **Pre-flight** | `btp` not installed, not logged in, source == target subaccount, missing target collection, missing export file | Exit 1 immediately. No partial work. Clear error message naming the specific failure. |
| **Per-assignment** | One user lookup fails, transient 5xx, malformed entry in export | Logged with full `btp` CLI stderr to `.migration-data/btp-roles-import.log.json`. Counted. Loop continues. Exit 1 at the end if any failed; 0 otherwise. |

`runBtp` never throws on nonzero exit — every caller checks `result.ok` and decides. The 30-second per-call timeout exists because BTP control plane is normally sub-second; >30 s means something is wedged and we'd rather fail loudly.

The "already assigned" CLI response is treated as success (status `already`) because the CLI documents idempotent assignment but we don't fully trust the docs to match the runtime — defensive parse of the stdout/stderr message text.

`--create-user-if-missing false` is set deliberately on every `assign` call. If a user really doesn't exist on the target IDP, we want a loud failure (and a row in the log), not a silent shadow-user creation that papers over a typo in the export.

## Testing

No conventional unit tests for the script itself — it's an operator tool with subprocess side effects, and mocking around `child_process.spawn` ends up testing the mock more than the logic.

Two layers instead:

1. **Fixture-driven dry-run smoke test** at `test/scripts/migrate-btp-roles.dry-run.test.js` (runs in the existing `unit` Vitest project):
   - Writes a synthetic `.migration-data/btp-roles.json` with 2 collections and 5 users.
   - Sets `BTP_BIN=node test/scripts/fake-btp.cjs` pointing at a tiny Node script that pretends to be `btp` (echoes canned JSON for `target`, `list`, `get`, `assign`; exits 0).
   - Runs `node scripts/migrate-btp-roles.js import --dry-run`.
   - Asserts: stdout contains 5 `would assign` lines, target-collection-existence pre-flight passes, exit code 0.
2. **Manual hybrid run** by Tom: dry-run against the new tutorial-system subaccount with the real export → eyeball the output → real run with `--confirm` → `verify`. The dry-run is the protection.

The `BTP_BIN` env-var seam (defaults to `'btp'`) is the only thing that makes the script testable. It's invisible in normal use.

## Documentation

- New runbook at **`docs/developers/operations/btp-role-migration.md`**, sibling to the other operator runbooks. Covers: when to run, prerequisites (two-step `btp login`), the export → review → dry-run → confirm → verify cadence, what to do when the export discovers unmapped collections, what failed-assignment messages mean.
- Mention in [CLAUDE.md](../../../CLAUDE.md) under the "Data Migration" subsection so future-Claude knows the script exists.
- Sidebar entry in `docs/.vitepress/config.ts` so the `predocs:build` guard accepts the new page.

## Open items / known limitations

- **Discover-first.** First export run will reveal the actual IMS-side role-collection names. `ROLE_COLLECTION_MAP` is filled in based on that output, then committed.
- **Group/attribute-mapped assignments are invisible** to `--show-user-assignments`. If we discover IMS Prod uses any group/attribute mapping, that's a separate (out-of-scope) concern.
- **Audit trail.** BTP records who assigned a role collection. With this script, that audit log will show "Tom @ 2026-06-17" for every migrated assignment, not the original assignor. Acceptable for a cutover; mentioned in the runbook for the record.
- **Reversibility.** No automatic rollback. If the import goes wrong (e.g. wrong target subaccount), reverting is `btp unassign security/role-collection ... --to-user ...` per row, which is exactly what the script could re-script if needed. Not building it speculatively.
