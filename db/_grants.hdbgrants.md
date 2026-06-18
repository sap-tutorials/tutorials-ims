# `_grants.hdbgrants` — design notes

This file documents the design rationale for the SPARQL grants files:

- `db/src/_grants.hdbgrants` — **prod** channel; binds `tutorials-kg-grantor` only
- `db-qa/src/_grants.hdbgrants` — **qa** channel; binds `tutorials-kg-grantor-qa` only

Both are valid JSON, with one (and only one) top-level key naming the grantor service that's bound to that channel's deployer. The `.cdsrc.json` build config has separate tasks per channel (`{ "for": "hana", "src": "db", "dest": "db" }` and `{ "for": "hana", "src": "db-qa", "dest": "db-qa" }`); each task copies its own `src/_grants.hdbgrants` verbatim into `gen/<dest>/src/`, and `mta.yaml`'s two deployer modules point to those separate `gen/` paths.

## Why split per channel?

HDI's grants-file processor (`@sap/hdi-deploy`) iterates EVERY top-level key in `.hdbgrants` as a **required** bound-grantor service name. Two distinct ways this bites you:

1. **JSON `_comment_*` keys**: PR #403 originally embedded design-rationale comments as top-level `_comment_*` keys. HDI tried to look them up as services. Deploy failed with `service _comment_purpose not found`. Fix: PR #407 stripped the comment keys and moved the notes here.
2. **Cross-channel keys**: PR #403 also listed BOTH grantors (`tutorials-kg-grantor` AND `tutorials-kg-grantor-qa`) in a single shared `db/src/_grants.hdbgrants`. The original author hedged — "If empirical behaviour rejects unbound grantors, split into per-channel artefacts as a follow-up." Empirical behaviour DID reject them: the prod deployer fails at `service tutorials-kg-grantor-qa not found; the service definition does not exist` because the QA grantor isn't bound there. Fix: PR #409 split the file into prod-only / qa-only siblings, one per `cds build` task in `.cdsrc.json`.

Both bugs surface as "service X not found" errors; the cause differs.

## Purpose

Grants SPARQL system privileges to each HDI container's runtime user (`default_access_role`) so that `CALL SYS.SPARQL_EXECUTE` succeeds for the CAP service handlers in PR 4. See [docs/developers/architecture/hana-kge-access.md](../docs/developers/architecture/hana-kge-access.md) (Privileges required > HDI delivery) for the design rationale and [docs/developers/operations/kg-grantor-setup.md](../docs/developers/operations/kg-grantor-setup.md) for the per-environment DBADMIN + `cf cups` runbook that MUST be executed BEFORE these artefacts deploy cleanly.

Without (a) a grantor user holding `SPARQL QUERY`/`SPARQL UPDATE WITH ADMIN OPTION`, (b) a properly-shaped user-provided service (cups must include `tags: ["hana", "password"]` inside its credentials body — service-level tags are NOT enough; HDI reads `credentials.tags`), and (c) the relevant cups bound to the matching deployer in `mta.yaml`, the HDI deploy of these artefacts will fail. Verify with `cf env <deployer> | grep -A5 kg-grantor` — `credentials.tags` must show `["hana","password"]` in the binding.

## Field verification

Field names verified 2026-06-18 against the [@sap/hdi-deploy README](https://github.com/gregorwolf/SAP-NPM-API-collection/blob/b7d845b333ef166e2e404e36e9fdd112d20d26d6/apis/hdi-deploy/README.md). Confirmed:

- top-level keys = bound grantor service-names (one only, must match the channel's binding)
- grantee buckets = `object_owner` and `application_user`
- system-privileges field = `system_privileges` (snake_case, plural), shaped as an array of objects each with a `privileges` array (and optional `privileges_with_admin_option`). NOT a flat string array.

The architecture-doc sketch hedged this; the shape used in the files is the verified one. Cross-checked against [SAP-samples/hana-ml-samples](https://github.com/SAP-samples/hana-ml-samples/blob/main/Templates/BTP-App/CAP-App/db/src/hana-ml-grants.hdbgrants) for the multi-grantee structure.

## Grantee choice

Only `application_user` is populated. The HDI schema owner (`object_owner`) does not need SPARQL privileges — it issues DDL, not SPARQL. Granting to `application_user` causes HDI to add the privileges to `default_access_role`, which is auto-granted to the runtime user that CAP uses for `cds.connect.to('db')`.
