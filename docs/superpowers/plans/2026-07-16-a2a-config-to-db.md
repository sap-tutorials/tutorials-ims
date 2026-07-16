# A2A Config → DB + Admin UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Move the three A2A settings (`enabled`, public base URL, token URL) from environment variables to fields on the `ChatSettings` DB singleton, editable via the `/admin-ui/#joule` page; remove all A2A env vars.

**Architecture:** Add 3 columns to `ChatSettings`; a DB→default resolver (`a2a-settings.js`, cloned from `kg-settings.js`) reads them; the card handler (`server.js`) and kill-switch (`rpc-router.js`) read the resolver instead of `process.env`; the freestyle Joule Admin UI page gets an A2A panel; the feature-flag registry's `A2A_ENABLED` entry is removed.

**Tech Stack:** CAP Node.js (`@sap/cds` 10), CDS `.hdbmigrationtable`, freestyle UI5 (SimpleForm + JSONModel + fetch/PATCH), Vitest.

**Design spec:** `docs/superpowers/specs/2026-07-16-a2a-config-to-db-design.md`

## Global Constraints

- **NO A2A env vars remain** — `A2A_ENABLED`, `A2A_PUBLIC_BASE_URL`, `A2A_TOKEN_URL` removed from all code, the feature-flag registry, and docs.
- **`ChatSettings` CSV (`db/data/com.sap.developers.ims-ChatSettings.csv`) keeps its exact 5 columns** — do NOT add the new columns to the CSV (prevents the `.hdbtabledata` import from wiping operator-set values; existing precedent: 28 schema fields vs 5 CSV columns).
- **NEVER hand-edit `db/src/com.sap.developers.ims.ChatSettings.hdbmigrationtable`** — regenerate via `cds build --production` (hand edits poison the migration version counter).
- **Run `npx cds deploy --to sqlite::memory:` after any `db/**/*.cds` or CSV change** — catches `@assert.unique`/constraint issues invisible to `cds compile`.
- `a2aEnabled` default `true` — preserves #1220's `A2A_ENABLED !== 'false'` behavior (on unless explicitly disabled).
- URL columns are `String(500)` (repo convention for config URLs).
- The Joule Admin page is **freestyle UI5** (not Fiori Elements) — add fields via view XML + controller JS + i18n, no annotation regeneration.
- ES modules; LF line endings; commit after every task. Branch: `a2a-config-to-db` (already checked out, off origin/main).

## File Structure

| File | Change |
|---|---|
| `db/schema.cds` (modify) | Add `a2aEnabled`, `a2aPublicBaseUrl`, `a2aTokenUrl` to `ChatSettings` (~line 604-682). |
| `db/src/com.sap.developers.ims.ChatSettings.hdbmigrationtable` (regenerated) | Via `cds build --production` — not hand-edited. |
| `srv/lib/runtime-config/a2a-settings.js` (create) | `resolveA2aSettings()` → `{enabled, publicBaseUrl, tokenUrl}`, DB→default, 5s cache. |
| `srv/server.js` (modify) | Card handler reads resolver instead of `process.env.A2A_*` (handler → async). |
| `srv/lib/a2a/rpc-router.js` (modify) | `enabled()` kill-switch reads resolver instead of `process.env.A2A_ENABLED`. |
| `srv/lib/feature-flags/registry.js` (modify) | Remove the `A2A_ENABLED` entry. |
| `app/admin/joule/webapp/view/Settings.view.xml` (modify) | Add A2A panel (Switch + 2 Inputs). |
| `app/admin/joule/webapp/controller/Settings.controller.js` (modify) | Add 3 fields to onInit defaults + `_loadSettings` mapping + `onSave` body. |
| `app/admin/joule/webapp/i18n/i18n.properties` (modify) | Labels for the panel + 3 fields. |
| `app/admin-annotations.cds` (modify, optional) | Add `@Common.Label` for the 3 fields (metadata completeness). |
| `docs/developers/reference/a2a-instructions.md`, `docs/developers/operations/testing-endpoints.md` (modify) | Replace env-var references with "configured via /admin-ui/#joule". |
| `test/unit/a2a/a2a-settings.test.js` (create) | Resolver precedence + cache + fail-soft. |
| `test/unit/a2a/rpc-router.test.js` (modify) | Kill-switch test drives resolver, not env. |

---

## Task 1: Schema fields + migration + resolver

Add the 3 columns, regenerate the migration table, and build the DB→default resolver. Grouped because they share one testable deliverable: the resolver reading real columns.

**Files:**
- Modify: `db/schema.cds` (ChatSettings entity, ~604-682)
- Regenerate: `db/src/com.sap.developers.ims.ChatSettings.hdbmigrationtable` (via cds build)
- Create: `srv/lib/runtime-config/a2a-settings.js`
- Test: `test/unit/a2a/a2a-settings.test.js`

**Interfaces:**
- Produces: `resolveA2aSettings()` → `Promise<{ enabled: boolean, publicBaseUrl: string, tokenUrl: string }>`; `_resetA2aSettingsCache()` (test helper).

- [ ] **Step 1: Add the 3 fields to ChatSettings**

In `db/schema.cds`, inside `entity ChatSettings : cuid, managed { ... }` (after the last field, before the closing `}`), add:

```cds
  // A2A (Agent-to-Agent) endpoint config (#1220 follow-up). Moved from env vars
  // to DB so admins tune them via /admin-ui/#joule without a restart. Nullable
  // URLs; a2aEnabled default true preserves the prior A2A_ENABLED!=='false' gate.
  a2aEnabled        : Boolean default true;
  a2aPublicBaseUrl  : String(500);
  a2aTokenUrl       : String(500);
```

- [ ] **Step 2: Verify schema deploys clean (assert check)**

Run: `npx cds deploy --to sqlite::memory: > /dev/null 2>&1 && echo "DEPLOY OK" || npx cds deploy --to sqlite::memory:`
Expected: `DEPLOY OK` (no constraint errors). If it prints errors, fix the schema before continuing.

- [ ] **Step 3: Regenerate the migration table (production build)**

Run: `npx cds build --production > /dev/null 2>&1 && echo "BUILD OK"`
Expected: `BUILD OK`. Then confirm the migration table gained the columns:
Run: `grep -c "A2AENABLED\|A2APUBLICBASEURL\|A2ATOKENURL" db/src/com.sap.developers.ims.ChatSettings.hdbmigrationtable`
Expected: `3` (or the columns appear in a new migration version block). Do NOT hand-edit this file.

- [ ] **Step 4: Confirm the CSV was NOT modified**

Run: `git diff --stat db/data/com.sap.developers.ims-ChatSettings.csv`
Expected: no output (CSV unchanged — new columns are absent from it by design).

- [ ] **Step 5: Write the failing resolver test**

```javascript
// test/unit/a2a/a2a-settings.test.js
import { describe, it, expect, beforeEach, vi } from 'vitest';

let row = null;
const fakeDb = { run: vi.fn(async () => (row ? [row] : [])) };
vi.mock('@sap/cds', () => ({
  default: {
    entities: () => ({ ChatSettings: 'ChatSettings' }),
    connect: { to: vi.fn(async () => fakeDb) },
    log: () => ({ warn(){}, error(){}, info(){}, debug(){} }),
  },
}));
// SELECT.one.from(ChatSettings) → resolve `row`
globalThis.SELECT = { one: { from: () => Promise.resolve(row) } };

import { resolveA2aSettings, _resetA2aSettingsCache } from '../../../srv/lib/runtime-config/a2a-settings.js';

describe('resolveA2aSettings', () => {
  beforeEach(() => { row = null; _resetA2aSettingsCache(); vi.clearAllMocks(); });

  it('returns defaults when no row (enabled true, empty urls)', async () => {
    const s = await resolveA2aSettings();
    expect(s).toEqual({ enabled: true, publicBaseUrl: '', tokenUrl: '' });
  });

  it('reads DB values when present', async () => {
    row = { a2aEnabled: false, a2aPublicBaseUrl: 'https://x.example', a2aTokenUrl: 'https://uaa/token' };
    const s = await resolveA2aSettings();
    expect(s).toEqual({ enabled: false, publicBaseUrl: 'https://x.example', tokenUrl: 'https://uaa/token' });
  });

  it('treats null a2aEnabled as default true', async () => {
    row = { a2aEnabled: null, a2aPublicBaseUrl: null, a2aTokenUrl: null };
    const s = await resolveA2aSettings();
    expect(s.enabled).toBe(true);
    expect(s.publicBaseUrl).toBe('');
    expect(s.tokenUrl).toBe('');
  });

  it('caches within TTL (second call does not re-query)', async () => {
    row = { a2aEnabled: true };
    await resolveA2aSettings();
    const from = SELECT.one.from;
    let calls = 0;
    SELECT.one.from = () => { calls++; return Promise.resolve(row); };
    await resolveA2aSettings();
    expect(calls).toBe(0); // served from cache
    SELECT.one.from = from;
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run test/unit/a2a/a2a-settings.test.js`
Expected: FAIL — module not found.

- [ ] **Step 7: Write the resolver**

```javascript
// srv/lib/runtime-config/a2a-settings.js
// Resolves A2A endpoint config from the ChatSettings singleton. DB → hardcoded
// default (no env layer — #1220's A2A_* env vars were removed in this change).
// Mirrors srv/lib/runtime-config/kg-settings.js (DB→default, 5s cache). The
// card handler + rpc-router kill-switch are per-request hot paths, hence cache.
import cds from '@sap/cds';

const LOG = cds.log('a2a-settings-resolver');
const TTL_MS = 5_000;
let _cachedAt = 0;
let _cached = null;

const DEFAULTS = { enabled: true, publicBaseUrl: '', tokenUrl: '' };

async function readRow() {
  try {
    const { ChatSettings } = cds.entities('com.sap.developers.ims');
    return (await SELECT.one.from(ChatSettings)) ?? null;
  } catch (capErr) {
    try {
      const db = await cds.connect.to('db');
      const rows = await db.run(
        'SELECT a2aEnabled, a2aPublicBaseUrl, a2aTokenUrl ' +
        'FROM COM_SAP_DEVELOPERS_IMS_CHATSETTINGS LIMIT 1'
      );
      return rows?.[0] ?? null;
    } catch (sqlErr) {
      LOG.warn('ChatSettings read failed; using A2A defaults', sqlErr.message);
      return null;
    }
  }
}

function pick(row, lower, UPPER) {
  if (!row) return undefined;
  return row[lower] !== undefined ? row[lower] : row[UPPER];
}

export function _resetA2aSettingsCache() { _cachedAt = 0; _cached = null; }

export async function resolveA2aSettings() {
  const now = Date.now();
  if (_cached && now - _cachedAt < TTL_MS) return _cached;

  const row = await readRow();
  const enabledRaw = pick(row, 'a2aEnabled', 'A2AENABLED');
  const baseRaw    = pick(row, 'a2aPublicBaseUrl', 'A2APUBLICBASEURL');
  const tokenRaw   = pick(row, 'a2aTokenUrl', 'A2ATOKENURL');

  _cached = {
    enabled: enabledRaw == null ? DEFAULTS.enabled : !!enabledRaw,
    publicBaseUrl: baseRaw || DEFAULTS.publicBaseUrl,
    tokenUrl: tokenRaw || DEFAULTS.tokenUrl,
  };
  _cachedAt = now;
  return _cached;
}
```

Note: `Date.now()` is available in normal runtime code (the workflow-script restriction does not apply to app source).

- [ ] **Step 8: Run test to verify it passes**

Run: `npx vitest run test/unit/a2a/a2a-settings.test.js`
Expected: PASS (4 tests).

- [ ] **Step 9: Commit**

```bash
git add db/schema.cds db/src/com.sap.developers.ims.ChatSettings.hdbmigrationtable srv/lib/runtime-config/a2a-settings.js test/unit/a2a/a2a-settings.test.js
git commit -m "feat: ChatSettings A2A config fields + DB→default resolver"
```

---

## Task 2: Wire resolver into card handler + kill-switch; remove env

Replace `process.env.A2A_*` reads with the resolver in `server.js` and `rpc-router.js`, and remove the feature-flag registry entry.

**Files:**
- Modify: `srv/server.js` (card handler, ~485-509)
- Modify: `srv/lib/a2a/rpc-router.js` (`enabled()` ~line 16 + its call site)
- Modify: `srv/lib/feature-flags/registry.js` (remove `A2A_ENABLED` entry)
- Test: `test/unit/a2a/rpc-router.test.js` (update kill-switch test)

**Interfaces:**
- Consumes: `resolveA2aSettings()` (Task 1).

- [ ] **Step 1: Update server.js card handler**

In `srv/server.js`, add the import near the other lib imports:
```javascript
import { resolveA2aSettings } from './lib/runtime-config/a2a-settings.js';
```
Change `a2aBaseUrl(req)` (~line 489) so the DB value takes precedence over VCAP/headers. Since it now needs the resolved value, make the card handler resolve first and pass base in:
```javascript
  function a2aBaseUrlFallback(req) {
    try {
      const uris = JSON.parse(process.env.VCAP_APPLICATION || '{}').application_uris;
      if (Array.isArray(uris) && uris[0]) return `https://${uris[0]}`;
    } catch { /* fall through */ }
    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    return `${proto}://${host}`;
  }

  app.get('/.well-known/agent-card.json', async (req, res) => {
    const cfg = await resolveA2aSettings();
    const baseUrl = cfg.publicBaseUrl || a2aBaseUrlFallback(req);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Vary', 'X-Forwarded-Host, Host');
    res.json(buildAgentCard({ baseUrl, tokenUrl: cfg.tokenUrl, enabled: cfg.enabled }));
  });
```
Remove the old `a2aBaseUrl` function that read `process.env.A2A_PUBLIC_BASE_URL` (replaced by `a2aBaseUrlFallback` + the resolver). Remove all `process.env.A2A_TOKEN_URL` / `process.env.A2A_ENABLED` references in this handler.

- [ ] **Step 2: Update rpc-router kill-switch**

In `srv/lib/a2a/rpc-router.js`:
- Add import: `import { resolveA2aSettings } from '../runtime-config/a2a-settings.js';`
- Remove `const enabled = () => process.env.A2A_ENABLED !== 'false';` (line ~16).
- At the top of the POST handler where it currently does `if (!enabled()) return rpcError(res, 503, ...)`, change to:
```javascript
      const a2aCfg = await resolveA2aSettings();
      if (!a2aCfg.enabled) return rpcError(res, 503, id, -32603, 'A2A endpoint disabled');
```
(The handler is already async.)

- [ ] **Step 3: Remove the feature-flag registry entry**

In `srv/lib/feature-flags/registry.js`, delete the `A2A_ENABLED` entry (~line 244-249, the `{ key: 'A2A_ENABLED', ... }` object, including its `// ---- A2A ----` section comment if that section now has no entries). Confirm no trailing comma / syntax breakage.

- [ ] **Step 4: Verify the feature-flag drift guard passes**

Run: `npx vitest run test/unit/feature-flags-registry.test.js --reporter=dot 2>&1 | tail -6`
Expected: PASS — the guard (every `X_ENABLED` env var in srv/ must be registered) now passes because no code reads `process.env.A2A_ENABLED` anymore. If it fails claiming A2A_ENABLED is unregistered, grep `srv/` for any remaining `process.env.A2A_ENABLED` and remove it.

- [ ] **Step 5: Update the rpc-router kill-switch test**

In `test/unit/a2a/rpc-router.test.js`, the test that sets `process.env.A2A_ENABLED = 'false'` and expects 503 must now drive the resolver. Add a mock for the resolver at the top with the other `vi.mock` calls:
```javascript
vi.mock('../../../srv/lib/runtime-config/a2a-settings.js', () => ({
  resolveA2aSettings: vi.fn(async () => ({ enabled: true, publicBaseUrl: '', tokenUrl: '' })),
}));
```
Import it in the test and change the "503 when disabled" test to:
```javascript
  it('503 when A2A disabled in settings', async () => {
    const { resolveA2aSettings } = await import('../../../srv/lib/runtime-config/a2a-settings.js');
    resolveA2aSettings.mockResolvedValueOnce({ enabled: false, publicBaseUrl: '', tokenUrl: '' });
    const r = await fetch(`${baseUrl}/a2a`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'message/send', params: {} }) });
    expect(r.status).toBe(503);
  });
```
Remove any `process.env.A2A_ENABLED` set/delete in that test file's setup.

- [ ] **Step 6: Run rpc-router + full a2a tests**

Run: `npx vitest run test/unit/a2a --reporter=dot 2>&1 | tail -8`
Expected: PASS — all a2a tests (including the updated kill-switch test).

- [ ] **Step 7: Grep-confirm no A2A env vars remain in code**

Run: `grep -rn "A2A_ENABLED\|A2A_PUBLIC_BASE_URL\|A2A_TOKEN_URL" srv/ | grep -v "\.test\." || echo "NO A2A ENV VARS IN SRV"`
Expected: `NO A2A ENV VARS IN SRV`.

- [ ] **Step 8: Commit**

```bash
git add srv/server.js srv/lib/a2a/rpc-router.js srv/lib/feature-flags/registry.js test/unit/a2a/rpc-router.test.js
git commit -m "feat: read A2A config from DB resolver; remove A2A env vars"
```

---

## Task 3: Admin UI — A2A panel on the Joule settings page

Add the 3 fields to the freestyle Joule settings page (view + controller + i18n).

**Files:**
- Modify: `app/admin/joule/webapp/view/Settings.view.xml`
- Modify: `app/admin/joule/webapp/controller/Settings.controller.js`
- Modify: `app/admin/joule/webapp/i18n/i18n.properties`

**Interfaces:** none (UI wiring against the existing `/admin/ChatSettings` OData singleton).

- [ ] **Step 1: Read the existing view + controller to match style**

Read `app/admin/joule/webapp/view/Settings.view.xml` and `app/admin/joule/webapp/controller/Settings.controller.js` fully. Note: (a) how a `<Panel>` is structured and where panels are added; (b) the `settings` JSONModel binding syntax (`{settings>/fieldName}`); (c) the `onInit` model defaults object; (d) the `_loadSettings` mapping (~line 70) that copies fetched OData fields into the model; (e) the `onSave` `body` object (~line 103) built for the PATCH.

- [ ] **Step 2: Add the A2A panel to the view**

In `Settings.view.xml`, add a new `<Panel>` (matching the existing panels' structure) after the last existing panel, with headerText bound to an i18n key `a2aPanelTitle`:
```xml
<Panel headerText="{i18n>a2aPanelTitle}" expandable="true" expanded="false" class="sapUiResponsiveMargin" width="auto">
  <form:SimpleForm editable="true" layout="ResponsiveGridLayout" labelSpanXL="4" labelSpanL="4" labelSpanM="4" labelSpanS="12">
    <Label text="{i18n>a2aEnabledLabel}"/>
    <Switch state="{settings>/a2aEnabled}"/>
    <Label text="{i18n>a2aPublicBaseUrlLabel}"/>
    <Input value="{settings>/a2aPublicBaseUrl}" placeholder="{i18n>a2aPublicBaseUrlPlaceholder}"/>
    <Label text="{i18n>a2aTokenUrlLabel}"/>
    <Input value="{settings>/a2aTokenUrl}" placeholder="{i18n>a2aTokenUrlPlaceholder}"/>
  </form:SimpleForm>
</Panel>
```
(Match the actual namespaces/aliases used in the file — if the existing panels use `<f:SimpleForm>` or plain `<VBox>`+`<Label>`+control, mirror THAT exact structure and control set. Adapt the snippet to the file's real idiom rather than forcing `form:`.)

- [ ] **Step 3: Wire the 3 fields in the controller**

In `Settings.controller.js`:
- `onInit` model defaults: add `a2aEnabled: true, a2aPublicBaseUrl: "", a2aTokenUrl: ""`.
- `_loadSettings` mapping: add `a2aEnabled: data.a2aEnabled ?? true, a2aPublicBaseUrl: data.a2aPublicBaseUrl || "", a2aTokenUrl: data.a2aTokenUrl || ""` (match the file's existing mapping style — it may map field-by-field or spread).
- `onSave` `body`: add `a2aEnabled: m.a2aEnabled, a2aPublicBaseUrl: m.a2aPublicBaseUrl, a2aTokenUrl: m.a2aTokenUrl` (match how the existing body reads from the model — variable name may differ; use the file's actual model-read pattern).

- [ ] **Step 4: Add i18n keys**

In `app/admin/joule/webapp/i18n/i18n.properties`, add:
```
a2aPanelTitle=A2A (Agent-to-Agent) Endpoint
a2aEnabledLabel=A2A Enabled
a2aPublicBaseUrlLabel=Public Base URL
a2aPublicBaseUrlPlaceholder=https://your-host (blank = auto-detect from platform)
a2aTokenUrlLabel=OAuth Token URL
a2aTokenUrlPlaceholder=XSUAA token endpoint for the Agent Card
```

- [ ] **Step 5: Lint the changed UI5 files**

Run: `npx eslint app/admin/joule/webapp/controller/Settings.controller.js 2>&1 | tail -10 || echo "eslint not configured for this path — skip"`
Expected: no errors (or the skip message). Also sanity-check the XML view is well-formed:
Run: `node -e "const fs=require('fs'); const s=fs.readFileSync('app/admin/joule/webapp/view/Settings.view.xml','utf8'); const o=(s.match(/<Panel/g)||[]).length, c=(s.match(/<\/Panel>/g)||[]).length; console.log('Panel open/close:', o, c); process.exit(o===c?0:1)"`
Expected: open === close count.

- [ ] **Step 6: Commit**

```bash
git add app/admin/joule/webapp/view/Settings.view.xml app/admin/joule/webapp/controller/Settings.controller.js app/admin/joule/webapp/i18n/i18n.properties
git commit -m "feat(admin-ui): A2A config panel on Joule settings page"
```

---

## Task 4: Docs + optional annotations + full verification

Update docs to reflect DB config, add optional metadata labels, run the full suite, push, PR.

**Files:**
- Modify: `docs/developers/reference/a2a-instructions.md`, `docs/developers/operations/testing-endpoints.md`
- Modify (optional): `app/admin-annotations.cds`
- Possibly modify: `CLAUDE.md` (A2A gotcha, if one was added for the env vars)

- [ ] **Step 1: Update the consumption guide**

In `docs/developers/reference/a2a-instructions.md`, replace any mention of `A2A_ENABLED`/`A2A_PUBLIC_BASE_URL`/`A2A_TOKEN_URL` env vars with: "Configured by an Admin at `/admin-ui/#joule` (A2A panel): enable/disable, public base URL, and OAuth token URL. Changes take effect within ~5 seconds (no restart)."

- [ ] **Step 2: Update testing-endpoints.md**

In `docs/developers/operations/testing-endpoints.md`, update the A2A rows' notes to say enablement/config is via `/admin-ui/#joule` (ChatSettings), not env. Remove any env-var column references for A2A.

- [ ] **Step 3: (Optional) Add metadata labels**

In `app/admin-annotations.cds` near the `annotate AdminService.ChatSettings` block (~line 1913), add `@Common.Label` for the 3 fields (mirrors existing style). This is metadata-only (the freestyle app doesn't consume it) — include for completeness:
```cds
  a2aEnabled       @Common.Label: 'A2A Enabled' @description: 'Master switch for the /a2a endpoint and Agent Card.';
  a2aPublicBaseUrl @Common.Label: 'A2A Public Base URL' @description: 'Base URL advertised in the Agent Card; blank = auto-detect from platform.';
  a2aTokenUrl      @Common.Label: 'A2A Token URL' @description: 'OAuth token endpoint advertised in the Agent Card security scheme.';
```

- [ ] **Step 4: Search docs/CLAUDE.md for stale env references**

Run: `grep -rn "A2A_ENABLED\|A2A_PUBLIC_BASE_URL\|A2A_TOKEN_URL" docs/ CLAUDE.md 2>/dev/null || echo "NO STALE A2A ENV REFS"`
Expected: `NO STALE A2A ENV REFS` (or fix any that remain — but do NOT edit the user's global `~/.claude/CLAUDE.md`; only the repo `CLAUDE.md`).

- [ ] **Step 5: Schema deploy + build re-check**

Run: `npx cds deploy --to sqlite::memory: > /dev/null 2>&1 && echo "DEPLOY OK"; npx cds compile srv/ --to json > /dev/null 2>&1 && echo "COMPILE OK"`
Expected: both OK.

- [ ] **Step 6: Full unit suite**

Run: `npm test 2>&1 | tail -15`
Expected: PASS except the known pre-existing `test/unit/os-toggle.test.ts` (6 failures) — confirm no NEW failures.

- [ ] **Step 7: Commit + push + PR**

```bash
git add docs/developers/reference/a2a-instructions.md docs/developers/operations/testing-endpoints.md app/admin-annotations.cds CLAUDE.md 2>/dev/null
git commit -m "docs: A2A config via Admin UI (not env vars)"
git push -u origin a2a-config-to-db
gh pr create --draft --repo sap-tutorials/tutorials-ims --base main --head a2a-config-to-db \
  --title "feat: move A2A config from env vars to ChatSettings DB + Admin UI" \
  --body "Follow-up to #1220. Moves A2A_ENABLED / A2A_PUBLIC_BASE_URL / A2A_TOKEN_URL from environment variables to ChatSettings DB fields editable at /admin-ui/#joule. Adds a DB→default resolver, an A2A panel on the Joule settings page, removes the A2A env vars + feature-flag registry entry. Spec: docs/superpowers/specs/2026-07-16-a2a-config-to-db-design.md"
```

---

## Self-Review

**Spec coverage:** schema 3 fields (Task 1) ✓; migration regen (Task 1) ✓; resolver DB→default (Task 1) ✓; server.js card reads resolver (Task 2) ✓; rpc-router kill-switch reads resolver (Task 2) ✓; registry entry removed (Task 2) ✓; Admin UI panel (Task 3) ✓; docs updated + env removed (Tasks 2,4) ✓; CSV untouched + migration not hand-edited (Global Constraints, Task 1 steps 3-4) ✓; enabled default true (Task 1) ✓.

**Type consistency:** `resolveA2aSettings()` → `{enabled, publicBaseUrl, tokenUrl}` consumed identically in server.js + rpc-router (Task 2) and produced in Task 1. `buildAgentCard({baseUrl, tokenUrl, enabled})` signature unchanged (only its arg source changes). Field names `a2aEnabled`/`a2aPublicBaseUrl`/`a2aTokenUrl` consistent across schema, resolver (both camel + UPPER fallback), controller, and CSV-exclusion note.

**Placeholder scan:** no TBD/TODO; each code step has full code; commands have expected output. Task 3 explicitly instructs matching the file's real idiom (the exact view/controller structure is read in Step 1 before editing) rather than assuming — appropriate for freestyle UI I haven't line-mapped.
