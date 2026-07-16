# A2A Configuration → DB + Admin UI (follow-up to #1220)

**Status:** Design approved (decisions locked with Tom) — ready for implementation plan
**Parent:** #1220 (merged, PR #1223). This corrects a design mistake: A2A config shipped as env vars; it must be DB-backed and editable via the Admin UI.
**Branch:** `a2a-config-to-db` (off origin/main)
**Date:** 2026-07-16

## Problem

#1220 shipped three A2A settings as **environment variables**:
- `A2A_ENABLED` (kill switch; also in the feature-flag registry, `srv/lib/feature-flags/registry.js:244`)
- `A2A_PUBLIC_BASE_URL` (card `url` base; read in `srv/server.js:490`)
- `A2A_TOKEN_URL` (card `securitySchemes.xsuaa` tokenUrl; read in `srv/server.js:508`)

Tom's standing preference: **tunable runtime configuration lives in the database, edited via the Admin UI** — not env vars requiring `cf set-env` + restart. (Memory: `config-in-db-admin-ui-not-env-vars`.)

## Decisions (locked with Tom)

| Question | Decision |
|---|---|
| Where does A2A config live? | **Fields on the existing `ChatSettings` singleton**, surfaced on the existing **`/admin-ui/#joule`** page |
| Does the enabled/kill-switch also move to DB? | **Yes — all three move to DB.** No A2A env vars remain. `a2aEnabled` becomes an admin-toggled field like `ChatSettings.enabled`. |

## Established pattern this follows (from codebase recon)

- `ChatSettings` (`db/schema.cds:604`, `entity ChatSettings : cuid, managed`) is a fixed-ID singleton (`00000000-0000-0000-0000-00000000c8a7`), exposed as `@odata.singleton @requires:'Admin'` in `srv/admin-service.cds:307`, bootstrapped by a `before('READ','ChatSettings')` insert in `srv/admin-service.js:466-477`.
- The **Joule Admin page is freestyle UI5** (`app/admin/joule/`), NOT Fiori Elements. Fields are hand-wired in `view/Settings.view.xml` (SimpleForm/Panel), `controller/Settings.controller.js` (`onInit` defaults + `_loadSettings` mapping + `onSave` PATCH body), and `i18n/i18n.properties`. Adding fields = edit these three + schema. No annotation regeneration.
- Runtime reads use `cds.entities('com.sap.developers.ims')` + `SELECT.one.from(ChatSettings)`. The canonical **DB→default resolver** template is `srv/lib/runtime-config/kg-settings.js` (CAP path → raw-SQL UPPERCASE fallback → defaults, 5s cache).
- URL columns in config entities are `String(500)` (precedent: `DevtoberfestConfig.contentRulesUrl`, `db/schema.cds:530 ctaUrl`).

## Design

### Schema — add 3 fields to `ChatSettings` (`db/schema.cds`)

```cds
  // A2A (Agent-to-Agent) endpoint config (#1220 follow-up). Moved from env vars
  // to DB so admins tune them via /admin-ui/#joule without a restart. Nullable
  // → resolver falls through to hardcoded defaults (a2aEnabled null ⇒ true).
  a2aEnabled        : Boolean default true;
  a2aPublicBaseUrl  : String(500);
  a2aTokenUrl       : String(500);
```

- `a2aEnabled` defaults `true` — preserves #1220 behavior (A2A on unless explicitly disabled), matching the old `A2A_ENABLED !== 'false'` semantics.
- `a2aPublicBaseUrl` / `a2aTokenUrl` nullable — empty means "not configured". The card handler falls back to `VCAP_APPLICATION.application_uris` for base URL when `a2aPublicBaseUrl` is blank (keeps the host-header-injection fix's trusted-source behavior); tokenUrl renders empty if unset (as today).
- **CSV seed unchanged:** `db/data/com.sap.developers.ims-ChatSettings.csv` keeps its 5 columns — new columns are NOT added to the CSV, so the `.hdbtabledata` import never touches them (existing precedent: ChatSettings has 28 schema fields, 5 CSV columns). Existing rows get the `default` on ALTER.
- **Migration:** `ChatSettings` uses `.hdbmigrationtable` (`db/src/com.sap.developers.ims.ChatSettings.hdbmigrationtable`). Regenerate via `cds build --production` — NEVER hand-edit the migration file (memory: `hdbmigrationtable-hand-edit-poisons-version-counter`). Run `npx cds deploy --to sqlite::memory:` first to catch `@assert` issues.

### Resolver — `srv/lib/runtime-config/a2a-settings.js` (new)

Clone `kg-settings.js` structure, but **DB→default only** (no env layer, since env is being removed):

```js
export async function resolveA2aSettings() // → { enabled, publicBaseUrl, tokenUrl }
```
- Reads the `ChatSettings` singleton (CAP path; raw-SQL UPPERCASE fallback for build-pipeline contexts).
- `DEFAULTS = { enabled: true, publicBaseUrl: '', tokenUrl: '' }`.
- `enabled`: DB value if non-null, else default `true`.
- 5s in-module cache (card + rpc-router are per-request hot paths), same as kg-settings.
- Fail-soft: read throw → defaults (A2A stays enabled, base URL falls through to VCAP).

### Runtime read changes

1. **`srv/server.js`** card handler (~485-509):
   - `a2aBaseUrl(req)`: replace `process.env.A2A_PUBLIC_BASE_URL` with the resolved `publicBaseUrl` (await `resolveA2aSettings()`); keep the `VCAP_APPLICATION` → header fallback chain below it.
   - `tokenUrl`: replace `process.env.A2A_TOKEN_URL` with resolved `tokenUrl`.
   - `enabled`: replace `process.env.A2A_ENABLED !== 'false'` with resolved `enabled`.
   - The handler becomes `async` (it already can be — Express supports async handlers). Keep the `Cache-Control: private, no-store` + `Vary` headers.

2. **`srv/lib/a2a/rpc-router.js`** (`enabled()` at line 16): replace `process.env.A2A_ENABLED !== 'false'` with `await resolveA2aSettings()` → `.enabled`. The kill-switch check in the POST handler becomes an await (handler is already async).

3. **`srv/lib/a2a/agent-card.js`**: unchanged — it already takes `{baseUrl, tokenUrl, enabled}` as args. Only the caller (server.js) changes its source.

### Admin UI — add 3 fields to the Joule settings page (`app/admin/joule/webapp/`)

1. **`view/Settings.view.xml`** — new `<Panel>` "A2A (Agent-to-Agent)" with:
   - `<Switch state="{settings>/a2aEnabled}"/>` (Enabled)
   - `<Input value="{settings>/a2aPublicBaseUrl}"/>` (Public Base URL)
   - `<Input value="{settings>/a2aTokenUrl}"/>` (Token URL)
2. **`controller/Settings.controller.js`** — add the 3 fields to: the `onInit` JSONModel defaults, the `_loadSettings` mapping, and the `onSave` PATCH `body` object.
3. **`i18n/i18n.properties`** — labels for the 3 fields + the panel title.

### Feature-flag registry — remove the env entry

- Delete the `A2A_ENABLED` entry from `srv/lib/feature-flags/registry.js:244-249` (it was env-only; the registry's drift-guard test enforces every `X_ENABLED` env var IS registered — since we're removing the env var, we remove the entry so the guard passes). Confirm no other registry consumer references it.

### AdminService projection

- `ChatSettings` is already `@odata.singleton` on `AdminService` — the new columns are auto-projected. The vestigial `@Common.Label` block in `app/admin-annotations.cds:1913` is not consumed by the freestyle app, but add labels there too for metadata completeness (optional, low-cost).

## Out of scope

- No new Admin UI page (reusing `#joule`).
- No new settings entity (reusing `ChatSettings`).
- `A2A_TOKEN_URL` / `A2A_PUBLIC_BASE_URL` / `A2A_ENABLED` env vars are **removed** from all code and docs; the deploy no longer sets them. (Update the #1220 docs that mention them: `docs/developers/reference/a2a-instructions.md`, `docs/developers/operations/testing-endpoints.md`, and any CLAUDE.md gotcha.)

## Testing

- Unit: `a2a-settings.test.js` (resolver DB→default precedence, cache, fail-soft); update `agent-card.test.js` only if the card builder signature changes (it doesn't). Update `rpc-router.test.js` kill-switch test to drive the resolved value instead of `process.env.A2A_ENABLED` (mock `resolveA2aSettings`).
- Update the server.js card smoke expectations (values now come from ChatSettings, not env).
- `npx cds deploy --to sqlite::memory:` (schema + CSV assert check) + `npx cds build --production` (regenerate migration table).
- Admin UI: manual smoke — load `/admin-ui/#joule`, confirm the A2A panel renders, edit + save round-trips via PATCH `/admin/ChatSettings`.
- Full unit suite green (minus the pre-existing os-toggle failures).

## Deploy / migration notes

- `cds build --production` regenerates `ChatSettings.hdbmigrationtable` with a new version — the ALTER adds the 3 columns with defaults; existing operator-set rows are preserved (columns not in the CSV import set).
- After deploy, remove `A2A_*` env vars from the app (they're now ignored). No `cf set-env` needed for A2A going forward — admins use `/admin-ui/#joule`.
