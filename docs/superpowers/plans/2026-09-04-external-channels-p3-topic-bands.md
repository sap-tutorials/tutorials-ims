# External Channels P3 — Per-topic bands (Surface C) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `ChannelTopicMap` crosswalk (channel → site topic tag, LLM-drafted then human-reviewed) that renders a "Related channels" band on `/topics/*` term pages, plus a Channel Topic Map admin app to review/promote the crosswalk.

**Architecture:** `ChannelTopicMap` is a new journalled entity in the `com.sap.developers.ims` namespace, keyed `(channel, topicTag)`. An LLM seed pass (mirroring P2's `seed-collections.js`, lazy AI-SDK import) drafts `AI_SEEDED` rows; a curator promotes them to `REVIEWED` in a Fiori Elements admin app. **`/topics/*` pages are CAP server-side-rendered content BLOBs, NOT Hugo pages** — so the band is added to the CAP topic payload builder (`srv/lib/topics-query.js`) and renderer (`srv/lib/topic-detail-render.js`), shipping through the existing topic publish pipeline (`srv/lib/publish-topics.js`). No Hugo layout, no `build:all` change.

**Tech Stack:** SAP CAP (Node.js) + CDS, SAP HANA (migration tables), Fiori Elements V4 (admin shell componentUsages), `@sap-ai-sdk/orchestration` (lazy), Vitest (`cds.test('serve', …, '--in-memory')` + Playwright e2e).

**Spec:** `docs/superpowers/specs/2026-09-04-external-channels-integration-design.md` — this plan implements **P3 (§16)**: §5.3 (`ChannelTopicMap`), §9 (Surface C), §13 (Channel Topic Map admin), §14 (link health filter), §15 (testing). P1 (`Channels` + directory) and P2 (`ChannelCollections`) are already merged to DEV.

## Global Constraints

- **CAP namespace is `com.sap.developers.ims`**; reuse the existing `AuthoringStatus` enum from `db/homepage.cds` (values verbatim: `BLANK; AI_SEEDED; REVIEWED;`) via `using { com.sap.developers.ims.AuthoringStatus } from './homepage';` — already imported at `db/channels.cds:4`.
- **Validate every CDS change against cds-mcp before landing** (project rule): search CAP docs with `cds-mcp` when creating/modifying CDS models. Confirmed for this plan: `@assert.unique.<name>: [ assoc, field ]` references the association name (CAP auto-coerces to the FK); `@mandatory` on a managed to-one association is valid; enum `@assert.range` with `default` is valid.
- **Never hand-author or hand-edit `.hdbmigrationtable` files.** After editing `db/channels.cds` + `db/persistence.cds`, regenerate with `npx cds build --production` (npm script `build:cds`) and commit the regenerated `db/src/com.sap.developers.ims.ChannelTopicMap.hdbmigrationtable` **and** updated `db/last-dev/csn.json` **together** in the model task's commit. Gate: `npx tsx scripts/check-cds-build-staging.ts` must exit 0 (it re-runs `cds build --production` and fails on any diff under `db/last-dev/` or `db/src/`).
- **A new persisted entity produces NO HANA table unless journalled.** Add `annotate ims.ChannelTopicMap with @cds.persistence.journal;` to `db/persistence.cds`.
- **srv-qa cp-list discipline:** the seed lib must import `@sap-ai-sdk/orchestration` **only** via lazy `await import(...)` inside a function (never a top-level `require`/`import`), and must NOT be reachable from any `srv-qa/**` boot path. Gate: `npx tsx scripts/check-srv-qa-cp-list.ts` must exit 0. The lib is invoked only by `scripts/seed-channel-topic-map.cjs` via `cds bind --exec`.
- **Admin-shell manifest blocks are GENERATED, not hand-edited.** Register the app by editing `app/admin-shell/scripts/admin-shell-overrides.js` (`order` + `prefix` maps), `app/admin-shell/webapp/model/navigation.json`, and the two maps in `app/admin-shell/webapp/controller/Shell.controller.js`, then run `npm --prefix app/admin-shell run generate-manifest` (also runs on `prestart`/`prebuild`). Never hand-edit the generated `resourceRoots`/`componentUsages`/`routes`/`targets` in `app/admin-shell/webapp/manifest.json`.
- **Only `REVIEWED` rows render publicly** (§9). The Surface C join hard-gates on `authoringStatus === 'REVIEWED'`, filters to published channels, and drops broken links (`(linkStatusOverride || linkStatus) !== 'BROKEN'`) — P1/P2 parity.
- **HANA insert rule:** `INSERT.into(entity)` must set `ID: cds.utils.uuid()` explicitly (CAP does not auto-fill the UUID key on HANA, only on SQLite).
- **Tests** use `cds.test('serve', '--project', '.', '--in-memory')` + `const linked = () => cds.linked(cds.model).entities('com.sap.developers.ims');`. Run unit tests with `npx vitest run --project unit <file>`; e2e with `--project e2e`.
- **No deployment.** Deploy is a separate step the maintainer (Tom) controls.

## Key design decisions (rulings baked into this plan)

- **`topicTag` stores the mdFormat tag slug** (`"software-product>sap-hana-cloud"`), matching spec §5.3's example and the published `/build/tags` vocabulary (`srv/lib/tag-md-format.js` → `titlePathToMdFormat`). This is the stable, admin-recognizable vocabulary the LLM is seeded against. The Surface C join converts the topic page's canonical `Tags.titlePath` to mdFormat via `titlePathToMdFormat(tag.titlePath)` and matches on equality. *Cost if wrong:* if a future need requires joining on the spaced `titlePath` form instead, only `topics-query.js`'s one-line conversion and the seed's tag list change; the stored column and admin UI are unaffected.
- **`authoringStatus` defaults to `AI_SEEDED`** (per spec §5.3, unlike P2 collections' `BLANK`): crosswalk rows exist only because the generator created them, so `AI_SEEDED` is the correct birth state. Curators promote to `REVIEWED`. *Cost if wrong:* a hand-created admin row also starts `AI_SEEDED`; harmless since the render gate requires `REVIEWED`.
- **The band caps at the top 5 channels by `relevance` (desc)** per §9, omitting the section entirely when zero rows survive the gate (mirrors the existing "Related topics" empty-safe behavior in `topic-detail-render.js`).
- **No per-item blurb on the band.** Spec §5.3's `ChannelTopicMap` has no `blurb`; the band renders channel name (external link) + owner-type badge only.

---

### Task 1: `ChannelTopicMap` model + persistence + migration table

**Files:**
- Modify: `db/channels.cds` (add `entity ChannelTopicMap`)
- Modify: `db/persistence.cds` (add journal annotation)
- Regenerate + Commit: `db/last-dev/csn.json`, `db/src/com.sap.developers.ims.ChannelTopicMap.hdbmigrationtable`
- Test: `test/channel-topic-map-model.test.js` (Create)

**Interfaces:**
- Consumes: `Channels` entity + `AuthoringStatus` enum (both already in `db/channels.cds` / `db/homepage.cds`).
- Produces: `com.sap.developers.ims.ChannelTopicMap` with elements `channel : Association to Channels @mandatory`, `topicTag : String(140) @mandatory`, `relevance : Integer default 50`, `authoringStatus : AuthoringStatus default 'AI_SEEDED'`, plus `cuid`+`managed` audit fields. FK on HANA is `channel_ID`.

- [ ] **Step 1: Write the failing test** — `test/channel-topic-map-model.test.js`

```js
import cds from '@sap/cds';
import { describe, it, expect, afterAll } from 'vitest';

const project = cds.test('serve', '--project', '.', '--in-memory');
const NS = 'com.sap.developers.ims';
const linked = () => cds.linked(cds.model).entities(NS);

describe('ChannelTopicMap model', () => {
  afterAll(async () => {
    await DELETE.from(linked().ChannelTopicMap);
    await DELETE.from(linked().Channels).where({ sourceId: { like: 'ctm-%' } });
  });

  it('persists a crosswalk row joined to a Channel with an mdFormat topicTag', async () => {
    const { Channels, ChannelTopicMap } = linked();
    const chId = cds.utils.uuid();
    await INSERT.into(Channels).entries({
      ID: chId, sourceId: 'ctm-cap', name: 'CAP Docs', url: 'https://cap.cloud.sap', isPublished: true,
    });
    const rowId = cds.utils.uuid();
    await INSERT.into(ChannelTopicMap).entries({
      ID: rowId, channel_ID: chId, topicTag: 'software-product>sap-btp', relevance: 80, authoringStatus: 'REVIEWED',
    });
    const row = await SELECT.one.from(ChannelTopicMap).where({ ID: rowId });
    expect(row.channel_ID).toBe(chId);
    expect(row.topicTag).toBe('software-product>sap-btp');
    expect(row.relevance).toBe(80);
    expect(row.authoringStatus).toBe('REVIEWED');
  });

  it('defaults relevance=50 and authoringStatus=AI_SEEDED', async () => {
    const { Channels, ChannelTopicMap } = linked();
    const chId = cds.utils.uuid();
    await INSERT.into(Channels).entries({ ID: chId, sourceId: 'ctm-def', name: 'D', url: 'https://d', isPublished: true });
    const rowId = cds.utils.uuid();
    await INSERT.into(ChannelTopicMap).entries({ ID: rowId, channel_ID: chId, topicTag: 'software-product>x' });
    const row = await SELECT.one.from(ChannelTopicMap).where({ ID: rowId });
    expect(row.relevance).toBe(50);
    expect(row.authoringStatus).toBe('AI_SEEDED');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit test/channel-topic-map-model.test.js`
Expected: FAIL — `ChannelTopicMap` undefined in `linked()`.

- [ ] **Step 3: Add the entity to `db/channels.cds`**

Below the P2 `ChannelCollectionItems` block (currently ending at `db/channels.cds:62`), append:

```cds

// --- P3: per-topic crosswalk (Surface C; LLM-drafted, human-reviewed) --------
@assert.unique.pair: [ channel, topicTag ]
entity ChannelTopicMap : cuid, managed {
  channel         : Association to Channels @mandatory;
  topicTag        : String(140) @mandatory;   // mdFormat tag, e.g. "software-product>sap-hana-cloud"
  relevance       : Integer default 50;       // 0-100; orders the per-topic band, desc
  authoringStatus : AuthoringStatus default 'AI_SEEDED' @assert.range;
}
```

(cds-mcp confirmed: `@assert.unique.<name>: [ channel, topicTag ]` uses the association name — CAP resolves it to the `channel_ID` FK; `@mandatory` on a managed to-one is valid.)

- [ ] **Step 4: Add the journal annotation to `db/persistence.cds`**

After the existing `annotate ims.ChannelCollectionItems with @cds.persistence.journal;` line (currently `db/persistence.cds:56`), add:

```cds
annotate ims.ChannelTopicMap with @cds.persistence.journal;
```

- [ ] **Step 5: Verify the model deploys to SQLite**

Run: `npx cds deploy --to sqlite::memory:`
Expected: succeeds (no compile errors); `com.sap.developers.ims.ChannelTopicMap` present.

- [ ] **Step 6: Regenerate the migration table + csn (NEVER hand-author)**

Run: `npm run build:cds` (i.e. `cds build --production`).
This regenerates `db/last-dev/csn.json` and creates `db/src/com.sap.developers.ims.ChannelTopicMap.hdbmigrationtable`. Do not edit either file by hand.

- [ ] **Step 7: Run the model test to verify it passes**

Run: `npx vitest run --project unit test/channel-topic-map-model.test.js`
Expected: PASS (both tests).

- [ ] **Step 8: Verify the build-staging gate is clean**

Run: `npx tsx scripts/check-cds-build-staging.ts`
Expected: exit 0 (the regenerated artifacts are committed, so re-running `cds build` produces no diff).

- [ ] **Step 9: Commit**

```bash
git add db/channels.cds db/persistence.cds db/last-dev/csn.json db/src/com.sap.developers.ims.ChannelTopicMap.hdbmigrationtable test/channel-topic-map-model.test.js
git commit -m "feat(channels): ChannelTopicMap crosswalk model (P3)"
```

---

### Task 2: `AdminService` projection for `ChannelTopicMap`

**Files:**
- Modify: `srv/admin-service.cds` (add draft-enabled projection near the P2 channel projections at `:303-308`)
- Test: `test/admin-channel-topic-map.test.js` (Create)

**Interfaces:**
- Consumes: `com.sap.developers.ims.ChannelTopicMap` (Task 1).
- Produces: `AdminService.ChannelTopicMap` (draft-enabled OData V4 entity) served at `/admin/` under `@requires:'Admin'`.

- [ ] **Step 1: Write the failing test** — `test/admin-channel-topic-map.test.js`

```js
import cds from '@sap/cds';
import { describe, it, expect } from 'vitest';

cds.test('serve', '--project', '.', '--in-memory');

describe('AdminService.ChannelTopicMap projection', () => {
  it('is exposed and draft-enabled', () => {
    const def = cds.services.AdminService.model.definitions['AdminService.ChannelTopicMap'];
    expect(def).toBeDefined();
    expect(def['@odata.draft.enabled']).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit test/admin-channel-topic-map.test.js`
Expected: FAIL — `AdminService.ChannelTopicMap` undefined.

- [ ] **Step 3: Add the projection to `srv/admin-service.cds`**

Immediately after the P2 lines (`srv/admin-service.cds:303-308`, ending with `entity ChannelCollectionItems as projection on ims.ChannelCollectionItems;`), add:

```cds

  @odata.draft.enabled
  entity ChannelTopicMap as projection on ims.ChannelTopicMap;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project unit test/admin-channel-topic-map.test.js`
Expected: PASS.

- [ ] **Step 5: Verify build-staging still clean**

Run: `npx tsx scripts/check-cds-build-staging.ts`
Expected: exit 0. (Editing `srv/*.cds` re-sorts `db/last-dev/csn.json`; if the gate reports a diff, re-run `npm run build:cds` and `git add db/last-dev/csn.json` into this commit — a benign compiler re-sort, per project memory.)

- [ ] **Step 6: Commit**

```bash
git add srv/admin-service.cds db/last-dev/csn.json test/admin-channel-topic-map.test.js
git commit -m "feat(channels): AdminService ChannelTopicMap projection (P3)"
```

---

### Task 3: Channel Topic Map admin FE app + shell registration

**Files:**
- Create: `app/admin/channel-topic-map/package.json`
- Create: `app/admin/channel-topic-map/ui5.yaml`
- Create: `app/admin/channel-topic-map/webapp/Component.js`
- Create: `app/admin/channel-topic-map/webapp/manifest.json`
- Create: `app/admin/channel-topic-map/webapp/i18n/i18n.properties`
- Modify: `app/admin-shell/scripts/admin-shell-overrides.js` (`order` + `prefix` maps)
- Modify: `app/admin-shell/webapp/model/navigation.json` (nav item)
- Modify: `app/admin-shell/webapp/controller/Shell.controller.js` (NAV_KEY_TO_ROUTE + NAV_KEY_TO_TITLE maps)
- Regenerate: `app/admin-shell/webapp/manifest.json` (via `generate-manifest` — do not hand-edit)
- Test: `test/admin-channel-topic-map-app.test.js` (Create)

**Interfaces:**
- Consumes: `AdminService.ChannelTopicMap` (Task 2) at dataSource `/admin/`.
- Produces: an admin-shell nav entry `channelTopicMap` → route `channel-topic-map`, componentUsage `channelTopicMapComponent`, unique prefix **`ctm`** (`cc`/`ch`/`ca`/`cl`/`cm`/`co` are already taken).

- [ ] **Step 1: Write the failing scaffold test** — `test/admin-channel-topic-map-app.test.js`

```js
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (p) => readFileSync(resolve(p), 'utf8');

describe('Channel Topic Map admin app scaffold', () => {
  it('manifest points at /admin/ and the ChannelTopicMap contextPath', () => {
    const m = JSON.parse(read('app/admin/channel-topic-map/webapp/manifest.json'));
    expect(m['sap.app'].id).toBe('sap.tutorials.admin.channelTopicMap');
    expect(m['sap.app'].dataSources.mainService.uri).toBe('/admin/');
    const list = m['sap.ui5'].routing.targets.ChannelTopicMapList;
    expect(list.options.settings.contextPath).toBe('/ChannelTopicMap');
  });

  it('is registered in admin-shell overrides + navigation', () => {
    const overrides = read('app/admin-shell/scripts/admin-shell-overrides.js');
    expect(overrides).toContain('channel-topic-map');
    expect(overrides).toContain("'ctm'");
    const nav = read('app/admin-shell/webapp/model/navigation.json');
    expect(nav).toContain('channelTopicMap');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit test/admin-channel-topic-map-app.test.js`
Expected: FAIL — manifest file not found.

- [ ] **Step 3: Create the FE app files** (mirror `app/admin/channel-collections/` verbatim, substituting the entity)

`app/admin/channel-topic-map/webapp/manifest.json`:

```json
{
  "_version": "1.65.0",
  "sap.app": {
    "id": "sap.tutorials.admin.channelTopicMap",
    "type": "application",
    "title": "{{appTitle}}",
    "description": "{{appDescription}}",
    "applicationVersion": { "version": "0.0.1" },
    "i18n": "i18n/i18n.properties",
    "dataSources": {
      "mainService": {
        "uri": "/admin/",
        "type": "OData",
        "settings": { "odataVersion": "4.0" }
      }
    },
    "crossNavigation": {
      "inbounds": {
        "ChannelTopicMap-manage": {
          "semanticObject": "ChannelTopicMap",
          "action": "manage",
          "title": "{{appTitle}}",
          "signature": { "parameters": {}, "additionalParameters": "allowed" }
        }
      }
    }
  },
  "sap.ui5": {
    "dependencies": {
      "minUI5Version": "1.136.0",
      "libs": { "sap.fe.templates": {} }
    },
    "models": {
      "": {
        "dataSource": "mainService",
        "preload": true,
        "settings": {
          "synchronizationMode": "None",
          "operationMode": "Server",
          "autoExpandSelect": true,
          "earlyRequests": true
        }
      },
      "i18n": {
        "type": "sap.ui.model.resource.ResourceModel",
        "settings": { "bundleName": "sap.tutorials.admin.channelTopicMap.i18n.i18n" }
      }
    },
    "routing": {
      "routes": [
        { "name": "ChannelTopicMapList", "pattern": ":?query:", "target": "ChannelTopicMapList" },
        { "name": "ChannelTopicMapObject", "pattern": "ChannelTopicMap({key}):?query:", "target": "ChannelTopicMapObject" }
      ],
      "targets": {
        "ChannelTopicMapList": {
          "type": "Component",
          "id": "ChannelTopicMapList",
          "name": "sap.fe.templates.ListReport",
          "options": {
            "settings": {
              "contextPath": "/ChannelTopicMap",
              "initialLoad": "Enabled"
            }
          }
        },
        "ChannelTopicMapObject": {
          "type": "Component",
          "id": "ChannelTopicMapObject",
          "name": "sap.fe.templates.ObjectPage",
          "options": {
            "settings": {
              "contextPath": "/ChannelTopicMap"
            }
          }
        }
      }
    }
  }
}
```

`app/admin/channel-topic-map/webapp/Component.js`:

```js
sap.ui.define(["sap/fe/core/AppComponent"], function (AppComponent) {
  "use strict";
  return AppComponent.extend("sap.tutorials.admin.channelTopicMap.Component", { metadata: { manifest: "json" } });
});
```

`app/admin/channel-topic-map/webapp/i18n/i18n.properties`:

```
appTitle=Channel Topic Map
appDescription=Review and promote the channel-to-topic crosswalk
```

`app/admin/channel-topic-map/package.json` (mirror `channel-collections` package.json — `name: "channel-topic-map-admin"`, `"sapux": true`, `"scripts": { "build": "ui5 build --clean-dest" }`, same devDependencies `@sap/ux-specification` + `@ui5/cli ^4.0.0`):

```json
{
  "name": "channel-topic-map-admin",
  "version": "0.0.1",
  "private": true,
  "sapux": true,
  "scripts": {
    "build": "ui5 build --clean-dest"
  },
  "devDependencies": {
    "@sap/ux-specification": "^1.120.0",
    "@ui5/cli": "^4.0.0"
  }
}
```

(If `channel-collections/package.json` pins different devDependency versions, copy those exact versions instead — open `app/admin/channel-collections/package.json` and match it verbatim.)

`app/admin/channel-topic-map/ui5.yaml` (mirror `channel-collections/ui5.yaml`):

```yaml
specVersion: "4.0"
metadata:
  name: sap.tutorials.admin.channelTopicMap
type: application
framework:
  name: SAPUI5
  version: "1.136.0"
  libraries:
    - name: sap.m
    - name: sap.ui.core
    - name: sap.ushell
    - name: sap.fe.templates
```

- [ ] **Step 4: Register in the admin shell**

In `app/admin-shell/scripts/admin-shell-overrides.js`:
- Add `'channel-topic-map'` to the `order` array (near the P2 `'channel-collections'` entry, `~:87`).
- Add `'channel-topic-map': 'ctm'` to the `prefix` map (near `'channel-collections': 'cc'`, `~:172`).

In `app/admin-shell/webapp/model/navigation.json`, in the same "content" group as the `channelCollections` item (`~:26`), add:

```json
{ "key": "channelTopicMap", "title": "Channel Topic Map" }
```

In `app/admin-shell/webapp/controller/Shell.controller.js`:
- In `NAV_KEY_TO_ROUTE` (near `:67`), add: `channelTopicMap: "channelTopicMap",`
- In `NAV_KEY_TO_TITLE` (near `:128`), add: `channelTopicMap: "Channel Topic Map",`

- [ ] **Step 5: Regenerate the shell manifest**

Run: `npm --prefix app/admin-shell run generate-manifest`
Expected: exit 0; the generated `app/admin-shell/webapp/manifest.json` now contains a `channelTopicMap` route/target with prefix `ctm` and a `channelTopicMapComponent` componentUsage. If the generator reports a prefix collision, pick another free 2-3 char prefix and update both `admin-shell-overrides.js` and this step.

- [ ] **Step 6: Run the scaffold test to verify it passes**

Run: `npx vitest run --project unit test/admin-channel-topic-map-app.test.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add app/admin/channel-topic-map app/admin-shell/scripts/admin-shell-overrides.js app/admin-shell/webapp/model/navigation.json app/admin-shell/webapp/controller/Shell.controller.js app/admin-shell/webapp/manifest.json test/admin-channel-topic-map-app.test.js
git commit -m "feat(channels): Channel Topic Map admin app + shell registration (P3)"
```

---

### Task 4: LLM seed pass for the crosswalk

**Files:**
- Create: `srv/lib/channels/seed-channel-topic-map.js` (pure `draftChannelTopicMap` + `seedChannelTopicMap` + lazy `buildLlm`)
- Create: `scripts/seed-channel-topic-map.cjs` (CLI runner via `cds bind --exec`)
- Modify: `package.json` (add `seed-channel-topic-map` script)
- Test: `srv/lib/channels/__tests__/seed-channel-topic-map.test.js` (Create)

**Interfaces:**
- Consumes: `Channels` (published rows), `ChannelTopicMap`, the valid topicTag vocabulary (from `Tags` via `titlePathToMdFormat`), `resolveChatLlmSettings`.
- Produces:
  - `draftChannelTopicMap(channels, topicTags, { llm })` → `[{ sourceId, topicTag, relevance }]` (pure; `llm` is an injected async fn so tests never touch the AI SDK).
  - `seedChannelTopicMap(db, { commit, llm })` → `{ created, updatedDraft, skippedReviewed }` (idempotent upsert on `(channel_ID, topicTag)`, preserves `REVIEWED`, writes drafts as `AI_SEEDED`).
  - `buildLlm()` → real LLM caller (lazy `await import('@sap-ai-sdk/orchestration')`).

- [ ] **Step 1: Write the failing test** — `srv/lib/channels/__tests__/seed-channel-topic-map.test.js`

```js
import cds from '@sap/cds';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { draftChannelTopicMap, seedChannelTopicMap } from '../seed-channel-topic-map.js';

const project = cds.test('serve', '--project', '.', '--in-memory');
const NS = 'com.sap.developers.ims';
const linked = () => cds.linked(cds.model).entities(NS);

// Deterministic fake LLM: maps each channel's first focusArea to a topicTag.
const fakeLlm = async (channels /*, topicTags */) =>
  channels.map((c, i) => ({
    sourceId: c.sourceId,
    topicTag: `software-product>${(c.focusAreas && c.focusAreas[0]) || 'general'}`,
    relevance: 90 - i * 10,
  }));

describe('draftChannelTopicMap', () => {
  it('turns channels into crosswalk drafts via the injected llm', async () => {
    const drafts = await draftChannelTopicMap(
      [{ sourceId: 's1', name: 'CAP', focusAreas: ['cap'] }],
      ['software-product>cap'],
      { llm: fakeLlm },
    );
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ sourceId: 's1', topicTag: 'software-product>cap', relevance: 90 });
  });
});

describe('seedChannelTopicMap', () => {
  beforeAll(async () => {
    const { Channels } = linked();
    await INSERT.into(Channels).entries([
      { ID: cds.utils.uuid(), sourceId: 'stm-cap', name: 'CAP', url: 'https://stm-cap', isPublished: true, focusAreas: ['cap'] },
      { ID: cds.utils.uuid(), sourceId: 'stm-ai', name: 'AI', url: 'https://stm-ai', isPublished: true, focusAreas: ['ai'] },
    ]);
  });
  afterAll(async () => {
    await DELETE.from(linked().ChannelTopicMap);
    await DELETE.from(linked().Channels).where({ sourceId: { in: ['stm-cap', 'stm-ai'] } });
  });

  it('inserts AI_SEEDED rows, is idempotent, and preserves REVIEWED', async () => {
    const db = await cds.connect.to('db');
    const first = await seedChannelTopicMap(db, { commit: true, llm: fakeLlm });
    expect(first.created).toBeGreaterThan(0);

    const { Channels, ChannelTopicMap } = linked();
    const cap = await SELECT.one.from(Channels).where({ sourceId: 'stm-cap' });
    const row = await SELECT.one.from(ChannelTopicMap).where({ channel_ID: cap.ID });
    expect(row.authoringStatus).toBe('AI_SEEDED');

    // Curator reviews it (and bumps relevance):
    await UPDATE(ChannelTopicMap).set({ authoringStatus: 'REVIEWED', relevance: 100 }).where({ ID: row.ID });

    // Re-run: reviewed row preserved.
    const second = await seedChannelTopicMap(db, { commit: true, llm: fakeLlm });
    expect(second.skippedReviewed).toBeGreaterThan(0);
    const preserved = await SELECT.one.from(ChannelTopicMap).where({ ID: row.ID });
    expect(preserved.authoringStatus).toBe('REVIEWED');
    expect(preserved.relevance).toBe(100);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit srv/lib/channels/__tests__/seed-channel-topic-map.test.js`
Expected: FAIL — module `../seed-channel-topic-map.js` not found.

- [ ] **Step 3: Implement `srv/lib/channels/seed-channel-topic-map.js`**

```js
'use strict';
const cds = require('@sap/cds');

// Pure: given channels + the valid topicTag vocabulary + an async
// llm(channels, topicTags)->drafts fn, return normalized drafts.
// The llm fn is injected so tests never touch the AI SDK. The real llm is
// built lazily by buildLlm() below (never a top-level import — keeps
// @sap-ai-sdk/orchestration out of srv-qa boot; see project srv-qa cp-list rule).
async function draftChannelTopicMap(channels, topicTags, { llm }) {
  if (typeof llm !== 'function') throw new Error('draftChannelTopicMap requires an llm function');
  const valid = new Set(topicTags || []);
  const drafts = await llm(channels, topicTags);
  return (drafts || [])
    .filter((d) => d && d.sourceId && d.topicTag && (valid.size === 0 || valid.has(d.topicTag)))
    .map((d) => ({
      sourceId: d.sourceId,
      topicTag: d.topicTag,
      relevance: Number.isFinite(d.relevance) ? Math.max(0, Math.min(100, d.relevance)) : 50,
    }));
}

// Lazy-built real LLM caller. Mirrors srv/lib/channels/seed-collections.js.
async function buildLlm() {
  const { OrchestrationClient } = await import('@sap-ai-sdk/orchestration');
  const { resolveChatLlmSettings } = await import('../chat-settings-resolver.js');
  const { modelName, deploymentId } = await resolveChatLlmSettings();
  return async (channels, topicTags) => {
    const catalog = channels.map((c) => ({ sourceId: c.sourceId, name: c.name, purpose: c.purpose, focusAreas: c.focusAreas, tags: c.tags, category: c.category }));
    const tool = {
      type: 'function',
      function: {
        name: 'submit_topic_map',
        description: 'Map SAP developer channels to the most relevant site topic tags (from the provided vocabulary), with a 0-100 relevance score.',
        parameters: {
          type: 'object',
          properties: {
            rows: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  sourceId: { type: 'string', enum: catalog.map((c) => c.sourceId) },
                  topicTag: { type: 'string', enum: topicTags },
                  relevance: { type: 'integer' },
                },
                required: ['sourceId', 'topicTag', 'relevance'],
              },
            },
          },
          required: ['rows'],
        },
      },
    };
    const client = new OrchestrationClient({
      promptTemplating: {
        model: { name: modelName, params: { max_tokens: 4000, temperature: 0.2, tool_choice: { type: 'function', function: { name: 'submit_topic_map' } } } },
        prompt: {
          template: [{ role: 'system', content: 'You map SAP developer channels to site topic tags. For each channel, propose 1-3 of the MOST relevant topicTags from the provided vocabulary (never invent tags), each with a relevance 0-100. Prefer precision over recall.' }],
          tools: [tool],
        },
      },
    }, { deploymentId });
    const response = await client.chatCompletion({ messagesHistory: [{ role: 'user', content: JSON.stringify({ channels: catalog, topicTags }) }] });
    const calls = response.getToolCalls() || [];
    const args = calls[0] && JSON.parse(calls[0].function.arguments);
    return (args && args.rows) || [];
  };
}

// Load the valid mdFormat topicTag vocabulary from the Tags entity.
async function loadTopicTags(db, linked) {
  const { titlePathToMdFormat } = require('../tag-md-format.js');
  const { Tags } = linked.entities('com.sap.developers.ims');
  const tags = await db.run(SELECT.from(Tags).columns('titlePath'));
  const out = new Set();
  for (const t of tags) {
    if (t.titlePath) { const md = titlePathToMdFormat(t.titlePath); if (md) out.add(md); }
  }
  return [...out];
}

async function seedChannelTopicMap(db, { commit = false, llm } = {}) {
  const linked = cds.linked(cds.model ?? (await cds.load('*')));
  const { Channels, ChannelTopicMap } = linked.entities('com.sap.developers.ims');
  const channels = await db.run(SELECT.from(Channels).where({ isPublished: true }));
  const bySource = new Map(channels.map((c) => [c.sourceId, c]));
  const topicTags = await loadTopicTags(db, linked);
  const effectiveLlm = llm || (await buildLlm());
  const drafts = await draftChannelTopicMap(channels, topicTags, { llm: effectiveLlm });

  let created = 0, updatedDraft = 0, skippedReviewed = 0;
  for (const d of drafts) {
    const ch = bySource.get(d.sourceId);
    if (!ch) continue;
    const existing = await db.run(SELECT.one.from(ChannelTopicMap).where({ channel_ID: ch.ID, topicTag: d.topicTag }));
    if (existing && existing.authoringStatus === 'REVIEWED') { skippedReviewed++; continue; }
    if (!commit) { existing ? updatedDraft++ : created++; continue; }
    if (existing) {
      await db.run(UPDATE(ChannelTopicMap).set({ relevance: d.relevance, authoringStatus: 'AI_SEEDED' }).where({ ID: existing.ID }));
      updatedDraft++;
    } else {
      await db.run(INSERT.into(ChannelTopicMap).entries({ ID: cds.utils.uuid(), channel_ID: ch.ID, topicTag: d.topicTag, relevance: d.relevance, authoringStatus: 'AI_SEEDED' }));
      created++;
    }
  }
  return { created, updatedDraft, skippedReviewed };
}

module.exports = { draftChannelTopicMap, seedChannelTopicMap, buildLlm };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project unit srv/lib/channels/__tests__/seed-channel-topic-map.test.js`
Expected: PASS.

- [ ] **Step 5: Create the CLI runner `scripts/seed-channel-topic-map.cjs`** (mirror `scripts/seed-collections.cjs`)

```js
'use strict';
// Usage: cds bind --exec -- node scripts/seed-channel-topic-map.cjs [--commit]
const cds = require('@sap/cds');
const { seedChannelTopicMap } = require('../srv/lib/channels/seed-channel-topic-map.js');

(async () => {
  const commit = process.argv.includes('--commit');
  await cds.load('*'); // ensure cds.model is populated for cds.linked in the lib
  const db = await cds.connect.to('db');
  const res = await seedChannelTopicMap(db, { commit });
  console.log(`[seed-channel-topic-map] commit=${commit}`, res);
  if (!commit) console.log('[seed-channel-topic-map] dry run — pass --commit to write. Drafts land as AI_SEEDED; review in /admin-ui/#channelTopicMap.');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 6: Add the npm script to `package.json`**

Next to the existing `"seed-collections"` script, add:

```json
"seed-channel-topic-map": "cds bind --exec -- node scripts/seed-channel-topic-map.cjs",
```

- [ ] **Step 7: Confirm the srv-qa cp-list gate still passes**

Run: `npx tsx scripts/check-srv-qa-cp-list.ts`
Expected: exit 0 — `seed-channel-topic-map.js` is only imported by `scripts/seed-channel-topic-map.cjs` and its test, never by an `srv-qa/**` boot path, and the AI SDK is lazily imported. If it fails, STOP and rule: either sever the boot-path import or add the file to the `.deploy/mta.yaml` `tutorials-srv-qa` cp list.

- [ ] **Step 8: Commit**

```bash
git add srv/lib/channels/seed-channel-topic-map.js srv/lib/channels/__tests__/seed-channel-topic-map.test.js scripts/seed-channel-topic-map.cjs package.json
git commit -m "feat(channels): LLM seed pass for the topic crosswalk (P3)"
```

---

### Task 5: Surface C — `relatedChannels` in the topic payload

**Files:**
- Modify: `srv/lib/topics-query.js` (add `relatedChannels` to `buildTopicDetailPayload`)
- Test: `test/unit/topics-query.test.js` (extend — add a `relatedChannels` case; if the file's structure makes extension awkward, create `test/unit/topics-query-channels.test.js` following the same harness)

**Interfaces:**
- Consumes: `ChannelTopicMap` (Task 1), `Channels`, and the topic's resolved `titlePath`; `titlePathToMdFormat` from `srv/lib/tag-md-format.js`.
- Produces: `buildTopicDetailPayload(...)` return object gains a `relatedChannels` array: `[{ name, url, ownerType, isSapOwned, relevance }]` — REVIEWED-gated, published-channel + non-broken-link filtered, ordered by `relevance` desc, capped at 5. Empty array when none.

- [ ] **Step 1: Read the current payload builder**

Open `srv/lib/topics-query.js`; locate `buildTopicDetailPayload(db, slug, corpus)` and the return object (`{ slug, label, facet, tutorials, concepts, relatedTags, buildAt, error }`, ~`:176-180`) and how it resolves the tag (via `resolveTopicBySlug`, giving `tag.titlePath` + `tag.slug`).

- [ ] **Step 2: Write the failing test**

Add to `test/unit/topics-query.test.js` (mirror its existing `cds.test('serve', …, '--in-memory')` harness) a test that:
1. Seeds a `Channels` row (`isPublished:true`, `ownerType:'Community_Member'`, non-broken) and a `ChannelTopicMap` row for it with a `topicTag` equal to `titlePathToMdFormat(<the seeded topic's titlePath>)`, `authoringStatus:'REVIEWED'`, `relevance:80`.
2. Seeds a second `ChannelTopicMap` row that is `AI_SEEDED` (must NOT appear) and a third whose channel `isPublished:false` (must NOT appear).
3. Calls `buildTopicDetailPayload(db, <slug>, corpus)` and asserts `payload.relatedChannels` contains exactly the REVIEWED+published+non-broken channel, shaped `{ name, url, ownerType, relevance }`.

```js
// sketch — align field access with the file's existing helpers
const payload = await buildTopicDetailPayload(db, slug, corpus);
expect(payload.relatedChannels.map((c) => c.url)).toEqual(['https://reviewed-ch']);
expect(payload.relatedChannels[0]).toMatchObject({ ownerType: 'Community_Member', relevance: 80 });
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run --project unit test/unit/topics-query.test.js`
Expected: FAIL — `payload.relatedChannels` is `undefined`.

- [ ] **Step 4: Add the join to `buildTopicDetailPayload`**

At the top of the file, add `const { titlePathToMdFormat } = require('./tag-md-format.js');` (match the file's import style — `require` vs `import`). Inside `buildTopicDetailPayload`, after the tag is resolved and before assembling the return object, add:

```js
  // Surface C (P3): REVIEWED channel crosswalk rows for this topic, top 5 by relevance.
  let relatedChannels = [];
  try {
    const NS = 'com.sap.developers.ims';
    const mdTag = titlePathToMdFormat(tag.titlePath);
    if (mdTag) {
      const rows = await db.run(
        SELECT.from(`${NS}.ChannelTopicMap`)
          .where({ topicTag: mdTag, authoringStatus: 'REVIEWED' })
          .orderBy('relevance desc'),
      );
      if (rows.length) {
        const ids = rows.map((r) => r.channel_ID);
        const chans = await db.run(
          SELECT.from(`${NS}.Channels`)
            .columns('ID', 'name', 'url', 'ownerType', 'isSapOwned', 'isPublished', 'linkStatus', 'linkStatusOverride')
            .where({ ID: { in: ids } }),
        );
        const chById = new Map(chans.map((c) => [c.ID, c]));
        relatedChannels = rows
          .map((r) => ({ ch: chById.get(r.channel_ID), relevance: r.relevance }))
          .filter((x) => x.ch && x.ch.isPublished && (x.ch.linkStatusOverride || x.ch.linkStatus) !== 'BROKEN')
          .slice(0, 5)
          .map((x) => ({ name: x.ch.name, url: x.ch.url, ownerType: x.ch.ownerType, isSapOwned: x.ch.isSapOwned, relevance: x.relevance }));
      }
    }
  } catch (e) {
    relatedChannels = []; // Surface C is additive — never break topic rendering.
  }
```

Add `relatedChannels` to the returned object alongside `relatedTags`.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run --project unit test/unit/topics-query.test.js`
Expected: PASS (new + existing cases).

- [ ] **Step 6: Commit**

```bash
git add srv/lib/topics-query.js test/unit/topics-query.test.js
git commit -m "feat(channels): related-channels crosswalk in topic payload (P3)"
```

---

### Task 6: Surface C — render the "Related channels" band

**Files:**
- Modify: `srv/lib/topic-detail-render.js` (add a `topic-channels` section, mirroring the `topic-related` band)
- Test: `test/unit/topic-detail-render.test.js` (extend — add a `relatedChannels` render case)

**Interfaces:**
- Consumes: `topic.relatedChannels` (Task 5).
- Produces: an empty-safe `<section class="topic-channels">` band with an `<h2>` and a `<ul role="list">` of external links (each `<a href rel="noopener">` + owner badge); omitted entirely when `relatedChannels` is empty. Feeds `renderTopicDetail(topic)` → `{ body, contentHash }`; the change flows to published `topic-<slug>` BLOBs via `srv/lib/publish-topics.js` (contentHash changes → re-publish on next rebuild).

- [ ] **Step 1: Read the existing "Related topics" band**

Open `srv/lib/topic-detail-render.js`; study the `related` / `relatedSection` block (`:17-31`) and where sections are concatenated into the body (`:33-53`, after `${conceptsSection}` and `${relatedSection}`). Note the `esc()` helper and the `contentHash = sha256(body)` return.

- [ ] **Step 2: Write the failing test**

Add to `test/unit/topic-detail-render.test.js` a case that builds a fake `topic` with a `relatedChannels` array and asserts the rendered `body`:

```js
it('renders a related-channels band with external links', () => {
  const topic = {
    slug: 'sap-hana-cloud', label: 'SAP HANA Cloud', facet: 'Software Product',
    tutorials: [], concepts: [], relatedTags: [],
    relatedChannels: [
      { name: 'SAP HANA Academy', url: 'https://youtube.com/hana', ownerType: 'SAP_Official', isSapOwned: true, relevance: 90 },
      { name: 'HANA Reddit', url: 'https://reddit.com/r/hana', ownerType: 'Community_Member', isSapOwned: false, relevance: 60 },
    ],
  };
  const { body, contentHash } = renderTopicDetail(topic);
  expect(body).toContain('class="topic-channels"');
  expect(body).toContain('href="https://youtube.com/hana"');
  expect(body).toContain('rel="noopener"');
  expect(body).toMatch(/^/); // sanity
  expect(contentHash).toMatch(/^[a-f0-9]{64}$/);
});

it('omits the related-channels band when there are none', () => {
  const { body } = renderTopicDetail({ slug: 't', label: 'T', facet: 'F', tutorials: [], concepts: [], relatedTags: [], relatedChannels: [] });
  expect(body).not.toContain('topic-channels');
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run --project unit test/unit/topic-detail-render.test.js`
Expected: FAIL — no `topic-channels` in body.

- [ ] **Step 4: Add the band to `renderTopicDetail`**

Mirror the `relatedSection` pattern. Before the body assembly, add:

```js
  const badgeFor = (t) => {
    switch (t) {
      case 'SAP_Official': return 'SAP';
      case 'SAP_Developer_Advocate': return 'SAP Advocate';
      case 'User_Group': return 'User Group';
      case 'Community_Member':
      case 'Community_Organization': return 'Community';
      default: return 'Third-party';
    }
  };
  const channelItems = (topic.relatedChannels || []).map((c) => `
      <li class="topic-channels__item">
        <a href="${esc(c.url)}" rel="noopener" target="_blank">${esc(c.name)}</a>
        <span class="topic-channels__badge" data-owner="${esc(c.ownerType || '')}">${esc(badgeFor(c.ownerType))}</span>
      </li>`).join('');
  const channelsSection = channelItems
    ? `<section class="topic-channels" aria-labelledby="topic-channels-h">
        <h2 id="topic-channels-h">Related channels</h2>
        <ul class="topic-channels__list" role="list">${channelItems}</ul>
      </section>`
    : '';
```

Insert `${channelsSection}` into the body assembly, immediately after `${relatedSection}` (so "Related channels" follows "Related topics").

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run --project unit test/unit/topic-detail-render.test.js`
Expected: PASS (new + existing cases; existing `contentHash` assertions still hold).

- [ ] **Step 6: Commit**

```bash
git add srv/lib/topic-detail-render.js test/unit/topic-detail-render.test.js
git commit -m "feat(channels): render related-channels band on topic pages (P3)"
```

---

### Task 7: e2e coverage nudge for the topic-page band

**Files:**
- Create: `test/e2e/topic-channels.e2e.test.js` (self-skips without `SMOKE_BASE_URL`)

**Interfaces:**
- Consumes: a deployed `/topics/<slug>/` page (post-deploy only).

- [ ] **Step 1: Confirm the e2e harness + skip pattern**

Open `test/e2e/topics.spec.ts` and `test/e2e/channels.e2e.test.js`; note the self-skip (`describe.skipIf(!hasBaseUrl())` from `./e2e.config.js`) and the browser helpers (`./_browser.js`). Match the JS `.e2e.test.js` naming (vitest e2e include glob `test/e2e/**/*.test.{js,ts}`, per `vitest.config.ts:186`).

- [ ] **Step 2: Write a tolerant band assertion**

Create `test/e2e/topic-channels.e2e.test.js` that navigates to a topics index, follows a leaf topic to `/topics/<slug>/`, and:
- asserts the topic page renders `<main>` + `<h1>` (served pages render `<main>`+`<h1>`, NOT `<article>`);
- IF a `.topic-channels` section is present, asserts it has an `<h2>` and at least one `<a>` — but tolerates its absence (the crosswalk may be all-`AI_SEEDED`/empty until curators review), early-returning like `channels.e2e.test.js`'s collections check.

```js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasBaseUrl } from './e2e.config.js';
import { launchBrowser, newPage } from './_browser.js';

describe.skipIf(!hasBaseUrl())('e2e: /topics related-channels band (public)', () => {
  let browser;
  beforeAll(async () => { browser = await launchBrowser(); });
  afterAll(async () => { await browser?.close(); });

  it('topic pages render, and any related-channels band is well-formed', async () => {
    const page = await newPage(browser);
    // navigate to a topic detail page following the topics tree (mirror topics.spec.ts)
    // ...assert <main> + <h1> present...
    const band = await page.$('.topic-channels');
    if (!band) return; // tolerant: crosswalk may be empty pre-review
    expect(await band.$('h2')).toBeTruthy();
    expect((await band.$$('a')).length).toBeGreaterThan(0);
  });
});
```

(Fill the navigation body verbatim from `test/e2e/topics.spec.ts`'s leaf-navigation flow — reuse its selectors `#topics-tree-root` / `#topics-filter-input` and its click-through to a `/topics/<slug>/` page.)

- [ ] **Step 3: Verify it self-skips locally**

Run: `npx vitest run --project e2e test/e2e/topic-channels.e2e.test.js` (WITHOUT `SMOKE_BASE_URL`)
Expected: skipped, suite green.

- [ ] **Step 4: Commit**

```bash
git add test/e2e/topic-channels.e2e.test.js
git commit -m "test(channels): e2e nudge for topic related-channels band (P3)"
```

---

## Self-Review

**Spec coverage:**
- §5.3 `ChannelTopicMap` model (channel, topicTag, relevance, authoringStatus; unique pair) → Task 1. ✅
- §9 Surface C — "Go deeper / follow" band on `/topics/*`, join on topic tag, ordered by relevance, capped ~5, community items badged, REVIEWED-gated → Tasks 5 (payload join + gate + cap) + 6 (band + badge). ✅ (Ruling: `/topics/*` is CAP-SSR, so no baked `channels_by_topic.json` — §9's "baked-data vs island" alternative is moot; the band ships via the topic publish pipeline.)
- §13 Channel Topic Map admin (review/correct crosswalk; promote AI_SEEDED→REVIEWED) → Tasks 2 (service) + 3 (app). ✅
- §14 broken links filtered from bands → Task 5 filter. ✅
- §15 testing (model deploys to sqlite; crosswalk join renders only REVIEWED; e2e nudge) → Tasks 1, 5, 7. ✅ Seed idempotent/preserves-REVIEWED → Task 4. ✅
- §16 P3 scope boundary: `ChannelSubmissions` (P4) is explicitly OUT of this plan. ✅

**Open-question rulings baked in:**
- §17.4 (`AI_SEEDED` visibility): P3 **hard-gates** the band on `authoringStatus === 'REVIEWED'` (Task 5). A config flag to also render `AI_SEEDED` can be added later without rework.
- topicTag representation: stores mdFormat (`software-product>…`), join converts `titlePath` via `titlePathToMdFormat` (see Key design decisions).

**Placeholder scan:** No TBD/TODO. Tasks 5–7 reference existing files the implementer must open to match style verbatim (`topics-query.js` return object, `topic-detail-render.js` band + `esc`, `topics.spec.ts` navigation) — flagged explicitly with the reason, not left vague.

**Type consistency:** `draftChannelTopicMap(channels, topicTags, {llm})` and `seedChannelTopicMap(db, {commit,llm})` signatures match their test usage. `relatedChannels` item shape `{ name, url, ownerType, isSapOwned, relevance }` is produced identically by Task 5 (payload) and consumed by Task 6 (render). `topicTag` mdFormat form is written by Task 4 (seed) and matched by Task 5 (`titlePathToMdFormat`). `authoringStatus` uses the exact `AuthoringStatus` enum (`BLANK`/`AI_SEEDED`/`REVIEWED`).

**Ordering:** Task 1 (model) → 2 (service) & 4 (seed) & 5 (payload) depend on it → 3 (app) depends on 2 → 6 (render) depends on 5 → 7 (e2e) depends on 6. Tasks 2, 4, 5 are independent of each other. No forward references.
