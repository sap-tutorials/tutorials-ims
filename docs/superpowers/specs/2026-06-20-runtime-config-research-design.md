# Runtime config + secret rotation — research

**Issue:** [#444](https://github.com/sap-tutorials/tutorials-ims/issues/444) — Research: move runtime-tunable env vars to a DB-backed admin UI (with sub-idea: how to track and rotate access keys)

**Date:** 2026-06-20

**Status:** Research only. The deliverable is this doc plus follow-up implementation issues. No production code changes in this PR.

---

## TL;DR

1. **Adopt the per-domain typed-singleton pattern** that [`ChatSettings`](../../../srv/admin-service.cds) already uses. Each runtime-tunable concern (KG, Search, Navigator, AI-Author, UI-Events, etc.) gets its own 1-row CDS entity with typed columns. Resolvers layer DB row → env-var → hardcoded default, identical in shape to [`srv/lib/chat-settings-resolver.js`](../../../srv/lib/chat-settings-resolver.js). One admin tile per domain, mirroring the existing Joule tile.
2. **Hot-reload via read-on-demand + 5-second LRU TTL** per resolver. Cheapest first cut; acceptable lag for ops-tuning even on hot paths.
3. **Migrate in 3 batches by tune-frequency**: (Batch 1) the 4 KG knobs; (Batch 2) AI-author flags + UI-events; (Batch 3) the long tail (Navigator, Search, Dashboard URL, CORS).
4. **Track secret expiry in a new `Secrets` HANA entity** with optional encrypted value storage. Recommend encrypted-values, but the encryption-key management decision is a **Phase 2 prerequisite** — it materially shapes risk and code surface. Two viable mechanisms (HANA SBSS / external KMS) are discussed; neither is locked in here.
5. **Secret expiry-check cron** runs daily; 14-day-and-7-day warnings emit audit-log events + admin-shell banner.

---

## Acceptance criteria check

| Criterion (from issue body) | Answer |
|---|---|
| List of env vars tagged secret / runtime-tunable / build-time-only | Section "Inventory" below |
| Single vs per-domain table shape | Per-domain typed singletons (Section "Storage shape") |
| Hot-reload mechanism | Read-on-demand + 5-second LRU TTL (Section "Hot-reload") |
| Admin UI placement + permissions | One tile per domain, `Admin` scope, audit-logged via `@cap-js/audit-logging` (Section "Admin UI") |
| Migration order | KG → AI-author → long tail (Section "Migration order") |
| Concrete follow-up issue(s) | Sketched in Section "Follow-up issues" |

---

## Inventory

Generated from `grep -rhoE 'process\.env\.[A-Z_][A-Z_0-9]*' srv/ | sort -u`. 27 distinct env-var names referenced from `srv/` (the deployed app). Classified by candidacy for DB migration.

### Tier A — runtime-tunable (PRIMARY migration candidates)

These change frequently in operation, never hold secrets, and benefit immediately from no-redeploy updates.

| Env var | Type | Default | Consumers | Domain | Notes |
|---|---|---|---|---|---|
| `KNOWLEDGE_GRAPH_ENABLED` | boolean | `false` | 1 | KG | Gates `/graph/*` + sidebar (#381) |
| `KG_EXTRACT_BUILD_CAP` | integer | `200` | 1 | KG | LLM-call cap per cron tick |
| `KG_MERGE_SIM_THRESHOLD` | decimal | `0.92` | 3 | KG | Consolidator merge threshold |
| `KG_MERGE_SIM_THRESHOLD_EXTRACT` | decimal | `0.85` | 1 | KG | Extract-time threshold |
| `AI_AUTHOR_ENABLED` | boolean | (unset) | 0 from `srv/` (CI-side) | AI-Author | Build-time gate; **not** a srv runtime concern (verified — 0 consumers in srv/) |
| `UI_EVENTS_ENABLED` | boolean | `false` | 1 | UI-Events | Telemetry endpoint gate |
| `NAV_INCLUDE_NESTED_GROUPS` | boolean | `false` | 1 | Navigator | Output-shape toggle |
| `SEARCH_RATE_LIMIT_MAX` | integer | (default in code) | 1 | Search | Rate-limit tuning |
| `SEARCH_RATE_LIMIT_WINDOW_MS` | integer | (default in code) | 1 | Search | Rate-limit tuning |
| `EXPOSE_CAP_UI` | boolean | `false` | 1 | Dev | DEV-only; gates in-process CAP UI |

**Total: 9 candidates** (`AI_AUTHOR_ENABLED` is build-time-only per the per-consumer grep, so excluded from srv/ runtime migration).

### Tier B — runtime-config but stable (SECONDARY migration candidates)

URLs, identity-mapping JSON, and CORS allowlist. Operationally these change when an environment changes, not as a tuning knob. DB-backing them is still useful for "I added a new CF space and need to wire its allowlist without redeploying."

| Env var | Type | Consumers | Domain |
|---|---|---|---|
| `DASHBOARD_URL` | URL | 2 | Display |
| `ALLOWED_CORS_ORIGINS` | string (CSV) | 1 | CORS |
| `REBUILD_TARGET_ENV` | enum (`dev`/`qa`/`prod`) | 1 | Rebuild trigger |
| `TECH_USERS` | JSON array | 1 | Auth |
| `TECH_USERS_MAPPING` | JSON | 1 | Auth |

### Tier C — secrets (NOT migration candidates for the runtime-config table)

These hold credentials. They DO benefit from the rotation/expiry tracking proposal in Section "Secret rotation/expiry" below — but their *values* belong in CF env / Destination Service / managed services, not in `RuntimeConfig`-style entities.

| Env var | Notes |
|---|---|
| `SUBMISSION_SALT_SECRET` | IP-hash salt (5 consumers); rotation invalidates rate-limit keys |
| `CONTENT_API_KEY` | Bearer for `POST /content/publish` |
| `GITHUB_DISPATCH_TOKEN` | PAT for `workflow_dispatch` (90-day expiry per `feedback_cf_set_env_drops_on_redeploy`) |
| `CHAT_MODEL_NAME` | AI Hub model selector (already DB-resolved via `ChatSettings`) |
| `CHAT_DEPLOYMENT_ID` | AI Hub deployment selector (already DB-resolved) |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` | Outbound mail credentials |

`CHAT_MODEL_NAME` / `CHAT_DEPLOYMENT_ID` are an interesting hybrid case — they're *not strictly* secrets (model names are public; deployment IDs are organizational identifiers but not credentials). They're already in `ChatSettings`. Treating them as Tier C (or at the boundary) keeps the secrets-discipline conversation simple: any value where leakage to a SuperAdmin's screen is a concern is Tier C.

### Tier D — system-managed (out of scope)

`NODE_ENV`, `VCAP_APPLICATION`, `CF_INSTANCE_GUID`, `CF_INSTANCE_INDEX`. Set by the runtime; not for operators to tune.

---

## Storage shape

**Decision: per-domain typed singletons.** Mirror the existing `ChatSettings` precedent.

### Why per-domain over single key/value

`ChatSettings` already exists, ships its admin tile (Joule), and is consumed by [`chat-settings-resolver.js`](../../../srv/lib/chat-settings-resolver.js). Generalizing that pattern is cheaper than replacing it. Three concrete advantages:

1. **CDS type safety.** A `KnowledgeGraphSettings.extractBuildCap : Integer` enforces type at write time. A single key/value table would store `extractBuildCap` as `valueString` and parse-on-read; bad values fail at runtime instead of CDS-validation time.
2. **Annotation-driven admin UI.** `@Common.ValueListWithFixedValues`, `@Validation.Minimum`, `@assert.range`, etc. give Fiori Elements the hints to render proper editors (boolean toggle, number-with-min, enum dropdown). A key/value table loses this.
3. **Discoverability.** Entity names self-document scope (`KnowledgeGraphSettings`, `SearchSettings`). Operators can grep schema.cds for "Settings" and see the surface.

### Why NOT pure single-key/value

The issue body's Q1 entertained a single `RuntimeConfig` table. Two failure modes:

- **Validation lives in JavaScript**, not CDS. A `KG_MERGE_SIM_THRESHOLD = 1.5` slips through write validation unless every consumer adds bounds checks.
- **Admin UI is one giant list-report** of opaque key names. Discoverability suffers; permissions become per-row metadata rather than per-entity scopes.

### Hybrid (mentioned in issue body Q1) — rejected

> "Probably hybrid: keep typed per-domain singletons (extending the ChatSettings precedent) for things with clear ownership ... use a fallback `RuntimeConfig` table for the long tail."

Rejected: the long tail isn't actually large enough to justify a second mechanism. **Tier A has 9 entries, Tier B has 5 — total 14 runtime-tunable values across ~6 domains.** Per-domain singletons cover all of them with ~6 new entities. Adding a fallback key/value table would add complexity without removing per-domain entities (the typed ones still want to exist for KG/Search/etc.).

If we ever cross ~30 runtime-tunable values, revisit.

### Proposed entities (Phase 2)

Schema sketch — types and exact columns to be finalized in Phase 2's spec, but shape is:

```cds
entity KnowledgeGraphSettings : cuid, managed {
  enabled                  : Boolean default false;
  extractBuildCap          : Integer default 200;
  mergeSimThreshold        : Decimal(3, 2) default 0.92;
  mergeSimThresholdExtract : Decimal(3, 2) default 0.85;
}
entity SearchSettings : cuid, managed {
  rateLimitMax             : Integer default 60;
  rateLimitWindowMs        : Integer default 60000;
}
entity NavigatorSettings : cuid, managed {
  includeNestedGroups      : Boolean default false;
}
entity UiEventsSettings : cuid, managed {
  enabled                  : Boolean default false;
}
entity DisplayConfig : cuid, managed {
  dashboardUrl             : String(500);
}
entity TenantConfig : cuid, managed {
  allowedCorsOrigins       : String(2000);     // CSV
  rebuildTargetEnv         : String(10);       // 'dev' / 'qa' / 'prod'
  techUsersJson            : LargeString;      // JSON array
  techUsersMappingJson     : LargeString;      // JSON
}
```

Each is a singleton (`@assert.unique` on a synthetic key, OR enforced application-side as `ChatSettings` does today).

**`AI_AUTHOR_ENABLED` and `AI_AUTHOR_BUILD_CAP` stay env-only** because they're consumed in CI scripts (`scripts/fetch-tutorials.ts` AI-quiz pipeline), not in deployed `srv/`. The DB lives only on the deployed srv; CI can't read it.

---

## Hot-reload

**Decision: read-on-demand with a 5-second LRU TTL per resolver.**

### Why 5 seconds

Operators flipping a flag at the admin UI care about "did my change take effect" feedback within ~10 seconds at worst. A 5-second TTL bounds that. The DB hit on cache miss is single-row, sub-millisecond on a warm HANA connection.

For low-frequency consumers (cron-cap-style — KG extract runs every 30 min), the TTL is irrelevant; they'd refetch on every tick anyway.

For hot-path consumers (e.g. `KNOWLEDGE_GRAPH_ENABLED` checked on every `/graph/*` request), 5s adds at most one DB read per 5 seconds per srv instance. Cost: negligible. Lag on flag-flip: 5s. Acceptable.

### Why NOT push-based invalidation

`@cap-js`-side `after('UPDATE')` handlers + a polling loop on a `cache_bust_token` row would give sub-second reactivity. Cost: ~50 lines of plumbing on top of the resolver, plus a write-side handler for every settings entity. **YAGNI for #444 today.** If a future operational scenario needs sub-second flag flipping (e.g. "I'm on call, prod is breaking, I need the flag off NOW"), revisit. The 5s gap is not an outage.

### Why NOT no-cache

Every consumer call doing a fresh DB read for `KNOWLEDGE_GRAPH_ENABLED` would add 1-3ms per request. Public site `/` and `/browse/` already hit `KNOWLEDGE_GRAPH_ENABLED` on render. Multiply by request volume — significant DB load. The LRU TTL wins.

### Resolver shape (sketch — Phase 2 spec finalizes)

```js
// srv/lib/runtime-config/resolver.js
import { LRUCache } from 'lru-cache';
import cds from '@sap/cds';

const cache = new LRUCache({ max: 50, ttl: 5_000 });

export async function resolveKnowledgeGraphSettings() {
  const hit = cache.get('kg');
  if (hit) return hit;

  const { KnowledgeGraphSettings } = cds.entities('com.sap.developers.ims');
  const row = (await SELECT.one.from(KnowledgeGraphSettings)) ?? {};

  // Same precedence as chat-settings-resolver: DB → env → hardcoded
  const settings = {
    enabled: row.enabled ?? (process.env.KNOWLEDGE_GRAPH_ENABLED === 'true'),
    extractBuildCap: row.extractBuildCap ?? Number(process.env.KG_EXTRACT_BUILD_CAP ?? 200),
    mergeSimThreshold: row.mergeSimThreshold ?? Number(process.env.KG_MERGE_SIM_THRESHOLD ?? 0.92),
    mergeSimThresholdExtract: row.mergeSimThresholdExtract ?? Number(process.env.KG_MERGE_SIM_THRESHOLD_EXTRACT ?? 0.85),
  };
  cache.set('kg', settings);
  return settings;
}
```

Each domain gets its own resolver function. **Backwards-compatible env fallback throughout** — the migration is non-breaking and reversible.

---

## Admin UI

**Decision: one tile per domain, mirroring Joule.**

The admin-shell already supports this pattern (see `app/admin-shell/webapp/manifest.json` `componentUsages`). Each new entity gets:

1. A new admin app under `app/admin/<domain>/` (e.g. `app/admin/knowledge-graph/`) with a custom XML view (Joule-style) OR a Fiori Elements list-report+object-page if standard form is enough.
2. A `componentUsages` entry in `admin-shell` so the tile appears.
3. An `@requires: 'Admin'` guard on the AdminService projection (already the default for new admin entities).

### Permissions

Single `Admin` scope. The issue body's Q7 raised "should some changes be higher-stakes than others, with a per-row `requires` annotation?" **Verdict: not yet.** Granular per-key permissions add complexity without a clear operational need today. If a Phase 2 use case demands "operators can see but not edit", we revisit then.

### Audit logging

All settings entities get `@cap-js/audit-logging` `@PersonalData.EntitySemantics: Other` + `@AuditLog.Operation` annotations. **Every change to a settings row is auditable to a SuperAdmin user.** Aligns with existing `Concepts` / admin-curated entities.

### Field-level UX

Annotations to use:

- Boolean: `@Common.ValueListWithFixedValues` with two entries (true/false display labels) — Fiori renders a Switch.
- Integer with range: `@assert.range: [0, 10000]` plus UI Min/Max for input field.
- Decimal threshold: `@Common.UnitInISOCurrency: false` + `@Validation.Minimum: 0` + `@Validation.Maximum: 1`.
- Enum: `@assert.range` with literal values OR `@Common.ValueListWithFixedValues` against a backing entity.
- JSON / LargeString: `@UI.MultiLineText: true` for `techUsersJson` etc. Validation runs in a `before('UPDATE')` handler that JSON-parses + checks shape.

---

## Migration order

**Decision: tune-frequency-first, three batches.**

### Batch 1 — Knowledge Graph (4 values)

`KNOWLEDGE_GRAPH_ENABLED`, `KG_EXTRACT_BUILD_CAP`, `KG_MERGE_SIM_THRESHOLD`, `KG_MERGE_SIM_THRESHOLD_EXTRACT`.

**Why first:** these are 4 of the 9 Tier-A entries (44%) AND the operational pain Tom flagged in #444 — flipping `KNOWLEDGE_GRAPH_ENABLED` post-deploy currently requires `cf set-env` + `cf restart`, fragile per `feedback_cf_set_env_drops_on_redeploy` and the `cf set-env` → mtaext envsubst migration in [PR #438](https://github.com/sap-tutorials/tutorials-ims/pull/438). Phase 2's "first migration" is a real win.

**Single PR:** `KnowledgeGraphSettings` entity + `srv/lib/runtime-config/kg-settings.js` resolver + `app/admin/knowledge-graph/` admin tile + 4 consumer-side conversions. Estimated diff: ~300-500 lines (admin-tile XML + tests can push above the original ~300-400 estimate). Backwards-compatible env-fallback throughout.

### Batch 2 — UI-Events + Search (3 values)

`UI_EVENTS_ENABLED`, `SEARCH_RATE_LIMIT_MAX`, `SEARCH_RATE_LIMIT_WINDOW_MS`.

**Why next:** UI-Events flag-flip frequency matches KG; Search rate-limits are a tuning knob ops will want to bump under load.

**Single PR:** `UiEventsSettings` + `SearchSettings` entities + 2 resolvers + 2 admin tiles + consumer conversions.

### Batch 3 — long tail (the rest)

`NAV_INCLUDE_NESTED_GROUPS`, `DASHBOARD_URL`, `ALLOWED_CORS_ORIGINS`, `REBUILD_TARGET_ENV`, `TECH_USERS`, `TECH_USERS_MAPPING`. Lower change frequency; smaller per-PR urgency.

### What stays env-only forever

Tier C (secrets) and Tier D (system-managed). Plus `EXPOSE_CAP_UI` — DEV-only deployment switch, not an operator concern.

---

## Secret rotation/expiry — Tom's sub-idea

This is research, NOT a Phase 2 commitment. The encryption-key management decision is a **prerequisite** before any Phase 2 implementation can start.

### The visibility problem

The table below is intentionally broader than the srv/-runtime scope — it includes CI-only secrets (`TUTORIALS_GITHUB_TOKEN`, `AI_AUTHOR_AICORE_SERVICE_KEY`) because the visibility/expiry-tracking proposal solves *both* surfaces with one mechanism. The `Secrets` HANA entity is the inventory; CI-only entries don't need DB-stored *values*, only metadata (`expiresAt` / `rotationOwner` / `rotationDocsUrl`).

| Secret | Where stored | Rotation cadence | Tracking |
|---|---|---|---|
| `DISPATCH_TOKEN` (GitHub PAT) | GH Actions secret + envsubst into mtaext | 90 days (GitHub default) | Calendar entry, manual |
| `CONTENT_API_KEY` | mtaext + dev.mtaext literal | None — static | None |
| `SUBMISSION_SALT_SECRET` | CF env | None — static (rotation invalidates rate-limit keys) | None |
| `SMTP_*` | CF env / managed mail service | Vendor-defined | None |
| `TUTORIALS_GITHUB_TOKEN` | GH Actions secret (CI-only) | 90 days | Calendar entry, manual |
| `AI_AUTHOR_AICORE_SERVICE_KEY` | GH Actions secret (CI-only) | Vendor-defined | None |

**Nobody on the team currently has visibility into "what expires when."** Tom's PAT-rotation runbook ([docs/developers/operations/github-dispatch-pat-rotation.md](../../developers/operations/github-dispatch-pat-rotation.md)) handles ONE token. Extending that to N tokens via N runbooks doesn't scale.

### Recommendation: `Secrets` HANA entity with metadata + encrypted-values

Tom asked for encrypted values in the DB (not just metadata). I'll lay out both approaches and the prerequisites.

#### Shape (encrypted-values approach)

```cds
entity Secrets : cuid, managed {
  key            ![key]     : String(120) @assert.unique;  // e.g. 'GITHUB_DISPATCH_TOKEN'
  description              : String(500);
  kind                     : String(40);   // 'github-pat' | 'content-api-key' | 'salt' | 'smtp-pass' | …
  rotationOwner            : String(120);  // 'thomas.jung@sap.com'
  rotationDocsUrl          : String(500);  // link to the rotation runbook
  expiresAt                : Date;          // null = never expires
  lastRotatedAt            : Timestamp;
  // Encrypted-value column. Plaintext NEVER stored. Decryption happens
  // application-side via the resolver, with a per-read audit-log entry.
  encryptedValue           : LargeBinary;
  encryptionKeyId          : String(60);   // identifier of the wrapping key
}
```

The resolver layer reads the row, decrypts, returns plaintext to the consumer. Same DB-row → env → hardcoded precedence as Tier A. **Encryption-at-rest in the DB doesn't help if the application-layer decryption is unconditional** — you've moved the secret from "env var visible via `cf env`" to "DB row visible via SELECT to anyone with srv DB access." That's not strictly worse, but it's not strictly better either. Three real benefits emerge:

1. **Centralized inventory.** A single table answers "what credentials does the platform use?" Today nobody can answer that from a single place.
2. **Expiry visibility.** `expiresAt` enables the warning cron below. Today the GitHub PAT 90-day expiry is calendared in someone's head.
3. **Audit log.** Every secret read goes through the resolver + emits an audit-log entry. Today `process.env.X` is invisible.

#### Encryption-key management — the Phase 2 prerequisite

This is the unresolved question that materially shapes risk and code surface. The encryption-key has to live SOMEWHERE outside the encrypted DB. Three viable mechanisms:

**(A) HANA SBSS (Secure Storage in System Database).** HANA's built-in secret-storage facility. Native, no extra service. Problems: SBSS read API requires SAP-internal client libs we don't currently use; the abstraction across HANA editions varies. Investigation needed.

**(B) External KMS** (e.g. SAP Credential Store on BTP). Native to BTP. Adds a service binding. `tutorials-srv` reads the wrapping key on boot from the bound credential store.

**(C) CF env var holding the wrapping key.** Simplest. We've moved the secret problem from N values to 1 value (the wrapping key). Encryption-at-rest inside HANA still mitigates the "rogue HANA admin reads the table" threat. Wrapping key rotation is harder — re-encrypts every row. The `encryptionKeyId` column above makes this tractable: write new rows under key v2, lazily migrate v1 rows on first read after rotation; never need a flag-day re-encryption.

**Recommendation: (B) SAP Credential Store**, but **don't lock this in** until Phase 2 spec dedicates a section to it. The choice has implications (BTP entitlement quota, service-binding count, app boot-time). The research doc closes WITHOUT picking — Tom + a security review needed.

#### Alternative: metadata-only

If the encryption-key management decision is harder than expected OR a security review pushes back, fall back to **metadata-only**: `Secrets` table tracks `expiresAt`/`rotationOwner`/`rotationDocsUrl` but values stay in CF env. This still solves the visibility problem AND is a stepping-stone to encrypted-values later.

**Strong recommendation: ship metadata-only as Phase 2-A, encrypted-values as Phase 2-B once key management is decided.** Splitting reduces risk of letting key-management debate stall the visibility win.

#### Expiry-check cron

```
srv/jobs/secret-expiry-check.js
  Runs daily at 04:00 UTC.
  SELECT key, expiresAt, rotationOwner FROM Secrets WHERE expiresAt IS NOT NULL.
  For each: days_remaining = (expiresAt - today).days.
    days_remaining ≤ 0       → critical: emit audit-log + set adminBannerText
    0 < days_remaining ≤ 7   → warning: emit audit-log
    7 < days_remaining ≤ 14  → info: emit audit-log
    days_remaining > 14      → silent
  Bonus: post a comment to a tracked GitHub issue per critical/warning,
  so the rotation owner gets a notification without us reinventing email.
```

Admin-shell reads `getAdminBanner()` on boot; the banner shows "GITHUB_DISPATCH_TOKEN expires in 4 days — rotate via [runbook]." Yellow severity ≤ 14 days; red ≤ 7.

#### Out of scope (rotation automation)

Tom asked: "How can we automate the rotation?" Per-secret-kind rotation handlers would be:

- **GitHub PAT**: hit `POST /user/personal-access-tokens` to mint, `DELETE /user/personal-access-tokens/<id>` to revoke. Requires a separate "rotation service account" PAT to authenticate the rotate-PAT call. Recursive but possible.
- **CONTENT_API_KEY / SUBMISSION_SALT_SECRET**: generate via `crypto.randomBytes`, push to env (re-deploy or `cf set-env`), update DB. Two-key rolling-window required to avoid downtime.
- **SMTP / vendor secrets**: cannot automate; vendor-driven.

**Phase 2 does NOT propose automated rotation.** Visibility (expiry-check cron + banner) is the immediate pain. Automation is a Phase 3+ concern; it's expensive (per-kind handlers, key-management, recursive auth) and the visibility solution alone closes ~80% of the problem.

---

## Risks & open questions

| Risk | Mitigation |
|---|---|
| **Encryption-key management** is unresolved (Phase 2-B prerequisite) | Recommend security review before Phase 2-B starts. Phase 2-A (metadata-only) ships unblocked. |
| **Migration ROLLBACK** mid-flight requires env vars to still exist alongside DB rows | Backwards-compatible env fallback in every resolver. Reverting a Phase 2 PR preserves the env-var path. Old env vars stay in mtaext until Batch 3 ships AND a soak window passes. |
| **Audit-log volume** grows linearly with config-resolver call count if naively logged | Audit-log only WRITE operations on settings rows; READS are not audit-logged (CDS audit-logging default). Resolver reads are routine and high-volume. |
| **5-second TTL** is too long if a flag-flip needs sub-second propagation | Document the 5s lag in admin UI tooltip. If a future use case demands faster, revisit hot-reload mechanism (push-based). |
| **DEV/QA/PROD divergence** if a settings row exists in DEV but not QA/PROD | Settings rows ship as CSV seeds in `db/data/com.sap.developers.ims-<Entity>.csv`. HDI deploy auto-imports as UPSERT (per `feedback_cap_csv_seeds_clobber_admin_data`). Document: ship empty CSVs for admin-edited entities so HDI redeploy doesn't clobber operator-set values. |
| **`AI_AUTHOR_ENABLED` is build-time** but `AI_AUTHOR_BUILD_CAP` is also build-time — neither is in `srv/`, so neither is migration scope | Verified by per-consumer grep. Both stay env-only forever (live in CI scripts, not the deployed srv). |

---

## Follow-up issues (to file after this research PR merges)

1. **Phase 2-A: Foundation + KG migration** — implement `KnowledgeGraphSettings` entity, resolver lib, admin tile, and migrate the 4 KG env vars. ~300-400 lines. Backwards-compatible env fallback.
2. **Phase 2-B: Secrets visibility (metadata-only)** — `Secrets` HANA entity with `key`/`description`/`expiresAt`/`rotationOwner`/`rotationDocsUrl` columns. Daily expiry-check cron. Admin tile + banner. **No encrypted values yet** — that's a separate prerequisite.
3. **Phase 2-C: Encrypted-value secrets store** — adds `encryptedValue`/`encryptionKeyId` columns + decryption resolver. Depends on a SECURITY review and an explicit key-management decision (HANA SBSS / SAP Credential Store / CF env wrapping key). Blocked on that decision.
4. **Phase 3: Migrate Batch 2 + Batch 3** — ui-events, search, navigator, dashboard URL, CORS, etc. Multiple PRs.

Each follow-up gets its own brainstorming → spec → plan cycle. None should be started until this research PR is merged.

---

## References

- Issue: [#444](https://github.com/sap-tutorials/tutorials-ims/issues/444)
- Sub-idea on rotation: Tom's chat message 2026-06-20 (referenced in issue thread when the implementation issues are filed)
- Existing precedent: [`srv/lib/chat-settings-resolver.js`](../../../srv/lib/chat-settings-resolver.js), [`srv/admin-service.cds:84`](../../../srv/admin-service.cds#L84) (`ChatSettings`), [`app/admin/joule/`](../../../app/admin/joule/)
- Memory: `feedback_cf_set_env_drops_on_redeploy` (motivation — env vars don't survive redeploys)
- Memory: `feedback_cap_csv_seeds_clobber_admin_data` (DEV/QA/PROD divergence risk)
- Recent related PRs: #438 (GITHUB_DISPATCH_TOKEN via mtaext), #461 (envsubst placeholder substitution)
