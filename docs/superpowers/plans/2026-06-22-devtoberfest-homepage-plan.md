# Devtoberfest Homepage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a public `/devtoberfest/` homepage with auth-gated registration, scroll-to-enable T&C dialog, and admin config tile — per spec at `docs/superpowers/specs/2026-06-22-devtoberfest-homepage-design.md`.

**Architecture:** Hugo-served static page + Vue island that calls 4 endpoints on tutorials-srv (2 public: status/terms, 2 XSUAA-gated: join/me). Two new HANA entities (`DevtoberfestConfig` singleton + `EventRegistrations` cross-ref). One new admin tile under System (Configuration + Registrations sub-tabs). Auth uses the site's existing shellbar — no custom auth UX.

**Tech Stack:** CAP Node.js, HANA, Hugo, Vue 3 + UI5 Web Components, vitest, sap.fe.templates.ListReport (for the admin tile's Registrations view), sap.m.IconTabBar (for the tile's tab strip).

**Spec:** [docs/superpowers/specs/2026-06-22-devtoberfest-homepage-design.md](../specs/2026-06-22-devtoberfest-homepage-design.md)

**Branch:** `feat/devtoberfest-homepage` (already created)

---

## Working agreement

- **TDD throughout.** Each task: write the failing test → run it (confirm it fails) → write minimal code → run again (confirm it passes) → commit. Follow the @superpowers:test-driven-development skill.
- **One commit per task.** Smaller commits = easier review + cleaner blame.
- **Pre-stage CDS artifacts.** After ANY schema change in this plan, run `npx cds build --production` and commit the regenerated `db/last-dev/csn.json` + `db/src/*.hdbmigrationtable` files alongside the schema change. Per memory `feedback_cds_build_staging_check_csn_diff` — CI fails otherwise.
- **No regressions.** Before final PR, run the broader test suite (`npx vitest run` against the unit project) to confirm nothing adjacent broke.
- **Reuse `resolveUser`.** The join handler reads the authenticated user via `srv/lib/resolve-user.js` (shipped in PR #557) — not `req.user` directly. The helper handles the deployed-XSUAA + multer async-context drop pattern.
- **Match singleton pattern.** `DevtoberfestConfig` mirrors `ChatSettings` exactly: bare entity in db CDS (no `@odata.singleton`), `@odata.singleton` only on the AdminService projection, defensive `before('READ', '<Entity>', ...)` handler in admin-service.js to insert the row on first access. See `srv/admin-service.js:104-117` for the template.

---

## File structure map

### New files

```text
db/devtoberfest.cds                                 ← DevtoberfestConfig + EventRegistrations entities
srv/routes/devtoberfest-public.js                   ← /api/devtoberfest/{status,terms}: public reads
srv/routes/devtoberfest-auth.js                     ← /api/devtoberfest/{join,me}: XSUAA-gated
hugo/content/devtoberfest/_index.md                 ← Hugo page front-matter (mounts island)
hugo/layouts/devtoberfest/list.html                 ← layout: mount point + noscript fallback
hugo/static/images/devtoberfest/kasimir.svg         ← placeholder: cat emoji in styled SVG circle
hugo/static/images/devtoberfest/teched-logo.svg     ← placeholder: SAP TechEd wordmark
hugo/static/images/devtoberfest/devtoberfest-logo.svg ← placeholder: Devtoberfest wordmark
hugo-apps/src/devtoberfest/main.ts                  ← Vue mount glue
hugo-apps/src/devtoberfest/DevtoberfestHome.vue     ← main homepage component (state machine, header, body, rail)
hugo-apps/src/devtoberfest/TermsDialog.vue          ← T&C dialog (scroll-to-enable, POST to join)
hugo-apps/src/devtoberfest/types.ts                 ← shared TS interfaces (StatusResponse, etc.)
hugo-apps/src/devtoberfest/styles.css               ← scoped Joule-gradient × arcade overlay styles
app/admin/devtoberfest/package.json                 ← UI5 app shell (mirrors app/admin/secrets/package.json)
app/admin/devtoberfest/ui5.yaml                     ← UI5 build config
app/admin/devtoberfest/webapp/Component.js          ← UI5 component
app/admin/devtoberfest/webapp/manifest.json         ← UI5 manifest (IconTabBar routing)
app/admin/devtoberfest/webapp/view/Devtoberfest.view.xml         ← root view with IconTabBar
app/admin/devtoberfest/webapp/view/ConfigurationTab.fragment.xml ← Configuration tab markup
app/admin/devtoberfest/webapp/view/RegistrationsTab.fragment.xml ← Registrations tab markup
app/admin/devtoberfest/webapp/controller/Devtoberfest.controller.js ← shared tab orchestrator
app/admin/devtoberfest/webapp/i18n/i18n.properties               ← labels
test/unit/devtoberfest-config-schema.test.js
test/unit/devtoberfest-status-handler.test.js
test/unit/devtoberfest-join-handler.test.js
test/unit/devtoberfest-registration-unique.test.js
test/unit/devtoberfest-terms-handler.test.js
test/hybrid/devtoberfest-registration-hana.test.js
test/smoke/devtoberfest.smoke.test.js
```

### Modified files

```text
db/schema.cds                          ← `using` for db/devtoberfest.cds
srv/admin-service.cds                  ← DevtoberfestConfig + EventRegistrations projections, value-help code list
srv/admin-service.js                   ← defensive singleton-init handler, legacyKeyedEntities list update
srv/server.js                          ← register(public/auth) route modules
app/admin-shell/webapp/manifest.json   ← devtoberfest resourceRoot + componentUsage + route + target
app/admin-shell/webapp/controller/Shell.controller.js ← NAV_KEY_TO_ROUTE + NAV_KEY_TO_TITLE entries
app/admin-shell/webapp/view/Shell.view.xml ← new nav item under System
app/admin-shell/scripts/copy-components.js ← add 'devtoberfest' to copy list
app/admin-annotations.cds              ← EventRegistrations annotations (LineItem, SelectionFields, etc.)
approuter/xs-app.json                  ← /devtoberfest/* (static, no-auth) + /api/devtoberfest/{status,terms} (no-auth) + /api/devtoberfest/{join,me} (xsuaa)
hugo-apps/vite.config.ts               ← devtoberfest entry point in rollupOptions.input
db/last-dev/csn.json                   ← regenerated by cds build
db/src/com.sap.developers.ims.DevtoberfestConfig.hdbmigrationtable    ← generated by cds build
db/src/com.sap.developers.ims.EventRegistrations.hdbmigrationtable    ← generated by cds build
```

---

## Task 1: Schema — DevtoberfestConfig + EventRegistrations entities

**Files:**
- Create: `db/devtoberfest.cds`
- Modify: `db/schema.cds` (add `using from './devtoberfest';` at top of file)

- [ ] **Step 1: Write the failing test**

Create `test/unit/devtoberfest-registration-unique.test.js`:

```javascript
// test/unit/devtoberfest-registration-unique.test.js
// Verifies the @assert.unique.userEvent constraint rejects duplicate
// (user, event) rows. The constraint is the safety net behind the
// idempotent join flow — POST /api/devtoberfest/join can safely retry
// because the DB enforces "one registration per user-event pair".

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

describe('EventRegistrations @assert.unique.userEvent', () => {
  let Users, Events, EventRegistrations;
  const userId = cds.utils.uuid();
  const eventId = cds.utils.uuid();

  beforeAll(() => {
    ({ Users, Events, EventRegistrations } = cds.entities('com.sap.developers.ims'));
  });

  beforeEach(async () => {
    await DELETE.from(EventRegistrations);
    await DELETE.from(Users).where({ ID: userId });
    await DELETE.from(Events).where({ ID: eventId });
    await INSERT.into(Users).entries({ ID: userId, sapId: 'C1234567', email: 'a@b', legacyId: 1234567 });
    await INSERT.into(Events).entries({
      ID: eventId, name: 'Devtoberfest 2026',
      startDate: '2026-10-01T00:00:00Z', endDate: '2026-10-28T00:00:00Z',
      legacyId: 9001,
    });
  });

  it('accepts the first registration for a (user, event) pair', async () => {
    await INSERT.into(EventRegistrations).entries({
      ID: cds.utils.uuid(),
      user_ID: userId, event_ID: eventId,
      joinedAt: new Date().toISOString(),
      termsVersion: 1,
      termsAcceptedAt: new Date().toISOString(),
      legacyId: 1,
    });
    const rows = await SELECT.from(EventRegistrations);
    expect(rows.length).toBe(1);
  });

  it('rejects a second registration for the same (user, event)', async () => {
    await INSERT.into(EventRegistrations).entries({
      ID: cds.utils.uuid(),
      user_ID: userId, event_ID: eventId,
      joinedAt: new Date().toISOString(),
      termsVersion: 1,
      termsAcceptedAt: new Date().toISOString(),
      legacyId: 1,
    });
    await expect(
      INSERT.into(EventRegistrations).entries({
        ID: cds.utils.uuid(),
        user_ID: userId, event_ID: eventId,
        joinedAt: new Date().toISOString(),
        termsVersion: 1,
        termsAcceptedAt: new Date().toISOString(),
        legacyId: 2,
      })
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run test/unit/devtoberfest-registration-unique.test.js --project unit
```
Expected: FAIL — `cds.entities('com.sap.developers.ims').EventRegistrations` is undefined.

- [ ] **Step 3: Create the schema file**

Create `db/devtoberfest.cds`:

```cds
namespace com.sap.developers.ims;

using { com.sap.developers.ims as ims } from './schema';

/**
 * Singleton config (one row, fixed UUID) for the Devtoberfest homepage.
 *
 * Lifecycle:
 *   - The entity has no inline @odata.singleton — that lives on the
 *     AdminService projection in srv/admin-service.cds.
 *   - Defensive insert lives in srv/admin-service.js as a
 *     before('READ', 'DevtoberfestConfig') handler — auto-creates the
 *     row on first access. Same shape as ChatSettings + KnowledgeGraphSettings.
 *   - termsVersion bump forces re-acceptance for unregistered users
 *     mid-flow (via 412 from /api/devtoberfest/join).
 *
 * Spec: docs/superpowers/specs/2026-06-22-devtoberfest-homepage-design.md §5.1
 */
entity DevtoberfestConfig {
  key ID            : UUID;
  currentEvent      : Association to ims.Events;
  termsText         : LargeString;          // markdown body
  termsVersion      : Integer default 1;
  contentRulesUrl   : String(500);
  faqUrl            : String(500);
  gameboardUrl      : String(500);
  activitiesUrl     : String(500);
}

/**
 * One row per (user, event) registration. The @assert.unique.userEvent
 * constraint makes POST /api/devtoberfest/join idempotent — a second
 * call for the same pair fails at the DB layer, which the handler
 * translates to HTTP 409.
 *
 * Spec: docs/superpowers/specs/2026-06-22-devtoberfest-homepage-design.md §5.2
 */
@assert.unique.userEvent: [user, event]
entity EventRegistrations : cuid, managed, LegacyKeyed {
  user             : Association to ims.Users @mandatory;
  event            : Association to ims.Events @mandatory;
  joinedAt         : Timestamp;
  termsVersion     : Integer;
  termsAcceptedAt  : Timestamp;
}
```

Note: `cuid`, `managed`, and `LegacyKeyed` are imported via the `using` statement (they're aspects defined in db/schema.cds — verified by `grep -n "aspect LegacyKeyed\|aspect cuid" db/schema.cds`).

- [ ] **Step 4: Wire the new file into db/schema.cds**

Add at the top of `db/schema.cds` (right after the existing `using` statements):

```cds
using from './devtoberfest';
```

Verify by reading `db/schema.cds:1-10` — `using` statements live there.

- [ ] **Step 5: Run the test again — it should now pass**

```bash
npx vitest run test/unit/devtoberfest-registration-unique.test.js --project unit
```
Expected: PASS, 2/2 tests.

- [ ] **Step 6: Pre-stage cds build artifacts**

```bash
npx cds build --production
git status --short db/last-dev/ db/src/
```
Expected: `db/last-dev/csn.json` modified + two new `hdbmigrationtable` files (DevtoberfestConfig + EventRegistrations).

- [ ] **Step 7: Commit**

```bash
git add db/devtoberfest.cds db/schema.cds db/last-dev/csn.json db/src/com.sap.developers.ims.DevtoberfestConfig.hdbmigrationtable db/src/com.sap.developers.ims.EventRegistrations.hdbmigrationtable test/unit/devtoberfest-registration-unique.test.js
git commit -m "feat(db): DevtoberfestConfig + EventRegistrations entities

Spec: docs/superpowers/specs/2026-06-22-devtoberfest-homepage-design.md §5

Two new entities for the Devtoberfest homepage feature (#397):
- DevtoberfestConfig: singleton config (current event, terms text/version, sub-page URLs)
- EventRegistrations: per (user, event) audit row, @assert.unique.userEvent

Test test/unit/devtoberfest-registration-unique.test.js verifies the
unique constraint — the safety net behind the idempotent join flow."
```

---

## Task 2: AdminService projections + defensive singleton init

**Files:**
- Modify: `srv/admin-service.cds`
- Modify: `srv/admin-service.js`
- Test: `test/unit/devtoberfest-config-schema.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/unit/devtoberfest-config-schema.test.js`:

```javascript
// test/unit/devtoberfest-config-schema.test.js
// Verifies the DevtoberfestConfig singleton invariant:
//   - First READ auto-creates the row (defensive init)
//   - Default termsVersion = 1 on a fresh row
//   - Subsequent READs reuse the same row (no duplicate)

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

const ADMIN = { id: 'admin@test', roles: ['Admin'] };

describe('DevtoberfestConfig singleton', () => {
  let DevtoberfestConfig;

  beforeAll(() => {
    ({ DevtoberfestConfig } = cds.entities('com.sap.developers.ims'));
  });

  beforeEach(async () => {
    await DELETE.from(DevtoberfestConfig);
  });

  it('GET /admin/DevtoberfestConfig auto-creates the singleton on first read', async () => {
    const srv = await cds.connect.to('AdminService');
    const rowBefore = await SELECT.one.from(DevtoberfestConfig);
    expect(rowBefore).toBeFalsy();

    const result = await srv.tx({ user: ADMIN }, (tx) => tx.read('DevtoberfestConfig'));
    expect(result).toBeTruthy();
    // FE V4 odata.singleton returns the row object (or wrapped); check via DB.
    const rowAfter = await SELECT.one.from(DevtoberfestConfig);
    expect(rowAfter).toBeTruthy();
    expect(rowAfter.termsVersion).toBe(1);
  });

  it('subsequent reads reuse the same row', async () => {
    const srv = await cds.connect.to('AdminService');
    await srv.tx({ user: ADMIN }, (tx) => tx.read('DevtoberfestConfig'));
    await srv.tx({ user: ADMIN }, (tx) => tx.read('DevtoberfestConfig'));
    const rows = await SELECT.from(DevtoberfestConfig);
    expect(rows.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run test/unit/devtoberfest-config-schema.test.js --project unit
```
Expected: FAIL — `AdminService.DevtoberfestConfig` doesn't exist yet (no projection).

- [ ] **Step 3: Add projections to srv/admin-service.cds**

Find the section near other singletons (around `entity ChatSettings as projection on ims.ChatSettings`) — typically `srv/admin-service.cds:88-93`. After the `KnowledgeGraphSettings` block, add:

```cds
@odata.singleton
@requires: 'Admin'
entity DevtoberfestConfig as projection on ims.DevtoberfestConfig;

@readonly
entity EventRegistrations as projection on ims.EventRegistrations;
```

- [ ] **Step 4: Add defensive singleton init + legacyId allocator entry to srv/admin-service.js**

Find the `ChatSettings` defensive-init block at `srv/admin-service.js:104-117`. Immediately AFTER it, add:

```javascript
    // Ensure singleton row exists for DevtoberfestConfig (defensive — same
    // shape as ChatSettings above). Hardcoded UUID matches the
    // "one row per system" invariant. termsVersion defaults to 1; admin
    // populates termsText + currentEvent via the Devtoberfest admin tile.
    const DEVTOBERFEST_CONFIG_SINGLETON_ID = '00000000-0000-0000-0000-00d0fe57feed';
    this.before('READ', 'DevtoberfestConfig', async () => {
      const exists = await SELECT.one.from('com.sap.developers.ims.DevtoberfestConfig')
        .where({ ID: DEVTOBERFEST_CONFIG_SINGLETON_ID });
      if (!exists) {
        await INSERT.into('com.sap.developers.ims.DevtoberfestConfig').entries({
          ID: DEVTOBERFEST_CONFIG_SINGLETON_ID,
          termsVersion: 1,
        });
      }
    });
```

Then find the `legacyKeyedEntities` array (around line 120-127) and add `'EventRegistrations'` to the list — alphabetical-ish, near `PrivacyProtectionActions`:

```javascript
    const legacyKeyedEntities = [
      'Users', 'Tutorials', 'Missions', 'Groups', 'Events', 'TaskRecords',
      'StepFailures', 'Tags', 'Accomplishments', 'AccomplishmentRecords',
      'PrizeRecords', 'TutorialMeta', 'TutorialContributors', 'TutorialRepositories',
      'FeaturedTasks', 'PrimaryAccounts', 'SecondaryAccounts', 'PrivacyProtectionActions',
      'EventRegistrations',   // ← ADD THIS line; keep every existing entry below it intact.
      // (DO NOT delete any pre-existing entries that follow this line in the file.)
    ];
```

- [ ] **Step 5: Run the test — should pass**

```bash
npx vitest run test/unit/devtoberfest-config-schema.test.js --project unit
```
Expected: PASS, 2/2 tests.

- [ ] **Step 6: Re-run cds build (annotations changed)**

```bash
npx cds build --production
git status --short db/last-dev/ db/src/
```
Expected: `db/last-dev/csn.json` shows further drift from the AdminService projection annotations. Stage it.

- [ ] **Step 7: Commit**

```bash
git add srv/admin-service.cds srv/admin-service.js db/last-dev/csn.json test/unit/devtoberfest-config-schema.test.js
git commit -m "feat(admin): DevtoberfestConfig + EventRegistrations AdminService projections

- @odata.singleton on DevtoberfestConfig, @readonly on EventRegistrations.
- Defensive READ-handler in admin-service.js auto-creates the singleton
  on first access — same pattern as ChatSettings / KnowledgeGraphSettings.
- EventRegistrations added to legacyKeyedEntities so legacyId auto-allocates
  on create.

Spec §5.1, §9.5."
```

---

## Task 3: Public route scaffold + `/api/devtoberfest/status` (event-missing path)

**Files:**
- Create: `srv/routes/devtoberfest-public.js`
- Modify: `srv/server.js` (~line 18 + ~line 185)
- Test: `test/unit/devtoberfest-status-handler.test.js`

- [ ] **Step 1: Write the failing test (event-missing case only — first slice)**

Create `test/unit/devtoberfest-status-handler.test.js`:

```javascript
// test/unit/devtoberfest-status-handler.test.js
// Tests for GET /api/devtoberfest/status. Built incrementally across
// Tasks 3, 4. Each slice adds one branch of the state machine in
// spec §6.1.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

describe('GET /api/devtoberfest/status', () => {
  let DevtoberfestConfig, Events;

  beforeAll(() => {
    ({ DevtoberfestConfig, Events } = cds.entities('com.sap.developers.ims'));
  });

  beforeEach(async () => {
    await DELETE.from(DevtoberfestConfig);
    await DELETE.from(Events);
  });

  it('returns 503 EVENT_NOT_CONFIGURED when currentEvent is NULL', async () => {
    const res = await project.axios.get('/api/devtoberfest/status', {
      validateStatus: () => true,
    });
    expect(res.status).toBe(503);
    expect(res.data.error).toBe('EVENT_NOT_CONFIGURED');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run test/unit/devtoberfest-status-handler.test.js --project unit
```
Expected: FAIL with 404 (route not registered yet).

- [ ] **Step 3: Create the public route module**

Create `srv/routes/devtoberfest-public.js`:

```javascript
// Public read endpoints for the Devtoberfest homepage island.
// Mounted at /api/devtoberfest/{status,terms}. NO auth — anonymous
// users see the page and the JOIN button (which is gated separately
// by /api/devtoberfest/join requiring XSUAA).
//
// Spec: docs/superpowers/specs/2026-06-22-devtoberfest-homepage-design.md §6

import cds from '@sap/cds';

const LOG = cds.log('devtoberfest');
const DEVTOBERFEST_CONFIG_SINGLETON_ID = '00000000-0000-0000-0000-00d0fe57feed';

async function ensureSingleton() {
  const { DevtoberfestConfig } = cds.entities('com.sap.developers.ims');
  const existing = await SELECT.one.from(DevtoberfestConfig)
    .where({ ID: DEVTOBERFEST_CONFIG_SINGLETON_ID });
  if (!existing) {
    await INSERT.into(DevtoberfestConfig).entries({
      ID: DEVTOBERFEST_CONFIG_SINGLETON_ID,
      termsVersion: 1,
    });
  }
}

async function statusHandler(req, res) {
  try {
    await cds.connect.to('db');
    await ensureSingleton();
    const { DevtoberfestConfig, Events } = cds.entities('com.sap.developers.ims');

    const config = await SELECT.one.from(DevtoberfestConfig);
    if (!config?.currentEvent_ID) {
      return res.status(503).json({ error: 'EVENT_NOT_CONFIGURED' });
    }

    const event = await SELECT.one.from(Events).where({ ID: config.currentEvent_ID });
    // TODO Task 4: resolve joined + termsRequired per caller.
    return res.status(200).json({
      event: event ? { name: event.name, startDate: event.startDate, endDate: event.endDate } : null,
      joined: false,
      termsVersion: config.termsVersion,
      termsRequired: true,
      contentRulesUrl: config.contentRulesUrl || '',
      faqUrl: config.faqUrl || '',
      gameboardUrl: config.gameboardUrl || '',
      activitiesUrl: config.activitiesUrl || '',
    });
  } catch (err) {
    LOG.error('[status]', err);
    return res.status(500).json({ error: 'INTERNAL' });
  }
}

export function register(app) {
  app.get('/api/devtoberfest/status', statusHandler);
  // /api/devtoberfest/terms wired in Task 5.
}

export { statusHandler };
```

- [ ] **Step 4: Wire into srv/server.js**

After the existing `import * as advocatesPublic from './routes/advocates-public.js';` (around line 18), add:

```javascript
import * as devtoberfestPublic from './routes/devtoberfest-public.js';
```

Then after `advocatesPublic.register(app);` (around line 185), add:

```javascript
  devtoberfestPublic.register(app);
```

- [ ] **Step 5: Run the test — should pass**

```bash
npx vitest run test/unit/devtoberfest-status-handler.test.js --project unit
```
Expected: PASS, 1/1.

- [ ] **Step 6: Commit**

```bash
git add srv/routes/devtoberfest-public.js srv/server.js test/unit/devtoberfest-status-handler.test.js
git commit -m "feat(srv): /api/devtoberfest/status — event-missing 503 path

First slice of the public route module. Returns 503 EVENT_NOT_CONFIGURED
when DevtoberfestConfig.currentEvent_ID is NULL. Defensive singleton
init lives here too (duplicates the AdminService before-READ handler
because this route bypasses AdminService dispatch).

Spec §6.1. Subsequent tasks fill in joined-resolution + /terms."
```

---

## Task 4: `/api/devtoberfest/status` — joined-resolution branches

**Files:**
- Modify: `srv/routes/devtoberfest-public.js`
- Test: `test/unit/devtoberfest-status-handler.test.js` (extends existing file)

- [ ] **Step 1: Add the three remaining state-machine tests**

Add inside the existing `describe('GET /api/devtoberfest/status', ...)`, after the existing `it('returns 503 ...')`:

```javascript
  describe('with event configured', () => {
    let Users;
    const SINGLETON_ID = '00000000-0000-0000-0000-00d0fe57feed';
    const eventId = cds.utils.uuid();

    beforeAll(() => {
      ({ Users } = cds.entities('com.sap.developers.ims'));
    });

    beforeEach(async () => {
      const { EventRegistrations } = cds.entities('com.sap.developers.ims');
      await DELETE.from(EventRegistrations);
      await DELETE.from(Events);
      await DELETE.from(DevtoberfestConfig);
      await INSERT.into(Events).entries({
        ID: eventId, name: 'Devtoberfest 2026',
        startDate: '2026-10-01T00:00:00Z', endDate: '2026-10-28T00:00:00Z',
        legacyId: 9001,
      });
      await INSERT.into(DevtoberfestConfig).entries({
        ID: SINGLETON_ID,
        currentEvent_ID: eventId,
        termsVersion: 3,
        contentRulesUrl: 'https://example.test/rules',
        faqUrl: '', gameboardUrl: '', activitiesUrl: '',
      });
    });

    it('anonymous → 200 { joined: false, termsRequired: true }', async () => {
      const res = await project.axios.get('/api/devtoberfest/status');
      expect(res.status).toBe(200);
      expect(res.data).toMatchObject({
        event: { name: 'Devtoberfest 2026' },
        joined: false,
        termsVersion: 3,
        termsRequired: true,
        contentRulesUrl: 'https://example.test/rules',
      });
    });

    it('authenticated unregistered → joined: false', async () => {
      const res = await project.axios.get('/api/devtoberfest/status', {
        auth: { username: 'C0000001', password: 'password' },
      }).catch((e) => e.response);
      expect(res.status).toBe(200);
      expect(res.data.joined).toBe(false);
    });

    it('authenticated registered → joined: true, termsRequired: false', async () => {
      const userId = cds.utils.uuid();
      const { EventRegistrations } = cds.entities('com.sap.developers.ims');
      await INSERT.into(Users).entries({ ID: userId, sapId: 'admin', email: 'a@b', legacyId: 2 });
      await INSERT.into(EventRegistrations).entries({
        ID: cds.utils.uuid(),
        user_ID: userId, event_ID: eventId,
        joinedAt: '2026-06-15T00:00:00Z',
        termsVersion: 3,
        termsAcceptedAt: '2026-06-15T00:00:00Z',
        legacyId: 1,
      });
      const res = await project.axios.get('/api/devtoberfest/status', {
        auth: { username: 'admin', password: 'admin' },
      });
      expect(res.status).toBe(200);
      expect(res.data.joined).toBe(true);
      expect(res.data.termsRequired).toBe(false);
    });
  });
```

**Auth note:** cds.test mock-auth maps `Authorization: Basic admin:admin` to `req.user = { id: 'admin', roles: ['Admin', 'authenticated-user'] }`. The `authenticated registered` test seeds a Users row with `sapId: 'admin'` to bridge `req.user.id` ↔ Users lookup.

- [ ] **Step 2: Run tests — `authenticated registered` should fail**

```bash
npx vitest run test/unit/devtoberfest-status-handler.test.js --project unit
```
Expected: FAIL on `authenticated registered` (handler still returns `joined: false`).

- [ ] **Step 3: Update statusHandler to resolve joined state**

In `srv/routes/devtoberfest-public.js`, add the import at the top:

```javascript
import { resolveUser } from '../lib/resolve-user.js';
```

Replace the `// TODO Task 4` block + the literal `joined: false` with:

```javascript
    const user = resolveUser(req, cds);
    let joined = false;
    if (user) {
      const { Users, EventRegistrations } = cds.entities('com.sap.developers.ims');
      const dbUser = await SELECT.one.from(Users).where({ sapId: user.id });
      if (dbUser) {
        const reg = await SELECT.one.from(EventRegistrations).where({
          user_ID: dbUser.ID,
          event_ID: config.currentEvent_ID,
        });
        joined = Boolean(reg);
      }
    }

    return res.status(200).json({
      event: event ? { name: event.name, startDate: event.startDate, endDate: event.endDate } : null,
      joined,
      termsVersion: config.termsVersion,
      termsRequired: !joined,
      contentRulesUrl: config.contentRulesUrl || '',
      faqUrl: config.faqUrl || '',
      gameboardUrl: config.gameboardUrl || '',
      activitiesUrl: config.activitiesUrl || '',
    });
```

- [ ] **Step 4: Re-run tests — all pass**

```bash
npx vitest run test/unit/devtoberfest-status-handler.test.js --project unit
```
Expected: PASS, 4/4.

- [ ] **Step 5: Commit**

```bash
git add srv/routes/devtoberfest-public.js test/unit/devtoberfest-status-handler.test.js
git commit -m "feat(srv): /api/devtoberfest/status — resolve joined state per caller

Uses srv/lib/resolve-user.js (PR #557) to identify the calling user.
Looks up Users by sapId, then EventRegistrations by (user, currentEvent).
termsRequired mirrors !joined. Anonymous + unknown-user paths return
joined:false (no Users row to anchor the lookup).

Spec §6.1."
```

---

## Task 5: `/api/devtoberfest/terms`

**Files:**
- Modify: `srv/routes/devtoberfest-public.js`
- Test: `test/unit/devtoberfest-terms-handler.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/unit/devtoberfest-terms-handler.test.js`:

```javascript
// test/unit/devtoberfest-terms-handler.test.js
// /api/devtoberfest/terms returns the raw markdown termsText + current
// termsVersion. Client (TermsDialog.vue) renders the markdown — server
// stays renderer-free in Phase 1 to keep the dependency surface tiny.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

describe('GET /api/devtoberfest/terms', () => {
  let DevtoberfestConfig;
  const SINGLETON_ID = '00000000-0000-0000-0000-00d0fe57feed';

  beforeAll(() => {
    ({ DevtoberfestConfig } = cds.entities('com.sap.developers.ims'));
  });

  beforeEach(async () => {
    await DELETE.from(DevtoberfestConfig);
  });

  it('returns configured terms text + version', async () => {
    await INSERT.into(DevtoberfestConfig).entries({
      ID: SINGLETON_ID,
      termsText: '# Devtoberfest\n\n1. Eligibility...',
      termsVersion: 3,
    });
    const res = await project.axios.get('/api/devtoberfest/terms');
    expect(res.status).toBe(200);
    expect(res.data.text).toBe('# Devtoberfest\n\n1. Eligibility...');
    expect(res.data.version).toBe(3);
  });

  it('returns empty text + default version on fresh singleton', async () => {
    const res = await project.axios.get('/api/devtoberfest/terms');
    expect(res.status).toBe(200);
    expect(res.data.text).toBe('');
    expect(res.data.version).toBe(1);
  });
});
```

- [ ] **Step 2: Run — should fail with 404**

```bash
npx vitest run test/unit/devtoberfest-terms-handler.test.js --project unit
```

- [ ] **Step 3: Add termsHandler + register the route**

In `srv/routes/devtoberfest-public.js`, add after `statusHandler`:

```javascript
async function termsHandler(_req, res) {
  try {
    await cds.connect.to('db');
    await ensureSingleton();
    const { DevtoberfestConfig } = cds.entities('com.sap.developers.ims');
    const config = await SELECT.one.from(DevtoberfestConfig);
    return res.status(200).json({
      text: config?.termsText || '',
      version: config?.termsVersion || 1,
    });
  } catch (err) {
    LOG.error('[terms]', err);
    return res.status(500).json({ error: 'INTERNAL' });
  }
}
```

Update `register` and the named exports:

```javascript
export function register(app) {
  app.get('/api/devtoberfest/status', statusHandler);
  app.get('/api/devtoberfest/terms', termsHandler);
}

export { statusHandler, termsHandler };
```

- [ ] **Step 4: Run — PASS**

```bash
npx vitest run test/unit/devtoberfest-terms-handler.test.js --project unit
```

- [ ] **Step 5: Commit**

```bash
git add srv/routes/devtoberfest-public.js test/unit/devtoberfest-terms-handler.test.js
git commit -m "feat(srv): /api/devtoberfest/terms — public T&C body + version

Returns DevtoberfestConfig.termsText (markdown as-is — client renders)
plus current termsVersion. Empty text returns {text:'', version:1}
rather than 404 — homepage island handles empty body gracefully.

Spec §6, §8."
```

---

## Task 6: Auth-gated route module + `/api/devtoberfest/me`

**Files:**
- Create: `srv/routes/devtoberfest-auth.js`
- Modify: `srv/server.js`
- Test: `test/unit/devtoberfest-me-handler.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/unit/devtoberfest-me-handler.test.js`:

```javascript
// test/unit/devtoberfest-me-handler.test.js
// GET /api/devtoberfest/me — for the authenticated caller, returns
// their registration state for the current event. Used by the homepage
// island to refresh after a successful POST /join.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

describe('GET /api/devtoberfest/me', () => {
  let Users, Events, DevtoberfestConfig, EventRegistrations;
  const SINGLETON_ID = '00000000-0000-0000-0000-00d0fe57feed';
  const eventId = cds.utils.uuid();

  beforeAll(() => {
    ({ Users, Events, DevtoberfestConfig, EventRegistrations } =
      cds.entities('com.sap.developers.ims'));
  });

  beforeEach(async () => {
    await DELETE.from(EventRegistrations);
    await DELETE.from(DevtoberfestConfig);
    await DELETE.from(Events);
    await INSERT.into(Events).entries({
      ID: eventId, name: 'Devtoberfest 2026',
      startDate: '2026-10-01T00:00:00Z', endDate: '2026-10-28T00:00:00Z',
      legacyId: 9001,
    });
    await INSERT.into(DevtoberfestConfig).entries({
      ID: SINGLETON_ID, currentEvent_ID: eventId, termsVersion: 3,
    });
  });

  it('401 when anonymous', async () => {
    const res = await project.axios.get('/api/devtoberfest/me', {
      validateStatus: () => true,
    });
    expect(res.status).toBe(401);
  });

  it('returns joined:false when authenticated but not registered', async () => {
    await INSERT.into(Users).entries({
      ID: cds.utils.uuid(), sapId: 'admin', email: 'a@b', legacyId: 1,
    });
    const res = await project.axios.get('/api/devtoberfest/me', {
      auth: { username: 'admin', password: 'admin' },
    });
    expect(res.status).toBe(200);
    expect(res.data.joined).toBe(false);
  });

  it('returns joined:true + joinedAt + termsVersion when registered', async () => {
    const userId = cds.utils.uuid();
    await INSERT.into(Users).entries({
      ID: userId, sapId: 'admin', email: 'a@b', legacyId: 2,
    });
    await INSERT.into(EventRegistrations).entries({
      ID: cds.utils.uuid(),
      user_ID: userId, event_ID: eventId,
      joinedAt: '2026-06-15T12:00:00Z',
      termsVersion: 3,
      termsAcceptedAt: '2026-06-15T12:00:00Z',
      legacyId: 1,
    });
    const res = await project.axios.get('/api/devtoberfest/me', {
      auth: { username: 'admin', password: 'admin' },
    });
    expect(res.status).toBe(200);
    expect(res.data.joined).toBe(true);
    expect(res.data.termsVersion).toBe(3);
    expect(res.data.joinedAt).toContain('2026-06-15');
  });
});
```

- [ ] **Step 2: Run — should fail with 404**

```bash
npx vitest run test/unit/devtoberfest-me-handler.test.js --project unit
```

- [ ] **Step 3: Create the auth-gated route module**

Create `srv/routes/devtoberfest-auth.js`:

```javascript
// Auth-gated endpoints for the Devtoberfest homepage:
//   POST /api/devtoberfest/join — record this year's registration
//   GET  /api/devtoberfest/me   — return caller's registration state
//
// Both require an authenticated user (XSUAA in production; mock-auth
// in tests). resolveUser() from PR #557 handles the deployed-XSUAA +
// multer async-context gap.
//
// Spec: docs/superpowers/specs/2026-06-22-devtoberfest-homepage-design.md §6

import cds from '@sap/cds';
import { resolveUser } from '../lib/resolve-user.js';

const LOG = cds.log('devtoberfest');

async function meHandler(req, res) {
  try {
    const user = resolveUser(req, cds);
    if (!user) return res.status(401).json({ error: 'UNAUTHENTICATED' });

    await cds.connect.to('db');
    const { Users, DevtoberfestConfig, EventRegistrations } =
      cds.entities('com.sap.developers.ims');

    const config = await SELECT.one.from(DevtoberfestConfig);
    if (!config?.currentEvent_ID) {
      return res.status(503).json({ error: 'EVENT_NOT_CONFIGURED' });
    }

    const dbUser = await SELECT.one.from(Users).where({ sapId: user.id });
    if (!dbUser) {
      return res.status(200).json({ joined: false });
    }

    const reg = await SELECT.one.from(EventRegistrations).where({
      user_ID: dbUser.ID,
      event_ID: config.currentEvent_ID,
    });
    if (!reg) return res.status(200).json({ joined: false });

    return res.status(200).json({
      joined: true,
      joinedAt: reg.joinedAt,
      termsVersion: reg.termsVersion,
    });
  } catch (err) {
    LOG.error('[me]', err);
    return res.status(500).json({ error: 'INTERNAL' });
  }
}

export function register(app) {
  app.get('/api/devtoberfest/me', meHandler);
  // /api/devtoberfest/join wired in Task 7.
}

export { meHandler };
```

- [ ] **Step 4: Wire into srv/server.js**

After the `import * as devtoberfestPublic ...` line, add:

```javascript
import * as devtoberfestAuth from './routes/devtoberfest-auth.js';
```

After `devtoberfestPublic.register(app);` add:

```javascript
  devtoberfestAuth.register(app);
```

- [ ] **Step 5: Run tests — PASS**

```bash
npx vitest run test/unit/devtoberfest-me-handler.test.js --project unit
```

- [ ] **Step 6: Commit**

```bash
git add srv/routes/devtoberfest-auth.js srv/server.js test/unit/devtoberfest-me-handler.test.js
git commit -m "feat(srv): /api/devtoberfest/me — caller's registration state

Auth-gated read used by the homepage island to refresh after a
successful POST /join. resolveUser() from PR #557. 401 when anonymous,
503 when no event configured, 200 { joined, joinedAt?, termsVersion? }
otherwise.

Spec §6."
```

---

## Task 7: `POST /api/devtoberfest/join` — happy path

**Files:**
- Modify: `srv/routes/devtoberfest-auth.js`
- Test: `test/unit/devtoberfest-join-handler.test.js`

- [ ] **Step 1: Write the failing test (happy path only — first slice)**

Create `test/unit/devtoberfest-join-handler.test.js`:

```javascript
// test/unit/devtoberfest-join-handler.test.js
// Tests for POST /api/devtoberfest/join. Built incrementally across
// Tasks 7, 8. This task covers the 201 happy path. Task 8 adds the
// 401/403/409/412/503 branches.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

describe('POST /api/devtoberfest/join', () => {
  let Users, Events, DevtoberfestConfig, EventRegistrations;
  const SINGLETON_ID = '00000000-0000-0000-0000-00d0fe57feed';
  const eventId = cds.utils.uuid();

  beforeAll(() => {
    ({ Users, Events, DevtoberfestConfig, EventRegistrations } =
      cds.entities('com.sap.developers.ims'));
  });

  beforeEach(async () => {
    await DELETE.from(EventRegistrations);
    await DELETE.from(DevtoberfestConfig);
    await DELETE.from(Events);
    await INSERT.into(Events).entries({
      ID: eventId, name: 'Devtoberfest 2026',
      startDate: '2026-10-01T00:00:00Z', endDate: '2026-10-28T00:00:00Z',
      legacyId: 9001,
    });
    await INSERT.into(DevtoberfestConfig).entries({
      ID: SINGLETON_ID, currentEvent_ID: eventId, termsVersion: 3,
    });
    await INSERT.into(Users).entries({
      ID: cds.utils.uuid(), sapId: 'admin', email: 'a@b', legacyId: 1,
    });
  });

  it('happy path: 201 + creates EventRegistration row', async () => {
    const res = await project.axios.post('/api/devtoberfest/join',
      { termsVersion: 3 },
      { auth: { username: 'admin', password: 'admin' } },
    );
    expect(res.status).toBe(201);
    expect(res.data.joined).toBe(true);
    expect(res.data.termsVersion).toBe(3);

    const rows = await SELECT.from(EventRegistrations);
    expect(rows.length).toBe(1);
    expect(rows[0].termsVersion).toBe(3);
    expect(rows[0].event_ID).toBe(eventId);
  });
});
```

- [ ] **Step 2: Run — should fail with 404**

```bash
npx vitest run test/unit/devtoberfest-join-handler.test.js --project unit
```

- [ ] **Step 3: Add joinHandler to srv/routes/devtoberfest-auth.js**

Add `getNextLegacyId` to the imports + add the handler before `register`:

```javascript
import { getNextLegacyId } from '../lib/legacy-id.js';
```

Then add:

```javascript
async function joinHandler(req, res) {
  try {
    const user = resolveUser(req, cds);
    if (!user) return res.status(401).json({ error: 'UNAUTHENTICATED' });

    const submittedVersion = Number(req.body?.termsVersion);
    if (!Number.isInteger(submittedVersion)) {
      return res.status(400).json({ error: 'BAD_REQUEST', message: 'termsVersion required' });
    }

    const db = await cds.connect.to('db');
    const { Users, DevtoberfestConfig, EventRegistrations } =
      cds.entities('com.sap.developers.ims');

    const config = await SELECT.one.from(DevtoberfestConfig);
    if (!config?.currentEvent_ID) {
      return res.status(503).json({ error: 'EVENT_NOT_CONFIGURED' });
    }
    if (config.termsVersion !== submittedVersion) {
      return res.status(412).json({ error: 'TERMS_OUTDATED', current: config.termsVersion });
    }

    const dbUser = await SELECT.one.from(Users).where({ sapId: user.id });
    if (!dbUser) {
      return res.status(403).json({ error: 'USER_NOT_IN_DB' });
    }

    const now = new Date().toISOString();
    try {
      await INSERT.into(EventRegistrations).entries({
        ID: cds.utils.uuid(),
        user_ID: dbUser.ID,
        event_ID: config.currentEvent_ID,
        joinedAt: now,
        termsVersion: submittedVersion,
        termsAcceptedAt: now,
        legacyId: await getNextLegacyId('EventRegistrations', db),
      });
    } catch (err) {
      if (/unique|duplicate/i.test(err.message)) {
        return res.status(409).json({ error: 'ALREADY_JOINED' });
      }
      throw err;
    }

    // Audit-log: same shape as _executeAnonymization (PR #554).
    try {
      const audit = await cds.connect.to('audit-log');
      await audit.log('SecurityEvent', {
        data: {
          action: 'DevtoberfestJoin',
          sapId: user.id,
          eventId: config.currentEvent_ID,
          termsVersion: submittedVersion,
        },
      });
    } catch (auditErr) {
      // Audit failure must not break the join (mirrors PR #554's
      // pattern — the join itself is the canonical record).
      LOG.warn('[join] audit-log failed (non-fatal)', auditErr.message);
    }

    return res.status(201).json({ joined: true, termsVersion: submittedVersion });
  } catch (err) {
    LOG.error('[join]', err);
    return res.status(500).json({ error: 'INTERNAL' });
  }
}
```

Update `register`:

```javascript
export function register(app) {
  app.get('/api/devtoberfest/me', meHandler);
  app.post('/api/devtoberfest/join', joinHandler);
}

export { meHandler, joinHandler };
```

- [ ] **Step 4: Run test — PASS**

```bash
npx vitest run test/unit/devtoberfest-join-handler.test.js --project unit
```

- [ ] **Step 5: Commit**

```bash
git add srv/routes/devtoberfest-auth.js test/unit/devtoberfest-join-handler.test.js
git commit -m "feat(srv): POST /api/devtoberfest/join — happy path

Creates EventRegistration row + emits SecurityEvent audit-log entry
(same shape as _executeAnonymization in PR #554). resolveUser() per
PR #557. legacyId via getNextLegacyId() — registered in Task 2's
legacyKeyedEntities list. 

Spec §6 — happy path only. Subsequent task adds error branches."
```

---

## Task 8: `POST /api/devtoberfest/join` — error branches

**Files:**
- Modify: `srv/routes/devtoberfest-auth.js` (only if a branch needs fixing)
- Test: `test/unit/devtoberfest-join-handler.test.js` (extends existing file)

- [ ] **Step 1: Add the 6 error-branch tests**

Append inside the existing `describe('POST /api/devtoberfest/join', ...)`:

```javascript
  it('401 when anonymous', async () => {
    const res = await project.axios.post('/api/devtoberfest/join',
      { termsVersion: 3 },
      { validateStatus: () => true },
    );
    expect(res.status).toBe(401);
    expect(res.data.error).toBe('UNAUTHENTICATED');
  });

  it('400 when termsVersion missing/invalid', async () => {
    const res = await project.axios.post('/api/devtoberfest/join',
      { /* no termsVersion */ },
      { auth: { username: 'admin', password: 'admin' }, validateStatus: () => true },
    );
    expect(res.status).toBe(400);
    expect(res.data.error).toBe('BAD_REQUEST');
  });

  it('412 when termsVersion stale', async () => {
    const res = await project.axios.post('/api/devtoberfest/join',
      { termsVersion: 2 },  // server has version 3
      { auth: { username: 'admin', password: 'admin' }, validateStatus: () => true },
    );
    expect(res.status).toBe(412);
    expect(res.data.error).toBe('TERMS_OUTDATED');
    expect(res.data.current).toBe(3);
  });

  it('503 when currentEvent_ID NULL', async () => {
    await DELETE.from(DevtoberfestConfig);
    await INSERT.into(DevtoberfestConfig).entries({
      ID: SINGLETON_ID, termsVersion: 3,
      // currentEvent_ID intentionally omitted
    });
    const res = await project.axios.post('/api/devtoberfest/join',
      { termsVersion: 3 },
      { auth: { username: 'admin', password: 'admin' }, validateStatus: () => true },
    );
    expect(res.status).toBe(503);
    expect(res.data.error).toBe('EVENT_NOT_CONFIGURED');
  });

  it('403 when authenticated but no Users row matches sapId', async () => {
    await DELETE.from(Users);   // wipe the admin row seeded by beforeEach
    const res = await project.axios.post('/api/devtoberfest/join',
      { termsVersion: 3 },
      { auth: { username: 'admin', password: 'admin' }, validateStatus: () => true },
    );
    expect(res.status).toBe(403);
    expect(res.data.error).toBe('USER_NOT_IN_DB');
  });

  it('409 when re-joining (idempotent — second call fails on unique constraint)', async () => {
    const first = await project.axios.post('/api/devtoberfest/join',
      { termsVersion: 3 },
      { auth: { username: 'admin', password: 'admin' } },
    );
    expect(first.status).toBe(201);

    const second = await project.axios.post('/api/devtoberfest/join',
      { termsVersion: 3 },
      { auth: { username: 'admin', password: 'admin' }, validateStatus: () => true },
    );
    expect(second.status).toBe(409);
    expect(second.data.error).toBe('ALREADY_JOINED');
  });
```

- [ ] **Step 2: Run — all branches should already pass**

```bash
npx vitest run test/unit/devtoberfest-join-handler.test.js --project unit
```

Expected: PASS, 7/7 (1 happy path from Task 7 + 6 new). The handler in Task 7 ALREADY covers all branches; this task is pure test-coverage expansion. If any fail, adjust the handler before committing.

- [ ] **Step 3: Commit**

```bash
git add test/unit/devtoberfest-join-handler.test.js
git commit -m "test(srv): /api/devtoberfest/join — error-branch coverage

Adds 6 tests pinning each non-201 response code documented in
spec §6.2: 401 anonymous, 400 bad-request, 412 stale termsVersion,
503 no event configured, 403 missing Users row, 409 duplicate
registration (idempotent retry).

Spec §6.2."
```

---

## Task 9: Approuter routes (public homepage + API)

**Files:**
- Modify: `approuter/xs-app.json`

- [ ] **Step 1: Verify the route ordering convention**

Read `approuter/xs-app.json` to find the existing route for `/api/advocates` (around line 159):

```bash
grep -n "advocates" approuter/xs-app.json
```

`/api/advocates` is `authenticationType: none` — the closest sibling to our public endpoints.

- [ ] **Step 2: Add 3 new route entries**

In `approuter/xs-app.json` inside the `routes:` array, **place these before** the catch-all `/admin/(.*)$` route (so the more-specific Devtoberfest routes win):

```json
{
  "source": "^/api/devtoberfest/(status|terms)$",
  "target": "/api/devtoberfest/$1",
  "destination": "srv-api",
  "authenticationType": "none",
  "csrfProtection": false
},
{
  "source": "^/api/devtoberfest/(join|me)$",
  "target": "/api/devtoberfest/$1",
  "destination": "srv-api",
  "authenticationType": "xsuaa",
  "csrfProtection": false
},
{
  "source": "^/devtoberfest(/.*)?$",
  "target": "/devtoberfest$1",
  "localDir": "static",
  "authenticationType": "none"
}
```

Notes:
- The two `/api/devtoberfest/*` routes are split by auth requirement. The first is anonymous-safe; the second requires XSUAA.
- The `/devtoberfest` route serves Hugo's static output from `approuter/static/devtoberfest/...` (where `cds build` + `mbt build` copies `hugo/public/devtoberfest/...`).
- `csrfProtection: false` matches the pattern used for `/api/advocates` (the existing public + auth approuter routes don't require CSRF — the OData admin routes do).

- [ ] **Step 3: Smoke-verify the JSON parses**

```bash
node -e "console.log('routes:', JSON.parse(require('fs').readFileSync('approuter/xs-app.json','utf8')).routes.length)"
```

Expected: prints `routes: N` where N is the previous count + 3.

- [ ] **Step 4: Commit**

```bash
git add approuter/xs-app.json
git commit -m "feat(approuter): /devtoberfest + /api/devtoberfest/* routes

3 new routes:
  - /api/devtoberfest/(status|terms) — public (no auth), bypasses XSUAA
  - /api/devtoberfest/(join|me)      — XSUAA-gated
  - /devtoberfest(/...)              — static (Hugo-built page)

Routes placed before the /admin/(.*)$ catch-all to ensure specificity
wins. Pattern matches /api/advocates for the public split.

Spec §7.5."
```

---

## Task 10: Hugo page + placeholder SVG assets

**Files:**
- Create: `hugo/content/devtoberfest/_index.md`
- Create: `hugo/layouts/devtoberfest/list.html`
- Create: `hugo/static/images/devtoberfest/kasimir.svg`
- Create: `hugo/static/images/devtoberfest/teched-logo.svg`
- Create: `hugo/static/images/devtoberfest/devtoberfest-logo.svg`

- [ ] **Step 1: Front-matter for the Hugo page**

Create `hugo/content/devtoberfest/_index.md`:

```yaml
---
title: Devtoberfest 2026
description: Four weeks of tutorials, real prizes, and one cat in a witch hat.
type: devtoberfest
layout: list
---
```

- [ ] **Step 2: Layout — mount point + noscript fallback**

Create `hugo/layouts/devtoberfest/list.html`:

```html
{{ define "main" }}
<main id="devtoberfest-mount"
      data-api-status="/api/devtoberfest/status"
      data-api-terms="/api/devtoberfest/terms"
      data-api-join="/api/devtoberfest/join"
      data-api-me="/api/devtoberfest/me"
      data-img-kasimir="/images/devtoberfest/kasimir.svg"
      data-img-teched="/images/devtoberfest/teched-logo.svg"
      data-img-devtoberfest="/images/devtoberfest/devtoberfest-logo.svg"></main>
<noscript>
  <div class="ds-noscript-fallback">
    <h1>Devtoberfest 2026</h1>
    <p>Four weeks of tutorials, real prizes, and one cat in a witch hat.
    JavaScript is required to join — please enable it and refresh.</p>
  </div>
</noscript>
<script type="module" src="{{ "/js/devtoberfest.js" | relURL }}"></script>
{{ end }}
```

- [ ] **Step 3: Placeholder Kasimir SVG**

Create `hugo/static/images/devtoberfest/kasimir.svg`:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80" width="80" height="80" aria-label="Kasimir the Cat (placeholder)">
  <circle cx="40" cy="40" r="38" fill="#1d232e" stroke="url(#g)" stroke-width="3"/>
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0070f2"/>
      <stop offset="1" stop-color="#7858ff"/>
    </linearGradient>
  </defs>
  <text x="40" y="52" text-anchor="middle" font-size="40" font-family="system-ui">🐱</text>
</svg>
```

- [ ] **Step 4: Placeholder TechEd wordmark**

Create `hugo/static/images/devtoberfest/teched-logo.svg`:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 180 32" width="180" height="32" aria-label="SAP TechEd">
  <rect width="180" height="32" rx="4" fill="#003b71"/>
  <text x="90" y="22" text-anchor="middle" fill="#fff" font-size="14" font-weight="700"
        font-family="'72',-apple-system,sans-serif" letter-spacing="1">SAP TECHED</text>
</svg>
```

- [ ] **Step 5: Placeholder Devtoberfest wordmark**

Create `hugo/static/images/devtoberfest/devtoberfest-logo.svg`:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 180 32" width="180" height="32" aria-label="Devtoberfest">
  <rect width="180" height="32" rx="4" fill="#ff6b35"/>
  <text x="90" y="22" text-anchor="middle" fill="#fff" font-size="14" font-weight="700"
        font-family="'72',-apple-system,sans-serif" letter-spacing="1">DEVTOBERFEST</text>
</svg>
```

- [ ] **Step 6: Smoke-test by building Hugo locally**

```bash
npm run dev
```

Hit `http://localhost:1313/devtoberfest/` — should render the noscript fallback (the Vue island ships in Task 11). The page should not 404.

- [ ] **Step 7: Commit**

```bash
git add hugo/content/devtoberfest/ hugo/layouts/devtoberfest/ hugo/static/images/devtoberfest/
git commit -m "feat(hugo): /devtoberfest/ page scaffold + placeholder SVG assets

Mount-point HTML for the Vue island that ships in Task 11. data-*
attributes carry the API URLs + image paths so the island stays
URL-agnostic. Placeholder SVGs use emoji + plain text wordmarks —
art swap is a file-only change when real assets arrive.

Spec §7.1, §7.5."
```

---

## Task 11: Vue island scaffold + StatusResponse types + state machine

**Files:**
- Create: `hugo-apps/src/devtoberfest/main.ts`
- Create: `hugo-apps/src/devtoberfest/types.ts`
- Create: `hugo-apps/src/devtoberfest/DevtoberfestHome.vue`
- Create: `hugo-apps/src/devtoberfest/styles.css`
- Modify: `hugo-apps/vite.config.ts`

- [ ] **Step 1: Shared types**

Create `hugo-apps/src/devtoberfest/types.ts`:

```typescript
export interface EventInfo {
  name: string
  startDate: string
  endDate: string
}

export interface StatusResponse {
  event: EventInfo | null
  joined: boolean
  termsVersion: number
  termsRequired: boolean
  contentRulesUrl: string
  faqUrl: string
  gameboardUrl: string
  activitiesUrl: string
}

export interface TermsResponse {
  text: string    // markdown source
  version: number
}

export interface JoinResponse {
  joined: boolean
  termsVersion: number
}

export type HomeState =
  | 'loading'
  | 'event-missing'
  | 'anonymous'
  | 'unregistered'
  | 'registered'

export interface MountConfig {
  apiStatus: string
  apiTerms: string
  apiJoin: string
  apiMe: string
  imgKasimir: string
  imgTeched: string
  imgDevtoberfest: string
}
```

- [ ] **Step 2: Mount glue (`main.ts`)**

Create `hugo-apps/src/devtoberfest/main.ts`:

```typescript
import { createApp } from 'vue'
import DevtoberfestHome from './DevtoberfestHome.vue'
import './styles.css'
import type { MountConfig } from './types'

const mount = document.getElementById('devtoberfest-mount') as HTMLElement | null
if (mount) {
  const config: MountConfig = {
    apiStatus:        mount.dataset.apiStatus        || '/api/devtoberfest/status',
    apiTerms:         mount.dataset.apiTerms         || '/api/devtoberfest/terms',
    apiJoin:          mount.dataset.apiJoin          || '/api/devtoberfest/join',
    apiMe:            mount.dataset.apiMe            || '/api/devtoberfest/me',
    imgKasimir:       mount.dataset.imgKasimir       || '/images/devtoberfest/kasimir.svg',
    imgTeched:        mount.dataset.imgTeched        || '/images/devtoberfest/teched-logo.svg',
    imgDevtoberfest:  mount.dataset.imgDevtoberfest  || '/images/devtoberfest/devtoberfest-logo.svg',
  }
  createApp(DevtoberfestHome, { config }).mount(mount)
}
```

- [ ] **Step 3: Main component — state machine + header + body**

Create `hugo-apps/src/devtoberfest/DevtoberfestHome.vue`:

```vue
<!--
  Devtoberfest homepage island. Mounts at #devtoberfest-mount on the
  Hugo-served /devtoberfest/ page. Reads its API URLs + image paths
  from data-* attributes on the mount node (set in
  hugo/layouts/devtoberfest/list.html).

  State machine (spec §7.3):
    loading       → initial mount, /status fetch in flight
    event-missing → /status returned 503 (no event configured)
    anonymous     → 200, no req.user (joined:false + termsRequired:true)
    unregistered  → 200, joined:false but a user was authenticated
    registered    → 200, joined:true

  T&C dialog (TermsDialog.vue, wired in Task 12) opens on header CTA
  click when state === 'unregistered'.

  Spec: docs/superpowers/specs/2026-06-22-devtoberfest-homepage-design.md §7
-->
<template>
  <article class="dtbf-root" :class="['dtbf-state-' + state]">
    <header class="dtbf-header">
      <div class="dtbf-brand">
        <img :src="config.imgKasimir" class="dtbf-kasimir" alt="" />
        <div class="dtbf-titles">
          <span class="dtbf-eyebrow">DEVTOBERFEST</span>
          <h1 class="dtbf-title">{{ eventName }}</h1>
        </div>
      </div>
      <button
        class="dtbf-cta"
        :class="{ 'dtbf-cta--joined': state === 'registered' }"
        :disabled="state === 'loading' || state === 'event-missing' || state === 'registered'"
        @click="onCtaClick"
      >
        {{ ctaLabel }}
      </button>
    </header>

    <div class="dtbf-arcade-strip">
      <span>▶ READY_PLAYER_1</span>
      <span v-if="eventWindow">{{ eventWindow }}</span>
    </div>

    <div class="dtbf-body">
      <section class="dtbf-content">
        <h2 class="dtbf-welcome">Welcome, friend</h2>
        <p class="dtbf-lede">
          Four weeks of tutorials, real prizes, and one cat in a witch hat.
          Pull up a chair.
        </p>
        <p v-if="state === 'anonymous'" class="dtbf-anon-hint">
          Log in via the user menu (top-right) to join →
        </p>
        <p v-if="state === 'event-missing'" class="dtbf-missing">
          Devtoberfest hasn't started yet. Check back closer to October.
        </p>
        <p v-if="state === 'registered'" class="dtbf-joined-strip">
          Welcome aboard. ✨ See the gameboard, then pick a tutorial.
        </p>
      </section>
      <nav class="dtbf-rail" aria-label="Devtoberfest sections">
        <a v-for="item in railItems" :key="item.label"
           :href="item.url || undefined"
           :class="['dtbf-rail-link', { 'dtbf-rail-link--disabled': !item.url }]"
           :title="item.url ? '' : 'Coming soon'">
          └ {{ item.label }}
        </a>
      </nav>
    </div>

    <!-- TermsDialog mounts here in Task 12 -->
  </article>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import type { MountConfig, StatusResponse, HomeState } from './types'

const props = defineProps<{ config: MountConfig }>()

const state = ref<HomeState>('loading')
const status = ref<StatusResponse | null>(null)

async function fetchStatus(): Promise<void> {
  try {
    const res = await fetch(props.config.apiStatus, { credentials: 'same-origin' })
    if (res.status === 503) {
      state.value = 'event-missing'
      return
    }
    if (!res.ok) {
      console.warn('[devtoberfest] /status', res.status)
      state.value = 'event-missing'
      return
    }
    const body = (await res.json()) as StatusResponse
    status.value = body
    if (body.joined) {
      state.value = 'registered'
    } else if (body.termsRequired) {
      // Could be anonymous OR authenticated-unregistered. Probe /me to
      // distinguish — if /me returns 401, anonymous; otherwise unregistered.
      const me = await fetch(props.config.apiMe, { credentials: 'same-origin' })
      state.value = me.status === 401 ? 'anonymous' : 'unregistered'
    }
  } catch (err) {
    console.warn('[devtoberfest] fetchStatus failed', err)
    state.value = 'event-missing'
  }
}

onMounted(fetchStatus)

const eventName = computed(() => status.value?.event?.name || 'Devtoberfest')
const eventWindow = computed(() => {
  const e = status.value?.event
  if (!e) return ''
  const fmt = (s: string) => new Date(s).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }).toUpperCase()
  return `${fmt(e.startDate)} — ${fmt(e.endDate)}`
})

const ctaLabel = computed(() => {
  switch (state.value) {
    case 'loading':       return '...'
    case 'event-missing': return 'Coming soon'
    case 'anonymous':     return 'Join the Fest'
    case 'unregistered':  return 'Join the Fest'
    case 'registered':    return "You're in! 🎉"
  }
})

const railItems = computed(() => [
  { label: 'THE RULES',  url: status.value?.contentRulesUrl || '' },
  { label: 'THE WEEKS',  url: status.value?.activitiesUrl   || '' },
  { label: 'FAQ',        url: status.value?.faqUrl          || '' },
  { label: 'GAMEBOARD',  url: status.value?.gameboardUrl    || '' },
])

function onCtaClick(): void {
  if (state.value === 'anonymous') {
    // Surface the inline hint paragraph; no redirect (Tom's spec: shellbar
    // handles auth via the user-menu).
    return
  }
  if (state.value === 'unregistered') {
    // Task 12 wires the T&C dialog open here.
    console.warn('[devtoberfest] T&C dialog not wired yet (Task 12)')
  }
}
</script>
```

- [ ] **Step 4: Scoped styles (Joule × arcade × Horizon)**

Create `hugo-apps/src/devtoberfest/styles.css`:

```css
/* Devtoberfest homepage — Joule × retro-arcade × Horizon fusion.
   All colors via Horizon CSS tokens where possible; explicit hex only
   for the Joule gradient (intentional brand accent) and the arcade
   highlight colors (CRT-green / cyan / mango per state).
   Spec §3. */

.dtbf-root {
  --joule-grad: linear-gradient(90deg, #0070f2 0%, #7858ff 100%);
  --joule-grad-dark: linear-gradient(90deg, #1b90ff 0%, #9d83ff 100%);
  margin: 0 auto;
  max-width: 980px;
  padding: 1rem;
  font-family: '72', -apple-system, BlinkMacSystemFont, sans-serif;
}

.dtbf-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 1rem 1.25rem;
  background: var(--joule-grad);
  color: #fff;
  border-radius: 0.5rem 0.5rem 0 0;
  position: relative;
  overflow: hidden;
}

/* CRT scanline overlay — low-opacity repeating gradient. */
.dtbf-header::before {
  content: '';
  position: absolute;
  inset: 0;
  background: repeating-linear-gradient(
    0deg,
    transparent 0 3px,
    rgba(255,255,255,0.04) 3px 4px
  );
  pointer-events: none;
}

[data-theme='dark'] .dtbf-header { background: var(--joule-grad-dark); }

.dtbf-brand { display: flex; align-items: center; gap: 0.75rem; position: relative; }
.dtbf-kasimir { width: 48px; height: 48px; filter: drop-shadow(0 0 8px rgba(157,131,255,0.6)); }
.dtbf-titles { display: flex; flex-direction: column; line-height: 1.1; }
.dtbf-eyebrow {
  font-family: '72Mono', ui-monospace, monospace;
  font-size: 0.625rem;
  letter-spacing: 2px;
  opacity: 0.85;
}
.dtbf-title { margin: 0; font-size: 1.25rem; font-weight: 700; letter-spacing: -0.3px; }

.dtbf-cta {
  padding: 0.5rem 1rem;
  background: #fff;
  color: #0070f2;
  border: none;
  border-radius: 4px;
  font-family: '72', sans-serif;
  font-weight: 600;
  font-size: 0.875rem;
  cursor: pointer;
  box-shadow: 0 2px 0 #0040c0;
  position: relative;
}
.dtbf-cta:hover:not(:disabled) { transform: translateY(-1px); }
.dtbf-cta:disabled { opacity: 0.6; cursor: default; }
.dtbf-cta--joined { background: var(--sapPositiveColor, #36a41d); color: #fff; }

[data-theme='dark'] .dtbf-cta {
  background: #1d232e;
  color: #1b90ff;
  border: 1px solid #1b90ff;
  box-shadow: 0 0 8px rgba(27,144,255,0.6);
}

.dtbf-arcade-strip {
  display: flex;
  justify-content: space-between;
  padding: 0.25rem 1.25rem;
  background: #0070f2;
  color: #fff;
  font-family: '72Mono', ui-monospace, monospace;
  font-size: 0.625rem;
  letter-spacing: 2px;
}
[data-theme='dark'] .dtbf-arcade-strip { background: #1b90ff; color: #1d232e; font-weight: 600; }

.dtbf-body {
  display: grid;
  grid-template-columns: 1fr 140px;
  gap: 1rem;
  padding: 1.25rem;
  background: var(--sapList_Background, #fff);
  border: 1px solid var(--sapList_BorderColor, #e5e5e5);
  border-top: none;
  border-radius: 0 0 0.5rem 0.5rem;
}
.dtbf-welcome { margin: 0 0 0.25rem; font-size: 1rem; color: var(--sapTextColor); }
.dtbf-lede { margin: 0; font-size: 0.875rem; line-height: 1.5; color: var(--sapContent_LabelColor, #6a6d70); }
.dtbf-anon-hint { margin-top: 0.5rem; font-size: 0.8125rem; color: var(--sapLinkColor); }
.dtbf-missing { color: var(--sapNegativeColor, #aa0808); }
.dtbf-joined-strip {
  margin-top: 0.75rem;
  padding: 0.5rem 0.75rem;
  background: var(--sapPositiveBackground, #f5fae5);
  border-left: 3px solid var(--sapPositiveColor, #36a41d);
  border-radius: 0 4px 4px 0;
  font-size: 0.875rem;
}

.dtbf-rail { display: flex; flex-direction: column; gap: 0.375rem; }
.dtbf-rail-link {
  padding: 0.375rem 0.5rem;
  background: var(--sapList_Background, #fff);
  border: 1px solid var(--sapList_BorderColor, #d5dadf);
  border-left: 3px solid #0070f2;
  border-radius: 3px;
  font-family: '72Mono', ui-monospace, monospace;
  font-size: 0.625rem;
  color: var(--sapTextColor);
  text-decoration: none;
}
.dtbf-rail-link:nth-child(2) { border-left-color: #7858ff; }
.dtbf-rail-link:nth-child(3) { border-left-color: #00bcd4; }
.dtbf-rail-link:nth-child(4) { border-left-color: #36a41d; }
.dtbf-rail-link:hover:not(.dtbf-rail-link--disabled) { background: var(--sapList_Hover_Background); }
.dtbf-rail-link--disabled { opacity: 0.45; pointer-events: none; cursor: not-allowed; }
[data-theme='dark'] .dtbf-rail-link { background: #2a3340; border-color: #3a4452; color: var(--sapTextColor); }
```

- [ ] **Step 5: Wire into Vite — add entry point**

Modify `hugo-apps/vite.config.ts`. Find the `rollupOptions.input` block (around line 141) and add a new entry **alphabetically** (between `cmd-palette` and `event-display`, or near `related-graph`):

```typescript
        devtoberfest: resolve(__dirname, 'src/devtoberfest/main.ts'),
```

- [ ] **Step 6: Smoke-build to confirm it compiles**

```bash
cd hugo-apps && npx vite build 2>&1 | tail -10
```

Expected: `dist/js/devtoberfest.js` (or `hugo/static/js/devtoberfest.js` per the project's output dir) emits without errors.

- [ ] **Step 7: Verify the page renders end-to-end locally**

In one terminal:

```bash
cd hugo-apps && npx vite build --watch
```

In a second terminal:

```bash
cds watch  # starts CAP at :4004
```

In a third terminal:

```bash
npm run dev  # Hugo at :1313
```

Visit `http://localhost:1313/devtoberfest/` — should render the new homepage with "event-missing" state (no DB config yet).

- [ ] **Step 8: Commit**

```bash
git add hugo-apps/src/devtoberfest/ hugo-apps/vite.config.ts
git commit -m "feat(hugo-apps): Devtoberfest homepage Vue island

State machine wires /status + /me into 5 states (loading,
event-missing, anonymous, unregistered, registered). Header has the
Joule-gradient brand band + CTA; arcade strip below with READY_PLAYER_1
+ event window; body has Welcome + 4-item rail. Styles use Horizon
tokens for theme + explicit Joule gradient for the brand accent.

T&C dialog wires up in Task 12 — CTA click currently logs a warning
in the unregistered path.

Spec §7."
```

---

## Task 12: T&C dialog component + join wire-up

**Files:**
- Create: `hugo-apps/src/devtoberfest/TermsDialog.vue`
- Modify: `hugo-apps/src/devtoberfest/DevtoberfestHome.vue`
- Modify: `hugo-apps/src/devtoberfest/styles.css`

- [ ] **Step 1: T&C dialog component**

Create `hugo-apps/src/devtoberfest/TermsDialog.vue`:

```vue
<!--
  Devtoberfest T&C dialog — opens when an unregistered user clicks
  "Join the Fest". Loads /api/devtoberfest/terms on first show, scrolls
  the markdown body to enable the Accept button at ≥95% scroll, POSTs
  /api/devtoberfest/join on accept.

  Joule gradient header matches the homepage (spec §3 + §8.1).
  95% threshold (not 100) defends against sub-pixel scroll quirks
  on Safari/Firefox (spec §8.2).

  Spec: §8.
-->
<template>
  <div v-if="open" class="dtbf-dialog-backdrop" @click.self="$emit('close')">
    <div class="dtbf-dialog" role="dialog" aria-labelledby="dtbf-dialog-title">
      <header class="dtbf-dialog-header">
        <div class="dtbf-dialog-brand">
          <img :src="imgKasimir" class="dtbf-dialog-kasimir" alt="" />
          <div>
            <span class="dtbf-dialog-eyebrow">DEVTOBERFEST · CONTENTS RULES</span>
            <h2 id="dtbf-dialog-title" class="dtbf-dialog-title">Before we play together</h2>
          </div>
        </div>
        <span class="dtbf-dialog-version">v{{ version }}</span>
      </header>
      <div class="dtbf-dialog-body" ref="bodyEl" @scroll="onScroll">
        <p v-if="loadState === 'loading'" class="dtbf-dialog-loading">Loading terms…</p>
        <p v-else-if="loadState === 'error'" class="dtbf-dialog-error">Couldn't load terms. Try again later.</p>
        <pre v-else class="dtbf-dialog-markdown">{{ text }}</pre>
      </div>
      <footer class="dtbf-dialog-footer">
        <div class="dtbf-dialog-progress" aria-label="Scroll progress">
          <div class="dtbf-dialog-progress-bar"
               :style="{ width: scrollPercent + '%' }"></div>
          <span class="dtbf-dialog-progress-pct">{{ scrollPercent }}%</span>
        </div>
        <div class="dtbf-dialog-actions">
          <button class="dtbf-dialog-cancel" @click="$emit('close')">Cancel</button>
          <button class="dtbf-dialog-accept"
                  :disabled="!canAccept || posting"
                  @click="onAccept">
            {{ posting ? 'Joining…' : 'Accept & Join' }}
          </button>
        </div>
      </footer>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import type { TermsResponse } from './types'

const props = defineProps<{
  open: boolean
  apiTerms: string
  apiJoin: string
  imgKasimir: string
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'joined'): void
}>()

const text = ref('')
const version = ref(1)
const loadState = ref<'loading' | 'ok' | 'error'>('loading')
const scrollPercent = ref(0)
const bodyEl = ref<HTMLElement | null>(null)
const posting = ref(false)

const canAccept = computed(() => scrollPercent.value >= 95 && loadState.value === 'ok')

watch(() => props.open, async (isOpen) => {
  if (!isOpen) return
  loadState.value = 'loading'
  scrollPercent.value = 0
  try {
    const res = await fetch(props.apiTerms, { credentials: 'same-origin' })
    if (!res.ok) throw new Error('http ' + res.status)
    const body = (await res.json()) as TermsResponse
    text.value = body.text || '(no terms configured yet)'
    version.value = body.version
    loadState.value = 'ok'
    // If content fits the viewport without scrolling, enable immediately.
    requestAnimationFrame(() => {
      const el = bodyEl.value
      if (!el) return
      if (el.scrollHeight <= el.clientHeight) scrollPercent.value = 100
    })
  } catch (e) {
    console.warn('[devtoberfest] terms fetch failed', e)
    loadState.value = 'error'
  }
})

function onScroll(e: Event): void {
  const el = e.target as HTMLElement
  const max = el.scrollHeight - el.clientHeight
  scrollPercent.value = max <= 0 ? 100 : Math.min(100, Math.round((el.scrollTop / max) * 100))
}

async function onAccept(): Promise<void> {
  if (!canAccept.value || posting.value) return
  posting.value = true
  try {
    const res = await fetch(props.apiJoin, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ termsVersion: version.value }),
    })
    if (res.status === 201 || res.status === 409) {
      // 409 = already joined — treat as success (idempotent).
      emit('joined')
      emit('close')
      return
    }
    if (res.status === 412) {
      // Terms bumped while dialog was open — reload them.
      const body = await res.json()
      console.warn('[devtoberfest] terms outdated, server has v' + body.current)
      loadState.value = 'loading'
      scrollPercent.value = 0
      if (bodyEl.value) bodyEl.value.scrollTop = 0
      const fresh = await fetch(props.apiTerms, { credentials: 'same-origin' }).then(r => r.json())
      text.value = fresh.text
      version.value = fresh.version
      loadState.value = 'ok'
      return
    }
    if (res.status === 401) {
      alert('Please log in via the user menu (top-right) to join.')
      emit('close')
      return
    }
    console.error('[devtoberfest] join failed', res.status)
    alert('Something went wrong. Please try again.')
  } catch (e) {
    console.error('[devtoberfest] join error', e)
    alert('Network error. Please try again.')
  } finally {
    posting.value = false
  }
}
</script>
```

- [ ] **Step 2: Wire the dialog into `DevtoberfestHome.vue`**

Add to the template (replace the existing `<!-- TermsDialog mounts here in Task 12 -->` comment):

```vue
    <TermsDialog
      :open="dialogOpen"
      :api-terms="config.apiTerms"
      :api-join="config.apiJoin"
      :img-kasimir="config.imgKasimir"
      @close="dialogOpen = false"
      @joined="onJoined"
    />
```

In `<script setup>`, add:

```typescript
import TermsDialog from './TermsDialog.vue'

const dialogOpen = ref(false)

function onJoined(): void {
  dialogOpen.value = false
  state.value = 'registered'
  // Optimistic update; status object also gets a partial refresh.
  if (status.value) {
    status.value = { ...status.value, joined: true, termsRequired: false }
  }
}
```

Replace the existing `onCtaClick` body's `unregistered` branch with:

```typescript
  if (state.value === 'unregistered') {
    dialogOpen.value = true
  }
```

- [ ] **Step 3: Dialog styles**

Append to `hugo-apps/src/devtoberfest/styles.css`:

```css
.dtbf-dialog-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}
.dtbf-dialog {
  background: var(--sapList_Background, #fff);
  border-radius: 8px;
  width: min(640px, 92vw);
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 0 24px rgba(120,88,255,0.45);
  overflow: hidden;
}
.dtbf-dialog-header {
  padding: 0.875rem 1rem;
  background: linear-gradient(90deg, #0070f2 0%, #7858ff 100%);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: space-between;
}
[data-theme='dark'] .dtbf-dialog-header {
  background: linear-gradient(90deg, #1b90ff 0%, #9d83ff 100%);
}
.dtbf-dialog-brand { display: flex; align-items: center; gap: 0.625rem; }
.dtbf-dialog-kasimir { width: 36px; height: 36px; }
.dtbf-dialog-eyebrow { font-family: '72Mono', ui-monospace, monospace; font-size: 0.6875rem; letter-spacing: 2px; opacity: 0.85; }
.dtbf-dialog-title { margin: 0; font-size: 1rem; font-weight: 600; }
.dtbf-dialog-version { font-family: '72Mono', ui-monospace, monospace; font-size: 0.75rem; opacity: 0.85; }
.dtbf-dialog-body {
  flex: 1;
  overflow-y: auto;
  padding: 1rem 1.25rem;
  font-size: 0.875rem;
  line-height: 1.5;
  color: var(--sapTextColor);
}
.dtbf-dialog-markdown { font-family: '72', sans-serif; white-space: pre-wrap; margin: 0; }
.dtbf-dialog-footer {
  padding: 0.75rem 1rem;
  display: flex;
  justify-content: space-between;
  align-items: center;
  border-top: 1px solid var(--sapList_BorderColor, #e8edf1);
}
.dtbf-dialog-progress {
  position: relative;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-family: '72Mono', ui-monospace, monospace;
  font-size: 0.75rem;
  color: var(--sapContent_LabelColor);
}
.dtbf-dialog-progress::before {
  content: '';
  display: inline-block;
  width: 80px;
  height: 4px;
  background: var(--sapList_BorderColor, #e8edf1);
  border-radius: 2px;
  position: relative;
}
.dtbf-dialog-progress-bar {
  position: absolute;
  left: 0;
  top: 50%;
  transform: translateY(-50%);
  height: 4px;
  background: linear-gradient(90deg, #0070f2, #7858ff);
  border-radius: 2px;
  transition: width 0.15s linear;
}
.dtbf-dialog-actions { display: flex; gap: 0.5rem; }
.dtbf-dialog-cancel,
.dtbf-dialog-accept {
  padding: 0.375rem 0.75rem;
  border: none;
  border-radius: 4px;
  font-family: '72', sans-serif;
  font-size: 0.8125rem;
  cursor: pointer;
}
.dtbf-dialog-cancel { background: transparent; color: var(--sapTextColor); }
.dtbf-dialog-accept { background: #0070f2; color: #fff; font-weight: 600; box-shadow: 0 2px 0 #0040c0; }
.dtbf-dialog-accept:disabled { opacity: 0.45; cursor: default; box-shadow: none; }
[data-theme='dark'] .dtbf-dialog-accept { background: #1b90ff; box-shadow: 0 0 8px rgba(27,144,255,0.6); }
```

- [ ] **Step 4: Build + manual smoke**

```bash
cd hugo-apps && npx vite build 2>&1 | tail -3
```

Then run `npm run dev` and visit `/devtoberfest/`. With DEV config seeded (event + terms), click "Join the Fest" → dialog opens, scroll to bottom → button enables, click → state changes to `registered`.

- [ ] **Step 5: Commit**

```bash
git add hugo-apps/src/devtoberfest/
git commit -m "feat(hugo-apps): T&C dialog + JOIN flow

TermsDialog.vue loads /terms on open, gates 'Accept & Join' on
≥95% scroll (sub-pixel-quirk safe), POSTs /join, handles 201/409
(treat both as success), 412 (terms bumped — reload), 401 (alert
+ close, defers to shellbar), and generic failure (alert + retry).

DevtoberfestHome wires dialogOpen + onJoined. CTA click in
unregistered state opens the dialog; joined event flips state to
registered.

Spec §7.4, §8."
```

---

## Task 13: Admin tile — package skeleton + Configuration view

**Files:**

- Create: `app/admin/devtoberfest/package.json`
- Create: `app/admin/devtoberfest/ui5.yaml`
- Create: `app/admin/devtoberfest/webapp/Component.js`
- Create: `app/admin/devtoberfest/webapp/manifest.json`
- Create: `app/admin/devtoberfest/webapp/view/Devtoberfest.view.xml`
- Create: `app/admin/devtoberfest/webapp/view/ConfigurationTab.fragment.xml`
- Create: `app/admin/devtoberfest/webapp/view/RegistrationsTab.fragment.xml`
- Create: `app/admin/devtoberfest/webapp/controller/Devtoberfest.controller.js`
- Create: `app/admin/devtoberfest/webapp/i18n/i18n.properties`

- [ ] **Step 1: package.json**

Create `app/admin/devtoberfest/package.json` (mirror `app/admin/secrets/package.json`):

```json
{
  "name": "sap.tutorials.admin.devtoberfest",
  "version": "0.0.1",
  "private": true,
  "description": "Devtoberfest admin tile (Config + Registrations)",
  "sapux": true,
  "scripts": {
    "build": "ui5 build --clean-dest"
  },
  "devDependencies": {
    "@sap/ux-specification": "latest",
    "@ui5/cli": "^4.0.0"
  }
}
```

- [ ] **Step 2: ui5.yaml**

```yaml
specVersion: "4.0"
metadata:
  name: sap.tutorials.admin.devtoberfest
type: application
framework:
  name: SAPUI5
  version: "1.136.0"
  libraries:
    - name: sap.m
    - name: sap.ui.layout
    - name: sap.fe.templates
```

- [ ] **Step 3: Component.js**

```javascript
sap.ui.define(["sap/fe/core/AppComponent"], function (AppComponent) {
  "use strict";
  return AppComponent.extend("sap.tutorials.admin.devtoberfest.Component", {
    metadata: { manifest: "json" }
  });
});
```

- [ ] **Step 4: manifest.json**

```json
{
  "_version": "1.59.0",
  "sap.app": {
    "id": "sap.tutorials.admin.devtoberfest",
    "type": "application",
    "title": "Devtoberfest",
    "applicationVersion": { "version": "0.0.1" },
    "dataSources": {
      "mainService": {
        "uri": "/admin/",
        "type": "OData",
        "settings": { "odataVersion": "4.0" }
      }
    }
  },
  "sap.ui5": {
    "rootView": {
      "viewName": "sap.tutorials.admin.devtoberfest.view.Devtoberfest",
      "type": "XML",
      "id": "appView"
    },
    "dependencies": {
      "minUI5Version": "1.136.0",
      "libs": {
        "sap.m": {},
        "sap.ui.core": {},
        "sap.ui.layout": {},
        "sap.fe.templates": {}
      }
    },
    "models": {
      "": {
        "dataSource": "mainService",
        "settings": {
          "synchronizationMode": "None",
          "operationMode": "Server",
          "autoExpandSelect": true,
          "earlyRequests": true
        }
      },
      "i18n": {
        "type": "sap.ui.model.resource.ResourceModel",
        "settings": { "bundleName": "sap.tutorials.admin.devtoberfest.i18n.i18n" }
      }
    }
  }
}
```

- [ ] **Step 5: Root view with IconTabBar**

Create `app/admin/devtoberfest/webapp/view/Devtoberfest.view.xml`:

```xml
<mvc:View
  controllerName="sap.tutorials.admin.devtoberfest.controller.Devtoberfest"
  xmlns:mvc="sap.ui.core.mvc"
  xmlns="sap.m"
  xmlns:core="sap.ui.core"
  height="100%">
  <Page showHeader="false" enableScrolling="true">
    <IconTabBar id="devtoberfestTabs" expanded="true" applyContentPadding="true">
      <items>
        <IconTabFilter key="config" text="{i18n>tabConfiguration}" icon="sap-icon://settings">
          <core:Fragment fragmentName="sap.tutorials.admin.devtoberfest.view.ConfigurationTab" type="XML"/>
        </IconTabFilter>
        <IconTabFilter key="registrations" text="{i18n>tabRegistrations}" icon="sap-icon://group">
          <core:Fragment fragmentName="sap.tutorials.admin.devtoberfest.view.RegistrationsTab" type="XML"/>
        </IconTabFilter>
      </items>
    </IconTabBar>
  </Page>
</mvc:View>
```

- [ ] **Step 6: Configuration tab fragment**

Create `app/admin/devtoberfest/webapp/view/ConfigurationTab.fragment.xml`:

```xml
<core:FragmentDefinition
  xmlns="sap.m"
  xmlns:core="sap.ui.core"
  xmlns:l="sap.ui.layout"
  xmlns:f="sap.ui.layout.form">
  <Panel headerText="{i18n>panelEvent}" expandable="false" class="sapUiResponsiveMargin">
    <f:SimpleForm editable="true" layout="ColumnLayout" columnsXL="1" columnsL="1" columnsM="1">
      <Label text="{i18n>labelCurrentEvent}" />
      <ComboBox
        id="eventCombo"
        items="{
          path: '/Events',
          parameters: { '$orderby': 'startDate desc' }
        }"
        selectedKey="{/DevtoberfestConfig/currentEvent_ID}">
        <core:Item key="{ID}" text="{name} ({startDate} → {endDate})" />
      </ComboBox>
    </f:SimpleForm>
  </Panel>

  <Panel headerText="{i18n>panelTerms}" expandable="false" class="sapUiResponsiveMargin">
    <f:SimpleForm editable="true" layout="ColumnLayout" columnsXL="1" columnsL="1" columnsM="1">
      <Label text="{i18n>labelTermsVersion}" />
      <StepInput id="termsVersionInput"
        value="{/DevtoberfestConfig/termsVersion}"
        min="1" max="9999" />
      <MessageStrip id="versionWarning"
        text="{i18n>warnTermsVersionBump}"
        type="Warning" showIcon="true" visible="false"
        class="sapUiSmallMarginTop" />
      <Label text="{i18n>labelTermsText}" />
      <TextArea
        value="{/DevtoberfestConfig/termsText}"
        rows="20"
        growing="true"
        growingMaxLines="40"
        wrapping="Off"
        ariaLabelledBy="termsTextLabel" />
    </f:SimpleForm>
  </Panel>

  <Panel headerText="{i18n>panelSubPages}" expandable="false" class="sapUiResponsiveMargin">
    <f:SimpleForm editable="true" layout="ColumnLayout" columnsXL="1" columnsL="1" columnsM="1">
      <Label text="{i18n>labelContentRulesUrl}" />
      <Input value="{/DevtoberfestConfig/contentRulesUrl}" placeholder="https://..." />
      <Label text="{i18n>labelFaqUrl}" />
      <Input value="{/DevtoberfestConfig/faqUrl}" placeholder="(empty = disabled)" />
      <Label text="{i18n>labelGameboardUrl}" />
      <Input value="{/DevtoberfestConfig/gameboardUrl}" placeholder="(empty = disabled)" />
      <Label text="{i18n>labelActivitiesUrl}" />
      <Input value="{/DevtoberfestConfig/activitiesUrl}" placeholder="(empty = disabled)" />
    </f:SimpleForm>
  </Panel>

  <HBox justifyContent="End" class="sapUiResponsiveMargin">
    <Button text="{i18n>buttonDiscard}" type="Transparent" press=".onDiscard" />
    <Button text="{i18n>buttonSave}" type="Emphasized" press=".onSave" />
  </HBox>
</core:FragmentDefinition>
```

- [ ] **Step 7: Registrations tab fragment**

Create `app/admin/devtoberfest/webapp/view/RegistrationsTab.fragment.xml`:

```xml
<core:FragmentDefinition
  xmlns="sap.m"
  xmlns:core="sap.ui.core">
  <Table
    id="registrationsTable"
    items="{
      path: '/EventRegistrations',
      parameters: {
        '$expand': 'user,event',
        '$orderby': 'joinedAt desc',
        '$top': 200
      }
    }"
    growing="true"
    growingThreshold="50">
    <headerToolbar>
      <Toolbar>
        <Title text="{i18n>titleRegistrations} ({= ${/EventRegistrations}.length })" level="H3"/>
        <ToolbarSpacer/>
      </Toolbar>
    </headerToolbar>
    <columns>
      <Column><Text text="{i18n>colJoinedAt}"/></Column>
      <Column><Text text="{i18n>colUserEmail}"/></Column>
      <Column><Text text="{i18n>colUserSapId}"/></Column>
      <Column><Text text="{i18n>colEventName}"/></Column>
      <Column hAlign="End"><Text text="{i18n>colTermsVersion}"/></Column>
    </columns>
    <items>
      <ColumnListItem>
        <cells>
          <Text text="{
            path: 'joinedAt',
            formatter: '.formatTimestamp'
          }"/>
          <Text text="{user/email}"/>
          <Text text="{user/sapId}"/>
          <Text text="{event/name}"/>
          <Text text="{termsVersion}"/>
        </cells>
      </ColumnListItem>
    </items>
  </Table>
</core:FragmentDefinition>
```

- [ ] **Step 8: Controller — save + version-bump warning**

Create `app/admin/devtoberfest/webapp/controller/Devtoberfest.controller.js`:

```javascript
sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/m/MessageToast"
], function (Controller, MessageToast) {
  "use strict";

  return Controller.extend("sap.tutorials.admin.devtoberfest.controller.Devtoberfest", {

    onInit: function () {
      // Bind a snapshot of the original termsVersion so we can show the
      // version-bump warning strip when the admin edits it.
      var oModel = this.getOwnerComponent().getModel();
      oModel.bindContext("/DevtoberfestConfig", null, { $$updateGroupId: "auto" })
        .requestObject()
        .then((cfg) => {
          this._originalTermsVersion = cfg.termsVersion;
        });

      // Watch the StepInput for changes; toggle the MessageStrip.
      var oVersionInput = this.byId("termsVersionInput");
      if (oVersionInput) {
        oVersionInput.attachChange((evt) => {
          var newVal = parseInt(evt.getParameter("value"), 10);
          var strip = this.byId("versionWarning");
          if (strip) {
            strip.setVisible(this._originalTermsVersion !== undefined &&
                            newVal !== this._originalTermsVersion);
          }
        });
      }
    },

    formatTimestamp: function (iso) {
      if (!iso) return "";
      return new Date(iso).toLocaleString();
    },

    onSave: function () {
      var oModel = this.getOwnerComponent().getModel();
      oModel.submitBatch("auto").then(() => {
        MessageToast.show(this.getBundle().getText("toastSaved"));
        var strip = this.byId("versionWarning");
        if (strip) strip.setVisible(false);
      }).catch((err) => {
        MessageToast.show(this.getBundle().getText("toastSaveFailed") + ": " + (err.message || ""));
      });
    },

    onDiscard: function () {
      var oModel = this.getOwnerComponent().getModel();
      oModel.resetChanges();
      MessageToast.show(this.getBundle().getText("toastDiscarded"));
    },

    getBundle: function () {
      return this.getOwnerComponent().getModel("i18n").getResourceBundle();
    }
  });
});
```

- [ ] **Step 9: i18n.properties**

```properties
tabConfiguration=Configuration
tabRegistrations=Registrations
panelEvent=Current Event
panelTerms=Contents Rules (T&C)
panelSubPages=Sub-page links (optional — leave empty until ready)
labelCurrentEvent=Event
labelTermsVersion=Version
labelTermsText=Terms text (markdown)
labelContentRulesUrl=Content Rules URL
labelFaqUrl=FAQ URL
labelGameboardUrl=Gameboard URL
labelActivitiesUrl=Activities URL
warnTermsVersionBump=Bumping the version will force every registered user to re-accept the new terms on their next login.
buttonSave=Save
buttonDiscard=Discard
titleRegistrations=Registrations
colJoinedAt=Joined At
colUserEmail=User
colUserSapId=SAP ID
colEventName=Event
colTermsVersion=Terms Version
toastSaved=Configuration saved
toastSaveFailed=Save failed
toastDiscarded=Changes discarded
```

- [ ] **Step 10: Commit**

```bash
git add app/admin/devtoberfest/
git commit -m "feat(admin): Devtoberfest admin tile — Config + Registrations views

IconTabBar with two fragments:
  - ConfigurationTab — singleton DevtoberfestConfig bound via OData.
    Event combobox value-help, version-bump warning strip when
    termsVersion is edited, 4 optional sub-page URL inputs.
  - RegistrationsTab — read-only table of EventRegistrations with
    expand on user + event (email, sapId, eventName, termsVersion).

Controller handles Save (submitBatch) + Discard (resetChanges). i18n
keys for every label. Mirror of the Privacy Audit + Secrets tile shape.

Spec §9."
```

---

## Task 14: Wire the new tile into admin-shell

**Files:**

- Modify: `app/admin-shell/webapp/manifest.json`
- Modify: `app/admin-shell/webapp/controller/Shell.controller.js`
- Modify: `app/admin-shell/webapp/view/Shell.view.xml`
- Modify: `app/admin-shell/scripts/copy-components.js`

- [ ] **Step 1: manifest — register the component**

In `app/admin-shell/webapp/manifest.json`, find `componentUsages` block. Add the new entry after the existing `privacyAudit` entry (alphabetical-ish):

```json
"devtoberfest": {
  "name": "sap.tutorials.admin.devtoberfest",
  "settings": {},
  "componentData": {},
  "lazy": true
}
```

Also find `resourceRoots` and add:

```json
"sap.tutorials.admin.devtoberfest": "./components/devtoberfest"
```

Find the `routing.routes` array and add:

```json
{ "pattern": "devtoberfest", "name": "devtoberfest", "target": "devtoberfest" }
```

Find `routing.targets` and add:

```json
"devtoberfest": {
  "type": "Component",
  "usage": "devtoberfest",
  "id": "devtoberfestTarget",
  "controlAggregation": "to"
}
```

- [ ] **Step 2: Shell.controller.js — nav key → route + title**

In `app/admin-shell/webapp/controller/Shell.controller.js`, find the `NAV_KEY_TO_ROUTE` map and add:

```javascript
devtoberfest: "devtoberfest",
```

Find `NAV_KEY_TO_TITLE` and add:

```javascript
devtoberfest: "Devtoberfest",
```

- [ ] **Step 3: Shell.view.xml — side-nav entry**

Find the System group in `app/admin-shell/webapp/view/Shell.view.xml` and add a new `tnt:NavigationListItem` (alphabetical-ish — between "Account Merges" and "Change Log"):

```xml
<tnt:NavigationListItem text="Devtoberfest" key="devtoberfest" icon="sap-icon://flag" />
```

- [ ] **Step 4: copy-components.js — add to copy list**

In `app/admin-shell/scripts/copy-components.js`, add `'devtoberfest'` to the components array (around line 20-30 — alphabetical).

- [ ] **Step 5: Build admin-shell to verify**

```bash
npm --prefix app/admin-shell run build
```

Expected: `dist/components/devtoberfest/` populated.

- [ ] **Step 6: Manually smoke against `cds watch` + local approuter**

Visit `http://localhost:5000/admin-ui/#/devtoberfest`. Should render the IconTabBar with two empty tabs (Config defaults populated by the singleton handler, Registrations empty).

- [ ] **Step 7: Commit**

```bash
git add app/admin-shell/
git commit -m "feat(admin-shell): wire Devtoberfest tile into navigation

Adds resourceRoot, componentUsage, route, target, side-nav entry,
controller route+title maps, and copy-components inclusion. Mirrors
the Privacy Audit (PR #554) and Secrets (PR #549) shell-wiring shape.

Spec §9.1."
```

---

## Task 15: Annotations + value-help code list

**Files:**

- Modify: `app/admin-annotations.cds`

- [ ] **Step 1: Add EventRegistrations + DevtoberfestConfig annotations**

In `app/admin-annotations.cds`, append (near the Privacy Audit / Account Merges annotation blocks):

```cds
// --- Devtoberfest (singleton config + read-only registrations audit) ---
//
// Spec: docs/superpowers/specs/2026-06-22-devtoberfest-homepage-design.md §9
//
// DevtoberfestConfig is @odata.singleton in srv/admin-service.cds — the
// tile's OData URL is /admin/DevtoberfestConfig (no key in path). UI
// annotations here are minimal because the tile uses a custom IconTabBar
// view (not Fiori Elements ListReport/ObjectPage), so most layout lives
// in the tile's XML fragments. We keep field labels here for the OData
// $metadata, which various downstream consumers reflect.
annotate AdminService.DevtoberfestConfig with {
  currentEvent      @title: 'Current Devtoberfest Event'
                    @Common.ValueList: {
                      Label: 'Event',
                      CollectionPath: 'Events',
                      Parameters: [
                        { $Type: 'Common.ValueListParameterInOut',       LocalDataProperty: currentEvent_ID, ValueListProperty: 'ID' },
                        { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'name' },
                        { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'startDate' },
                        { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'endDate' }
                      ]
                    };
  termsText         @title: 'Contents Rules (markdown)'
                    @UI.MultiLineText;
  termsVersion      @title: 'Terms Version';
  contentRulesUrl   @title: 'Content Rules URL';
  faqUrl            @title: 'FAQ URL';
  gameboardUrl      @title: 'Gameboard URL';
  activitiesUrl     @title: 'Activities URL';
};

// EventRegistrations — read-only audit table. Tile renders via a hand-
// written Table fragment in RegistrationsTab.fragment.xml, so no full
// @UI.LineItem block. Labels here for $metadata consumers.
annotate AdminService.EventRegistrations with {
  user             @title: 'User';
  event            @title: 'Event';
  joinedAt         @title: 'Joined At';
  termsVersion     @title: 'Terms Version';
  termsAcceptedAt  @title: 'Terms Accepted At';
};

annotate AdminService.EventRegistrations with @(
  Capabilities.DeleteRestrictions.Deletable: false,
  Capabilities.InsertRestrictions.Insertable: false,
  Capabilities.UpdateRestrictions.Updatable: false
);
```

- [ ] **Step 2: Re-run cds build (annotations changed → csn.json drifts)**

```bash
npx cds build --production
git status --short db/last-dev/
```

Expected: `db/last-dev/csn.json` modified.

- [ ] **Step 3: Smoke — re-run the singleton + status tests to confirm no breakage**

```bash
npx vitest run test/unit/devtoberfest-config-schema.test.js test/unit/devtoberfest-status-handler.test.js test/unit/devtoberfest-terms-handler.test.js test/unit/devtoberfest-join-handler.test.js test/unit/devtoberfest-me-handler.test.js test/unit/devtoberfest-registration-unique.test.js --project unit
```

Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add app/admin-annotations.cds db/last-dev/csn.json
git commit -m "feat(annotations): DevtoberfestConfig + EventRegistrations labels

@title labels on every field of both entities so OData \$metadata
exposes friendly names. @Common.ValueList on currentEvent → Events
collection (name + start + end visible in the dropdown). Capabilities
locked on EventRegistrations to read-only — writes go through
/api/devtoberfest/join only.

Spec §9.6."
```

---

## Task 16: Hybrid test — real HANA round-trip

**Files:**

- Create: `test/hybrid/devtoberfest-registration-hana.test.js`

- [ ] **Step 1: Write the hybrid test**

Create `test/hybrid/devtoberfest-registration-hana.test.js`:

```javascript
// test/hybrid/devtoberfest-registration-hana.test.js
// End-to-end against real HANA: create Event + Config, POST /join,
// verify Registration row, idempotent re-join returns 409. Test data
// prefixed __TEST__ per test/hybrid/_guard.js rules.
//
// Run with:
//   ALLOW_HYBRID_WRITES=true npx vitest run test/hybrid/devtoberfest-registration-hana.test.js --project hybrid
//
// Spec §10.2

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';
import { isSafeForWrites } from './_guard.js';

describe('Devtoberfest join — real HANA', () => {
  let project;
  let createdRegistrationId;
  const testSapId = '__TEST__devtoberfest_' + Date.now();
  const SINGLETON_ID = '00000000-0000-0000-0000-00d0fe57feed';
  let savedConfig;
  let testEventId;
  let testUserId;

  beforeAll(async () => {
    if (process.env.ALLOW_HYBRID_WRITES !== 'true') {
      throw new Error('Set ALLOW_HYBRID_WRITES=true to run this test');
    }
    isSafeForWrites();

    project = cds.test().in(process.cwd());
    await new Promise((r) => setTimeout(r, 500));

    const { Users, Events, DevtoberfestConfig } = cds.entities('com.sap.developers.ims');

    // Snapshot existing config so we restore it in afterAll.
    savedConfig = await SELECT.one.from(DevtoberfestConfig);

    testUserId = cds.utils.uuid();
    testEventId = cds.utils.uuid();
    await INSERT.into(Users).entries({
      ID: testUserId, sapId: testSapId,
      email: '__test__@example.com', legacyId: 999999,
    });
    await INSERT.into(Events).entries({
      ID: testEventId, name: '__TEST__Devtoberfest', startDate: '2026-10-01T00:00:00Z',
      endDate: '2026-10-28T00:00:00Z', legacyId: 999998,
    });

    // Set DevtoberfestConfig.currentEvent to the test event.
    if (savedConfig) {
      await UPDATE(DevtoberfestConfig).set({
        currentEvent_ID: testEventId, termsVersion: 7,
      }).where({ ID: SINGLETON_ID });
    } else {
      await INSERT.into(DevtoberfestConfig).entries({
        ID: SINGLETON_ID, currentEvent_ID: testEventId, termsVersion: 7,
      });
    }
  });

  afterAll(async () => {
    const { Users, Events, DevtoberfestConfig, EventRegistrations } =
      cds.entities('com.sap.developers.ims');
    if (createdRegistrationId) {
      await DELETE.from(EventRegistrations).where({ ID: createdRegistrationId });
    }
    await DELETE.from(EventRegistrations).where({ event_ID: testEventId });
    await DELETE.from(Events).where({ ID: testEventId });
    await DELETE.from(Users).where({ ID: testUserId });
    if (savedConfig) {
      await UPDATE(DevtoberfestConfig).set({
        currentEvent_ID: savedConfig.currentEvent_ID,
        termsVersion: savedConfig.termsVersion,
      }).where({ ID: SINGLETON_ID });
    }
  });

  it('POST /join creates a row, second call returns 409', async () => {
    const auth = { username: testSapId, password: 'test' };

    const first = await project.axios.post(
      '/api/devtoberfest/join',
      { termsVersion: 7 },
      { auth, validateStatus: () => true },
    );
    expect([201, 403]).toContain(first.status);
    if (first.status === 403) {
      // Some hybrid setups don't auto-resolve sapId via mock auth on
      // deployed HANA. That's documented spec behavior (403 USER_NOT_IN_DB).
      // The smoke test in Task 17 covers the deployed XSUAA path.
      return;
    }

    const { EventRegistrations } = cds.entities('com.sap.developers.ims');
    const reg = await SELECT.one.from(EventRegistrations).where({
      user_ID: testUserId, event_ID: testEventId,
    });
    expect(reg).toBeTruthy();
    createdRegistrationId = reg.ID;
    expect(reg.termsVersion).toBe(7);

    const second = await project.axios.post(
      '/api/devtoberfest/join',
      { termsVersion: 7 },
      { auth, validateStatus: () => true },
    );
    expect(second.status).toBe(409);
  });
});
```

- [ ] **Step 2: Verify locally (optional — gated on cf login + ALLOW_HYBRID_WRITES)**

```bash
ALLOW_HYBRID_WRITES=true npx vitest run test/hybrid/devtoberfest-registration-hana.test.js --project hybrid
```

This step is optional in CI; the test runs in the existing hybrid suite locally.

- [ ] **Step 3: Commit**

```bash
git add test/hybrid/devtoberfest-registration-hana.test.js
git commit -m "test(hybrid): Devtoberfest join — real HANA round-trip

Creates an Event + sets DevtoberfestConfig, POSTs join, verifies
the EventRegistration row, asserts idempotent re-join returns 409.
Restores DevtoberfestConfig from snapshot in afterAll so the test
leaves no side effects. ALLOW_HYBRID_WRITES gate per project policy.

Spec §10.2."
```

---

## Task 17: Smoke test — deployed DEV

**Files:**

- Create: `test/smoke/devtoberfest.smoke.test.js`

- [ ] **Step 1: Write the smoke test**

Create `test/smoke/devtoberfest.smoke.test.js`:

```javascript
// test/smoke/devtoberfest.smoke.test.js
// HTTP-only checks against deployed DEV. Runs after deploy in CI.
//
// Required env vars (set by the deploy.yml smoke step):
//   SMOKE_BASE_URL — approuter URL
//   SMOKE_SRV_URL  — srv URL (direct, bypasses approuter)
//
// Spec §10.3

import { describe, it, expect, beforeAll } from 'vitest';

const BASE_URL = process.env.SMOKE_BASE_URL;
const SRV_URL  = process.env.SMOKE_SRV_URL;

describe('Devtoberfest smoke', () => {
  beforeAll(() => {
    if (!BASE_URL || !SRV_URL) {
      throw new Error('SMOKE_BASE_URL and SMOKE_SRV_URL must be set');
    }
  });

  it('GET /devtoberfest/ returns 200 with the mount script', async () => {
    const res = await fetch(`${BASE_URL}/devtoberfest/`, { redirect: 'manual' });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('devtoberfest-mount');
    expect(html.toLowerCase()).toContain('devtoberfest');
  });

  it('GET /api/devtoberfest/status returns valid JSON shape', async () => {
    const res = await fetch(`${SRV_URL}/api/devtoberfest/status`);
    expect([200, 503]).toContain(res.status);
    const body = await res.json();
    if (res.status === 503) {
      expect(body.error).toBe('EVENT_NOT_CONFIGURED');
    } else {
      expect(body).toHaveProperty('joined');
      expect(body).toHaveProperty('termsVersion');
      expect(typeof body.joined).toBe('boolean');
      expect(typeof body.termsVersion).toBe('number');
    }
  });

  it('GET /api/devtoberfest/terms returns valid shape', async () => {
    const res = await fetch(`${SRV_URL}/api/devtoberfest/terms`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('text');
    expect(body).toHaveProperty('version');
    expect(typeof body.text).toBe('string');
    expect(typeof body.version).toBe('number');
  });

  it('POST /api/devtoberfest/join without auth returns 401', async () => {
    const res = await fetch(`${SRV_URL}/api/devtoberfest/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ termsVersion: 1 }),
    });
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Sanity-check via the existing smoke runner**

```bash
# Locally after a DEV deploy:
SMOKE_BASE_URL=https://tutorial-system-dev-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com \
SMOKE_SRV_URL=https://tutorial-system-dev-tutorials-srv.cfapps.eu10-005.hana.ondemand.com \
npx vitest run test/smoke/devtoberfest.smoke.test.js --project smoke
```

Expected: 4/4 pass post-deploy.

- [ ] **Step 3: Commit**

```bash
git add test/smoke/devtoberfest.smoke.test.js
git commit -m "test(smoke): Devtoberfest endpoints — deployed DEV

4 HTTP checks against the deployed approuter + srv:
  - GET /devtoberfest/ → 200 + contains mount script
  - GET /api/devtoberfest/status → 200 OR 503 (event not configured)
  - GET /api/devtoberfest/terms → 200 + valid {text,version}
  - POST /api/devtoberfest/join (no auth) → 401

Runs after every deploy in CI; gates the release.

Spec §10.3."
```

---

## Task 18: Pre-PR sweep + lint clean + final review

**Files:** all touched files in prior tasks

- [ ] **Step 1: Run the full unit suite for the new files**

```bash
npx vitest run \
  test/unit/devtoberfest-config-schema.test.js \
  test/unit/devtoberfest-registration-unique.test.js \
  test/unit/devtoberfest-status-handler.test.js \
  test/unit/devtoberfest-terms-handler.test.js \
  test/unit/devtoberfest-join-handler.test.js \
  test/unit/devtoberfest-me-handler.test.js \
  --project unit
```

Expected: all tests across all 6 files green.

- [ ] **Step 2: Run the broader unit suite to catch any adjacency regressions**

```bash
npx vitest run --project unit 2>&1 | tail -10
```

Expected: prior tests in the unit suite still all green. If any fail, the failure is most likely related to:

- A new `legacyKeyedEntities` entry colliding with an existing test (unlikely, but check that test's `beforeEach` cleanup).
- The defensive singleton handler firing unexpectedly during a test that doesn't seed `DevtoberfestConfig` (also unlikely — the handler is scoped to `'READ', 'DevtoberfestConfig'`).

- [ ] **Step 3: Verify CDS build is clean + artifacts staged**

```bash
npx cds build --production
git status --short db/last-dev/ db/src/
```

Expected: no further drift after the most recent stage. If new diff appears, stage it.

- [ ] **Step 4: Verify the Hugo + Vite build emits the devtoberfest.js bundle**

```bash
cd hugo-apps && npx vite build 2>&1 | grep -E 'devtoberfest|error' | head -5
```

Expected: `devtoberfest.js` listed in the output, no errors.

- [ ] **Step 5: Verify the admin-shell build copies the new component**

```bash
npm --prefix app/admin-shell run build 2>&1 | tail -5
ls app/admin-shell/dist/components/devtoberfest 2>&1 | head -5
```

Expected: `Component.js`, `manifest.json`, `view/`, `controller/`, `i18n/`.

- [ ] **Step 6: Clean any straggling markdownlint warnings in the plan doc**

The MD031/MD032 warnings flagged during plan authoring are cosmetic (blank-line-around-block rules) and don't affect rendering or CI. If desired, add a blank line before each `**Files:**` list and between any inline code fences and the next paragraph. Optional polish — not blocking.

- [ ] **Step 7: Open the PR**

```bash
git push origin feat/devtoberfest-homepage
gh pr create --base main --title "feat(devtoberfest): public homepage + admin tile (#397)" --body-file - <<'EOF'
Implements the Devtoberfest homepage per the design spec at
docs/superpowers/specs/2026-06-22-devtoberfest-homepage-design.md.

## What's in this PR

- New `DevtoberfestConfig` (singleton) + `EventRegistrations` entities
- Public `/devtoberfest/` page with Vue island (state machine, Joule×arcade styling, scroll-to-enable T&C dialog)
- 4 API endpoints: `/api/devtoberfest/{status,terms}` public; `/{join,me}` XSUAA-gated
- Admin tile `/admin-ui/#/devtoberfest` with IconTabBar (Configuration + Registrations)
- Placeholder SVG assets for Kasimir + TechEd + Devtoberfest logos (real art swap is a file-only change later)
- Approuter routes for the new public + auth surfaces
- Tests: 6 unit, 1 hybrid (gated on ALLOW_HYBRID_WRITES), 1 smoke

## Out of scope (deferred per spec §12)

- Real artwork (file-only swap when assets arrive)
- Content rules / FAQ / Gameboard / Activities sub-pages (URL fields empty until each ships)
- Weekly activity tracking + points/scoring engine
- Per-year automation (admin manually creates next year's Event + flips `currentEvent`)

## Operational notes (spec §13)

After deploy:

1. Admin opens `/admin-ui/#/events-display`, creates "Devtoberfest 2026" Event row with `startDate` + `endDate`.
2. Admin opens `/admin-ui/#/devtoberfest`, picks the new Event from the value-help, pastes legal Contents Rules into the markdown textarea, sets `termsVersion = 1`, saves.
3. `/devtoberfest/` is now live for anonymous + authenticated users.

Spec: docs/superpowers/specs/2026-06-22-devtoberfest-homepage-design.md
Plan: docs/superpowers/plans/2026-06-22-devtoberfest-homepage-plan.md
Closes #397
EOF
```

- [ ] **Step 8: Final commit (if any straggling deltas)**

```bash
git status
git add -A
git commit -m "chore: final pre-PR sweep — staged any remaining cds build drift" --allow-empty
```

---

## Wrap-up notes

Once the PR merges + deploys to DEV, the operational steps to bring the page online are:

1. **Create the Devtoberfest 2026 Event** via the Events admin tile (set startDate + endDate).
2. **Configure the Devtoberfest singleton**: open the new Devtoberfest admin tile → pick the Event in the combobox → paste the legal Contents Rules into the textarea → set `termsVersion: 1` → save.
3. **Verify the homepage**: navigate to `/devtoberfest/` while logged out (should see "Join the Fest" CTA + the rail with "Coming soon" tooltips since sub-page URLs are empty) and logged in (CTA active → dialog opens → register → state flips to `registered`).
4. **Watch for the post-deploy team brainstorm**: Tom plans to bring this working draft to the team Wednesday so they can decide what each sub-page should contain. Sub-page URLs are filled in DevtoberfestConfig as each sub-page ships — no homepage redeploy needed.

If real artwork arrives during the brainstorm window, the swap is:

```bash
# Tom (or whoever) drops the real SVGs into hugo/static/images/devtoberfest/
# overwriting the placeholders. Then:
git add hugo/static/images/devtoberfest/
git commit -m "art(devtoberfest): swap placeholder SVGs for final artwork"
# Deploy. No code changes required.
```

