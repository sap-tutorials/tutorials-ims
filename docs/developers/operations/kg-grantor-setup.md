# Knowledge-graph SPARQL grantor — per-environment setup

> Operations runbook for PR [#381](https://github.com/sap-tutorials/tutorials-ims/issues/381).
> Required reading before deploying the knowledge-graph data model (PR 2 of 8).

## Why this exists

The HDI deployer cannot grant the SPARQL system privileges it does not itself
hold transitively. The canonical SAP-supported pattern is the
**`.hdbgrants` + grantor-service** flow:

1. A HANA user (the *grantor*) is created once per environment by `DBADMIN`
   and given `SPARQL QUERY` and `SPARQL UPDATE` `WITH ADMIN OPTION`.
2. The grantor's credentials are wrapped in a Cloud Foundry user-provided
   service (`tutorials-kg-grantor` / `tutorials-kg-grantor-qa`).
3. That service is bound to the HDI deployer module in
   [`mta.yaml`](../../../mta.yaml). At deploy time, the grants plug-in inside
   `@sap/hdi-deploy` reads the channel's `_grants.hdbgrants`
   ([`db/src/_grants.hdbgrants`](../../../db/src/_grants.hdbgrants) for prod;
   [`db-qa/src/_grants.hdbgrants`](../../../db-qa/src/_grants.hdbgrants) for
   QA), connects as the grantor named there, and `GRANT`s the two SPARQL
   privileges to the container's `default_access_role` (which is in turn
   auto-granted to the runtime user that CAP uses for `cds.connect.to('db')`).

A **direct `GRANT … TO <runtime-user>` is the anti-pattern** — the runtime
user is owned by HDI and re-created on container redeploy, so out-of-band
grants do not survive. See
[hana-kge-access.md § Privileges required](../architecture/hana-kge-access.md#privileges-required)
for the full design rationale.

The runbook below is a **one-time setup per environment** (DEV, QA, PROD).
Once the grantor user exists and the user-provided service is bound, the
grants flow runs on every subsequent `cf deploy` of the MTA without any
ops involvement.

## Prerequisites

- `cf` CLI installed and authenticated to the target subaccount/space
- A HANA Cloud SQL endpoint reachable as `DBADMIN` (via SAP Cockpit's
  Database Explorer, `hdbsql`, or any other administrative SQL client)
- The HANA host + port for the target HDI container (find via
  `cf service-key tutorials-hana <some-key>` if you have one bound)
- A strong, generated password for the grantor user (recommended: a 32-char
  random string from a password manager — the grantor never logs in
  interactively, only the platform binds it)

## Step 1 — Create the grantor user (DBADMIN, one-time)

Connect to the HANA Cloud instance as `DBADMIN`. The grantor user name is
arbitrary; the convention this project uses is `TUTORIALS_KG_GRANTOR` (or
`TUTORIALS_KG_GRANTOR_QA` for the QA channel).

```sql
-- DEV / PROD
CREATE USER TUTORIALS_KG_GRANTOR
  PASSWORD <strong-password>
  NO FORCE_FIRST_PASSWORD_CHANGE;

GRANT "SPARQL QUERY"  TO TUTORIALS_KG_GRANTOR WITH ADMIN OPTION;
GRANT "SPARQL UPDATE" TO TUTORIALS_KG_GRANTOR WITH ADMIN OPTION;
```

For the QA channel, repeat against the QA HANA instance (which may be the
same physical instance — the grantor is per-HANA, not per-CF-space):

```sql
CREATE USER TUTORIALS_KG_GRANTOR_QA
  PASSWORD <strong-password-qa>
  NO FORCE_FIRST_PASSWORD_CHANGE;

GRANT "SPARQL QUERY"  TO TUTORIALS_KG_GRANTOR_QA WITH ADMIN OPTION;
GRANT "SPARQL UPDATE" TO TUTORIALS_KG_GRANTOR_QA WITH ADMIN OPTION;
```

Capture for the next step:

- Username (`TUTORIALS_KG_GRANTOR` / `_QA`)
- The chosen password
- The HANA Cloud host (e.g. `<guid>.hana.prod-eu10.hanacloud.ondemand.com`)
- The SQL port (e.g. `443` for HANA Cloud, or the resolved port from a
  `cf service-key` for the HDI container)

> **Why `WITH ADMIN OPTION`?** HDI cannot delegate a privilege it does not
> hold transitively. Without `WITH ADMIN OPTION`, the deploy fails with
> `insufficient privilege: Not authorized for system privilege …`.

## Step 2 — Bind the user-provided service in CF

Make sure your CF target is correct **before** running this — `cf target`
should show the right org/space (DEV vs PROD vs QA). Targeting the wrong
space is the single most-common foot-gun on this codebase; double-check.

```bash
cf target -o <org> -s <space>

# The -t "hana,password" tags are REQUIRED — both of them. The `hana` tag
# tells @sap/hdi-deploy's grants plug-in this is a HANA-backed grantor;
# the `password` tag tells it this is a basic-auth (user/password)
# binding rather than a certificate-based one. Without BOTH, the HDI
# deploy fails with a confusing "no grantor service bound" /
# "missing required tags" error rather than honouring the binding from
# mta.yaml. Tag spelling is comma-separated, no spaces.
cf cups tutorials-kg-grantor -t "hana,password" -p '{
  "user":     "TUTORIALS_KG_GRANTOR",
  "password": "<password>",
  "host":     "<hana-host>",
  "port":     "<hana-port>",
  "schema":   "DBADMIN",
  "driver":   "com.sap.db.jdbc.Driver",
  "url":      "jdbc:sap://<hana-host>:<hana-port>?encrypt=true&validateCertificate=true"
}'
```

For the QA grantor (in the same or a different space, depending on your
deployment topology):

```bash
cf cups tutorials-kg-grantor-qa -t "hana,password" -p '{
  "user":     "TUTORIALS_KG_GRANTOR_QA",
  "password": "<password-qa>",
  "host":     "<hana-host-qa>",
  "port":     "<hana-port-qa>",
  "schema":   "DBADMIN",
  "driver":   "com.sap.db.jdbc.Driver",
  "url":      "jdbc:sap://<hana-host-qa>:<hana-port-qa>?encrypt=true&validateCertificate=true"
}'
```

> **If you already created the services without `-t "hana,password"`** (or with a
> minimal credentials shape), update them in place instead of recreating:
>
> ```bash
> cf uups tutorials-kg-grantor    -t "hana,password" -p '{ ...same JSON as above... }'
> cf uups tutorials-kg-grantor-qa -t "hana,password" -p '{ ...same JSON as above... }'
> ```
>
> The HDI deployer reads tags + credentials at deploy time, so a fresh
> `cf deploy` after `cf uups` picks up the corrected shape.

> **Service-name spelling matters.** The names `tutorials-kg-grantor` and
> `tutorials-kg-grantor-qa` are referenced verbatim from
> [`mta.yaml`](../../../mta.yaml) (resources block) and from
> [`db/src/_grants.hdbgrants`](../../../db/src/_grants.hdbgrants) (top-level
> keys). Renaming requires updating all three.

> **`schema` field is informational** — HDI does not connect to a schema
> when issuing system grants (system privileges are global), but `@sap/hdi-deploy`
> includes the schema in the connection string regardless. `DBADMIN` is the
> safe default.

Verify the service exists and looks right:

```bash
cf services | grep tutorials-kg-grantor
cf service tutorials-kg-grantor   # confirms last-update timestamp
```

## Step 3 — Deploy the MTA so the grants flow runs

The HDI deployer reads `_grants.hdbgrants` only at deploy time. After
binding the user-provided service, trigger a deploy:

```bash
cd .deploy && mbt build && cf deploy mta_archives/*.mtar -e ../deploy/dev.mtaext -f
```

Watch the deployer logs for the grants step (look for lines mentioning
`tutorials-kg-grantor` and `SPARQL QUERY` / `SPARQL UPDATE`):

```bash
cf logs tutorials-db-deployer --recent | grep -i 'grant\|sparql'
```

A successful first run prints something like
`Granting "SPARQL QUERY" to default_access_role` (exact phrasing depends on
the `@sap/hdi-deploy` version).

## Step 4 — Verify the runtime user can call SPARQL

Re-run the spike probe shipped in PR 1. It is the canonical end-to-end smoke
test for the grants flow:

```bash
cf login   # if not already
npx cds bind --exec --profile hybrid -- node scripts/spike/kg-probe.cjs
```

Expected output (exit 0):

```text
[probe] connected. db.kind = hana
[probe] access path: CALL SYS.SPARQL_EXECUTE(?, ?, ?, ?)
[probe] CLEAR GRAPH (initial): ok in <N> ms
[probe] INSERT DATA (3 triples): ok in <N> ms
[probe] SELECT (2-hop): ok in <N> ms
[probe] CLEAR GRAPH (cleanup): ok in <N> ms
[probe] all operations succeeded.
```

If the probe still exits 2 with `PRIVILEGE BLOCKER: this user lacks SPARQL
QUERY`, see [Troubleshooting](#troubleshooting) below.

## Rotation runbook

When the grantor's password is rotated (recommended cadence: every 90 days
or per your org's password-rotation policy):

```bash
# 1. Rotate the password on the HANA side (DBADMIN)
ALTER USER TUTORIALS_KG_GRANTOR PASSWORD <new-strong-password> NO FORCE_FIRST_PASSWORD_CHANGE;

# 2. Update the user-provided service binding in CF.
#    Re-pass `-t "hana,password"` and the full credentials shape — `cf uups` overwrites,
#    not merges, so omitting either drops it from the binding.
cf uups tutorials-kg-grantor -t "hana,password" -p '{
  "user":     "TUTORIALS_KG_GRANTOR",
  "password": "<new-strong-password>",
  "host":     "<hana-host>",
  "port":     "<hana-port>",
  "schema":   "DBADMIN",
  "driver":   "com.sap.db.jdbc.Driver",
  "url":      "jdbc:sap://<hana-host>:<hana-port>?encrypt=true&validateCertificate=true"
}'

# 3. Restart any apps that consume this binding so they pick up the new VCAP_SERVICES.
#    The HDI deployer is a short-lived task (it re-reads the binding on each cf deploy),
#    so a redeploy of the MTA picks up the rotated credentials at the next deploy:
cd .deploy && mbt build && cf deploy mta_archives/*.mtar -e ../deploy/dev.mtaext -f

# Note: tutorials-srv does NOT need to be restarted - it never reads the grantor
# credentials directly, only the HDI deployer does.
```

The HDI grants are already issued and persisted in HANA — rotating the
grantor password does **not** revoke or re-issue grants, only changes who
can perform future grant operations.

For the QA channel, repeat with `tutorials-kg-grantor-qa`.

## Troubleshooting

### "User does not have SPARQL QUERY privileges" after deploy

Most common cause: the user-provided service is bound but its credentials are
wrong, or the grantor user does not actually hold `WITH ADMIN OPTION`.

Diagnostic checklist:

1. Confirm the service is bound:
   ```bash
   cf services | grep tutorials-kg-grantor
   ```
   Status should be `succeeded`.

2. Confirm the deployer module sees the binding:
   ```bash
   cf env tutorials-db-deployer | grep -A 20 tutorials-kg-grantor
   ```
   You should see the credentials block (with `password` redacted by CF).

3. Confirm the grantor holds the privileges with `WITH ADMIN OPTION`:
   ```sql
   SELECT * FROM SYS.GRANTED_PRIVILEGES
    WHERE GRANTEE = 'TUTORIALS_KG_GRANTOR'
      AND PRIVILEGE IN ('SPARQL QUERY', 'SPARQL UPDATE');
   ```
   `IS_GRANTABLE` must be `TRUE` for both rows.

4. Confirm the grants made it to `default_access_role`:
   ```sql
   SELECT * FROM SYS.GRANTED_PRIVILEGES
    WHERE GRANTEE = '<HDI-CONTAINER-PREFIX>::access_role'
      AND PRIVILEGE LIKE 'SPARQL%';
   ```
   Find the container prefix via `cf env tutorials-srv | grep schema`.

### "HDI deploy fails with grants error: insufficient privilege"

Almost always means the grantor user was created without `WITH ADMIN OPTION`
on the privileges. Re-run the `GRANT … WITH ADMIN OPTION` statements as
`DBADMIN` (they are idempotent — re-issuing is safe).

```sql
GRANT "SPARQL QUERY"  TO TUTORIALS_KG_GRANTOR WITH ADMIN OPTION;
GRANT "SPARQL UPDATE" TO TUTORIALS_KG_GRANTOR WITH ADMIN OPTION;
```

Then re-run `cf deploy`.

### "HDI deploy fails: cannot find grantor service"

The bound service-name in CF does not match a top-level key in the
channel's `_grants.hdbgrants`, or the wrong channel's artefact is being
shipped to the deployer. Confirm:

```bash
cf services | grep grantor                                          # what's bound

# Prod artefact must contain ONLY tutorials-kg-grantor (no -qa entry):
jq -c keys db/src/_grants.hdbgrants
# expect: ["tutorials-kg-grantor"]

# QA artefact must contain ONLY tutorials-kg-grantor-qa:
jq -c keys db-qa/src/_grants.hdbgrants
# expect: ["tutorials-kg-grantor-qa"]

grep -E 'service-name:\s*tutorials-kg-grantor' mta.yaml             # what mta.yaml declares
```

> **One grantor per channel.** Listing both grantors in a single
> `_grants.hdbgrants` causes HDI to demand bindings for both on every
> deployer — so the prod deployer fails with `service tutorials-kg-grantor-qa
> not found` even though it has no business binding the QA grantor.
> The fix is per-channel artefacts (one in `db/src/`, one in
> `db-qa/src/`); each `cds build` task copies its source `_grants.hdbgrants`
> verbatim into the channel's `gen/db/` or `gen/db-qa/` output, so the
> deployer ships only the grantor it needs.

All three must agree exactly. Renaming requires updating all three.

### "HDI deploy fails: grantor service is missing required tags / wrong shape"

Symptoms: deploy log mentions the grantor service but says it doesn't
look like a HANA service, or the deploy succeeds but no privileges are
actually granted to `default_access_role` (probe still exits 2).

Root cause: the user-provided service was created with `cf cups` but
without `-t "hana,password"`, or without the full HANA credentials shape (missing
`driver` / `url`). The grants plug-in looks for the `hana` tag to
identify HANA-backed grantors and inspects the credentials JSON for
JDBC connection fields.

Fix without recreating:

```bash
cf uups tutorials-kg-grantor -t "hana,password" -p '{
  "user":     "TUTORIALS_KG_GRANTOR",
  "password": "<password>",
  "host":     "<hana-host>",
  "port":     "<hana-port>",
  "schema":   "DBADMIN",
  "driver":   "com.sap.db.jdbc.Driver",
  "url":      "jdbc:sap://<hana-host>:<hana-port>?encrypt=true&validateCertificate=true"
}'
# repeat for tutorials-kg-grantor-qa
# then redeploy the MTA — the new binding shape is picked up at deploy time
cd .deploy && mbt build && cf deploy mta_archives/*.mtar -e ../deploy/dev.mtaext -f
```

Verify with `cf service tutorials-kg-grantor | grep tags` — must show
`tags: hana` (not empty).

### Spike probe still exits 2 after a successful deploy

The probe re-binds via `cds bind --exec --profile hybrid`, which uses the
HDI runtime user — not the grantor. If the deploy succeeded but the probe
fails, the grants may not have been applied to `default_access_role`. Run
the SQL diagnostic above (item 4 in the first troubleshooting block) and
attach the output to a comment on
[#381](https://github.com/sap-tutorials/tutorials-ims/issues/381).

## See also

- [hana-kge-access.md § Privileges required](../architecture/hana-kge-access.md#privileges-required)
  — design rationale for the grants flow
- [hdi-deploy-checklist.md](hdi-deploy-checklist.md)
  — general HDI deploy gotchas
- [mta-deployment.md](mta-deployment.md)
  — full MTA deploy procedure
- [`db/src/_grants.hdbgrants`](../../../db/src/_grants.hdbgrants)
  — the prod artefact this runbook backs
- [`db-qa/src/_grants.hdbgrants`](../../../db-qa/src/_grants.hdbgrants)
  — the QA artefact (sibling, gates the QA grantor for the QA channel only)
- [`scripts/spike/kg-probe.cjs`](../../../scripts/spike/kg-probe.cjs)
  — the canonical smoke test
