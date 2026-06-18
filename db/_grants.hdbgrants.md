# `_grants.hdbgrants` — design notes

This file documents the design rationale for `db/src/_grants.hdbgrants`. The notes used to live as `_comment_*` keys inline in the JSON; HDI's grants-file processor strictly iterates ALL top-level keys as bound-grantor service names, so the `_comment_purpose` key was looked up as a service and the deploy failed with `service _comment_purpose not found`. JSON has no comment syntax; for `.hdbgrants` files specifically, every top-level key MUST be a valid grantor service name. Caught 2026-06-18 on the first deploy after PR #403 landed.

## Purpose

Grants SPARQL system privileges to this HDI container's runtime user (`default_access_role`) so that `CALL SYS.SPARQL_EXECUTE` succeeds for the CAP service handlers in PR 4. See [docs/developers/architecture/hana-kge-access.md](../docs/developers/architecture/hana-kge-access.md) (Privileges required > HDI delivery) for the design rationale and [docs/developers/operations/kg-grantor-setup.md](../docs/developers/operations/kg-grantor-setup.md) for the per-environment DBADMIN + `cf cups` runbook that MUST be executed BEFORE this artefact deploys cleanly.

Without (a) a grantor user holding `SPARQL QUERY`/`SPARQL UPDATE WITH ADMIN OPTION` and (b) the user-provided service `tutorials-kg-grantor` (or `-qa`) bound to the relevant deployer in `mta.yaml`, the HDI deploy of this artefact will fail with insufficient-privilege errors.

## Field verification

Field names verified 2026-06-18 against the [@sap/hdi-deploy README](https://github.com/gregorwolf/SAP-NPM-API-collection/blob/b7d845b333ef166e2e404e36e9fdd112d20d26d6/apis/hdi-deploy/README.md). Confirmed:

- top-level keys = bound grantor service-names
- grantee buckets = `object_owner` and `application_user`
- system-privileges field = `system_privileges` (snake_case, plural), shaped as an array of objects each with a `privileges` array (and optional `privileges_with_admin_option`). NOT a flat string array.

The architecture-doc sketch hedged this; the shape used in the file is the verified one. Cross-checked against [SAP-samples/hana-ml-samples](https://github.com/SAP-samples/hana-ml-samples/blob/main/Templates/BTP-App/CAP-App/db/src/hana-ml-grants.hdbgrants) for the multi-grantee structure.

## Dual grantor

Two grantor keys are listed (one per environment) so the same artefact can be deployed by both `tutorials-db-deployer` (binds `tutorials-kg-grantor`) and `tutorials-db-qa-deployer` (binds `tutorials-kg-grantor-qa`). README text "For each grantor in the file, the HDI Deployer looks up a bound service with the name…" indicates the deployer iterates per-grantor, so a grantor whose service is not bound to the current deployer is expected to be a no-op (best understanding from public docs; verify on first dev deploy). If empirical behaviour rejects unbound grantors, split into per-channel artefacts (e.g. `_grants.prod.hdbgrants` / `_grants.qa.hdbgrants` gated by HDI features) as a follow-up.

## Grantee choice

Only `application_user` is populated. The HDI schema owner (`object_owner`) does not need SPARQL privileges — it issues DDL, not SPARQL. Granting to `application_user` causes HDI to add the privileges to `default_access_role`, which is auto-granted to the runtime user that CAP uses for `cds.connect.to('db')`.
