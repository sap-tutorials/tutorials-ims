# HCQL Support for Major Services — Design (#995)

**Issue:** [sap-tutorials/tutorials-ims#995](https://github.com/sap-tutorials/tutorials-ims/issues/995)
**Upstream:** [CAP 10 June 2026 — New HCQL Protocol Adapter](https://cap.cloud.sap/docs/releases/2026/jun26#new-hcql-protocol-adapter)
**Status:** Design approved by Tom on 2026-07-05, ready for implementation-plan.
**Author:** Tom (via Claude Code)

---

## 1. Goal

Expose SAP CAP's new **HCQL protocol adapter** (CQL over HTTP, shipped in CAP 10 June 2026, currently **beta**) on the read-heavy services in this project so AI agents and power users can send CQN/CQL queries directly instead of composing OData URLs. The change is annotation-only; no handler, schema, or MTA changes.

## 2. Scope

HCQL is enabled on **9 of 14** CAP services. Auth posture is inherited from each service's existing annotations — no new `@requires` or `@restrict` rules are added.

| Service | Path | Auth today | HCQL exposure |
|---|---|---|---|
| `AdminService` | `/admin` | XSUAA + `Admin` | Behind `Admin` scope |
| `AuthorService` | `/author` | XSUAA + `Tutorial.Author` | Behind `Tutorial.Author` scope |
| `AnalyticsService` | `/admin/analytics` | XSUAA + `Admin` | Behind `Admin` scope |
| `ExportsService` | `/admin/exports` | XSUAA + `Admin` | Behind `Admin` scope |
| `ConsolidationService` | `/consolidation` | XSUAA + `Admin` | Behind `Admin` scope |
| `KnowledgeGraphService` | `/graph` | Public (entities are `@readonly`) | Public |
| `HomepageService` | `/homepage` | Public + entity-level `@requires` for user-scoped bits | Public (per-entity guardrails carry over) |
| `SearchService` | `/search` | Public | Public |
| `DeveloperService` | `/developer` | Public | Public |

**Excluded** (not "major" for HCQL purposes, or wrong shape):

- `ChatService`, `DisplayService`, `EventStreamService` — WebSocket-only surfaces; HCQL has no meaningful mapping.
- `CronService` — empty service (no entities), purely a scheduling shim.
- `ScannerService` — function-based (`getContestant`, `claimPrize`); HCQL is entity-query oriented.

## 3. Non-goals

- **No new authorization gates.** Existing `@readonly`, `@requires`, `@restrict` posture is the boundary. HCQL inherits it from the CAP runtime.
- **No custom HCQL middleware, rate limiter, or query-cost estimator.** Beta feature; wait for real usage before adding infrastructure.
- **No env flag to toggle HCQL.** The kill switch is reverting the enablement file (see §4).
- **No write-path support.** CAP explicitly warns that only read operations are stable cross-runtime in beta. This project relies on that guarantee.

## 4. Architecture

### 4.1 Single central enablement file

New file: **`srv/hcql-enablement.cds`**

```cds
// #995 — enable CAP 10 HCQL protocol adapter on read-heavy services.
// Beta feature (see docs/developers/reference/hcql-support.md).
// Revert this file + `cds build --production` + redeploy to disable.

using AdminService from './admin-service';
using AuthorService from './author-service';
using AnalyticsService from './analytics-service';
using ExportsService from './exports-service';
using ConsolidationService from './consolidation-service';
using KnowledgeGraphService from './knowledge-graph-service';
using HomepageService from './homepage-service';
using SearchService from './search-service';
using DeveloperService from './developer-service';

annotate AdminService with @hcql;
annotate AuthorService with @hcql;
annotate AnalyticsService with @hcql;
annotate ExportsService with @hcql;
annotate ConsolidationService with @hcql;
annotate KnowledgeGraphService with @hcql;
annotate HomepageService with @hcql;
annotate SearchService with @hcql;
annotate DeveloperService with @hcql;
```

**Rationale for a central file rather than per-service inline annotations:**

- One reviewable diff — the entire HCQL footprint fits on one screen.
- One-file revert disables the feature cleanly if the CAP beta surfaces a regression.
- Consistent with the "hand-curated registration lists rot" gotcha in `MEMORY.md` only insofar as this list is derived from the service catalog. The operator doc (§6) lists the same 9 services, so drift is human-visible.

### 4.2 No config changes

CAP 10 Node.js activates the HCQL adapter as soon as any service is annotated `@hcql`. There is **no change** to:

- `package.json` `cds.protocols` — HCQL loads automatically on annotation.
- `xs-security.json` — same JWT, same scopes.
- `mta.yaml` — `srv/**/*.cds` glob picks the new file up.
- `db/schema.cds` or any HDI artifact — HCQL is a protocol adapter, not a data-model change.

### 4.3 URL shape

> **Post-implementation correction (2026-07-05):** Runtime discovery via `cds watch` showed the hypothesis below is wrong. The `/hcql` protocol prefix is ONLY prepended when a service's `@path` is *relative*. All 9 target services have absolute `@path` values (e.g. `/admin`, `/search`), so CAP mounts HCQL at the **same URL as OData** and dispatches by request-body shape (`{"SELECT":...}` → HCQL; else → OData). Content-Type is `application/json` — `application/cqn+json` crashes CAP 10.0.3's body parser. Full details in `docs/developers/reference/hcql-support.md`. The original hypothesis is preserved below for provenance.

~~Per the CAP protocol-adapter convention (parallel to `/odata/v4`, `/rest`, `/graphql`), the HCQL adapter mounts under the **`/hcql` base path** by default. Exact per-service URL shape is confirmed by `cds watch` output at implementation time; expected form is one of:~~

- ~~`POST /hcql<service-path>` — e.g. `/hcql/admin`, `/hcql/search`~~
- ~~`POST /hcql/<ServiceName>` — e.g. `/hcql/AdminService`~~

~~The implementation step will `cds watch` locally, capture the actual routes printed by the runtime, and use those in the reference doc. If the base path is configurable, it stays at the default `/hcql` (no `cds.protocols` override — see §4.2).~~

### 4.4 Data flow

```
Client                    AppRouter                 CAP HCQL adapter          Service handlers
  ├─ POST /hcql/admin  ────┤ JWT verified,          ├─ parses CQN JSON     ├─ existing @Before/@On/@After
  │  Content-Type:         │ Admin scope enforced   │  or CQL text body    │  handlers run unchanged
  │    application/cqn+json                         │                      │
  └─ body: { SELECT: ... }
                                                    └─ srv.run(query) — same code path as OData
```

The adapter is a **new URL shape** for existing services. All existing runtime plumbing — `@readonly` enforcement, `@requires` scope checks, audit logging, tracing, error mapping — fires exactly as it does for OData today. Zero handler code changes.

### 4.5 QA channel (`srv-qa`)

The QA app builds from the same `srv/` tree, so it will also receive HCQL. This is acceptable: QA is XSUAA + `Tutorial.Author`-gated, no additional public surface is created. No `srv-qa` cp-list audit needed (no new `srv/lib/` deps introduced).

## 5. Operator documentation

New file: **`docs/developers/reference/hcql-support.md`**

Contents:

1. **What HCQL is** — one paragraph plus upstream link.
2. **Beta status warning** — read-only stable, writes not guaranteed cross-runtime, protocol not yet fully specified.
3. **Enabled services table** — mirrors §2 above.
4. **Per-service curl examples** — 9 examples, one per service, using dev-env URLs. The exact per-service path is captured from `cds watch` output during implementation. Example (final path TBD from runtime):

   ```bash
   # AdminService.Tutorials — first 5 slugs + titles
   curl -X POST "https://tutorials-approuter-dev.cfapps.eu10-005.hana.ondemand.com/hcql/admin" \
     -H "Authorization: Bearer $JWT" \
     -H "Content-Type: application/cqn+json" \
     -d '{
       "SELECT": {
         "from":    { "ref": ["AdminService.Tutorials"] },
         "columns": [{ "ref": ["slug"] }, { "ref": ["title"] }],
         "limit":   { "rows": { "val": 5 } }
       }
     }'
   ```

5. **How to disable** — delete `srv/hcql-enablement.cds`, run `cds build --production`, `mbt build`, `cf deploy`.
6. **Known caveats** — writes unstable, Node.js accepts CQL text bodies (Content-Type `application/cql`), Java accepts JSON only.

Update **`CLAUDE.md`** "Top Gotchas" with a one-liner:

> **HCQL is enabled on 9 services (see `srv/hcql-enablement.cds`)** — CAP 10 beta protocol adapter; reference: [docs/developers/reference/hcql-support.md](docs/developers/reference/hcql-support.md). Kill switch: delete the enablement file, rebuild, redeploy.

## 6. Testing

**Per Tom's decision: doc examples only.** No dedicated Vitest test file.

Rationale:

- HCQL is a CAP protocol adapter — its correctness is CAP's responsibility, not ours.
- Auth posture is inherited from existing annotations, which are already covered by the auth tests in `test/unit/xs-security-authorities.test.js` and the hybrid smoke tests.
- The reference doc's 9 curl examples double as a manual smoke matrix an operator can run against the deployed dev env post-deploy.

**Post-deploy smoke check** (added to §5 doc):

- Anonymous curl to a public service (e.g. `POST /hcql/search`) → expect 200 + JSON.
- Anonymous curl to a scoped service (e.g. `POST /hcql/admin`) → expect 401.
- Authenticated curl to `/hcql/admin` without `Admin` scope → expect 403.

## 7. Error handling

No new error paths. HCQL surfaces errors through the same CAP `error` envelope OData uses; existing error mapping and audit-log integration cover it.

## 8. Deploy impact

- **`cds build --production`** — required after adding `srv/hcql-enablement.cds` per the schema-change gotcha in `MEMORY.md`. CSN changes even though no HDI artifacts change; `db/last-dev/` may update.
- **MTA:** no manifest edits. `srv/**/*.cds` glob catches the new file.
- **QA channel:** builds automatically; HCQL becomes available on `tutorials-srv-qa` too, gated by existing `Tutorial.Author` scope. No cp-list changes.
- **Rollback:** `git revert` the enablement-file commit, `cds build --production`, `mbt build`, `cf deploy`. ~15 minutes end-to-end.

## 9. Risks & mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| HCQL beta introduces protocol-breaking change in a subsequent CAP release | Medium | Kill switch is one revert. Track the CAP release notes; re-review at CAP 10.1. |
| Public-service query cost spikes from expensive CQN queries | Low | Public services already ship with `@readonly` projections and existing `@cds.query.limit.*` defaults. Monitor `cds_http_requests_total` (existing telemetry). If needed, add per-service limits in a follow-up. |
| CQL text bodies (Node.js only) create Java/Node.js drift for the QA channel or future dual-runtime plans | Low | Documented in §5 caveats. Project is Node.js-only today; no dual-runtime plans. |
| Write attempts against HCQL succeed in Node.js beta but fail in Java, creating unstable client contracts | Very low | We aren't shipping write clients. Doc explicitly says beta writes are unsupported. |

## 10. Deliverables checklist

- [x] `srv/hcql-enablement.cds` — 9 `annotate ... with @hcql;` lines.
- [x] `docs/developers/reference/hcql-support.md` — reference doc per §5.
- [x] `CLAUDE.md` — one-line entry in "Top Gotchas".
- [x] `cds build --production` run locally; commit any `db/last-dev/` delta if produced.
- [ ] PR opened; merge; MTA deploy to DEV.
- [ ] Post-deploy: run the 3-line smoke matrix from §6; paste results in the PR.
