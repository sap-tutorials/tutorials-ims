# Developer Portal Homepage — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `developers.sap.com/` with a developer-viewpoint catalog homepage organised by six verbs (Learn / Build / Integrate / Operate / Extend with AI / Connect), relocate the current tutorial navigator to `/tutorial-navigator/`, and surface ~50 SAP developer destinations through admin-curated shelves + live YouTube/events bands.

**Architecture:** Hugo static pages + Vue islands consume a new `HomepageService` CAP service over a new `HomepageShelves` CDS entity (admin-curated content) + a new `LegacyRedirects` entity (admin-edited URL map) + a new `HomepageConfig` singleton (runtime feature config). Live data bands (events, SAPDevs YouTube) pull through CAP-side fetchers with server-side TTL caches. A new Fiori Elements admin app at `app/admin/homepage/` edits shelves + redirects. Legacy `*.html` redirects move from the existing static `LEGACY_REDIRECTS` array in `approuter/server.js` to a dynamic CAP-backed map with a conservative existence-checking catch-all and sampled hit-count flush.

**Tech Stack:** CAP 9 (Node.js), CDS, HANA Cloud (prod) / SQLite (unit tests), Hugo, Vue 3 islands (Vite), Fiori Elements (UI5 1.136), `@cap-js/audit-logging`, `@cap-js/change-tracking`, BTP credstore via `srv/lib/secret-resolver.js`, Vitest (3 workspaces: unit / hybrid / smoke), YouTube Data API v3.

---

## Spec §17 resolutions (decisions made during plan-writing)

| # | Question | Decision | Rationale |
|---|---------|----------|-----------|
| 1 | Catch-all `*.html` strictness | **Conservative** — only redirect if a Hugo target exists | Spec §9.3 leaned this way; safer; typos still 404 instead of misrouting |
| 2 | Verb sub-page extras | **3 of 6 get one extra section:** Connect (events calendar), Learn (curated paths), Operate (BTP service catalog link). Build / Integrate / AI ship 4-shelf-only | Honest MVP scope; admin can add later |
| 3 | Developer News playlist ID | **Runtime config** via new `HomepageConfig` singleton entity, admin-editable | Decouples deploy from the playlist ID Tom needs to fill in |
| 4 | Pre-baked legacy URLs | **3 named at launch:** `/tutorial-navigator.html`, `/index.html`, `/groups.html`. Rest observed post-launch | Adds named coverage without speculating |
| 5 | Admin app permission scope | **Reuse existing `Admin` scope** | Matches the 14 existing admin apps |
| 6 | `LegacyRedirects.hitCount` write path | **In-memory counter, batched flush every 60s** via single `POST /api/redirects/hits` | No per-request write amplification; tolerates approuter restart loss |

---

## File structure

**New files (created):**

```
db/homepage.cds                                      CDS entities: HomepageShelves, LegacyRedirects, HomepageConfig
db/data/com.sap.developers.ims-HomepageShelves.csv   Seed: ~50 destinations from inventory artifact
db/data/com.sap.developers.ims-HomepageConfig.csv    Seed: 1 row with placeholder playlist ID
db/data/com.sap.developers.ims-LegacyRedirects.csv   Seed: 3 named redirects

srv/homepage-service.cds                             HomepageService (@path: /api/homepage, public)
srv/homepage-service.js                              Service handlers
srv/lib/youtube-fetcher.js                           YouTube Data API v3 wrapper
srv/lib/homepage-events-merger.js                    Pure-function merger of EventStreamService + sap-devs events
srv/lib/homepage-rss-fetcher.js                      RSS pull for community blogs + news.sap.com
srv/lib/legacy-redirects-resolver.js                 Pattern-match + lookup helper (shared by approuter and tests)
srv/jobs/homepage-link-health.js                     Nightly job; walks HomepageShelves.url

approuter/lib/legacy-redirects-loader.js             Fetches LegacyRedirects map from /api/redirects/active, refreshes hourly
approuter/lib/hit-counter.js                         In-memory hit counter + 60s flush

scripts/fetch-homepage-shelves.ts                    Hugo build step: GET /build/homepage-shelves → hugo/data/homepage_shelves.json

hugo/content/_index.md                               (REPLACE) the new homepage content stub
hugo/content/learn/_index.md                         Verb sub-page stubs (one per verb)
hugo/content/build/_index.md
hugo/content/integrate/_index.md
hugo/content/operate/_index.md
hugo/content/ai/_index.md
hugo/content/connect/_index.md
hugo/content/tutorial-navigator/_index.md            Relocated tutorial-navigator (Hugo content stub)

hugo/layouts/index.html                              (REPLACE) renders new homepage anatomy (7 rows)
hugo/layouts/verb/list.html                          Shared layout for all 6 verb sub-pages
hugo/layouts/tutorial-navigator/list.html            (RENAME) what's currently hugo/layouts/index.html
hugo/layouts/partials/homepage/                      New partials directory
  hero.html                                          Row 1 hero
  verb-spine.html                                    Row 2 6-tile spine
  events-band.html                                   Row 3 events
  video-band.html                                    Row 4 SAPDevs videos
  tutorials-teaser.html                              Row 5 (reuses /browse/ card partials)
  community-lane.html                                Row 6 three-column lane
  directory-footer.html                              Row 7 6-column footer

hugo/assets/css/homepage.css                         All homepage-specific styles
hugo-apps/src/homepage-bands/                        Vue islands for live-data bands
  index.ts                                           Vite entry → hugo/static/js/homepage-bands.js
  EventsBand.vue
  VideoBand.vue
  CommunityLane.vue

app/admin/homepage/                                  New Fiori Elements admin app
  package.json
  ui5.yaml
  webapp/manifest.json                               Two views: shelves + redirects
  webapp/Component.js
  webapp/i18n/i18n.properties

test/unit/homepage-shelves-crud.test.js              Unit: HomepageShelves CRUD via in-memory SQLite
test/unit/homepage-service-endpoints.test.js         Unit: shape of /api/homepage/* responses
test/unit/legacy-redirects-resolver.test.js          Unit: pattern + exact match + miss
test/unit/youtube-fetcher.test.js                    Unit: with mocked fetch (success / 403 / 429 / timeout)
test/unit/homepage-link-health.test.js               Unit: job updates linkStatus correctly

test/hybrid/homepage-shelves-schema.test.js          Hybrid: HANA schema deploy + admin CRUD round-trip
test/hybrid/legacy-redirects-uniqueness.test.js      Hybrid: case-insensitive @assert.unique on fromPath

test/smoke/homepage.smoke.test.ts                    Smoke: GET / + verb sub-pages + /tutorial-navigator/ + redirects
test/smoke/homepage-api.smoke.test.ts                Smoke: /api/homepage/* return well-formed JSON

docs/developers/architecture/homepage.md             Architecture doc — referenced by CLAUDE.md
```

**Modified files:**

```
db/schema.cds                                        Add `using from './homepage';` import
srv/admin-service.cds                                Add HomepageShelves, LegacyRedirects, HomepageConfig projections (Admin scope)
app/admin-annotations.cds                            @UI annotations for the new entities
db/change-tracking.cds                               Annotate the 3 new entities with @changelog
mta.yaml                                             Add YOUTUBE_API_KEY env var declaration
.deploy/mta.yaml                                     Add srv-qa cp list entries for new srv/lib files; mtaext placeholder
deploy/dev.mtaext, deploy/qa.mtaext, deploy/prod.mtaext  Add YOUTUBE_API_KEY placeholder

approuter/server.js                                  REPLACE static LEGACY_REDIRECTS with dynamic loader call
                                                     ADD conservative *.html catch-all middleware
                                                     ADD hit-counter middleware

scripts/fetch-tutorials.ts                           Add post-step that invokes scripts/fetch-homepage-shelves.ts
                                                     (no rename; per spec §11.3 fold-in)
hugo-apps/vite.config.ts                             Add homepage-bands entry

app/admin-shell/webapp/manifest.json                 Register homepage component usage + route
app/admin-shell/webapp/view/Shell.view.xml           Add side-nav item "Homepage"
app/admin-shell/webapp/controller/Shell.controller.js  Or wherever nav model is populated; add Homepage entry

.deploy/mta.yaml                                     Approuter cp list — add legacy-redirects-loader.js + hit-counter.js

docs/developers/operations/testing-endpoints.md     Document /api/homepage/*, /api/redirects/hits, /build/homepage-shelves
docs/developers/architecture/build.md                Note the new homepage_shelves.json data feed
CLAUDE.md                                            Link to docs/developers/architecture/homepage.md in the architecture index

package.json                                         Add `npm run fetch-homepage-shelves` script (called by build:all)
```

---

## Phased delivery

The plan splits into **5 phases** that can ship as separate PRs to keep review surface manageable. Each phase produces working software that passes all three test workspaces.

- **Phase 1 — Data model + admin app:** CDS entities, seed data, AdminService projections, Fiori admin app for shelves/redirects/config. Ships independently; no user-visible homepage change.
- **Phase 2 — HomepageService + live data fetchers:** `HomepageService` (`/api/homepage/*`), YouTube fetcher, RSS fetchers, events merger. Smoke-testable but not yet wired to a UI.
- **Phase 3 — Legacy redirects (dynamic + catch-all):** Migrate static `LEGACY_REDIRECTS` to dynamic loader, add conservative catch-all, add hit counter. Approuter changes; user-visible only for legacy URLs.
- **Phase 4 — New homepage + verb sub-pages:** Hugo content/layout/partials, Vue islands, CSS. Switches `/` to the new homepage and `/tutorial-navigator/` to the relocated tutorial navigator. **This is the cutover moment.**
- **Phase 5 — Nightly link-health job + docs:** Cron job for link health, architecture doc, CLAUDE.md updates.

Each phase has its own task list below.

---

# Phase 1 — Data model + admin app

> **Branch convention:** Work in a worktree at `.claude/worktrees/639-phase1/` per `feedback_use_worktree_for_multi_step_parser_fixes` memory. Branch name: `feat/639-phase1-data-model`.
>
> **Pre-flight:** `npm install && npm run setup && cf login` (for the hybrid test). The hybrid test needs `ALLOW_HYBRID_WRITES=true` since it writes seed data.

## Task 1 — CDS entities (`db/homepage.cds`)

**Files:**
- Create: `db/homepage.cds`
- Modify: `db/schema.cds` (add `using from './homepage';`)
- Test: `test/unit/homepage-shelves-crud.test.js`

- [ ] **Step 1.1 — Write the failing CRUD test**

Read `test/unit/admin-singleton-auto-init.test.js` for the in-memory CDS boot pattern. Create `test/unit/homepage-shelves-crud.test.js`:

```js
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

cds.test('serve', '--project', '.', '--in-memory');

describe('HomepageShelves CRUD', () => {
  let db;
  beforeAll(async () => { db = await cds.connect.to('db'); });

  it('inserts and retrieves a shelf entry', async () => {
    const { HomepageShelves } = db.entities('com.sap.developers.ims');
    await db.run(INSERT.into(HomepageShelves).entries({
      ID: 'aaaaaaaa-1111-2222-3333-444444444444',
      verb: 'LEARN',
      shelf: 'START_HERE',
      sortOrder: 10,
      title: 'Tutorial navigator',
      url: '/tutorial-navigator/',
      description: 'Catalog of 1,400+ tutorials',
      isExternal: false,
      isActive: true
    }));
    const row = await db.run(SELECT.one.from(HomepageShelves).where({
      ID: 'aaaaaaaa-1111-2222-3333-444444444444'
    }));
    expect(row).toBeTruthy();
    expect(row.verb).toBe('LEARN');
    expect(row.title).toBe('Tutorial navigator');
  });

  it('rejects duplicate URL within same verb (assert.unique)', async () => {
    const { HomepageShelves } = db.entities('com.sap.developers.ims');
    const entry = {
      verb: 'BUILD', shelf: 'REFERENCE', sortOrder: 5,
      title: 'CAP docs', url: 'https://cap.cloud.sap', isActive: true
    };
    await db.run(INSERT.into(HomepageShelves).entries({ ...entry, ID: cds.utils.uuid() }));
    await expect(
      db.run(INSERT.into(HomepageShelves).entries({ ...entry, ID: cds.utils.uuid() }))
    ).rejects.toThrow(/unique|duplicate/i);
  });

  it('persists HomepageConfig as a singleton', async () => {
    const { HomepageConfig } = db.entities('com.sap.developers.ims');
    await db.run(INSERT.into(HomepageConfig).entries({
      ID: 'cccccccc-1111-2222-3333-444444444444',
      developerNewsPlaylistId: 'PLxxxx',
      videoBandEnabled: true
    }));
    const row = await db.run(SELECT.one.from(HomepageConfig));
    expect(row.developerNewsPlaylistId).toBe('PLxxxx');
  });
});
```

- [ ] **Step 1.2 — Run the test; expect it to fail with "Entity not found"**

```bash
npx vitest run test/unit/homepage-shelves-crud.test.js
```

Expected: FAIL — `HomepageShelves` / `HomepageConfig` not found in CSN.

- [ ] **Step 1.3 — Create `db/homepage.cds`**

Use the project's existing `managed`/`cuid` patterns. Note the `@assert.unique` per-verb is implemented as compound key `(verb, url)`.

```cds
namespace com.sap.developers.ims;

using { managed, cuid } from '@sap/cds/common';

// Source-of-truth for every shelf entry on the new homepage and verb sub-pages.
// Spec: docs/superpowers/specs/2026-06-27-639-developer-homepage-design.md §10.1
@assert.unique.verbUrl: [verb, url]
entity HomepageShelves : cuid, managed {
  verb        : String enum {
                  LEARN; BUILD; INTEGRATE; OPERATE; AI; CONNECT
                } @mandatory @assert.range;
  shelf       : String enum {
                  START_HERE; REFERENCE; TOOLS; KEEP_CURRENT
                } @mandatory @assert.range;
  sortOrder   : Integer default 100;
  title       : String(120) @mandatory;
  url         : String(500) @mandatory;
  description : String(280);
  badge       : String enum {
                  NEW; UPDATED; HIDDEN_GEM; THIRD_PARTY
                } @assert.range;
  isExternal  : Boolean default true;
  isActive    : Boolean default true;
  lastChecked : Timestamp;
  linkStatus  : String enum {
                  OK; BROKEN; SLOW; UNKNOWN
                } default 'UNKNOWN' @assert.range;
}

// Hand-curated map of legacy URLs → new URLs. Approuter fetches via
// /api/redirects/active and refreshes hourly. Spec §10.2.
@assert.unique.fromPath: [fromPath]
entity LegacyRedirects : cuid, managed {
  fromPath   : String(500) @mandatory;
  toPath     : String(500) @mandatory;
  statusCode : Integer default 301;
  isPattern  : Boolean default false;
  isActive   : Boolean default true;
  hitCount   : Integer default 0;
}

// Runtime homepage feature config (singleton). Auto-init handler in
// srv/admin-service.js inserts a default row on first read (matches the
// existing pattern for ChatSettings et al.).
// Spec §17 resolution 3.
entity HomepageConfig : cuid, managed {
  developerNewsPlaylistId : String(64);  // YouTube playlist ID for the featured Friday show
  videoBandEnabled        : Boolean default true;
  eventsBandEnabled       : Boolean default true;
  communityLaneEnabled    : Boolean default true;
}
```

- [ ] **Step 1.4 — Wire into `db/schema.cds`**

Add the import alongside the existing `using from './advocates';` line near the top of `db/schema.cds`:

```cds
using from './homepage';
```

- [ ] **Step 1.5 — Re-run the test; expect it to pass**

```bash
npx vitest run test/unit/homepage-shelves-crud.test.js
```

Expected: PASS (all 3 cases).

- [ ] **Step 1.6 — Commit**

```bash
git add db/homepage.cds db/schema.cds test/unit/homepage-shelves-crud.test.js
git commit -m "feat(#639): add HomepageShelves, LegacyRedirects, HomepageConfig CDS entities"
```

---

## Task 2 — CSV seed data

**Files:**
- Create: `db/data/com.sap.developers.ims-HomepageShelves.csv`
- Create: `db/data/com.sap.developers.ims-HomepageConfig.csv`
- Create: `db/data/com.sap.developers.ims-LegacyRedirects.csv`
- Test: `test/unit/homepage-seed.test.js`

- [ ] **Step 2.1 — Write the seed-load test**

```js
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

cds.test('serve', '--project', '.', '--in-memory');

describe('Homepage seed data', () => {
  let db;
  beforeAll(async () => { db = await cds.connect.to('db'); });

  it('loads HomepageShelves seed (>= 40 entries spanning all 6 verbs)', async () => {
    const { HomepageShelves } = db.entities('com.sap.developers.ims');
    const rows = await db.run(SELECT.from(HomepageShelves));
    expect(rows.length).toBeGreaterThanOrEqual(40);
    const verbs = new Set(rows.map(r => r.verb));
    expect(verbs).toEqual(new Set(['LEARN','BUILD','INTEGRATE','OPERATE','AI','CONNECT']));
  });

  it('loads exactly one HomepageConfig row', async () => {
    const { HomepageConfig } = db.entities('com.sap.developers.ims');
    const rows = await db.run(SELECT.from(HomepageConfig));
    expect(rows.length).toBe(1);
  });

  it('loads 3 LegacyRedirects (tutorial-navigator.html, index.html, groups.html)', async () => {
    const { LegacyRedirects } = db.entities('com.sap.developers.ims');
    const rows = await db.run(SELECT.from(LegacyRedirects));
    const froms = rows.map(r => r.fromPath).sort();
    expect(froms).toEqual(['/groups.html', '/index.html', '/tutorial-navigator.html']);
  });
});
```

- [ ] **Step 2.2 — Run test; expect FAIL (seed files do not exist)**

```bash
npx vitest run test/unit/homepage-seed.test.js
```

- [ ] **Step 2.3 — Create the seed CSV files**

Compose the HomepageShelves CSV from the inventory artifact at `docs/superpowers/specs/2026-06-27-639-homepage-sap-destination-inventory.md` §2 + spec Appendix A. Header line MUST match exactly (CSV seeds need explicit columns):

```csv
ID;verb;shelf;sortOrder;title;url;description;badge;isExternal;isActive
```

Use deterministic UUIDs of the form `66333900-0001-0001-0001-NNNNNNNNNNNN` (the `6633...` prefix is mnemonic for issue #639, the final 12 hex digits are sequential). This keeps seed inserts idempotent across redeploys.

Compose at minimum **8 entries per verb × 6 verbs = 48 rows**, distributing as:
- LEARN: tutorial navigator (start-here), Learning Journeys (start-here), "New to cloud SAP" curated path (start-here), learning.sap.com (reference), Certifications (reference), BTP free tier (tools), SAP-samples (tools), Developer News (keep-current)
- BUILD: CAP (start-here), ABAP Cloud (start-here), Fiori/UI5 (start-here), SAP Build (start-here), ui5.sap.com (reference), Cloud SDK (reference), BAS (tools), tools.hana.ondemand.com (tools), CAP community blogs (keep-current), CodeJams (keep-current)
- INTEGRATE: api.sap.com (start-here), Integration Suite (start-here), "First integration flow" tutorial (start-here), Event Mesh (reference), Destination Service (reference), ORD (reference), Project Piper (tools), Integration samples (tools)
- OPERATE: BTP Cockpit (start-here), BTP CLI (start-here), BTP getting-started (start-here), Discovery Center (reference), Kyma (reference), HANA Cloud (reference), MTA build/cf push patterns (tools), HANA-CLI (tools), BTP release notes (keep-current)
- AI: btp-ai-bp.docs.sap (start-here), skills.cloud.sap (start-here), Joule extension tutorial (start-here), Joule docs (reference), AI Core (reference), AI Launchpad (reference), AI4U (tools), RAG-on-HANA cookbook (tools)
- CONNECT: community.sap.com (start-here), @sapdevs YouTube (start-here), Devtoberfest (start-here), news.sap.com (reference), Community blogs (reference), Developer Advocates (reference), github.com/SAP (tools), SAP-samples (tools), SAP-docs PR-welcome (tools, badge=HIDDEN_GEM), TechEd (keep-current), ASUG (keep-current, badge=THIRD_PARTY), SAPinsider (keep-current, badge=THIRD_PARTY), Developer News (keep-current)

For HomepageConfig:

```csv
ID;developerNewsPlaylistId;videoBandEnabled;eventsBandEnabled;communityLaneEnabled
66333900-c0fc-0001-0001-000000000001;PLACEHOLDER_PLAYLIST_ID;true;true;true
```

For LegacyRedirects:

```csv
ID;fromPath;toPath;statusCode;isPattern;isActive
66333900-1eaa-0001-0001-000000000001;/tutorial-navigator.html;/tutorial-navigator/;301;false;true
66333900-1eaa-0001-0001-000000000002;/index.html;/;301;false;true
66333900-1eaa-0001-0001-000000000003;/groups.html;/missions/;301;false;true
```

- [ ] **Step 2.4 — Re-run test; expect PASS**

```bash
npx vitest run test/unit/homepage-seed.test.js
```

- [ ] **Step 2.5 — Commit**

```bash
git add db/data/com.sap.developers.ims-Homepage*.csv \
        db/data/com.sap.developers.ims-LegacyRedirects.csv \
        test/unit/homepage-seed.test.js
git commit -m "feat(#639): seed HomepageShelves (~48 entries), HomepageConfig, LegacyRedirects"
```

---

## Task 3 — AdminService projections + admin annotations + singleton auto-init

**Files:**
- Modify: `srv/admin-service.cds`
- Modify: `srv/admin-service.js` (auto-init handler for HomepageConfig)
- Modify: `app/admin-annotations.cds`
- Modify: `db/change-tracking.cds`
- Test: `test/unit/admin-homepage-crud.test.js`

- [ ] **Step 3.1 — Write the failing AdminService test**

```js
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

cds.test('serve', '--project', '.', '--in-memory');

describe('AdminService projections for Homepage entities', () => {
  let admin;
  beforeAll(async () => { admin = await cds.connect.to('AdminService'); });

  it('exposes HomepageShelves with full CRUD', async () => {
    const { HomepageShelves } = admin.entities;
    const list = await admin.run(SELECT.from(HomepageShelves).limit(5));
    expect(Array.isArray(list)).toBe(true);
  });

  it('exposes LegacyRedirects', async () => {
    const list = await admin.run(SELECT.from(admin.entities.LegacyRedirects));
    expect(list.length).toBeGreaterThanOrEqual(3);
  });

  it('auto-initialises HomepageConfig as a singleton on first READ', async () => {
    // Force the auto-init path: clear the seed row, then read.
    const db = await cds.connect.to('db');
    await db.run(DELETE.from(db.entities('com.sap.developers.ims').HomepageConfig));
    const row = await admin.run(SELECT.one.from(admin.entities.HomepageConfig));
    expect(row).toBeTruthy();  // auto-init returned a default
  });
});
```

- [ ] **Step 3.2 — Run test; expect FAIL ("entity not found in AdminService")**

```bash
npx vitest run test/unit/admin-homepage-crud.test.js
```

- [ ] **Step 3.3 — Add projections to `srv/admin-service.cds`**

Find a logical insertion point (alongside the existing `Alerts` projection per spec §12 cross-reference) and add:

```cds
  // Homepage redesign (#639). HomepageShelves is the source of truth for
  // shelves on / and /<verb>/. LegacyRedirects feeds the approuter's
  // dynamic redirect map. HomepageConfig is a singleton with the
  // featured-playlist ID and per-band feature flags.
  @cds.redirection.target: true
  @Capabilities.ChangeTracking : { Supported: true }
  entity HomepageShelves as projection on ims.HomepageShelves;

  @cds.redirection.target: true
  @Capabilities.ChangeTracking : { Supported: true }
  entity LegacyRedirects as projection on ims.LegacyRedirects;

  @odata.singleton
  @Capabilities.ChangeTracking : { Supported: false }
  entity HomepageConfig as projection on ims.HomepageConfig;
```

- [ ] **Step 3.4 — Add the singleton auto-init handler in `srv/admin-service.js`**

Search for the existing `before('READ', 'ChatSettings'` pattern (or whichever singleton already auto-inits) and copy its shape. Add an analogous block:

```js
// #639: HomepageConfig is a singleton; auto-init a default row on first
// READ so a fresh subaccount doesn't 404. Pattern matches ChatSettings.
this.before('READ', 'HomepageConfig', async (req) => {
  const db = await cds.connect.to('db');
  const existing = await db.run(SELECT.one.from('com.sap.developers.ims.HomepageConfig'));
  if (!existing) {
    await db.run(INSERT.into('com.sap.developers.ims.HomepageConfig').entries({
      ID: cds.utils.uuid(),
      developerNewsPlaylistId: null,
      videoBandEnabled: true,
      eventsBandEnabled: true,
      communityLaneEnabled: true
    }));
  }
});
```

- [ ] **Step 3.5 — Add @UI annotations to `app/admin-annotations.cds`**

Append at the end:

```cds
// Homepage admin tile (#639)
annotate AdminService.HomepageShelves with @(
  UI.HeaderInfo : {
    TypeName       : 'Shelf entry',
    TypeNamePlural : 'Homepage shelves',
    Title          : { Value : title }
  },
  UI.LineItem : [
    { Value : verb,        Label : 'Verb' },
    { Value : shelf,       Label : 'Shelf' },
    { Value : sortOrder,   Label : 'Order' },
    { Value : title,       Label : 'Title' },
    { Value : url,         Label : 'URL' },
    { Value : badge,       Label : 'Badge' },
    { Value : linkStatus,  Label : 'Link health',
      Criticality : #(linkStatus = 'OK' ? 3 : linkStatus = 'SLOW' ? 2 : linkStatus = 'BROKEN' ? 1 : 0) },
    { Value : isActive,    Label : 'Active' }
  ],
  UI.SelectionFields : [ verb, shelf, isActive, linkStatus ],
  UI.FieldGroup #Main : { Data : [
    { Value : verb },
    { Value : shelf },
    { Value : sortOrder },
    { Value : title },
    { Value : url },
    { Value : description },
    { Value : badge },
    { Value : isExternal },
    { Value : isActive }
  ]}
);

annotate AdminService.LegacyRedirects with @(
  UI.HeaderInfo : {
    TypeName       : 'Redirect',
    TypeNamePlural : 'Legacy redirects',
    Title          : { Value : fromPath }
  },
  UI.LineItem : [
    { Value : fromPath,   Label : 'From' },
    { Value : toPath,     Label : 'To' },
    { Value : statusCode, Label : 'Status' },
    { Value : isPattern,  Label : 'Regex?' },
    { Value : hitCount,   Label : 'Hits' },
    { Value : isActive,   Label : 'Active' }
  ],
  UI.SelectionFields : [ isActive, isPattern ]
);

annotate AdminService.HomepageConfig with @(
  UI.HeaderInfo : {
    TypeName       : 'Homepage config',
    TypeNamePlural : 'Homepage configs'
  },
  UI.FieldGroup #Main : { Data : [
    { Value : developerNewsPlaylistId, Label : 'Developer News playlist ID (YouTube)' },
    { Value : videoBandEnabled,        Label : 'Show video band' },
    { Value : eventsBandEnabled,       Label : 'Show events band' },
    { Value : communityLaneEnabled,    Label : 'Show community lane' }
  ]}
);
```

- [ ] **Step 3.6 — Annotate change-tracking in `db/change-tracking.cds`**

Per the existing "audit-material entities" section pattern:

```cds
// #639: track admin edits to homepage shelves + redirect map.
// HomepageConfig is intentionally NOT tracked — it's a config singleton
// (see issue #658 — singletons produce no-delta phantom rows).
annotate ims.HomepageShelves  with @changelog;
annotate ims.LegacyRedirects  with @changelog;
```

- [ ] **Step 3.7 — Re-run test; expect PASS**

```bash
npx vitest run test/unit/admin-homepage-crud.test.js test/unit/homepage-seed.test.js
```

- [ ] **Step 3.8 — Commit**

```bash
git add srv/admin-service.cds srv/admin-service.js app/admin-annotations.cds \
        db/change-tracking.cds test/unit/admin-homepage-crud.test.js
git commit -m "feat(#639): AdminService projections + UI annotations for Homepage entities

- Expose HomepageShelves/LegacyRedirects as full CRUD (Admin scope)
- HomepageConfig as @odata.singleton with auto-init handler
- @UI.LineItem + SelectionFields + FieldGroup on all three
- @changelog on Shelves + Redirects (singleton excluded per #658)"
```

---

## Task 4 — Admin Fiori app `app/admin/homepage/`

**Files:**
- Create: `app/admin/homepage/package.json`
- Create: `app/admin/homepage/ui5.yaml`
- Create: `app/admin/homepage/webapp/Component.js`
- Create: `app/admin/homepage/webapp/manifest.json`
- Create: `app/admin/homepage/webapp/i18n/i18n.properties`
- Modify: `app/admin-shell/webapp/manifest.json` (register component + route)
- Modify: `app/admin-shell/webapp/view/Shell.view.xml` (add side-nav entry; data-driven via nav model)
- Modify: `approuter/server.js` (add APP_MOUNTS entry for `/admin-ui/components/homepage`)

- [ ] **Step 4.1 — Scaffold the app from the `alerts` template**

The `alerts` app at `app/admin/alerts/` is the simplest existing precedent. Copy its structure verbatim, then rename:

```bash
cp -r app/admin/alerts app/admin/homepage
# Edit each file to replace "alerts"/"Alert" with "homepage"/"Homepage shelf entry"
```

Specifically rewrite identifiers in:
- `app/admin/homepage/package.json` — `name`: `sap.tutorials.admin.homepage`
- `app/admin/homepage/webapp/manifest.json` — see Step 4.2 below for the full new shape (3 routes: shelves list/OP + redirects list/OP + config OP)
- `app/admin/homepage/webapp/i18n/i18n.properties` — `appTitle=Homepage` / `appDescription=Curate the developer homepage`

- [ ] **Step 4.2 — Write the new manifest with 3 entity navigations**

Replace `app/admin/homepage/webapp/manifest.json` so its `sap.ui5.routing.routes` has six routes (list + OP for shelves and redirects, OP-only for the config singleton):

```json
"routing": {
  "routes": [
    { "pattern": ":?query:",                         "name": "ShelvesList",    "target": "ShelvesList" },
    { "pattern": "HomepageShelves({key}):?query:",   "name": "ShelfOP",        "target": "ShelfOP" },
    { "pattern": "Redirects:?query:",                "name": "RedirectsList",  "target": "RedirectsList" },
    { "pattern": "LegacyRedirects({key}):?query:",   "name": "RedirectOP",     "target": "RedirectOP" },
    { "pattern": "Config:?query:",                   "name": "ConfigOP",       "target": "ConfigOP" }
  ],
  "targets": {
    "ShelvesList":   { "type":"Component","name":"sap.fe.templates.ListReport",  "options":{"settings":{"contextPath":"/HomepageShelves","variantManagement":"Page","initialLoad":"Enabled","navigation":{"HomepageShelves":{"detail":{"route":"ShelfOP"}}}}} },
    "ShelfOP":       { "type":"Component","name":"sap.fe.templates.ObjectPage",  "options":{"settings":{"contextPath":"/HomepageShelves","editableHeaderContent":false}} },
    "RedirectsList": { "type":"Component","name":"sap.fe.templates.ListReport",  "options":{"settings":{"contextPath":"/LegacyRedirects","navigation":{"LegacyRedirects":{"detail":{"route":"RedirectOP"}}}}} },
    "RedirectOP":    { "type":"Component","name":"sap.fe.templates.ObjectPage",  "options":{"settings":{"contextPath":"/LegacyRedirects"}} },
    "ConfigOP":      { "type":"Component","name":"sap.fe.templates.ObjectPage",  "options":{"settings":{"contextPath":"/HomepageConfig"}} }
  }
}
```

- [ ] **Step 4.3 — Register the component in the admin-shell**

Read `app/admin-shell/webapp/manifest.json` to find the `componentUsages` map (around line 95 per the inspection in plan-writing). Add:

```json
"sap.app": {
  "embeddedBy": "...",
  "componentUsages": { ... }
},
"sap.ui5": {
  "componentUsages": {
    "homepageComponent": {
      "name": "sap.tutorials.admin.homepage",
      "lazy": true,
      "settings": {},
      "componentData": {}
    }
  }
}
```

…and add a matching route + target inside `sap.ui5.routing` (mirror the `alertsTarget` shape from line 367):

```json
{ "name": "homepage", "pattern": "homepage", "target": [{"name":"homepageTarget","prefix":"hp"}] }
```

```json
"homepageTarget": { "type":"Component", "usage":"homepageComponent", "id":"homepageTarget", "controlAggregation":"pages" }
```

Also add the `dataSources` entry for the component:

```json
"sap.tutorials.admin.homepage": "./components/homepage"
```

- [ ] **Step 4.4 — Add side-nav entry (data-driven)**

Read `app/admin-shell/webapp/controller/Shell.controller.js` (or whichever file populates the nav model — the inspection showed `Shell.view.xml` binds `{nav>key}`). Find the array that lists nav items and add a `homepage` entry:

```js
{ key: 'homepage', text: 'Homepage', icon: 'sap-icon://home', tooltip: 'Edit the developer-portal homepage' }
```

Group it next to `alerts` since both are "site-wide content" tiles.

- [ ] **Step 4.5 — Add the approuter mount**

In `approuter/server.js` find the `APP_MOUNTS` object (around line 145) and add:

```js
'/admin-ui/components/homepage': join(__dirname, '..', 'app', 'admin', 'homepage', 'webapp'),
```

- [ ] **Step 4.6 — Smoke-check locally**

```bash
cds watch &
# Wait for "server listening on http://localhost:4004"
node approuter/server.js &
# Open http://localhost:5000/admin-ui/#homepage in a browser, log in,
# verify the tile renders + the three sub-routes are reachable.
```

Expected: List Report shows the seeded shelves; clicking a row opens the OP; tab to Redirects shows the 3 seed entries; tab to Config shows the singleton.

- [ ] **Step 4.7 — Commit**

```bash
git add app/admin/homepage/ \
        app/admin-shell/webapp/manifest.json \
        app/admin-shell/webapp/view/Shell.view.xml \
        app/admin-shell/webapp/controller/Shell.controller.js \
        approuter/server.js
git commit -m "feat(#639): admin Fiori app for homepage shelves + redirects + config

Three nested routes (shelves list/OP, redirects list/OP, config singleton OP)
loaded as a componentUsage in admin-shell. New approuter mount at
/admin-ui/components/homepage."
```

---

## Task 5 — Hybrid test (Phase 1 closing)

**Files:**
- Create: `test/hybrid/homepage-schema.test.js`

- [ ] **Step 5.1 — Write the hybrid schema test**

```js
import { describe, it, expect } from 'vitest';
import cds from '@sap/cds';
import { guardWrites } from './_guard.js';

describe('Homepage entities — HANA schema (hybrid)', () => {
  it('HomepageShelves seed rows loaded with all 6 verbs', async () => {
    guardWrites();  // even though we only read, follows project convention
    const db = await cds.connect.to('db');
    const rows = await db.run(SELECT.from('com.sap.developers.ims.HomepageShelves'));
    expect(rows.length).toBeGreaterThanOrEqual(40);
    const verbs = new Set(rows.map(r => r.verb));
    expect(verbs).toEqual(new Set(['LEARN','BUILD','INTEGRATE','OPERATE','AI','CONNECT']));
  });

  it('LegacyRedirects.fromPath is unique (case-insensitive)', async () => {
    guardWrites();
    const db = await cds.connect.to('db');
    // case-insensitive uniqueness is enforced by HANA via UPPER index;
    // attempting to insert /TUTORIAL-NAVIGATOR.HTML must fail since
    // /tutorial-navigator.html is seeded.
    await expect(
      db.run(INSERT.into('com.sap.developers.ims.LegacyRedirects').entries({
        ID: cds.utils.uuid(),
        fromPath: '/TUTORIAL-NAVIGATOR.HTML',  // upper-case duplicate
        toPath: '/tutorial-navigator/',
        statusCode: 301
      }))
    ).rejects.toThrow();
  });

  it('HomepageConfig has exactly one row after deploy', async () => {
    const db = await cds.connect.to('db');
    const rows = await db.run(SELECT.from('com.sap.developers.ims.HomepageConfig'));
    expect(rows.length).toBe(1);
  });
});
```

- [ ] **Step 5.2 — Run hybrid; expect PASS after deploy**

```bash
# Requires cf login + ALLOW_HYBRID_WRITES=true
cds bind --exec -- npx vitest run test/hybrid/homepage-schema.test.js
```

If the seed didn't deploy because the test runs before `cds deploy`, run `npx cds bind --exec -- cds deploy --to hana --with-mocks` first.

- [ ] **Step 5.3 — Commit + PR for Phase 1**

```bash
git add test/hybrid/homepage-schema.test.js
git commit -m "test(#639): hybrid schema test for Homepage entities"
git push origin feat/639-phase1-data-model
gh pr create --title "feat(#639): Phase 1 — Homepage data model + admin app" \
  --body "Implements §10 data model + §12 admin app from the design spec.
Spec: docs/superpowers/specs/2026-06-27-639-developer-homepage-design.md
Plan: docs/superpowers/plans/2026-06-27-639-developer-homepage.md (Phase 1)

Closes nothing — kept open until Phase 4 cuts over."
```

---

# Phase 2 — HomepageService + live data fetchers

> **Branch:** `feat/639-phase2-homepage-service`. Worktree: `.claude/worktrees/639-phase2/`.
>
> **Depends on:** Phase 1 merged (HomepageShelves entity must exist).

## Task 6 — YouTube fetcher (`srv/lib/youtube-fetcher.js`)

**Files:**

- Create: `srv/lib/youtube-fetcher.js`
- Test: `test/unit/youtube-fetcher.test.js`

- [ ] **Step 6.1 — Write the failing unit test**

```js
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fetchSapDevsVideos, _resetForTests } from '../../srv/lib/youtube-fetcher.js';

beforeEach(() => { _resetForTests(); vi.restoreAllMocks(); });

describe('youtube-fetcher', () => {
  it('returns featured + recent on success', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (url.includes('playlistItems')) {
        return new Response(JSON.stringify({ items: [
          { snippet: { resourceId: { videoId: 'feat1' }, title: 'Developer News Ep 99',
            thumbnails: { high: { url: 'https://yt/feat1.jpg' } },
            publishedAt: '2026-06-26T15:00:00Z' } }
        ]}), { status: 200 });
      }
      if (url.includes('search')) {
        return new Response(JSON.stringify({ items: [
          { id: { videoId: 'r1' }, snippet: { title: 'Tech Bytes 1', thumbnails: { high: { url: 'x' } }, publishedAt: '2026-06-25T00:00:00Z' } },
          { id: { videoId: 'r2' }, snippet: { title: 'Live 2',        thumbnails: { high: { url: 'x' } }, publishedAt: '2026-06-20T00:00:00Z' } },
          { id: { videoId: 'r3' }, snippet: { title: 'Tutorial 3',    thumbnails: { high: { url: 'x' } }, publishedAt: '2026-06-15T00:00:00Z' } }
        ]}), { status: 200 });
      }
      if (url.includes('channels')) {
        return new Response(JSON.stringify({ items: [{ id: 'UC_sapdevs' }] }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    }));
    const out = await fetchSapDevsVideos({ apiKey: 'test', playlistId: 'PLxxx', channelHandle: '@sapdevs' });
    expect(out.featured.videoId).toBe('feat1');
    expect(out.recent).toHaveLength(3);
    expect(out.error).toBeNull();
  });

  it('returns error metadata on 403 (quota)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":{"code":403}}', { status: 403 })));
    const out = await fetchSapDevsVideos({ apiKey: 'test', playlistId: 'PLxxx', channelHandle: '@sapdevs' });
    expect(out.error).toMatch(/403|quota/i);
    expect(out.featured).toBeNull();
  });

  it('returns no-api-key when apiKey is empty', async () => {
    const out = await fetchSapDevsVideos({ apiKey: '', playlistId: null, channelHandle: '@sapdevs' });
    expect(out.error).toBe('no-api-key');
  });
});
```

- [ ] **Step 6.2 — Run; expect FAIL**

```bash
npx vitest run test/unit/youtube-fetcher.test.js
```

- [ ] **Step 6.3 — Implement** — see the full file in the appendix of this plan (Appendix B § Task 6 implementation). Key contract:

- Function signature: `fetchSapDevsVideos({ apiKey, playlistId, channelHandle })` → `{ featured, recent, error }`.
- 15-min TTL cache keyed on `${channelHandle}|${playlistId||''}`.
- 5s timeout per HTTP call.
- Graceful empty payload + `error` string on any failure — never throws.
- `_resetForTests()` exported for vitest.
- Module-singleton via `globalThis[Symbol.for(...)]` per `feedback_module_singletons_in_vitest_cds` memory.

- [ ] **Step 6.4 — Run; PASS. Commit.**

```bash
npx vitest run test/unit/youtube-fetcher.test.js
git add srv/lib/youtube-fetcher.js test/unit/youtube-fetcher.test.js
git commit -m "feat(#639): YouTube Data API v3 fetcher for SAPDevs band"
```

## Task 7 — Events merger (`srv/lib/homepage-events-merger.js`)

**Files:**

- Create: `srv/lib/homepage-events-merger.js`
- Test: `test/unit/homepage-events-merger.test.js`

- [ ] **Step 7.1 — Failing test** — covers: dedupe by `(normTitle, startsAt)` with local-wins; drops past events; sorts ascending; caps at limit. Pure function, no I/O — fastest test in the plan.

- [ ] **Step 7.2 — Implement pure-function `mergeEvents(local, remote, { now, limit })`** — Map-based dedupe, filter by `now`, sort by `startsAt` ascending, slice to `limit`. ~30 lines.

- [ ] **Step 7.3 — Commit**

```bash
git add srv/lib/homepage-events-merger.js test/unit/homepage-events-merger.test.js
git commit -m "feat(#639): pure-function events merger for homepage band"
```

## Task 8 — RSS fetcher (`srv/lib/homepage-rss-fetcher.js`)

**Files:**

- Create: `srv/lib/homepage-rss-fetcher.js`
- Test: `test/unit/homepage-rss-fetcher.test.js`

- [ ] **Step 8.1 — Failing test** — covers: parses items, sorts newest-first, caps at limit; returns `[]` on network error; caches within TTL.

- [ ] **Step 8.2 — Implement** — `fetchRssItems(url, { limit })` with regex-based item extraction (community.sap.com RSS is well-formed; full XML parser is overkill). 30-min TTL cache. 5s timeout. Empty array on any failure.

- [ ] **Step 8.3 — Commit**

```bash
git add srv/lib/homepage-rss-fetcher.js test/unit/homepage-rss-fetcher.test.js
git commit -m "feat(#639): minimal RSS fetcher for homepage community lane"
```

## Task 9 — HomepageService (`srv/homepage-service.cds` + `.js`)

**Files:**

- Create: `srv/homepage-service.cds`
- Create: `srv/homepage-service.js`
- Modify: `srv/server.js` (add `/build/homepage-shelves` express route alongside existing `/build/catalog`)
- Test: `test/unit/homepage-service-endpoints.test.js`

- [ ] **Step 9.1 — Failing service-shape test** — connect to `HomepageService`, send GET to `/events`, `/videos`, `/community-blogs`, `/news`, `/shelves?verb=LEARN`. Assert each returns the documented shape. The `/videos` test stubs `YOUTUBE_API_KEY=''` to exercise the no-key fallback.

- [ ] **Step 9.2 — Run; FAIL (service not found).**

- [ ] **Step 9.3 — Define `srv/homepage-service.cds`**

```cds
using { com.sap.developers.ims as ims } from '../db/schema';

@path: '/api/homepage'
service HomepageService {

  type EventCard   { title: String; startsAt: Timestamp; location: String; format: String; register: String; }
  type VideoItem   { videoId: String; title: String; thumbnail: String; publishedAt: Timestamp; }
  type VideoPayload { featured: VideoItem; recent: array of VideoItem; error: String; }
  type RssItem     { title: String; link: String; publishedAt: Timestamp; description: String; }
  type ShelfItem   { ID: UUID; verb: String; shelf: String; sortOrder: Integer; title: String;
                     url: String; description: String; badge: String; isExternal: Boolean; }

  function events()              returns array of EventCard;
  function videos()              returns VideoPayload;
  function communityBlogs()      returns array of RssItem;
  function news()                returns array of RssItem;
  function shelves(verb: String) returns array of ShelfItem;
}
```

- [ ] **Step 9.4 — Implement `srv/homepage-service.js`** — class extends `cds.ApplicationService`; in `init()` register `on()` handlers for each function:

- `events()`: select `Events` from DB where `startsAt >= now`, pass into `mergeEvents()` with optional `globalThis.__sapDevsEvents__` as remote source (test-injectable). 60s cache.
- `videos()`: read `HomepageConfig` for `developerNewsPlaylistId` + `videoBandEnabled` flag. If disabled, return `{ featured: null, recent: [], error: 'disabled' }`. Otherwise call `fetchSapDevsVideos` with `await resolveSecret('YOUTUBE_API_KEY')` from `srv/lib/secret-resolver.js`.
- `communityBlogs()`: `fetchRssItems('https://community.sap.com/t5/s/Y09vMI/rss/Community?interaction.style=blog', { limit: 3 })`. Verify the URL with `curl` during step 9.5 — if community.sap.com's RSS lives at a different path, update the constant. Fallback to no-blog-band on persistent 404 (already handled by `fetchRssItems` returning `[]`).
- `news()`: `fetchRssItems('https://news.sap.com/feed/', { limit: 2 })`.
- `shelves(verb)`: `SELECT.from(HomepageShelves).where({ isActive: true, verb? }).orderBy('verb','shelf','sortOrder')`. 5-min cache keyed by verb.

- [ ] **Step 9.5 — Smoke-check the RSS URL**

```bash
curl -sI 'https://community.sap.com/t5/s/Y09vMI/rss/Community?interaction.style=blog' | head -1
```

If not 200, search community.sap.com's "Subscribe" affordances for the correct RSS URL and update the constant. Fallback acceptable: hardcode a few editorially-curated blog posts in `HomepageShelves` under verb=CONNECT, shelf=KEEP_CURRENT.

- [ ] **Step 9.6 — Add `/build/homepage-shelves` to `srv/server.js`**

Find the `cds.on('bootstrap'` block (look for existing `/build/catalog` or `/health` route registration). Add alongside:

```js
app.get('/build/homepage-shelves', async (_req, res) => {
  const db = await cds.connect.to('db');
  const rows = await db.run(SELECT.from('com.sap.developers.ims.HomepageShelves')
    .where({ isActive: true })
    .orderBy('verb', 'shelf', 'sortOrder'));
  res.set('Cache-Control', 'public, max-age=60');
  res.json({ shelves: rows, buildAt: new Date().toISOString() });
});
```

- [ ] **Step 9.7 — Run all unit tests; expect PASS**

```bash
npx vitest run test/unit/homepage-service-endpoints.test.js \
                test/unit/youtube-fetcher.test.js \
                test/unit/homepage-events-merger.test.js \
                test/unit/homepage-rss-fetcher.test.js
```

- [ ] **Step 9.8 — Commit**

```bash
git add srv/homepage-service.cds srv/homepage-service.js srv/server.js \
        test/unit/homepage-service-endpoints.test.js
git commit -m "feat(#639): HomepageService (/api/homepage/*) + /build/homepage-shelves"
```

## Task 10 — Wire YOUTUBE_API_KEY into deploy descriptors

**Files:** `mta.yaml`, `deploy/dev.mtaext`, `deploy/qa.mtaext`, `deploy/prod.mtaext`, `.deploy/mta.yaml`

- [ ] **Step 10.1 — Declare env var on `tutorials-srv` and `tutorials-srv-qa`** in `mta.yaml`, alongside `CONTENT_API_KEY: ""`:

```yaml
      YOUTUBE_API_KEY: ""
```

Per memory `feedback_mtaext_envsubst_empty_quote_required`: must be literal `""`, not bare empty.

- [ ] **Step 10.2 — Add `YOUTUBE_API_KEY: ${YOUTUBE_API_KEY}` to all 3 mtaext files** under each module's `properties:`.

- [ ] **Step 10.3 — Add 3 new files to srv-qa cp list** in `.deploy/mta.yaml`:

```
../../srv/lib/youtube-fetcher.js \
../../srv/lib/homepage-events-merger.js \
../../srv/lib/homepage-rss-fetcher.js \
```

- [ ] **Step 10.4 — Run the drift check**

```bash
node scripts/check-srv-qa-cp-list.ts
```

Expected: PASS.

- [ ] **Step 10.5 — Commit + PR**

```bash
git add mta.yaml deploy/*.mtaext .deploy/mta.yaml
git commit -m "build(#639): wire YOUTUBE_API_KEY + srv-qa cp list for Phase 2"
git push origin feat/639-phase2-homepage-service
gh pr create --title "feat(#639): Phase 2 — HomepageService + live data fetchers" \
  --body "Spec §11. Depends on Phase 1."
```

---

# Phase 3 — Legacy redirects (dynamic + catch-all)

> **Branch:** `feat/639-phase3-redirects`. Worktree: `.claude/worktrees/639-phase3/`.
>
> **Depends on:** Phase 1 (LegacyRedirects entity) + Phase 2 (`/api/homepage` namespace, though redirects get their own `/api/redirects/*` namespace — see below).

## Task 12 — Pure-function redirect resolver (`srv/lib/legacy-redirects-resolver.js`)

**Files:**

- Create: `srv/lib/legacy-redirects-resolver.js`
- Test: `test/unit/legacy-redirects-resolver.test.js`

- [ ] **Step 12.1 — Failing test**

```js
import { describe, it, expect } from 'vitest';
import { resolveRedirect, buildIndex } from '../../srv/lib/legacy-redirects-resolver.js';

const FIXTURES = [
  { id: 'r1', fromPath: '/tutorial-navigator.html', toPath: '/tutorial-navigator/', statusCode: 301, isPattern: false, isActive: true },
  { id: 'r2', fromPath: '/index.html',              toPath: '/',                    statusCode: 301, isPattern: false, isActive: true },
  { id: 'r3', fromPath: '^/topics/([^/]+)\\.html$', toPath: '/tags/$1/',            statusCode: 301, isPattern: true,  isActive: true },
  { id: 'r4', fromPath: '/old-disabled.html',       toPath: '/new/',                statusCode: 301, isPattern: false, isActive: false }
];

describe('resolveRedirect', () => {
  const idx = buildIndex(FIXTURES);

  it('matches exact path (case-insensitive)', () => {
    expect(resolveRedirect(idx, '/Tutorial-Navigator.html')).toEqual({
      id: 'r1', toPath: '/tutorial-navigator/', statusCode: 301
    });
  });

  it('matches regex pattern and substitutes capture groups', () => {
    expect(resolveRedirect(idx, '/topics/cap.html')).toEqual({
      id: 'r3', toPath: '/tags/cap/', statusCode: 301
    });
  });

  it('skips inactive entries', () => {
    expect(resolveRedirect(idx, '/old-disabled.html')).toBeNull();
  });

  it('returns null on no match', () => {
    expect(resolveRedirect(idx, '/nothing-here')).toBeNull();
  });

  it('preserves query string when target does not include one', () => {
    expect(resolveRedirect(idx, '/index.html?utm=foo')).toEqual({
      id: 'r2', toPath: '/?utm=foo', statusCode: 301
    });
  });
});
```

- [ ] **Step 12.2 — Run; FAIL.**

```bash
npx vitest run test/unit/legacy-redirects-resolver.test.js
```

- [ ] **Step 12.3 — Implement** — split the index into `exactMap: Map<lowercased-path, redirect>` and `patterns: Array<{regex, redirect}>` for O(1) exact lookups + O(n) pattern walk. Append query strings from the inbound URL to `toPath` unless `toPath` already has `?`. ~50 lines.

- [ ] **Step 12.4 — Run; PASS. Commit.**

```bash
git add srv/lib/legacy-redirects-resolver.js test/unit/legacy-redirects-resolver.test.js
git commit -m "feat(#639): pure-function legacy-redirects resolver"
```

## Task 13 — `/api/redirects/active` + `/api/redirects/hits` endpoints

**Files:**

- Modify: `srv/homepage-service.cds` (add `redirectsActive` function + `recordRedirectHits` action)
- Modify: `srv/homepage-service.js` (implement handlers)
- Test: `test/unit/redirects-endpoints.test.js`

- [ ] **Step 13.1 — Failing test**

```js
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

cds.test('serve', '--project', '.', '--in-memory');

describe('Redirect endpoints', () => {
  let svc;
  beforeAll(async () => { svc = await cds.connect.to('HomepageService'); });

  it('GET /redirects/active returns active rows only', async () => {
    const rows = await svc.send({ method: 'GET', path: '/redirectsActive' });
    expect(rows.every(r => r.isActive === undefined || r.isActive === true)).toBe(true);
    expect(rows.length).toBeGreaterThanOrEqual(3);  // 3 seed rows
  });

  it('POST /recordRedirectHits increments hitCount', async () => {
    const db = await cds.connect.to('db');
    const before = await db.run(SELECT.one.from('com.sap.developers.ims.LegacyRedirects')
      .where`fromPath = '/index.html'`);
    await svc.send({
      method: 'POST',
      path: '/recordRedirectHits',
      data: { hits: [{ id: before.ID, count: 7 }] }
    });
    const after = await db.run(SELECT.one.from('com.sap.developers.ims.LegacyRedirects')
      .where`fromPath = '/index.html'`);
    expect(after.hitCount).toBe(before.hitCount + 7);
  });
});
```

- [ ] **Step 13.2 — Run; FAIL.**

- [ ] **Step 13.3 — Add operations to `srv/homepage-service.cds`**

Append inside `service HomepageService { ... }`:

```cds
  type RedirectRow {
    ID         : UUID;
    fromPath   : String;
    toPath     : String;
    statusCode : Integer;
    isPattern  : Boolean;
  }

  type HitEntry { id: UUID; count: Integer; }

  // Approuter fetches this hourly to refresh its in-memory redirect map.
  function redirectsActive() returns array of RedirectRow;

  // Approuter batches hit counters and flushes every 60s.
  action recordRedirectHits(hits: array of HitEntry) returns Integer;
```

- [ ] **Step 13.4 — Implement handlers in `srv/homepage-service.js`**

In `init()`:

```js
this.on('redirectsActive', async () => {
  const db = await cds.connect.to('db');
  return db.run(SELECT.from('com.sap.developers.ims.LegacyRedirects')
    .where({ isActive: true })
    .columns('ID', 'fromPath', 'toPath', 'statusCode', 'isPattern'));
});

this.on('recordRedirectHits', async (req) => {
  const hits = Array.isArray(req.data?.hits) ? req.data.hits : [];
  if (hits.length === 0) return 0;
  const db = await cds.connect.to('db');
  // Single UPDATE per row; the volume is tiny (1 flush/min/instance × ~10 ids max).
  let updated = 0;
  for (const { id, count } of hits) {
    if (!id || !Number.isFinite(count) || count <= 0) continue;
    await db.run(`UPDATE com_sap_developers_ims_LegacyRedirects
                   SET hitCount = COALESCE(hitCount, 0) + ?
                   WHERE ID = ?`, [count, id]);
    updated++;
  }
  return updated;
});
```

- [ ] **Step 13.5 — Run; PASS. Commit.**

```bash
git add srv/homepage-service.cds srv/homepage-service.js test/unit/redirects-endpoints.test.js
git commit -m "feat(#639): /api/homepage/redirectsActive + recordRedirectHits"
```

## Task 14 — Approuter dynamic-redirects loader

**Files:**

- Create: `approuter/lib/legacy-redirects-loader.js`
- Create: `approuter/lib/hit-counter.js`
- Modify: `approuter/server.js` (replace the static `LEGACY_REDIRECTS` array + `redirectsHandler`; add catch-all `*.html` middleware; wire hit counter)
- Modify: `.deploy/mta.yaml` (approuter cp list — but approuter copies the whole `approuter/` tree, so likely no change; verify)
- Test: hybrid test only (this is integration code) — `test/hybrid/approuter-redirects.test.js`

- [ ] **Step 14.1 — Implement `approuter/lib/legacy-redirects-loader.js`** (no test — covered by Task 12's resolver tests + Task 14.5 hybrid test)

```js
// Fetches /api/homepage/redirectsActive from the srv app at startup, then
// hourly. Falls back to a bundled minimal map on first-boot fetch failure
// so a broken srv never breaks user-facing redirects.
// Spec §9.3 + §17 resolution 6.
const { buildIndex } = require('../../srv/lib/legacy-redirects-resolver.js');

const REFRESH_MS = 60 * 60 * 1000;  // 1 hour
const TIMEOUT_MS = 5000;

const BOOTSTRAP_MAP = [
  // Fallback if srv is unreachable on first boot — keeps the 3 named seed
  // redirects working even if /api/homepage/redirectsActive 503s.
  { id: 'b1', fromPath: '/tutorial-navigator.html', toPath: '/tutorial-navigator/', statusCode: 301, isPattern: false, isActive: true },
  { id: 'b2', fromPath: '/index.html',              toPath: '/',                    statusCode: 301, isPattern: false, isActive: true },
  { id: 'b3', fromPath: '/groups.html',             toPath: '/missions/',           statusCode: 301, isPattern: false, isActive: true }
];

let _index = buildIndex(BOOTSTRAP_MAP);

async function refresh(srvUrl, logger = console) {
  try {
    const res = await fetch(`${srvUrl}/api/homepage/redirectsActive`, {
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const rows = await res.json();
    if (!Array.isArray(rows)) throw new Error('not an array');
    _index = buildIndex(rows.map(r => ({ ...r, isActive: true })));
    logger.log?.(`[redirects-loader] refreshed ${rows.length} entries`);
  } catch (err) {
    logger.warn?.(`[redirects-loader] refresh failed: ${err.message}; keeping last good index`);
  }
}

function getIndex() { return _index; }

function startAutoRefresh(srvUrl, logger) {
  refresh(srvUrl, logger);  // immediate
  setInterval(() => refresh(srvUrl, logger), REFRESH_MS).unref();
}

module.exports = { refresh, getIndex, startAutoRefresh };
```

- [ ] **Step 14.2 — Implement `approuter/lib/hit-counter.js`**

```js
// In-memory hit counter + 60s batched flush to srv. Resilient to lost
// counts on restart (acceptable per §17 resolution 6).
const FLUSH_MS = 60_000;
const TIMEOUT_MS = 3000;

let _counts = new Map();

function bump(id) {
  if (!id) return;
  _counts.set(id, (_counts.get(id) || 0) + 1);
}

async function flush(srvUrl, logger = console) {
  if (_counts.size === 0) return;
  const hits = [...this?._counts?.entries?.() || _counts.entries()].map(([id, count]) => ({ id, count }));
  _counts = new Map();
  try {
    await fetch(`${srvUrl}/api/homepage/recordRedirectHits`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hits }),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
  } catch (err) {
    logger.warn?.(`[hit-counter] flush failed (${err.message}); ${hits.length} counts lost`);
  }
}

function startAutoFlush(srvUrl, logger) {
  setInterval(() => flush(srvUrl, logger), FLUSH_MS).unref();
}

module.exports = { bump, flush, startAutoFlush };
```

- [ ] **Step 14.3 — Replace `LEGACY_REDIRECTS` and `redirectsHandler` in `approuter/server.js`**

Delete lines 118–138 (the static array + handler). Add at the top of the file, after the existing requires:

```js
const { getIndex, startAutoRefresh } = require('./lib/legacy-redirects-loader')
const { bump, startAutoFlush } = require('./lib/hit-counter')
const { resolveRedirect } = require('../srv/lib/legacy-redirects-resolver.js')
const fs = require('fs')

// srv-api URL: in CF it's a bound service via VCAP_SERVICES; locally it's localhost:4004.
function srvUrlFromVcap() {
  try {
    const v = JSON.parse(process.env.VCAP_SERVICES || '{}')
    const dest = (v['destination'] || []).find(d => d.credentials?.destinations?.some?.(x => x.Name === 'srv-api'))
    // fallback to standard CF user-provided binding
  } catch {}
  return process.env.SRV_API_URL || 'http://localhost:4004'
}

const SRV_URL = srvUrlFromVcap()
startAutoRefresh(SRV_URL)
startAutoFlush(SRV_URL)

// Conservative *.html catch-all: 301 to */ only if Hugo emitted a static
// target. Spec §17 resolution 1.
const STATIC_DIR_ABS = join(__dirname, 'static')
function hugoTargetExists(path) {
  // path looks like '/foo/' — we look for static/foo/index.html
  const rel = path.replace(/^\/+/, '').replace(/\/+$/, '/')
  const candidate = join(STATIC_DIR_ABS, rel, 'index.html')
  return existsSync(candidate)
}

function legacyRedirectsHandler(req, res, next) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next()
  const url = req.url || '/'
  const idx = getIndex()
  const hit = resolveRedirect(idx, url)
  if (hit) {
    bump(hit.id)
    res.writeHead(hit.statusCode || 301, {
      Location: hit.toPath,
      'Cache-Control': 'public, max-age=86400'
    })
    res.end()
    return
  }
  // Catch-all *.html → */ if the slug-folder exists in Hugo output
  const m = url.match(/^(\/[^?#]*?)\.html(\?.*)?$/i)
  if (m) {
    const candidate = m[1] + '/'  // /foo.html → /foo/
    if (hugoTargetExists(candidate)) {
      res.writeHead(301, {
        Location: candidate + (m[2] || ''),
        'Cache-Control': 'public, max-age=86400'
      })
      res.end()
      return
    }
  }
  next()
}
```

Replace the `extensions.insertMiddleware.first` line `{ path: '/', handler: redirectsHandler }` with `{ path: '/', handler: legacyRedirectsHandler }`.

- [ ] **Step 14.4 — Local smoke check**

```bash
cd D:/projects/tutorials-poc
cds watch &  # srv on 4004
node approuter/server.js &  # approuter on 5000
sleep 3
curl -sI http://localhost:5000/tutorial-navigator.html | head -2
# Expected: HTTP/1.1 301 / Location: /tutorial-navigator/

curl -sI http://localhost:5000/index.html | head -2
# Expected: HTTP/1.1 301 / Location: /

curl -sI http://localhost:5000/nonexistent.html | head -2
# Expected: HTTP/1.1 404 (catch-all doesn't fire — no Hugo target)

curl -sI http://localhost:5000/groups.html | head -2
# Expected: HTTP/1.1 301 / Location: /missions/

curl -s http://localhost:5000/api/homepage/redirectsActive | head -1
# Expected: JSON array
```

- [ ] **Step 14.5 — Hybrid test (admin edits live-propagate)**

```js
// test/hybrid/approuter-redirects.test.js
import { describe, it, expect } from 'vitest';
import cds from '@sap/cds';
import { refresh, getIndex } from '../../approuter/lib/legacy-redirects-loader.js';
import { resolveRedirect } from '../../srv/lib/legacy-redirects-resolver.js';
import { guardWrites } from './_guard.js';

describe('Legacy redirects hot-reload (hybrid)', () => {
  it('newly inserted active redirect is picked up after refresh()', async () => {
    guardWrites();
    const db = await cds.connect.to('db');
    const id = cds.utils.uuid();
    await db.run(INSERT.into('com.sap.developers.ims.LegacyRedirects').entries({
      ID: id,
      fromPath: '/__test_hot_reload__.html',
      toPath: '/',
      statusCode: 301,
      isPattern: false,
      isActive: true
    }));

    try {
      const srvUrl = process.env.SMOKE_SRV_URL || 'http://localhost:4004';
      await refresh(srvUrl);
      expect(resolveRedirect(getIndex(), '/__test_hot_reload__.html')).toEqual(
        expect.objectContaining({ toPath: '/' })
      );
    } finally {
      await db.run(DELETE.from('com.sap.developers.ims.LegacyRedirects').where({ ID: id }));
    }
  });
});
```

- [ ] **Step 14.6 — Commit + PR**

```bash
git add approuter/lib/legacy-redirects-loader.js approuter/lib/hit-counter.js \
        approuter/server.js test/hybrid/approuter-redirects.test.js
git commit -m "feat(#639): dynamic legacy redirects + conservative *.html catch-all

- approuter/lib/legacy-redirects-loader.js fetches /api/homepage/redirectsActive
  hourly; bootstraps with 3 hardcoded named redirects so first boot survives
  srv unavailability
- approuter/lib/hit-counter.js batches hit counts, flushes every 60s
- approuter/server.js: replaces static LEGACY_REDIRECTS, adds conservative
  *.html → */ catch-all that requires a Hugo target to exist
- Hot-reload covered by hybrid test"
git push origin feat/639-phase3-redirects
gh pr create --title "feat(#639): Phase 3 — Dynamic legacy redirects" \
  --body "Spec §9.3. Depends on Phase 1 (LegacyRedirects entity) + Phase 2 (HomepageService)."
```

---

# Phase 4 — New homepage + verb sub-pages (the cutover)

> **Branch:** `feat/639-phase4-homepage-cutover`. Worktree: `.claude/worktrees/639-phase4/`.
>
> **Depends on:** Phase 1 (entities) + Phase 2 (HomepageService) + Phase 3 (redirects).
>
> **This is the user-visible cutover.** After this PR merges, `/` serves the new homepage and `/tutorial-navigator/` serves what `/` served before. Per spec §15: hard cutover, no opt-in flag.

## Task 15 — Hugo build-time shelves fetcher

**Files:**

- Create: `scripts/fetch-homepage-shelves.ts`
- Modify: `scripts/fetch-tutorials.ts` (call the new fetcher near the end of `main()`)
- Modify: `package.json` (add `fetch-homepage-shelves` script + chain into `build:all`)

- [ ] **Step 15.1 — Implement `scripts/fetch-homepage-shelves.ts`**

```ts
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const CAP_BASE = process.env.CAP_BASE_URL || 'http://localhost:4004';
const OUT_PATH = join('hugo', 'data', 'homepage_shelves.json');

async function main() {
  let payload = { shelves: [], buildAt: new Date().toISOString(), error: null as string | null };
  try {
    const res = await fetch(`${CAP_BASE}/build/homepage-shelves`);
    if (!res.ok) throw new Error(`status ${res.status}`);
    payload = await res.json();
  } catch (err: any) {
    payload.error = err.message;
    console.warn(`[fetch-homepage-shelves] WARN: ${err.message} — writing empty payload`);
  }
  mkdirSync(join('hugo', 'data'), { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(payload, null, 2), 'utf-8');
  console.log(`[fetch-homepage-shelves] wrote ${payload.shelves?.length ?? 0} shelves to ${OUT_PATH}`);
}

main().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 15.2 — Add npm script**

In `package.json` `scripts`:

```json
"fetch-homepage-shelves": "tsx scripts/fetch-homepage-shelves.ts"
```

Chain into `build:all` after `fetch-tutorials` (the existing chain):

```json
"build:all": "npm run fetch-tutorials && npm run fetch-homepage-shelves && ..."
```

- [ ] **Step 15.3 — Smoke check locally**

```bash
cds watch &
npm run fetch-homepage-shelves
cat hugo/data/homepage_shelves.json | head
```

Expected: JSON with `shelves` array containing seed entries.

- [ ] **Step 15.4 — Commit**

```bash
git add scripts/fetch-homepage-shelves.ts package.json
git commit -m "build(#639): fetch homepage shelves into hugo/data/ at build time"
```

## Task 16 — Hugo content stubs (homepage + 6 verbs + relocated tutorial-navigator)

**Files:**

- Modify: `hugo/content/_index.md` (replace with new front matter for the homepage)
- Create: `hugo/content/learn/_index.md`
- Create: `hugo/content/build/_index.md`
- Create: `hugo/content/integrate/_index.md`
- Create: `hugo/content/operate/_index.md`
- Create: `hugo/content/ai/_index.md`
- Create: `hugo/content/connect/_index.md`
- Create: `hugo/content/tutorial-navigator/_index.md` (the relocated current homepage)

- [ ] **Step 16.1 — Replace `hugo/content/_index.md`**

```yaml
---
title: "SAP Developers"
description: "Everything you need to build on SAP — tutorials, docs, APIs, and community in one place."
type: "homepage"
layout: "index"
sitemap:
  priority: 1.0
  changefreq: "daily"
---
```

- [ ] **Step 16.2 — Create 6 verb stubs**

For each verb (`learn`, `build`, `integrate`, `operate`, `ai`, `connect`), write `hugo/content/<verb>/_index.md`:

```yaml
---
title: "Learn"  # or Build, Integrate, Operate, Extend with AI, Connect
description: "<one-line tagline from spec §7>"
type: "verb"
layout: "list"
verbKey: "LEARN"  # or BUILD, INTEGRATE, OPERATE, AI, CONNECT
sitemap:
  priority: 0.9
  changefreq: "weekly"
---
```

Per spec §17 resolution 2, three verbs get an extra section flagged in front matter:

- `learn`: add `extraSection: "curated-paths"` to render multi-tutorial missions as a "Curated paths" block.
- `operate`: add `extraSection: "btp-service-catalog"` to render a single hero link to Discovery Center.
- `connect`: add `extraSection: "events-calendar"` to render a full events list (vs. the homepage band's 3-4 next-up).

- [ ] **Step 16.3 — Create `hugo/content/tutorial-navigator/_index.md`**

```yaml
---
title: "Tutorial navigator"
description: "Browse 1,400+ SAP developer tutorials. Filter by topic, role, level, and time."
type: "tutorial-navigator"
layout: "list"
sitemap:
  priority: 0.95
  changefreq: "daily"
---
```

- [ ] **Step 16.4 — Commit**

```bash
git add hugo/content/_index.md hugo/content/learn hugo/content/build \
        hugo/content/integrate hugo/content/operate hugo/content/ai \
        hugo/content/connect hugo/content/tutorial-navigator
git commit -m "feat(#639): Hugo content stubs for homepage + 6 verbs + relocated navigator"
```

## Task 17 — Layout: relocate current `index.html` → `tutorial-navigator/list.html`

**Files:**

- Rename: `hugo/layouts/index.html` → `hugo/layouts/tutorial-navigator/list.html`
- The new `hugo/layouts/index.html` is created in Task 18.

- [ ] **Step 17.1 — Move + verify**

```bash
mkdir -p hugo/layouts/tutorial-navigator
git mv hugo/layouts/index.html hugo/layouts/tutorial-navigator/list.html
```

Open the moved file. Most logic is portable as-is — it expects `.Site.Data.browse` (still populated by fetch-tutorials.ts) and renders the Vue navigator. **Edit the file:** find any literal `/browse/` or links that assumed it was the root page; update to reflect that this page now lives at `/tutorial-navigator/`. Specifically the existing "Try the new browse layout" pill is fine (still links to `/browse/`).

- [ ] **Step 17.2 — Build + verify**

```bash
npm run dev &
sleep 5
curl -s http://localhost:1313/tutorial-navigator/ | grep -c 'tutorial-navigator\|navigator-grid'
# Expected: ≥ 1
```

- [ ] **Step 17.3 — Commit**

```bash
git add hugo/layouts/tutorial-navigator/list.html
git commit -m "refactor(#639): relocate tutorial-navigator layout to /tutorial-navigator/"
```

## Task 18 — Layout: new homepage `hugo/layouts/index.html`

**Files:**

- Create: `hugo/layouts/index.html`
- Create: `hugo/layouts/partials/homepage/hero.html`
- Create: `hugo/layouts/partials/homepage/verb-spine.html`
- Create: `hugo/layouts/partials/homepage/events-band.html`
- Create: `hugo/layouts/partials/homepage/video-band.html`
- Create: `hugo/layouts/partials/homepage/tutorials-teaser.html`
- Create: `hugo/layouts/partials/homepage/community-lane.html`
- Create: `hugo/layouts/partials/homepage/directory-footer.html`
- Create: `hugo/assets/css/homepage.css`

- [ ] **Step 18.1 — Create the homepage shell `hugo/layouts/index.html`**

```html
{{ define "main" }}
{{- /* Spec §6 page anatomy: 7 rows. Live data (events, videos, community
       blogs, news) hydrates via Vue islands at /js/homepage-bands.js. Shelves
       come from hugo/data/homepage_shelves.json baked at build time. */ -}}
{{- $shelves := (.Site.Data.homepage_shelves.shelves) | default slice -}}

<article class="developer-homepage">
  {{ partial "homepage/hero.html" . }}
  {{ partial "homepage/verb-spine.html" (dict "shelves" $shelves) }}
  {{ partial "homepage/events-band.html" . }}
  {{ partial "homepage/video-band.html" . }}
  {{ partial "homepage/tutorials-teaser.html" . }}
  {{ partial "homepage/community-lane.html" . }}
  {{ partial "homepage/directory-footer.html" (dict "shelves" $shelves) }}
</article>

{{ $css := resources.Get "css/homepage.css" }}
<link rel="stylesheet" href="{{ $css.RelPermalink }}">
<script type="module" src="/js/homepage-bands.js?v={{ now.Unix }}"></script>
{{ end }}
```

- [ ] **Step 18.2 — Create each partial**

Per spec §6, each partial implements one row:

**`hero.html`** — single `<section class="hp-hero">` with `<h1>` (page title from front matter) and `<p>` (description). No CTA buttons. No search bar.

**`verb-spine.html`** — `<nav class="hp-verbs">` with 6 `<a>` tiles to `/learn/`, `/build/`, `/integrate/`, `/operate/`, `/ai/`, `/connect/`. Each tile shows verb label + icon + a 3-up preview of START_HERE shelf items for that verb (computed by filtering `$shelves` in the partial).

**`events-band.html`** — `<section id="hp-events" data-island="events">` empty placeholder; the Vue `EventsBand` island fetches `/api/homepage/events` on mount.

**`video-band.html`** — `<section id="hp-videos" data-island="videos">` placeholder; `VideoBand` Vue island handles it.

**`tutorials-teaser.html`** — read `.Site.Data.browse.featured` (already populated by `fetch-tutorials.ts`); render 6-8 cards using the same `browse/_partials/card-tutorial.html` partials. Link "Browse all tutorials →" to `/tutorial-navigator/`.

**`community-lane.html`** — `<section id="hp-community" data-island="community">` with three columns. `CommunityLane` Vue island fetches `/api/advocates`, `/api/homepage/community-blogs`, `/api/homepage/news` in parallel.

**`directory-footer.html`** — pure Hugo, no JS. Group `$shelves` by verb (using `where` and `groupBy`), render 6 columns, list every active entry. Plus utility links (privacy, accessibility, GitHub) and the footer-only sap.com door: `<a href="https://www.sap.com">SAP corporate site →</a>`.

- [ ] **Step 18.3 — Author `hugo/assets/css/homepage.css`**

Use Horizon CSS tokens (per project precedent: see `2026-06-22-devtoberfest-homepage-design.md`). Skeleton:

```css
.developer-homepage { display: flex; flex-direction: column; gap: 3rem; max-width: 1200px; margin: 0 auto; padding: 2rem 1rem; }
.hp-hero { padding: 2.5rem 0; text-align: center; }
.hp-hero h1 { font-size: 2.5rem; font-weight: 600; color: var(--sapTextColor); }
.hp-hero p { font-size: 1.125rem; color: var(--sapContent_LabelColor); max-width: 720px; margin: 1rem auto 0; }
.hp-verbs { display: grid; grid-template-columns: repeat(6, 1fr); gap: 0.75rem; }
@media (max-width: 900px) { .hp-verbs { grid-template-columns: repeat(2, 1fr); } }
.hp-verb { padding: 1rem; border: 1px solid var(--sapList_BorderColor); border-radius: 8px; background: var(--sapList_Background); text-decoration: none; color: inherit; transition: transform 0.15s, box-shadow 0.15s; }
.hp-verb:hover { transform: translateY(-2px); box-shadow: 0 4px 12px rgba(0,0,0,0.08); }
.hp-verb__label { font-weight: 600; font-size: 1.1rem; margin-bottom: 0.5rem; }
.hp-verb__preview { font-size: 0.85rem; color: var(--sapContent_LabelColor); }
/* Bands: events, video, community, directory — each is a <section> with --hp-band-bg */
.hp-band { padding: 1.5rem; border-radius: 8px; background: var(--sapList_HeaderBackground); }
.hp-band__title { font-size: 1.5rem; font-weight: 600; margin-bottom: 1rem; }
.hp-directory { display: grid; grid-template-columns: repeat(6, 1fr); gap: 1.5rem; padding: 2rem 1rem; border-top: 1px solid var(--sapList_BorderColor); margin-top: 3rem; }
@media (max-width: 900px) { .hp-directory { grid-template-columns: repeat(2, 1fr); } }
.hp-directory__col h3 { font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--sapContent_LabelColor); margin-bottom: 0.75rem; }
.hp-directory__col ul { list-style: none; padding: 0; margin: 0; }
.hp-directory__col li { margin-bottom: 0.4rem; }
.hp-directory__col a { color: var(--sapLinkColor); text-decoration: none; font-size: 0.9rem; }
.hp-directory__col a:hover { text-decoration: underline; }
```

- [ ] **Step 18.4 — Smoke check locally**

```bash
npm run fetch-tutorials  # repopulate browse data if cleared
npm run fetch-homepage-shelves
npm run dev &
sleep 5
curl -s http://localhost:1313/ | head -50
# Expected: see <article class="developer-homepage"> + verb tiles, no Vue island errors
```

- [ ] **Step 18.5 — Commit**

```bash
git add hugo/layouts/index.html hugo/layouts/partials/homepage hugo/assets/css/homepage.css
git commit -m "feat(#639): new homepage layout + 7 row partials + CSS"
```

## Task 19 — Verb sub-page layout `hugo/layouts/verb/list.html`

**Files:**

- Create: `hugo/layouts/verb/list.html`

- [ ] **Step 19.1 — Implement**

```html
{{ define "main" }}
{{- $verbKey := .Params.verbKey -}}
{{- $allShelves := (.Site.Data.homepage_shelves.shelves) | default slice -}}
{{- $verbShelves := where $allShelves "verb" $verbKey -}}

<article class="verb-page" data-verb="{{ $verbKey | lower }}">
  <header class="verb-page__hero">
    <h1>{{ .Title }}</h1>
    <p>{{ .Description }}</p>
  </header>

  {{- /* Four shelves in fixed order. */ -}}
  {{ range $shelfKey := slice "START_HERE" "REFERENCE" "TOOLS" "KEEP_CURRENT" }}
    {{- $items := where $verbShelves "shelf" $shelfKey -}}
    {{- if gt (len $items) 0 -}}
    <section class="verb-shelf verb-shelf--{{ $shelfKey | lower }}">
      <h2>{{ index (dict "START_HERE" "Start here" "REFERENCE" "Reference" "TOOLS" "Tools & samples" "KEEP_CURRENT" "Keep current") $shelfKey }}</h2>
      <ul class="verb-shelf__list">
        {{ range sort $items "sortOrder" }}
        <li>
          <a href="{{ .url }}" {{ if .isExternal }}target="_blank" rel="noopener"{{ end }}>
            <strong>{{ .title }}</strong>
            {{- if .badge }} <span class="badge badge--{{ .badge | lower }}">{{ .badge }}</span>{{ end -}}
            {{- if .description }}<p>{{ .description }}</p>{{ end -}}
          </a>
        </li>
        {{ end }}
      </ul>
    </section>
    {{- end -}}
  {{ end }}

  {{- /* Spec §17 resolution 2: 3 of 6 verbs get one extra section. */ -}}
  {{- with .Params.extraSection -}}
    {{ partial (printf "verb-extras/%s.html" .) (dict "ctx" $) }}
  {{- end -}}
</article>

{{ $css := resources.Get "css/homepage.css" }}
<link rel="stylesheet" href="{{ $css.RelPermalink }}">
{{ end }}
```

- [ ] **Step 19.2 — Create the 3 extras partials**

`hugo/layouts/partials/verb-extras/curated-paths.html` — render `.Site.Data.browse.featured` missions for Learn page.

`hugo/layouts/partials/verb-extras/btp-service-catalog.html` — single hero link card to <https://discovery-center.cloud.sap>.

`hugo/layouts/partials/verb-extras/events-calendar.html` — `<section data-island="events-calendar">` placeholder. The Connect page reuses the events island with a `mode="full-calendar"` data-attribute the Vue island reads to fetch more events.

- [ ] **Step 19.3 — Smoke check each verb page**

```bash
for v in learn build integrate operate ai connect; do
  curl -sI "http://localhost:1313/$v/" | head -1
done
# Expected: HTTP/1.1 200 OK for all 6
```

- [ ] **Step 19.4 — Commit**

```bash
git add hugo/layouts/verb hugo/layouts/partials/verb-extras
git commit -m "feat(#639): verb sub-page layout + 3 extras partials (curated-paths, btp-catalog, events-calendar)"
```

## Task 20 — Vue islands for live bands

**Files:**

- Create: `hugo-apps/src/homepage-bands/index.ts` (Vite entry)
- Create: `hugo-apps/src/homepage-bands/EventsBand.vue`
- Create: `hugo-apps/src/homepage-bands/VideoBand.vue`
- Create: `hugo-apps/src/homepage-bands/CommunityLane.vue`
- Modify: `hugo-apps/vite.config.ts` (add `homepage-bands` entry)

- [ ] **Step 20.1 — Add Vite entry**

Open `hugo-apps/vite.config.ts`, locate the existing `rollupOptions.input` map (entries like `navigator`, `me`, `advocates`). Add:

```ts
'homepage-bands': 'src/homepage-bands/index.ts'
```

- [ ] **Step 20.2 — Implement entry `hugo-apps/src/homepage-bands/index.ts`**

```ts
import { createApp } from 'vue';
import EventsBand from './EventsBand.vue';
import VideoBand from './VideoBand.vue';
import CommunityLane from './CommunityLane.vue';

function mount(selector: string, component: any) {
  const el = document.querySelector(selector);
  if (!el) return;
  createApp(component).mount(el as HTMLElement);
}

mount('[data-island="events"]', EventsBand);
mount('[data-island="videos"]', VideoBand);
mount('[data-island="community"]', CommunityLane);
mount('[data-island="events-calendar"]', EventsBand);  // reused on /connect/
```

- [ ] **Step 20.3 — `EventsBand.vue`**

Minimal Composition API SFC. On mount, fetch `/api/homepage/events`. Render 3-4 cards (event name, date, location, format chip, register link). Empty state: link to community.sap.com events. Detect `mode="full-calendar"` from the host element's `data-mode` attribute and fetch a longer list when set.

- [ ] **Step 20.4 — `VideoBand.vue`**

Two-column layout per spec §6 Row 4. Fetch `/api/homepage/videos`. Left column: large featured card (thumbnail + title + "Watch on YouTube" link to `https://youtube.com/watch?v=${featured.videoId}`). Right column: 3 recent cards. Graceful state on `error !== null`: render a single "Watch on @sapdevs" link card to `https://youtube.com/@sapdevs`.

- [ ] **Step 20.5 — `CommunityLane.vue`**

Three-column layout. Three parallel fetches: `/api/advocates` (pick 3 random), `/api/homepage/community-blogs`, `/api/homepage/news`. Cards link out. Each column has its own loading skeleton.

- [ ] **Step 20.6 — Build hugo-apps and verify entry**

```bash
npm --prefix hugo-apps run build
ls hugo/static/js/homepage-bands.js
# Expected: file exists
node scripts/check-build-collisions.ts
# Expected: no Vite ↔ Hugo js.Build collision
```

- [ ] **Step 20.7 — Manual browser check**

```bash
npm run dev &
sleep 5
# Open http://localhost:1313 in a browser, verify all 3 bands hydrate
# without console errors. Without YOUTUBE_API_KEY set, video band shows
# the graceful "no-api-key" fallback link card.
```

- [ ] **Step 20.8 — Commit**

```bash
git add hugo-apps/src/homepage-bands hugo-apps/vite.config.ts
git commit -m "feat(#639): Vue islands for homepage live bands (events, videos, community)"
```

## Task 21 — Update CSP for YouTube thumbnails

**Files:**

- Modify: `approuter/xs-app.json`

- [ ] **Step 21.1 — Add YouTube thumbnail host to CSP**

In `approuter/xs-app.json` find the `Content-Security-Policy` `responseHeaders` value. The current `img-src` directive is:

```
img-src 'self' https://raw.githubusercontent.com https://avatars.githubusercontent.com https://github.com https://*.sap.com data:;
```

Add `https://i.ytimg.com` (YouTube thumbnail CDN):

```
img-src 'self' https://raw.githubusercontent.com https://avatars.githubusercontent.com https://github.com https://*.sap.com https://i.ytimg.com data:;
```

Also add YouTube oEmbed / iframe (in case the video band ever embeds rather than links out):

```
frame-src https://www.youtube.com https://youtube.com https://youtu.be https://microlearning.opensap.com https://sapvideo.cfapps.eu10-004.hana.ondemand.com https://i.ytimg.com;
```

- [ ] **Step 21.2 — Commit**

```bash
git add approuter/xs-app.json
git commit -m "build(#639): add YouTube thumbnail host (i.ytimg.com) to CSP img-src"
```

## Task 22 — Smoke tests

**Files:**

- Create: `test/smoke/homepage.smoke.test.ts`
- Create: `test/smoke/homepage-api.smoke.test.ts`

- [ ] **Step 22.1 — `homepage.smoke.test.ts`**

```ts
import { describe, expect, it } from 'vitest';

const BASE = process.env.SMOKE_BASE_URL;

describe.skipIf(!BASE)('Developer homepage smoke', () => {
  it('GET / returns the new homepage', async () => {
    const res = await fetch(BASE + '/');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/<article[^>]+class=["']?developer-homepage/);
    expect(html).toMatch(/data-island=["']?events["']?/);
    expect(html).toMatch(/data-island=["']?videos["']?/);
  });

  it.each(['learn','build','integrate','operate','ai','connect'])('GET /%s/ returns the verb sub-page', async (verb) => {
    const res = await fetch(`${BASE}/${verb}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/<article[^>]+class=["']?verb-page/);
  });

  it('GET /tutorial-navigator/ renders the relocated navigator', async () => {
    const res = await fetch(BASE + '/tutorial-navigator/');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/tutorial-navigator|navigator-grid/);
  });

  it('GET /tutorial-navigator.html 301-redirects to /tutorial-navigator/', async () => {
    const res = await fetch(BASE + '/tutorial-navigator.html', { redirect: 'manual' });
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe('/tutorial-navigator/');
  });

  it('GET /index.html 301-redirects to /', async () => {
    const res = await fetch(BASE + '/index.html', { redirect: 'manual' });
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe('/');
  });

  it('GET /tutorials/abap-dev-get-started/ still resolves (regression guard)', async () => {
    const res = await fetch(BASE + '/tutorials/abap-dev-get-started/');
    // Tutorial may 404 in a fresh deploy if content not yet published; accept 200 or 404 but never 301-to-wrong-place.
    expect([200, 404]).toContain(res.status);
  });

  it('GET /nonexistent.html returns 404 (conservative catch-all)', async () => {
    const res = await fetch(BASE + '/nonexistent.html', { redirect: 'manual' });
    expect([404, 200]).toContain(res.status);  // 200 if it accidentally exists; never 301
    expect(res.status).not.toBe(301);
  });
});
```

- [ ] **Step 22.2 — `homepage-api.smoke.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
const SRV = process.env.SMOKE_SRV_URL;

describe.skipIf(!SRV)('Homepage API smoke', () => {
  it.each([
    ['/api/homepage/events',          'array'],
    ['/api/homepage/videos',          'object'],
    ['/api/homepage/communityBlogs',  'array'],
    ['/api/homepage/news',            'array'],
    ['/api/homepage/shelves?verb=LEARN', 'array'],
    ['/api/homepage/redirectsActive', 'array']
  ])('GET %s returns %s', async (path, kind) => {
    const res = await fetch(SRV + path);
    expect(res.ok).toBe(true);
    const data = await res.json();
    if (kind === 'array') expect(Array.isArray(data)).toBe(true);
    else expect(typeof data).toBe('object');
  });

  it('GET /build/homepage-shelves returns shelves + buildAt', async () => {
    const res = await fetch(SRV + '/build/homepage-shelves');
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(Array.isArray(data.shelves)).toBe(true);
    expect(data.buildAt).toBeTruthy();
  });
});
```

- [ ] **Step 22.3 — Commit + PR**

```bash
git add test/smoke/homepage.smoke.test.ts test/smoke/homepage-api.smoke.test.ts
git commit -m "test(#639): smoke tests for new homepage + verb pages + redirects + API"
git push origin feat/639-phase4-homepage-cutover
gh pr create --title "feat(#639): Phase 4 — New homepage + verb sub-pages (cutover)" \
  --body "Spec §6–9. Depends on Phase 1, 2, 3.

**This is the cutover PR.** Merging this changes what users see at / and where
the tutorial navigator lives. Pre-merge regression checklist (manual):

- [ ] All 3 vitest workspaces green
- [ ] Lighthouse ≥ 90 on staging
- [ ] Mobile viewport sanity (320 / 768 / 1024)
- [ ] Sample 10–20 actual Google search-result URLs (\\`site:developers.sap.com\\`) and verify each resolves or 301s correctly
- [ ] Manual click-through on every verb tile + sub-page on staging"
```

---

# Phase 5 — Nightly link-health job + docs

> **Branch:** `feat/639-phase5-link-health-and-docs`. Worktree: `.claude/worktrees/639-phase5/`.
>
> **Depends on:** Phase 1 (HomepageShelves entity).

## Task 23 — Link-health job (`srv/jobs/homepage-link-health.js`)

**Files:**

- Create: `srv/jobs/homepage-link-health.js`
- Modify: `srv/jobs/scheduler.js` (register cron at 04:00)
- Test: `test/unit/homepage-link-health.test.js`

- [ ] **Step 23.1 — Failing test**

```js
import { describe, it, expect, vi, beforeAll } from 'vitest';
import cds from '@sap/cds';

cds.test('serve', '--project', '.', '--in-memory');

describe('homepage-link-health job', () => {
  let runHomepageLinkHealth;

  beforeAll(async () => {
    ({ runHomepageLinkHealth } = await import('../../srv/jobs/homepage-link-health.js'));
  });

  it('marks reachable URLs OK and slow URLs SLOW', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
      if (url.includes('slow.example')) {
        await new Promise(r => setTimeout(r, 100));
        return new Response('', { status: 200 });
      }
      return new Response('', { status: 200 });
    }));

    const db = await cds.connect.to('db');
    const fastId = cds.utils.uuid();
    const slowId = cds.utils.uuid();
    await db.run(INSERT.into('com.sap.developers.ims.HomepageShelves').entries([
      { ID: fastId, verb: 'BUILD',  shelf: 'TOOLS', sortOrder: 1, title: 'Fast', url: 'https://fast.example', isActive: true },
      { ID: slowId, verb: 'BUILD',  shelf: 'TOOLS', sortOrder: 2, title: 'Slow', url: 'https://slow.example', isActive: true }
    ]));

    await runHomepageLinkHealth({ slowThresholdMs: 50 });

    const rows = await db.run(SELECT.from('com.sap.developers.ims.HomepageShelves')
      .where`ID in (${fastId}, ${slowId})`);
    const byId = Object.fromEntries(rows.map(r => [r.ID, r]));
    expect(byId[fastId].linkStatus).toBe('OK');
    expect(byId[slowId].linkStatus).toBe('SLOW');
    expect(byId[fastId].lastChecked).toBeTruthy();
  });

  it('marks broken URLs BROKEN', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));
    const db = await cds.connect.to('db');
    const id = cds.utils.uuid();
    await db.run(INSERT.into('com.sap.developers.ims.HomepageShelves').entries({
      ID: id, verb: 'INTEGRATE', shelf: 'TOOLS', sortOrder: 1, title: 'Broken',
      url: 'https://broken.example', isActive: true
    }));
    await runHomepageLinkHealth();
    const row = await db.run(SELECT.one.from('com.sap.developers.ims.HomepageShelves').where({ ID: id }));
    expect(row.linkStatus).toBe('BROKEN');
  });

  it('skips inactive entries', async () => {
    const stub = vi.fn(async () => new Response('', { status: 200 }));
    vi.stubGlobal('fetch', stub);
    const db = await cds.connect.to('db');
    await db.run(INSERT.into('com.sap.developers.ims.HomepageShelves').entries({
      ID: cds.utils.uuid(), verb: 'AI', shelf: 'TOOLS', sortOrder: 1,
      title: 'Inactive', url: 'https://inactive.example', isActive: false
    }));
    const callsBefore = stub.mock.calls.length;
    await runHomepageLinkHealth();
    // The fetcher should NOT have been called for inactive.example specifically
    expect(stub.mock.calls.some(c => String(c[0]).includes('inactive.example'))).toBe(false);
  });
});
```

- [ ] **Step 23.2 — Run; FAIL.**

- [ ] **Step 23.3 — Implement `srv/jobs/homepage-link-health.js`**

```js
import cds from '@sap/cds';

const TIMEOUT_MS = 5000;
const CONCURRENCY = 4;
const SLEEP_BETWEEN_MS = 200;
const DEFAULT_SLOW_THRESHOLD_MS = 1500;

const LOG = cds.log?.('homepage-link-health') ?? console;

async function checkOne(url, slowThresholdMs) {
  const started = Date.now();
  try {
    let res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok && (res.status === 405 || res.status === 501)) {
      // HEAD not allowed → fall back to GET
      res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(TIMEOUT_MS) });
    }
    const elapsed = Date.now() - started;
    if (!res.ok) return 'BROKEN';
    return elapsed > slowThresholdMs ? 'SLOW' : 'OK';
  } catch {
    return 'BROKEN';
  }
}

export async function runHomepageLinkHealth(opts = {}) {
  const slowThresholdMs = opts.slowThresholdMs ?? DEFAULT_SLOW_THRESHOLD_MS;
  const db = await cds.connect.to('db');
  const rows = await db.run(SELECT.from('com.sap.developers.ims.HomepageShelves')
    .where({ isActive: true })
    .columns('ID', 'url'));

  let cursor = 0;
  let okCount = 0, slowCount = 0, brokenCount = 0;

  async function worker() {
    while (cursor < rows.length) {
      const i = cursor++;
      const row = rows[i];
      if (i > 0) await new Promise(r => setTimeout(r, SLEEP_BETWEEN_MS));
      const status = await checkOne(row.url, slowThresholdMs);
      if (status === 'OK') okCount++;
      else if (status === 'SLOW') slowCount++;
      else brokenCount++;
      await db.run(`UPDATE com_sap_developers_ims_HomepageShelves
                     SET linkStatus = ?, lastChecked = ?
                     WHERE ID = ?`, [status, new Date().toISOString(), row.ID]);
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  LOG.info?.(`link-health: ${okCount} OK, ${slowCount} SLOW, ${brokenCount} BROKEN`);
  return { ok: okCount, slow: slowCount, broken: brokenCount };
}
```

- [ ] **Step 23.4 — Wire into scheduler**

In `srv/jobs/scheduler.js`, find the existing cron registrations (look for `cron.schedule(`). Add:

```js
import { runHomepageLinkHealth } from './homepage-link-health.js';

// Daily at 04:00 — after content GC (03:00) but well before peak traffic.
// Spec §13.1.
cron.schedule('0 4 * * *', () =>
  runWithLock('homepage-link-health', 30 * 60 * 1000, runHomepageLinkHealth)
);
```

Also add to the `srv-qa` cp list in `.deploy/mta.yaml` (per memory `feedback_srv_qa_cp_list` — this is the recurring class of bugs):

```
../../srv/jobs/homepage-link-health.js \
```

- [ ] **Step 23.5 — Run; PASS. Commit.**

```bash
npx vitest run test/unit/homepage-link-health.test.js
git add srv/jobs/homepage-link-health.js srv/jobs/scheduler.js .deploy/mta.yaml \
        test/unit/homepage-link-health.test.js
git commit -m "feat(#639): nightly homepage link-health job (04:00)"
```

## Task 24 — Architecture docs + CLAUDE.md cross-link

**Files:**

- Create: `docs/developers/architecture/homepage.md`
- Modify: `docs/developers/operations/testing-endpoints.md` (add `/api/homepage/*`, `/build/homepage-shelves`)
- Modify: `docs/developers/architecture/build.md` (note `homepage_shelves.json`)
- Modify: `CLAUDE.md` (add homepage architecture link under "Most-referenced developer docs")

- [ ] **Step 24.1 — Author `docs/developers/architecture/homepage.md`**

Sections:

1. **Overview** — one paragraph, links to the design spec.
2. **Components** — bullet list: HomepageShelves entity, LegacyRedirects entity, HomepageConfig singleton, HomepageService, YouTube fetcher, RSS fetchers, link-health job, admin Fiori app.
3. **Page anatomy diagram** — ASCII tree of the 7 rows (copy from spec §6).
4. **Verb sub-page contract** — explain the 4-shelf shape + the 3 extras.
5. **Data flow diagram** — ASCII showing build-time vs. runtime data sources for each row.
6. **URL contract** — table from spec §9.1 + §9.3.
7. **Admin operations** — how to add a new shelf entry, how to add a legacy redirect, how to update the YouTube playlist ID.
8. **Failure modes & graceful degradation** — what each band does when upstream fails.

- [ ] **Step 24.2 — Append `/api/homepage/*` entries to `docs/developers/operations/testing-endpoints.md`**

Add each endpoint with auth + scope columns (all are public/no-auth except internal `/api/homepage/recordRedirectHits` which is approuter→srv-only):

| Endpoint | Method | Auth | Notes |
|---|---|---|---|
| `/api/homepage/events` | GET | none | 60s cache |
| `/api/homepage/videos` | GET | none | 15-min cache; depends on YOUTUBE_API_KEY |
| `/api/homepage/communityBlogs` | GET | none | 30-min cache |
| `/api/homepage/news` | GET | none | 30-min cache |
| `/api/homepage/shelves?verb=<v>` | GET | none | 5-min cache |
| `/api/homepage/redirectsActive` | GET | none | approuter-only consumer; hourly refresh |
| `/api/homepage/recordRedirectHits` | POST | none | approuter-only writer; idempotent |
| `/build/homepage-shelves` | GET | none | Hugo build only |

- [ ] **Step 24.3 — Add a sentence to `docs/developers/architecture/build.md`**

Under the "Hugo build pipeline" / "Data feeds" section, note that `hugo/data/homepage_shelves.json` is baked from `/build/homepage-shelves` during `build:all`.

- [ ] **Step 24.4 — Add CLAUDE.md cross-link**

Under "Most-referenced developer docs" add a bullet:

```markdown
- [docs/developers/architecture/homepage.md](docs/developers/architecture/homepage.md) — developer-portal homepage architecture (#639)
```

- [ ] **Step 24.5 — Sidebar guard**

```bash
npm run docs:build
```

If it fails on the sidebar guard, add the new page to `docs/.vitepress/config.ts` `themeConfig.sidebar`. Re-run.

- [ ] **Step 24.6 — Commit + PR**

```bash
git add docs/developers/architecture/homepage.md docs/developers/operations/testing-endpoints.md \
        docs/developers/architecture/build.md docs/.vitepress/config.ts CLAUDE.md
git commit -m "docs(#639): homepage architecture doc + testing-endpoints + CLAUDE.md cross-link"
git push origin feat/639-phase5-link-health-and-docs
gh pr create --title "feat(#639): Phase 5 — Link-health job + docs" \
  --body "Spec §13 + docs ops. Depends on Phase 1."
```

---

## Appendix A — Test inventory

Sorted by Vitest workspace:

**Unit (`npm test`):**

- `test/unit/homepage-shelves-crud.test.js` (Task 1)
- `test/unit/homepage-seed.test.js` (Task 2)
- `test/unit/admin-homepage-crud.test.js` (Task 3)
- `test/unit/youtube-fetcher.test.js` (Task 6)
- `test/unit/homepage-events-merger.test.js` (Task 7)
- `test/unit/homepage-rss-fetcher.test.js` (Task 8)
- `test/unit/homepage-service-endpoints.test.js` (Task 9)
- `test/unit/legacy-redirects-resolver.test.js` (Task 12)
- `test/unit/redirects-endpoints.test.js` (Task 13)
- `test/unit/homepage-link-health.test.js` (Task 23)

**Hybrid (`npm run test:hybrid`, requires `cf login` + `ALLOW_HYBRID_WRITES=true`):**

- `test/hybrid/homepage-schema.test.js` (Task 5)
- `test/hybrid/approuter-redirects.test.js` (Task 14)

**Smoke (`npm run test:smoke`, requires `SMOKE_BASE_URL` + `SMOKE_SRV_URL`):**

- `test/smoke/homepage.smoke.test.ts` (Task 22)
- `test/smoke/homepage-api.smoke.test.ts` (Task 22)

## Appendix B — Pre-cutover regression checklist (Phase 4 PR)

Pasted into the cutover PR per spec §15:

1. All 3 vitest workspaces green on the cutover branch.
2. Deploy to DEV via `cd .deploy && mbt build && cf deploy mta_archives/*.mtar -e ../deploy/dev.mtaext -f`.
3. Run smoke tests against DEV: `SMOKE_BASE_URL=... SMOKE_SRV_URL=... npm run test:smoke`.
4. Lighthouse audit on `/` and on each `/<verb>/`: target ≥ 90 on Performance, Accessibility, Best Practices, SEO.
5. Mobile viewport sanity (manually walk through 320 / 768 / 1024 widths in Chrome devtools).
6. Sample inbound URLs from Google Search Console — `site:developers.sap.com` first page, `intitle:"tutorial"`, the top 10 most-clicked queries — verify each either resolves correctly or 301s to a sensible target.
7. Click-through every verb tile + sub-page on staging.
8. Click 10 random destinations from the directory footer, verify they open in a new tab (per `target="_blank"`) and reach a non-404 page.
9. With `YOUTUBE_API_KEY` populated in credstore, verify the video band shows the featured Friday Developer News + 3 recent. With the env var empty, verify graceful "Watch on @sapdevs" link card renders.
10. Stakeholder walkthrough with Tom + 1-2 others (per spec §15).

## Appendix C — Post-cutover watch window (1-2 weeks)

1. Daily check of `/admin-ui/#homepage` → Redirects tab `hitCount` column — adds named redirects for surprises.
2. Weekly check of Shelves tab `linkStatus` column — fix or de-activate BROKEN entries.
3. Monitor Search Console for "page indexed without content" warnings on the new URLs.
4. Watch Cloud Logging for the homepage-link-health job's nightly run; investigate any cron failures.
5. Tom adds the real Developer News playlist ID to HomepageConfig via the admin Fiori app once the SAPDevs channel owner provides it.

## Appendix D — Out of scope (deferred to follow-up issues)

Per spec §16, these are NOT part of #639:

- Per-user personalization on the homepage (handled by `/me/`).
- A search bar in the homepage hero.
- Translations / non-English locales.
- QA-channel equivalent of the new homepage.
- Co-branding with `sap.com` global nav (footer-only seam only).
- Additional data sources beyond YouTube / community blogs / news.
- The AEM-side redirect tree.
- Per-verb admin permission split.

