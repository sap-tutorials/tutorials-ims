# BTP role-collection migration

One-shot operator runbook: copy BTP role-collection user assignments from the legacy IMS Prod subaccount to the new tutorial-system subaccount.

## When to run

After a fresh deploy of the new subaccount has provisioned the empty role collections (`Tutorials Admin`, `Tutorials SuperAdmin`, etc.), but before tutorial admins/authors need to log in. The data-layer migration (tutorials, missions, user progress) can run before, after, or in parallel — it's independent.

## Prerequisites

- `btp` CLI v2.97.0+ (`btp --version`).
- Logged into both global accounts (one at a time): `btp login`.
- Read access on the IMS Prod subaccount (you need to be able to call `btp get security/role-collection NAME --show-user-assignments`).
- Write access on the tutorial-system subaccount (Subaccount Administrator or equivalent).

## Phase 1 — Discover

First export reveals the actual IMS-side collection names. The script ships with an empty `ROLE_COLLECTION_MAP`; this run tells you what to put in it.

```bash
btp login                                            # → IMS Prod global account
btp target -sa <ims-prod-subaccount-id>              # → IMS Prod subaccount
npm run migrate:btp-roles -- export
```

The script prints a `... discovered but UNMAPPED — add to ROLE_COLLECTION_MAP:` block on stdout listing every IMS Prod role collection that has no entry in the mapping; the same list is also persisted to the `discoveredButUnmapped` field of `.migration-data/btp-roles.json`. Search `scripts/migrate-btp-roles.js` for `ROLE_COLLECTION_MAP` (the commented examples there show the expected shape) — fill in an entry for each, commit, push, then re-run.

## Phase 2 — Export

Re-run with the populated mapping:

```bash
npm run migrate:btp-roles -- export
```

Eyeball `.migration-data/btp-roles.json`. Confirm:

- `source.subaccountId` matches the IMS Prod subaccount.
- Every expected role collection appears in `roleCollections`.
- `discoveredButUnmapped` is `[]` (or contains only collections you genuinely don't want to migrate).

## Phase 3 — Dry-run import

```bash
btp login                                            # → DevRel & Community Tools GA
btp target -sa <tutorial-system-subaccount-id>       # → tutorial-system subaccount
npm run migrate:btp-roles -- import --dry-run
```

Review the `[dry-run] would assign ...` lines. Every line you'd expect to see should be there. Note: dry-run does NOT write the import log file.

## Phase 4 — Real import

```bash
npm run migrate:btp-roles -- import --confirm
```

Re-runs are safe — the script classifies each user as `[ok]`, `[already]`, or `[FAIL]`, and re-running after a partial failure picks up only the assignments that didn't take.

Watch for `[FAIL]` lines. Per-call results are logged to `.migration-data/btp-roles-import.log.json`. The exact stderr is forwarded verbatim from the `btp` CLI; phrasing varies by version. Common categories:

| What you see | Likely cause | Fix |
|---|---|---|
| `[FAIL] ... user ... not exist` (or similar) | The user has never logged into the new GA's IDP, and `--create-user-if-missing false` blocks shadow creation. | Have the user log in once (creates the shadow user), then re-run. Re-run is idempotent — already-OK assignments are skipped. |
| `[FAIL] ... 403 ...` or `... permission ...` | The currently-targeted user lacks rights to assign on the target subaccount. | Verify your CLI session has Subaccount Administrator on the target. |
| `Target subaccount is missing these mapped role collections: ...` (script aborts BEFORE running) | The pre-flight detected a mapped target collection that doesn't exist on the target subaccount yet. | Run the MTA deploy to provision the role collections, or correct the mapping in `ROLE_COLLECTION_MAP` and re-export. |

The script exits 1 if any `[FAIL]` line is emitted (otherwise 0). CI wrappers can rely on the exit code to gate downstream steps.

## Phase 5 — Verify

```bash
npm run migrate:btp-roles -- verify
```

`Verify summary: 0 missing, N extra` is the success state. Non-zero "missing" → re-run `import --confirm` to retry, or address the underlying issue.

## Caveats

- `--show-user-assignments` only sees **directly-assigned** users. Group/attribute-mapped assignments do not appear in the export and need separate handling. (We don't believe IMS Prod uses any.)
- Audit trail on the new subaccount will record "migrated by Tom at the cutover date" for every assignment, not the original assignor. Acceptable for a cutover.
- IDP origin is preserved verbatim. Both subaccounts are expected to trust the same SAP IAS tenant on the same `--of-idp` origin. If that ever changes, add an origin-mapping step.

## Related

- Spec: [2026-06-17-btp-role-migration-design.md](../../superpowers/specs/2026-06-17-btp-role-migration-design.md)
- Sibling data-migration scripts: `migrate-reference-data.js`, `migrate-user-progress.js`
