# Cross-Container Integration (HDI ↔ HDI)

**Reusable playbook** for federating this system's HANA data with another CAP app that lives in the **same subaccount and same HANA instance but a different HDI container**. First worked example: the Devtoberfest Planner integration (`docs/superpowers/specs/2026-07-27-devtoberfest-cross-container-design.md`).

Read this when a second BTP app in the subaccount needs to read our tables/views, or we need to read theirs. It captures the pattern and the *why* so each new link is a fill-in-the-blanks exercise, not a re-derivation.

---

## TL;DR

Two independently-deployed CAP apps share one HANA instance, each with its own HDI container. Neither container can see the other's objects by default. To share data:

1. **Provider** publishes a **versioned view** (`<DOMAIN>_<PURPOSE>_V<n>`) — its stable API surface. Never expose base tables.
2. **Provider** defines a least-privilege **`.hdbrole`** granting `SELECT` on that view — the role *is* the versioned API contract.
3. **Consumer** binds the provider's HDI container and uses **its technical user as grantor**. A `.hdbgrants` file requests the provider's role (`container_roles`) for the consumer's own roles.
4. **Consumer** declares a `.hdbsynonym` pointing at the provider view, then wraps it in a `@cds.persistence.exists` **CDS facade** (a proxy view) so the CAP layer sees a normal read-only entity.
5. First-time bring-up is **base-then-enable**: publish views + roles first (no cross-deps), then add grants + synonyms (targets now exist).

> **No `.hdbsynonymconfig` needed for HDI-to-HDI.** Grants + synonyms are sufficient; the synonym resolves through the granted role on the bound container. (`.hdbsynonymconfig` is only for externalizing/parameterizing synonym targets — an optional convenience, not a requirement here. Confirmed against the [XSA cross-container tutorial](https://tutorial-system-prod-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com/tutorials/xsa-cross-container-access), which works identically on CF + HANA Cloud.)

The link is directional. Bi-directional access = two independent legs, each following steps 1–4.

---

## Architectural decisions (the "why")

These are deliberate. Change them only with a good reason and an update here.

### D1 — Views/procedures are the ONLY cross-container API surface. Never base tables.

A consumer's synonym points at a **published view** (or stored procedure), never at a base table like `com_sap_developers_ims_Tutorials`.

- **Decoupling** — the provider can refactor, rename, or re-partition base tables without breaking any consumer, as long as the view's projection holds.
- **Least privilege** — the view exposes exactly the columns a consumer needs and filters rows server-side (e.g. only `status='ACTIVE'` tutorials). The consumer never sees the rest of the table.
- **Server-owned business rules** — the "what counts as published" predicate lives in the provider's view, not scattered across every consumer.

### D2 — Views are versioned: `<DOMAIN>_<PURPOSE>_V<n>`.

The published view name carries a version suffix (`TUTORIAL_VALUE_HELP_V1`). The API surface can evolve without breaking live consumers:

- **Non-breaking change** (add a nullable column): edit `_V1` in place.
- **Breaking change** (drop/rename/retype a column, tighten a filter): publish `_V2` **alongside** `_V1`, migrate the consumer's synonym + facade to `_V2`, then retire `_V1` once no consumer references it.
- A consumer adopts a new version by changing only its synonym + facade — two small files.

Track live versions in the [registry](#cross-container-link-registry) below.

### D3 — Direct cross-bind grantor + a provider-defined role. NOT a grantor user-provided-service.

The consumer's db-deployer `requires:` the **provider's HDI container instance directly** (as an `existing-service` in mta.yaml). HDI uses that bound container's own technical (object-owner) user as the grantor for the `.hdbgrants`.

**Grant via a named role, not direct object privileges.** The provider defines a least-privilege **`.hdbrole`** that grants `SELECT` on its published `_Vn` view(s); the consumer's `.hdbgrants` requests that role by name (`container_roles`). This keeps the API surface in one provider-owned place — adding a view to the shared contract means the provider edits its role, not every consumer's grants file. (The [XSA tutorial](https://tutorial-system-prod-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com/tutorials/xsa-cross-container-access) uses a broad `admin` role for illustration; **use a narrow, purpose-named reader role in real integrations** — the tutorial says as much.)

We do **not** wrap the grant credentials in a separate `user-provided-service` (the pattern used by `tutorials-kg-grantor` for SPARQL/`SYS` grants — see `hana-kge-access.md`). That indirection exists only because `SYS` isn't a bindable container. **Container-to-container is a first-class HDI case**: both sides are real HDI containers, so binding one from the other is cleaner, has no extra secret to rotate, and no extra UPS resource to keep in sync.

### D4 — `@cds.persistence.exists` facade entities expose synonyms to CAP.

A raw synonym is invisible to the CAP model. On top of each synonym we define a CDS entity annotated `@cds.persistence.exists` — CAP treats it as an existing DB object (no CREATE emitted) and can project/serve it read-only. This is the "proxy view" layer. Generate it from the live view with `hana-cli` rather than hand-typing column types (see [Recipe step C3](#consumer-side)).

### D4a — Names must match the DEPLOYED HANA object EXACTLY, including case. Alias in the view to make them match.

**CDS names do not equal deployed HANA names.** The CDS compiler mangles case and formatting — `namespace.Entity` becomes `namespace_Entity`, and a plain CDS element name may deploy as an upper-cased or quoted identifier depending on how it was authored. A `@cds.persistence.exists` proxy binds **by exact string match** to the physical object and column names — **case-sensitive**. A one-character or case mismatch means the proxy silently fails to resolve (or resolves to nothing), with no compile error.

Consequences for this pattern:

1. **Never assume the CDS source name is the deployed name.** Always introspect the *deployed* container (`hana-cli`) to read the true physical object + column names and their case, then model the synonym and facade against those.
2. **The published view is where you fix mismatches.** When the provider's physical names don't line up with what a clean CDS proxy wants (e.g. mixed-case base columns, awkward generated names), **alias objects and columns in the view** using quoted identifiers so the view exposes exactly the names the proxy expects:
   ```sql
   VIEW "TUTORIAL_VALUE_HELP_V1" AS
     SELECT "ID"          AS "ID",
            "SLUG"        AS "slug",
            "TITLE"       AS "title",
            "PRIMARYTAG"  AS "primaryTag"
     FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALS"
     WHERE "STATUS" = 'ACTIVE' OR "STATUS" IS NULL
   ```
   > **Source-side identifiers use the deployed catalog case (UPPERCASE for unquoted-DDL tables); output aliases are the proxy contract.**

   The view is the compatibility shim between messy physical names and the proxy contract — another reason all cross-container access goes through a view (D1), not a base table.
3. **The synonym target and the facade entity/element names must all agree** with the view's exposed names, character-for-character and case-for-case.

Verify before wiring the facade: run a `hana-cli` inspect against the deployed view and copy the names verbatim; do not retype from memory or from the CDS source.

### D5 — Provider-first, base-then-enable deploy sequencing.

A synonym fails to deploy if its target view doesn't exist yet. So first-time bring-up publishes **views only** (Phase 1, zero cross-deps), then adds **grants + synonyms** (Phase 2, targets now exist). See [Bootstrap](#first-time-bootstrap-the-hard-part). Steady-state redeploys are order-independent because both views persist.

### D6 — Store the foreign key AND a denormalized label snapshot.

When a consumer stores a provider's row key (e.g. a Tutorial `ID` on a planner Session), it has **no cross-container FK enforcement** — the provider can retire that row anytime. Store the GUID **plus** a denormalized snapshot of the human label (slug/title) captured at pick-time, so the consumer UI still renders something meaningful if the source row later disappears. The live value help resolves current rows; the snapshot is the fallback.

---

## The repeatable recipe

Generic steps. Substitute your provider/consumer names. `PROVIDER` = the app publishing data; `CONSUMER` = the app reading it.

### Provider side

**P1 — Publish a versioned view.** In `db/src/<DOMAIN>_<PURPOSE>_V1.hdbview` (or a `.cds` view that compiles to HANA), select exactly the columns to expose, filtered to the rows allowed out:

```sql
-- db/src/TUTORIAL_VALUE_HELP_V1.hdbview
VIEW "TUTORIAL_VALUE_HELP_V1" AS
  SELECT "ID", "SLUG" AS "slug", "TITLE" AS "title", "PRIMARYTAG" AS "primaryTag"
  FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALS"
  WHERE "STATUS" = 'ACTIVE' OR "STATUS" IS NULL
```

That's the entire provider view obligation. No grants, no knowledge of who consumes it. (If you prefer a CDS-authored view, define it in the db model and let `cds build` emit the `.hdbview` — but keep the physical name version-suffixed.)

**P2 — Define ONE least-privilege reader role per provider (not per view).** In `db/src/<provider>_reader.hdbrole`, grant `SELECT` on the published view(s). Name it for the **provider domain** — `tutorial_reader`, `devtoberfest_reader` — NOT for a single view (`tutorial_value_help_reader` is an anti-pattern). This role is the durable API contract consumers request; as you publish more `_Vn` views, add them to this same role's `object_privileges` — every existing consumer picks up the new view without touching its own grants file. One role, many views, grown over time:

```json
// db/src/tutorial_reader.hdbrole
{
  "role": {
    "name": "tutorial_reader",
    "object_privileges": [
      { "name": "TUTORIAL_VALUE_HELP_V1", "type": "VIEW", "privileges": [ "SELECT" ] }
    ]
  }
}
```

Add views to the shared surface by editing this role — consumers need no change.

### Consumer side

**C1 — Bind the provider container + request its role.** The consumer's db-deployer gains a `requires:` on the provider's HDI container (an `existing-service`), and a `.hdbgrants` keyed by that bound service name requests the provider's reader role for the consumer's own roles:

```jsonc
// db/src/<provider>-grants.hdbgrants   (top-level key = the bound provider service name)
{
  "tutorials-hana": {
    "object_owner":     { "container_roles": [ "tutorial_reader" ] },
    "application_user": { "container_roles": [ "tutorial_reader" ] }
  }
}
```

- `object_owner` — lets the consumer's own views/procedures build on the synonym at deploy time.
- `application_user` — lets the CAP runtime read it.
- The role is **least-privilege** (SELECT on specific views only) — defined once, provider-side (P2).

> ⚠️ **Every top-level key in a `.hdbgrants` must be a genuinely bound service**, or the whole deploy fails with "service not found". Comment keys and unbound keys break it. This is why C1's grant and the mta `requires:` are a single unit — see `db/_grants.hdbgrants.md` for the same rule applied to the SPARQL grantor.

**C2 — Declare the synonym.** Point a plain local name at the external view:

```jsonc
// db/src/TUTORIAL_VALUE_HELP_V1.hdbsynonym
{
  "TUTORIAL_VALUE_HELP_V1": {
    "target": { "object": "TUTORIAL_VALUE_HELP_V1" }
  }
}
```

The synonym resolves through the role granted on the bound container — no explicit schema and **no `.hdbsynonymconfig` needed** for HDI-to-HDI. (`.hdbsynonymconfig` only externalizes the target for parameterization; skip it unless you have a reason.)

**C3 — Generate the `@cds.persistence.exists` facade.** Once the synonym resolves, introspect the **deployed** view (never the CDS source — see D4a) to emit the CDS proxy with the exact physical names/case rather than hand-typing it:

```bash
# via hana-cli (bound to the consumer container): emit a CDS proxy for the synonym/view
hana-cli inspectView --view TUTORIAL_VALUE_HELP_V1 --output cds
# or the MCP tool hana_inspect_table / hana_inspectView with output: "cds"
```

Land the result in `db/external/<provider>.cds`:

```cds
// db/external/tutorials.cds
namespace external.tutorials;

@cds.persistence.exists
entity TutorialValueHelpV1 {
  key ID        : String(36);
      slug      : String(255);
      title     : String(255);
      primaryTag: String(255);
}
```

**C4 — Project it read-only in a service** and wire whatever consumes it (a value help, a JOIN, a report). Keep the projection `@readonly` — the facade is a proxy over another container's data.

---

## First-time bootstrap (the hard part)

Bi-directional links create a **mutual `requires`**: each db-deployer binds the other's container, and each synonym needs the other's view to already exist. You cannot bring both up in one cold atomic deploy. Split into phases:

```
Phase 0  Both container instances exist, service-names PINNED on both sides.
         (A CF-autogenerated container name can't be referenced by the other project —
          pin `service-name:` on the hdi-container resource in mta.yaml.)

Phase 1  BASE — publish views + reader roles only. No grants, no synonyms. Zero cross-container
         deps, so each side deploys cleanly and independently.
         ├─ provider A  → publish A's view + reader role
         └─ provider B  → publish B's view + reader role   (if bi-directional)

Phase 2  ENABLE — add grants + synonyms + facades. Targets now exist, so they resolve.
         ├─ consumer of A → hdbgrants + synonym + facade → A's view
         └─ consumer of B → hdbgrants + synonym + facade → B's view

Phase 3  VERIFY — probe each synonym with a real SQL read (hana-cli) BEFORE trusting
         the CAP facades. A resolvable synonym returning rows is the gate.
```

**Steady state:** after bootstrap, both views persist, so ordinary redeploys are order-independent. The base-then-enable split is only needed for the first link and whenever you add a *new* leg.

**Practical tip:** keep the Phase-2 artifacts (grants + synonym + facade) as a self-contained, revertable set. If a synonym wedges a deploy, removing those files returns the container to a clean Phase-1 state.

---

## Gotchas

- **Unpinned `service-name` breaks referenceability** — a container whose instance name CF auto-generated can't be named by the other project's `requires:`. Pin `service-name:` on both `com.sap.xs.hdi-container` resources.
- **Synonym target missing → loud deploy failure** — deploy the provider view first (D5). The error names the unresolved synonym; the fix is ordering, not a code change.
- **Name/case mismatch → SILENT proxy failure** — unlike a missing synonym, a `@cds.persistence.exists` proxy whose names don't match the deployed object exactly (including case) fails quietly, not with a compile error (D4a). Introspect the deployed container with `hana-cli` and copy names verbatim; alias in the view to force a match.
- **`.hdbgrants` unbound-key failure** — every top-level key must map to a bound service (see C1 warning).
- **Broaden/narrow the API surface via the role, not the grant** — add or remove a view from a consumer's reach by editing the provider's `.hdbrole`; consumers keep requesting the same role name and pick up the change on next deploy. Never enumerate individual object privileges in a consumer's `.hdbgrants`.
- **Use a narrow reader role, never `admin`** — the linked tutorial grants `admin` for brevity; real integrations define a purpose-named least-privilege role (SELECT on the specific `_Vn` views only).
- **No cross-container FK** — the facade is read-only and enforces nothing; a stored foreign key can dangle when the provider retires the row (D6 — store a label snapshot).
- **Dropping a `_Vn` view breaks live synonyms** — follow the versioning policy (D2): add `_V2`, migrate, retire `_V1`.
- **QA/other channels** — grant only the containers actually in scope. Extra channels (e.g. `tutorials-hana-qa`) don't automatically participate; wire them explicitly if needed.
- **This repo's dual mta.yaml** — changes to `mta.yaml` must mirror into `.deploy/mta.yaml` (see `mta-deployment.md`).

---

## Cross-container link registry

Every active cross-container link. Update on add/version-bump/retire.

| Provider container | Published view | Consumer container | Consumer facade | Version | Status | Feature |
|---|---|---|---|---|---|---|
| `tutorials-hana` | `TUTORIAL_VALUE_HELP_V1` | `devtoberfest-planner-db` | `external.tutorials.TutorialValueHelpV1` | V1 | planned | Session tutorial value help |
| `devtoberfest-planner-db` | `ACTIVITY_SESSION_V1` | `tutorials-hana` | `external.devtoberfest.ActivitySessionV1` | V1 | planned (no consumer yet) | reciprocal leg, reserved |

---

## References

- Feature spec (worked example): `docs/superpowers/specs/2026-07-27-devtoberfest-cross-container-design.md`
- CAP: [Add existing SAP HANA objects from other HDI containers](https://cap.cloud.sap/docs/guides/databases/hana-native#add-existing-sap-hana-objects-from-other-hdi-containers)
- HDI grants/synonyms mechanics: [`@sap/hdi-deploy`](https://www.npmjs.com/package/@sap/hdi-deploy)
- Worked cross-container walkthrough (role-based grants, no synonymconfig; XSA but identical on CF + HANA Cloud): [XSA cross-container access tutorial](https://tutorial-system-prod-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com/tutorials/xsa-cross-container-access)
- Real cross-container sample project (mine for exact `.hdbgrants`/`.hdbrole`/`.hdbsynonym` syntax): [SAP-samples/hana-opensap-cloud-2020](https://github.com/SAP-samples/hana-opensap-cloud-2020)
- Existing grantor-UPS pattern (contrast, D3): `docs/developers/architecture/hana-kge-access.md`, `docs/developers/operations/kg-grantor-setup.md`, `db/_grants.hdbgrants.md`
- Deploy runbook: `docs/developers/operations/mta-deployment.md`
