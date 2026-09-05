# Channels Hub Phase 1 — Hub Band + Health Radar + Media-Diet Picker

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a four-card hub band to the existing `/channels/` page, ship an ecosystem-health radar at `/channels/health/`, and a focus-area–based media-diet picker at `/channels/media-diet/` — all fed by reliable Channels fields with no ChannelTopicMap dependency.

**Architecture:** Two new Vue 3 islands (`channels-health`, `media-diet`) follow the existing `channels-directory` island pattern — data baked into `<script type="application/json">` blocks by Hugo layouts, read by island `index.ts` at mount time. The health radar is fed by a new public `GET /build/channels-stats` Express handler that aggregates over reliable fields only; `scripts/fetch-channels-stats.ts` pulls this at build time and writes `hugo/data/channels-stats.json`. The media-diet picker is pure client-side over the already-baked `hugo/data/channels.json`. The hub band is a new section inside the existing `ChannelsDirectory.vue` — no new island or route.

**Tech Stack:** Vue 3 · TypeScript · `@vue/test-utils` + `happy-dom` (island tests) · Vitest (`npm test --project unit`) · CAP Node.js Express (srv/server.js) · Hugo static site · Vite (hugo-apps/vite.config.ts)

**Spec:** `docs/superpowers/specs/2026-09-05-channels-hub-design.md`

## Global Constraints

- Target branch is **DEV**; `main` is protected — open a PR, never direct-merge. NO main-hotfix path.
- **No raw SQL** anywhere — `SELECT.from(...)` CQL / `cds.ql` only.
- Slug comparisons are **lowercase-canonical** — `.toLowerCase()` before comparing.
- **`focusAreas`/`tags`/`relatedUrls` are HANA JSON NCLOB arrays** — no DB-side array-contains filter; filter in application code (parseArr pattern in `srv/server.js:432`).
- Anon browser endpoints (`/build/*`) must be reachable anonymously via approuter (`authenticationType: none`); the `check-public-endpoints.ts` post-build guard enforces RULE 2 (every `app.get` before the `basicAuthMiddleware` barrier must have a matching anon approuter route).
- Any new `srv/lib/*` file must be added to `.deploy/mta.yaml`'s `srv-qa` `cp` list. Phase 1 adds NO new srv/lib files — all new logic lives in `srv/server.js` inline.
- New Vue islands must register any `ui5-icon` name in `hugo-apps/src/ui5/ui5-core.ts`. All four hub-card icons (`org-chart`, `chain-link`, `sys-monitor`, `favorite`) are **already registered** there — no change needed.
- `ignore-scripts=true` global npmrc means `postbuild:apps` does NOT fire automatically — `build:island-manifest` is an explicit step in `build:all`. New islands added to `vite.config.ts` rollupOptions.input are automatically picked up by the existing `build:island-manifest` step.
- Vue island unit tests run in the `unit` project: `npx vitest --project unit run hugo-apps/src/<island>/<file>.test.ts` from repo root (NOT from `hugo-apps/`).
- Server-side tests (under `test/`) also run in the `unit` project: `npx vitest --project unit run test/<file>.test.js`.
- Use `cds.entities(NS)` (not bare `SELECT.from('X')`) for CI Node-version safety (Node 22 vs 24).
- `/auth/user` login probes (Phase 2 seam) MUST check `body.authenticated === true`, not `r.ok`.

---

## File Structure

```
hugo-apps/
  src/
    channels-directory/
      ChannelsDirectory.vue          MODIFY — add hub band section above filter/grid
      ChannelsDirectory.hub-band.test.ts  CREATE — hub band unit tests
    channels-health/                 CREATE dir
      index.ts                       CREATE — island mount entry
      ChannelsHealth.vue             CREATE — health radar Vue component
      ChannelsHealth.test.ts         CREATE — island unit tests
    media-diet/                      CREATE dir
      index.ts                       CREATE — island mount entry
      MediaDiet.vue                  CREATE — media-diet picker Vue component
      MediaDiet.test.ts              CREATE — island unit tests
  vite.config.ts                     MODIFY — add channels-health, media-diet entries

hugo/
  content/channels/
    health/
      _index.md                      CREATE — Hugo content (title, description, layout)
    media-diet/
      _index.md                      CREATE — Hugo content (title, description, layout)
  layouts/channels/
    health.html                      CREATE — injects stats JSON, mounts island
    media-diet.html                  CREATE — injects channels JSON, mounts island

scripts/
  fetch-channels-stats.ts            CREATE — fetches /build/channels-stats → hugo/data/channels-stats.json

srv/
  server.js                          MODIFY — add GET /build/channels-stats Express handler

approuter/
  xs-app.json                        MODIFY — add channels-stats to line-411 alternation group

package.json                         MODIFY — add fetch-channels-stats script; wire into build:all

test/
  channels-stats.test.js             CREATE — unit tests for /build/channels-stats endpoint
```

---

## Payload Contract (Produced by `/build/channels-stats` → `hugo/data/channels-stats.json`)

Every key below is defined here for type-consistency across Tasks 2 and 5.

```typescript
interface ChannelsStats {
  total: number;                          // all channels in DB (published + unpublished)
  publishedCount: number;                 // isPublished === true
  byStatus: Record<string, number>;       // { Active: N, Archived: N, Closed: N, Discontinued: N, EOL: N }
  byOwnerType: Record<string, number>;    // { SAP_Official: N, Community_Member: N, ... }
  byCategory: Record<string, number>;     // { Documentation: N, Community: N, ... }
  bySubcategory: Record<string, number>;  // { ... }
  sapVsCommunity: { sap: number; community: number };
  activeVsInactive: { active: number; inactive: number };
  buildAt: string;                        // ISO 8601 timestamp
}
```

Fields **explicitly absent**: `linkStatus`, `lastChecked`, `updateFrequency`. The test in Task 2 asserts their absence.

---

## Task 1: Hub Band in ChannelsDirectory.vue

**Files:**
- Modify: `hugo-apps/src/channels-directory/ChannelsDirectory.vue`
- Create: `hugo-apps/src/channels-directory/ChannelsDirectory.hub-band.test.ts`

**Interfaces:**
- Consumes: existing `channels`, `collections` props (unchanged)
- Produces: new `.channels-hub-band` section rendered before `.channels-directory__controls`

- [ ] **Step 1: Write the failing test**

Create `hugo-apps/src/channels-directory/ChannelsDirectory.hub-band.test.ts`:

```typescript
// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import ChannelsDirectory from './ChannelsDirectory.vue';

describe('ChannelsDirectory — hub band', () => {
  const wrapper = () => mount(ChannelsDirectory, { props: { channels: [], collections: [] } });

  it('renders four hub navigation cards', () => {
    const links = wrapper().findAll('.channels-hub-band__cards a');
    expect(links).toHaveLength(4);
  });

  it('card hrefs include atlas, health, and media-diet', () => {
    const hrefs = wrapper().findAll('.channels-hub-band__cards a').map((l) => l.attributes('href'));
    expect(hrefs).toContain('/channels/atlas/');
    expect(hrefs).toContain('/channels/health/');
    expect(hrefs).toContain('/channels/media-diet/');
  });

  it('hub band appears in DOM before the filter controls', () => {
    const html = wrapper().html();
    const hubPos = html.indexOf('channels-hub-band');
    const ctrlPos = html.indexOf('channels-directory__controls');
    expect(hubPos).toBeGreaterThan(-1);
    expect(hubPos).toBeLessThan(ctrlPos);
  });

  it('each card has a title and an icon name', () => {
    const cards = wrapper().findAll('.channels-hub-band__cards li');
    expect(cards).toHaveLength(4);
    for (const card of cards) {
      expect(card.find('.hub-card__title').text()).toBeTruthy();
      const icon = card.find('ui5-icon');
      expect(icon.attributes('name')).toBeTruthy();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest --project unit run hugo-apps/src/channels-directory/ChannelsDirectory.hub-band.test.ts
```

Expected: FAIL — `.channels-hub-band__cards` not found.

- [ ] **Step 3: Add the hub band section to ChannelsDirectory.vue**

In `hugo-apps/src/channels-directory/ChannelsDirectory.vue`, insert this block immediately after the opening `<div class="channels-directory">` tag (before the `<section v-if="cols.length"` block):

```html
<section class="channels-hub-band">
  <p class="channels-hub-band__intro">
    SAP developers consume content across dozens of surfaces — portals, docs,
    YouTube channels, podcasts, GitHub orgs, and community spaces. This directory
    maps that ecosystem so you can find the channels that fit your workflow.
  </p>
  <ul class="channels-hub-band__cards">
    <li>
      <a href="/channels/atlas/" class="hub-card">
        <ui5-icon name="org-chart" class="hub-card__icon"></ui5-icon>
        <span class="hub-card__title">Channel Atlas</span>
        <span class="hub-card__desc">Visual map of the full ecosystem</span>
      </a>
    </li>
    <li>
      <a href="/channels/crosswalk/" class="hub-card">
        <ui5-icon name="chain-link" class="hub-card__icon"></ui5-icon>
        <span class="hub-card__title">Learn ↔ Follow</span>
        <span class="hub-card__desc">Tutorial topics to channels crosswalk</span>
      </a>
    </li>
    <li>
      <a href="/channels/health/" class="hub-card">
        <ui5-icon name="sys-monitor" class="hub-card__icon"></ui5-icon>
        <span class="hub-card__title">Ecosystem Health</span>
        <span class="hub-card__desc">Active-vs-inactive and coverage radar</span>
      </a>
    </li>
    <li>
      <a href="/channels/media-diet/" class="hub-card">
        <ui5-icon name="favorite" class="hub-card__icon"></ui5-icon>
        <span class="hub-card__title">Build Your Media Diet</span>
        <span class="hub-card__desc">Get a personalized channel bundle</span>
      </a>
    </li>
  </ul>
</section>
```

Then add the following CSS inside the `<style scoped>` block (before `@media (max-width: 640px)`):

```css
/* --- Hub navigation band --- */
.channels-hub-band {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}
.channels-hub-band__intro {
  margin: 0;
  color: var(--sapTextColor, #1d2d3e);
  font-size: 1rem;
}
.channels-hub-band__cards {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(14rem, 1fr));
  gap: 0.75rem;
}
.hub-card {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.375rem;
  padding: 1rem 1.125rem;
  border: 1px solid var(--sapList_BorderColor, #d9d9d9);
  border-radius: var(--sapElement_BorderCornerRadius, 0.75rem);
  background: var(--sapGroup_ContentBackground, #fff);
  text-decoration: none;
  transition: box-shadow 0.12s;
}
.hub-card:hover {
  box-shadow: var(--sapContent_Shadow1, 0 0 0.5rem rgba(0, 0, 0, 0.12));
}
.hub-card__icon {
  font-size: 1.5rem;
  color: var(--sapAccentColor6, #0064d9);
}
.hub-card__title {
  font-weight: 600;
  font-size: 1rem;
  color: var(--sapLinkColor, #0070f2);
}
.hub-card__desc {
  font-size: 0.875rem;
  color: var(--sapNeutralTextColor, #556b82);
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest --project unit run hugo-apps/src/channels-directory/ChannelsDirectory.hub-band.test.ts
```

Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add hugo-apps/src/channels-directory/ChannelsDirectory.vue \
        hugo-apps/src/channels-directory/ChannelsDirectory.hub-band.test.ts
git commit -m "feat(channels): add hub band with four navigation cards to /channels/ page"
```

---

## Task 2: /build/channels-stats Endpoint + Approuter Route + Fetch Script + Build Wiring

**Files:**
- Modify: `srv/server.js` (add handler before `basicAuthMiddleware` barrier)
- Modify: `approuter/xs-app.json` (add `channels-stats` to line-411 alternation)
- Create: `scripts/fetch-channels-stats.ts`
- Modify: `package.json` (new script + wire into `build:all`)
- Create: `test/channels-stats.test.js`

**Interfaces:**
- Consumes: `com.sap.developers.ims.Channels` — fields: `status`, `ownerType`, `category`, `subcategory`, `isSapOwned`, `isPublished` only. Does NOT read `linkStatus`, `lastChecked`, `updateFrequency`.
- Produces: `GET /build/channels-stats` → `ChannelsStats` JSON (see contract above) + `hugo/data/channels-stats.json`

- [ ] **Step 1: Write the failing test**

Create `test/channels-stats.test.js`:

```javascript
// test/channels-stats.test.js
import cds from '@sap/cds';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const project = cds.test('serve', '--project', '.', '--in-memory');
const NS = 'com.sap.developers.ims';

const STATS_IDS = [
  'aaaaaaaa-9300-0000-0000-000000000001',
  'aaaaaaaa-9300-0000-0000-000000000002',
  'aaaaaaaa-9300-0000-0000-000000000003',
];

describe('GET /build/channels-stats', () => {
  beforeAll(async () => {
    const { Channels } = cds.entities(NS);
    await INSERT.into(Channels).entries([
      {
        ID: STATS_IDS[0], sourceId: 'stats-test-01', name: 'Alpha', url: 'https://alpha.example',
        status: 'Active', ownerType: 'SAP_Official', category: 'Documentation',
        subcategory: 'API Docs', isSapOwned: true, isPublished: true,
      },
      {
        ID: STATS_IDS[1], sourceId: 'stats-test-02', name: 'Beta', url: 'https://beta.example',
        status: 'Archived', ownerType: 'Community_Member', category: 'Community',
        subcategory: 'Forum', isSapOwned: false, isPublished: true,
      },
      {
        ID: STATS_IDS[2], sourceId: 'stats-test-03', name: 'Gamma', url: 'https://gamma.example',
        status: 'Active', ownerType: 'SAP_Developer_Advocate', category: 'Documentation',
        subcategory: null, isSapOwned: true, isPublished: false,
      },
    ]);
  });

  afterAll(async () => {
    const { Channels } = cds.entities(NS);
    await DELETE.from(Channels).where({ ID: { in: STATS_IDS } });
  });

  it('returns 200 with the ChannelsStats shape', async () => {
    const { status, data } = await project.get('/build/channels-stats');
    expect(status).toBe(200);
    expect(typeof data.total).toBe('number');
    expect(typeof data.publishedCount).toBe('number');
    expect(data.byStatus).toBeDefined();
    expect(data.byOwnerType).toBeDefined();
    expect(data.byCategory).toBeDefined();
    expect(data.bySubcategory).toBeDefined();
    expect(data.sapVsCommunity).toBeDefined();
    expect(data.sapVsCommunity).toHaveProperty('sap');
    expect(data.sapVsCommunity).toHaveProperty('community');
    expect(data.activeVsInactive).toBeDefined();
    expect(data.activeVsInactive).toHaveProperty('active');
    expect(data.activeVsInactive).toHaveProperty('inactive');
    expect(typeof data.buildAt).toBe('string');
  });

  it('counts reflect the seeded rows', async () => {
    const { data } = await project.get('/build/channels-stats');
    // At minimum our 3 seeded rows
    expect(data.total).toBeGreaterThanOrEqual(3);
    expect(data.publishedCount).toBeGreaterThanOrEqual(2); // STATS_IDS[0] + [1]
    // Active count includes STATS_IDS[0] + [2]
    expect(data.activeVsInactive.active).toBeGreaterThanOrEqual(2);
    // SAP count: STATS_IDS[0] + [2]
    expect(data.sapVsCommunity.sap).toBeGreaterThanOrEqual(2);
    expect(data.sapVsCommunity.community).toBeGreaterThanOrEqual(1);
    // Documentation category: STATS_IDS[0] + [2]
    expect(data.byCategory['Documentation']).toBeGreaterThanOrEqual(2);
  });

  it('payload does NOT reference linkStatus, lastChecked, or updateFrequency', async () => {
    const { data } = await project.get('/build/channels-stats');
    const bodyStr = JSON.stringify(data);
    expect(bodyStr).not.toMatch(/linkStatus/);
    expect(bodyStr).not.toMatch(/lastChecked/);
    expect(bodyStr).not.toMatch(/updateFrequency/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest --project unit run test/channels-stats.test.js
```

Expected: FAIL — `GET /build/channels-stats` returns 404 (handler not yet registered).

- [ ] **Step 3: Add the /build/channels-stats handler to srv/server.js**

Locate the `/build/channel-collections` handler in `srv/server.js` (line ~469 — ends around line 499). Add the following block immediately **after** that handler's closing `});`:

```javascript
  // Aggregate stats for the ecosystem-health radar at /channels/health/.
  // Consumed by scripts/fetch-channels-stats.ts at build time. Public, unauthenticated.
  // v1 uses ONLY reliably-populated fields: status, ownerType, category/subcategory,
  // isSapOwned, isPublished. Explicitly EXCLUDES linkStatus, lastChecked, updateFrequency.
  app.get('/build/channels-stats', async (_req, res) => {
    try {
      const db = await cds.connect.to('db');
      const rows = await db.run(
        SELECT.from('com.sap.developers.ims.Channels')
          .columns('status', 'ownerType', 'category', 'subcategory', 'isSapOwned', 'isPublished'),
      );
      const countBy = (key) => {
        const map = {};
        for (const r of rows) {
          const v = r[key] ?? '(unknown)';
          map[v] = (map[v] || 0) + 1;
        }
        return map;
      };
      res.set('Cache-Control', 'public, max-age=60');
      res.json({
        total: rows.length,
        publishedCount: rows.filter((r) => r.isPublished).length,
        byStatus: countBy('status'),
        byOwnerType: countBy('ownerType'),
        byCategory: countBy('category'),
        bySubcategory: countBy('subcategory'),
        sapVsCommunity: {
          sap: rows.filter((r) => r.isSapOwned).length,
          community: rows.filter((r) => !r.isSapOwned).length,
        },
        activeVsInactive: {
          active: rows.filter((r) => r.status === 'Active').length,
          inactive: rows.filter((r) => r.status !== 'Active').length,
        },
        buildAt: new Date().toISOString(),
      });
    } catch (err) {
      console.error('[build/channels-stats]', err.message);
      res.status(500).json({ error: err.message });
    }
  });
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest --project unit run test/channels-stats.test.js
```

Expected: PASS (3 tests).

- [ ] **Step 5: Add channels-stats to the approuter allowlist**

In `approuter/xs-app.json`, find the route at approximately line 411:

```json
"source": "^/build/(breadcrumb-context|catalog|co-completions|concepts|homepage-shelves|kg-stats|mission|my-progress|navigator|repo-catalog|slug-mapping|tag-labels|topics-gallery|topics-tree|topics)(/.*)?(\\?.*)?$"
```

Change it to (add `channels-stats|channels|channel-collections|channel-atlas` before `breadcrumb-context`):

```json
"source": "^/build/(channels-stats|channels|channel-collections|channel-atlas|breadcrumb-context|catalog|co-completions|concepts|homepage-shelves|kg-stats|mission|my-progress|navigator|repo-catalog|slug-mapping|tag-labels|topics-gallery|topics-tree|topics)(/.*)?(\\?.*)?$"
```

> **Why channels and channel-collections too?** They are public build-time endpoints registered before the `basicAuthMiddleware` barrier in `srv/server.js`. Adding them here ensures `check-public-endpoints.ts` (run in `postbuild:apps`) finds a named route with `authenticationType:none` as the first match, rather than relying on the static catch-all.

- [ ] **Step 6: Create scripts/fetch-channels-stats.ts**

Create `scripts/fetch-channels-stats.ts`:

```typescript
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const CAP_BASE = process.env.CAP_BASE_URL || 'http://localhost:4004';
const OUT_PATH = join('hugo', 'data', 'channels-stats.json');

let payload: {
  total: number; publishedCount: number;
  byStatus: Record<string, number>; byOwnerType: Record<string, number>;
  byCategory: Record<string, number>; bySubcategory: Record<string, number>;
  sapVsCommunity: { sap: number; community: number };
  activeVsInactive: { active: number; inactive: number };
  buildAt: string; error: string | null;
} = {
  total: 0, publishedCount: 0,
  byStatus: {}, byOwnerType: {},
  byCategory: {}, bySubcategory: {},
  sapVsCommunity: { sap: 0, community: 0 },
  activeVsInactive: { active: 0, inactive: 0 },
  buildAt: new Date().toISOString(), error: null,
};

try {
  const res = await fetch(`${CAP_BASE}/build/channels-stats`);
  if (!res.ok) throw new Error(`status ${res.status}`);
  payload = { ...payload, ...(await res.json()) };
} catch (err) {
  payload.error = err instanceof Error ? err.message : String(err);
  console.warn(`[fetch-channels-stats] warn: ${payload.error} — writing empty payload`);
}

mkdirSync(join('hugo', 'data'), { recursive: true });
writeFileSync(OUT_PATH, JSON.stringify(payload, null, 2), 'utf-8');
console.log(`[fetch-channels-stats] wrote stats (total=${payload.total}) → ${OUT_PATH}`);
```

- [ ] **Step 7: Add npm script and wire into build:all**

In `package.json`:

1. Add the script alongside the other `fetch-*` scripts:
```json
"fetch-channels-stats": "tsx scripts/fetch-channels-stats.ts",
```

2. In the `build:all` value, add `&& npm run fetch-channels-stats` immediately after `&& npm run fetch-channel-collections`:

Before:
```
... && npm run fetch-channels && npm run fetch-channel-collections && npm run fetch-verb-definitions && ...
```

After:
```
... && npm run fetch-channels && npm run fetch-channel-collections && npm run fetch-channels-stats && npm run fetch-verb-definitions && ...
```

- [ ] **Step 8: Verify the fetch script runs against local cds watch**

With `cds watch` running in a separate terminal:

```bash
npx tsx scripts/fetch-channels-stats.ts
```

Expected: `hugo/data/channels-stats.json` written with `total >= 0` and no `error` key.

If `cds watch` is not running, the script writes an empty payload and logs a warning — that is the intended fail-open behavior.

- [ ] **Step 9: Commit**

```bash
git add srv/server.js \
        approuter/xs-app.json \
        scripts/fetch-channels-stats.ts \
        package.json \
        test/channels-stats.test.js
git commit -m "feat(channels): add /build/channels-stats endpoint, fetch script, and approuter route"
```

---

## Task 3: Hugo Health Page (Content + Layout)

**Files:**
- Create: `hugo/content/channels/health/_index.md`
- Create: `hugo/layouts/channels/health.html`

**Interfaces:**
- Consumes: `hugo/data/channels-stats.json` (written by `fetch-channels-stats.ts`) — accessed in Hugo as `site.Data.channels_stats` (Hugo converts hyphens to underscores)
- Produces: static page at `/channels/health/` with `<script id="channels-stats-data" type="application/json">` injected; `<div data-island="channels-health">` mount point

- [ ] **Step 1: Create the Hugo content file**

Create `hugo/content/channels/health/_index.md`:

```markdown
---
title: "Channel Ecosystem Health"
description: "Active-vs-inactive breakdown, SAP-vs-community split, and category coverage across the SAP developer channel landscape."
layout: "health"
---
```

- [ ] **Step 2: Create the Hugo layout file**

Create `hugo/layouts/channels/health.html`:

```html
{{ define "main" }}
{{- $stats := .Site.Data.channels_stats | default dict -}}
<section class="channels-health-page">
  <header class="channels-health-page__intro">
    <h1>{{ .Title }}</h1>
    <p>{{ .Description }}</p>
  </header>
  <script id="channels-stats-data" type="application/json">{{ $stats | jsonify | safeJS }}</script>
  <div data-island="channels-health"></div>
  <noscript>
    <p>Total channels: {{ $stats.total | default 0 }}</p>
    <p>Published: {{ $stats.publishedCount | default 0 }}</p>
  </noscript>
</section>
<script type="module" src="{{ partial "island-src.html" "channels-health" }}"></script>
{{ end }}
```

> **Hugo data access note:** `hugo/data/channels-stats.json` → `site.Data.channels_stats` (Hugo auto-converts hyphens to underscores in data filenames). The `island-src.html` partial resolves the content-hashed path from `island_manifest.json`; it falls back to `/js/channels-health.js` when the manifest key is absent (local `hugo server` before Vite runs).

- [ ] **Step 3: Verify Hugo renders the page**

With `cds watch` and `hugo server --source hugo` running:

```bash
curl -sI http://localhost:1313/channels/health/
```

Expected: HTTP 200. Also verify the page source contains `channels-stats-data` script block.

- [ ] **Step 4: Commit**

```bash
git add hugo/content/channels/health/_index.md \
        hugo/layouts/channels/health.html
git commit -m "feat(channels): add Hugo health page content and layout"
```

---

## Task 4: channels-health Vue Island

**Files:**
- Create: `hugo-apps/src/channels-health/index.ts`
- Create: `hugo-apps/src/channels-health/ChannelsHealth.vue`
- Create: `hugo-apps/src/channels-health/ChannelsHealth.test.ts`
- Modify: `hugo-apps/vite.config.ts` (add `channels-health` entry)

**Interfaces:**
- Consumes: `ChannelsStats` prop (see payload contract above) — injected from `#channels-stats-data`
- Produces: island named `channels-health` registered in Vite and the island manifest

- [ ] **Step 1: Write the failing tests**

Create `hugo-apps/src/channels-health/ChannelsHealth.test.ts`:

```typescript
// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import ChannelsHealth from './ChannelsHealth.vue';

const SAMPLE_STATS = {
  total: 150,
  publishedCount: 120,
  byStatus: { Active: 110, Archived: 30, Closed: 10 },
  byOwnerType: { SAP_Official: 50, Community_Member: 80, SAP_Developer_Advocate: 20 },
  byCategory: { Documentation: 45, Community: 60, 'Developer Tools': 45 },
  bySubcategory: { 'API Docs': 20, Forum: 30 },
  sapVsCommunity: { sap: 70, community: 80 },
  activeVsInactive: { active: 110, inactive: 40 },
  buildAt: '2026-09-05T10:00:00.000Z',
  error: null,
};

describe('ChannelsHealth', () => {
  it('renders the total channel count', () => {
    const wrapper = mount(ChannelsHealth, { props: { stats: SAMPLE_STATS } });
    expect(wrapper.text()).toContain('150');
  });

  it('renders active vs inactive counts', () => {
    const wrapper = mount(ChannelsHealth, { props: { stats: SAMPLE_STATS } });
    expect(wrapper.text()).toContain('110');
    expect(wrapper.text()).toContain('40');
  });

  it('renders SAP vs community counts', () => {
    const wrapper = mount(ChannelsHealth, { props: { stats: SAMPLE_STATS } });
    expect(wrapper.text()).toContain('70');
    expect(wrapper.text()).toContain('80');
  });

  it('renders status breakdown entries', () => {
    const wrapper = mount(ChannelsHealth, { props: { stats: SAMPLE_STATS } });
    expect(wrapper.text()).toContain('Active');
    expect(wrapper.text()).toContain('Archived');
  });

  it('renders category coverage entries', () => {
    const wrapper = mount(ChannelsHealth, { props: { stats: SAMPLE_STATS } });
    expect(wrapper.text()).toContain('Documentation');
    expect(wrapper.text()).toContain('Community');
  });

  it('does NOT render any panel referencing linkStatus, lastChecked, or updateFrequency', () => {
    const wrapper = mount(ChannelsHealth, { props: { stats: SAMPLE_STATS } });
    const html = wrapper.html();
    expect(html).not.toMatch(/linkStatus/i);
    expect(html).not.toMatch(/lastChecked/i);
    expect(html).not.toMatch(/updateFrequency/i);
    expect(html).not.toMatch(/link status/i);
    expect(html).not.toMatch(/last checked/i);
    expect(html).not.toMatch(/update frequency/i);
  });

  it('shows empty-state message when stats.total is 0', () => {
    const empty = { ...SAMPLE_STATS, total: 0, publishedCount: 0, byStatus: {}, byOwnerType: {}, byCategory: {}, bySubcategory: {}, sapVsCommunity: { sap: 0, community: 0 }, activeVsInactive: { active: 0, inactive: 0 } };
    const wrapper = mount(ChannelsHealth, { props: { stats: empty } });
    expect(wrapper.text()).toMatch(/no channel data|loading|stats not/i);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest --project unit run hugo-apps/src/channels-health/ChannelsHealth.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Add channels-health entry to vite.config.ts**

In `hugo-apps/vite.config.ts`, inside `rollupOptions.input`, add after the `'channel-submit'` entry:

```typescript
'channels-health': resolve(__dirname, 'src/channels-health/index.ts'),
```

- [ ] **Step 4: Create the island entry index.ts**

Create `hugo-apps/src/channels-health/index.ts`:

```typescript
import { createApp } from 'vue';
import ChannelsHealth from './ChannelsHealth.vue';

function boot() {
  document.querySelectorAll('[data-island="channels-health"]').forEach((el) => {
    const dataEl = document.getElementById('channels-stats-data');
    let stats: Record<string, unknown> = {};
    try { stats = JSON.parse(dataEl?.textContent || '{}'); } catch { stats = {}; }
    createApp(ChannelsHealth, { stats }).mount(el);
  });
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
```

- [ ] **Step 5: Create ChannelsHealth.vue**

Create `hugo-apps/src/channels-health/ChannelsHealth.vue`:

```vue
<script setup lang="ts">
import { computed } from 'vue';

interface ChannelsStats {
  total?: number;
  publishedCount?: number;
  byStatus?: Record<string, number>;
  byOwnerType?: Record<string, number>;
  byCategory?: Record<string, number>;
  bySubcategory?: Record<string, number>;
  sapVsCommunity?: { sap: number; community: number };
  activeVsInactive?: { active: number; inactive: number };
  buildAt?: string;
  error?: string | null;
}

const props = defineProps<{ stats: ChannelsStats }>();

const isEmpty = computed(() => !props.stats?.total);

const statusEntries = computed(() =>
  Object.entries(props.stats?.byStatus ?? {}).sort((a, b) => b[1] - a[1]),
);
const ownerTypeEntries = computed(() =>
  Object.entries(props.stats?.byOwnerType ?? {}).sort((a, b) => b[1] - a[1]),
);
const categoryEntries = computed(() =>
  Object.entries(props.stats?.byCategory ?? {}).sort((a, b) => b[1] - a[1]),
);
</script>

<template>
  <div class="channels-health">
    <p v-if="isEmpty" class="channels-health__empty">No channel data available yet.</p>
    <template v-else>
      <!-- Summary row -->
      <div class="health-summary">
        <div class="health-stat">
          <span class="health-stat__value">{{ stats.total ?? 0 }}</span>
          <span class="health-stat__label">Total channels</span>
        </div>
        <div class="health-stat">
          <span class="health-stat__value">{{ stats.publishedCount ?? 0 }}</span>
          <span class="health-stat__label">Published</span>
        </div>
        <div class="health-stat">
          <span class="health-stat__value">{{ stats.activeVsInactive?.active ?? 0 }}</span>
          <span class="health-stat__label">Active</span>
        </div>
        <div class="health-stat">
          <span class="health-stat__value">{{ stats.activeVsInactive?.inactive ?? 0 }}</span>
          <span class="health-stat__label">Inactive</span>
        </div>
        <div class="health-stat">
          <span class="health-stat__value">{{ stats.sapVsCommunity?.sap ?? 0 }}</span>
          <span class="health-stat__label">SAP-owned</span>
        </div>
        <div class="health-stat">
          <span class="health-stat__value">{{ stats.sapVsCommunity?.community ?? 0 }}</span>
          <span class="health-stat__label">Community</span>
        </div>
      </div>

      <!-- Status breakdown -->
      <section class="health-panel">
        <h2 class="health-panel__title">By Status</h2>
        <ul class="health-panel__list">
          <li v-for="[status, count] in statusEntries" :key="status" class="health-panel__row">
            <span class="health-panel__name">{{ status }}</span>
            <span class="health-panel__count">{{ count }}</span>
          </li>
        </ul>
      </section>

      <!-- Category coverage -->
      <section class="health-panel">
        <h2 class="health-panel__title">By Category</h2>
        <ul class="health-panel__list">
          <li v-for="[category, count] in categoryEntries" :key="category" class="health-panel__row">
            <span class="health-panel__name">{{ category }}</span>
            <span class="health-panel__count">{{ count }}</span>
          </li>
        </ul>
      </section>

      <!-- Owner type breakdown -->
      <section class="health-panel">
        <h2 class="health-panel__title">By Owner Type</h2>
        <ul class="health-panel__list">
          <li v-for="[ownerType, count] in ownerTypeEntries" :key="ownerType" class="health-panel__row">
            <span class="health-panel__name">{{ ownerType.replace(/_/g, ' ') }}</span>
            <span class="health-panel__count">{{ count }}</span>
          </li>
        </ul>
      </section>

      <p v-if="stats.buildAt" class="health-footer">
        Stats as of {{ new Date(stats.buildAt).toLocaleDateString() }}
      </p>
    </template>
  </div>
</template>

<style scoped>
.channels-health {
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}
.channels-health__empty {
  color: var(--sapNeutralTextColor, #556b82);
}
.health-summary {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(8rem, 1fr));
  gap: 0.75rem;
}
.health-stat {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 0.875rem;
  border: 1px solid var(--sapList_BorderColor, #d9d9d9);
  border-radius: var(--sapElement_BorderCornerRadius, 0.75rem);
  background: var(--sapGroup_ContentBackground, #fff);
}
.health-stat__value {
  font-size: 1.75rem;
  font-weight: 700;
  color: var(--sapAccentColor6, #0064d9);
}
.health-stat__label {
  font-size: 0.8125rem;
  color: var(--sapNeutralTextColor, #556b82);
  text-align: center;
}
.health-panel {
  padding: 1rem 1.25rem;
  border: 1px solid var(--sapList_BorderColor, #d9d9d9);
  border-radius: var(--sapElement_BorderCornerRadius, 0.75rem);
  background: var(--sapGroup_ContentBackground, #fff);
}
.health-panel__title {
  margin: 0 0 0.75rem;
  font-size: 1rem;
  font-weight: 600;
  color: var(--sapGroup_TitleTextColor, #1d2d3e);
}
.health-panel__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
}
.health-panel__row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.25rem 0;
  border-bottom: 1px solid var(--sapList_BorderColor, #d9d9d9);
  font-size: 0.9375rem;
}
.health-panel__row:last-child {
  border-bottom: none;
}
.health-panel__name {
  color: var(--sapTextColor, #1d2d3e);
}
.health-panel__count {
  font-weight: 600;
  color: var(--sapAccentColor6, #0064d9);
}
.health-footer {
  font-size: 0.8125rem;
  color: var(--sapNeutralTextColor, #556b82);
  margin: 0;
}
</style>
```

- [ ] **Step 6: Run tests to verify they pass**

```bash
npx vitest --project unit run hugo-apps/src/channels-health/ChannelsHealth.test.ts
```

Expected: PASS (7 tests).

- [ ] **Step 7: Commit**

```bash
git add hugo-apps/src/channels-health/ \
        hugo-apps/vite.config.ts
git commit -m "feat(channels): add channels-health Vue island and register in Vite"
```

---

## Task 5: Hugo Media-Diet Page (Content + Layout)

**Files:**
- Create: `hugo/content/channels/media-diet/_index.md`
- Create: `hugo/layouts/channels/media-diet.html`

**Interfaces:**
- Consumes: `hugo/data/channels.json` (already baked by `fetch-channels`) — accessed as `site.Data.channels.channels` (array of Channel objects)
- Produces: static page at `/channels/media-diet/` with `<script id="channels-data" type="application/json">` injected; `<div data-island="media-diet">` mount point

> **Note:** The media-diet layout reuses the SAME `#channels-data` script block id and `channels.json` data file as the existing channels directory. This avoids a second JSON injection of the same data. The island reads from `#media-diet-channels-data` to avoid id collision with the channels-directory island's `#channels-data` — see below.

- [ ] **Step 1: Create the Hugo content file**

Create `hugo/content/channels/media-diet/_index.md`:

```markdown
---
title: "Build Your Media Diet"
description: "Pick 1–3 focus areas and get a personalized bundle of SAP developer channels to follow."
layout: "media-diet"
---
```

- [ ] **Step 2: Create the Hugo layout file**

Create `hugo/layouts/channels/media-diet.html`:

```html
{{ define "main" }}
{{- $channels := (.Site.Data.channels.channels) | default slice -}}
<section class="media-diet-page">
  <header class="media-diet-page__intro">
    <h1>{{ .Title }}</h1>
    <p>{{ .Description }}</p>
  </header>
  <script id="media-diet-channels-data" type="application/json">{{ $channels | jsonify | safeJS }}</script>
  <div data-island="media-diet"></div>
  <noscript>
    <p>Enable JavaScript to use the media-diet picker.</p>
  </noscript>
</section>
<script type="module" src="{{ partial "island-src.html" "media-diet" }}"></script>
{{ end }}
```

> **Why a different script id (`media-diet-channels-data`) rather than `channels-data`?** The channels-directory island's `index.ts` reads from `#channels-data`. This page does not include the channels-directory island, but using the same id risks confusion and would conflict if both islands ever appear on the same page. The media-diet island reads `#media-diet-channels-data`.

- [ ] **Step 3: Verify Hugo renders the page**

With `hugo server --source hugo` running:

```bash
curl -sI http://localhost:1313/channels/media-diet/
```

Expected: HTTP 200 with `media-diet-channels-data` in page source.

- [ ] **Step 4: Commit**

```bash
git add hugo/content/channels/media-diet/_index.md \
        hugo/layouts/channels/media-diet.html
git commit -m "feat(channels): add Hugo media-diet page content and layout"
```

---

## Task 6: media-diet Vue Island

**Files:**
- Create: `hugo-apps/src/media-diet/index.ts`
- Create: `hugo-apps/src/media-diet/MediaDiet.vue`
- Create: `hugo-apps/src/media-diet/MediaDiet.test.ts`
- Modify: `hugo-apps/vite.config.ts` (add `media-diet` entry)

**Interfaces:**
- Consumes: `channels: Channel[]` prop — the published Channel objects from `channels.json`. Relevant fields: `name`, `url`, `purpose`, `focusAreas` (string[] parsed from HANA JSON NCLOB by fetch-channels; arrives as a JS array in the baked JSON).
- Produces: island named `media-diet` registered in Vite and island manifest

> **Phase 2 seam (documented, not implemented):** After the `// PHASE 2 SEAM` comment in `MediaDiet.vue`, signed-in path would probe `GET /auth/user`, check `body.authenticated === true` (NOT `r.ok`), then call `GET /api/media-diet/my-picks` to get completion-inferred channels. The anon picker shown here is the complete Phase 1 experience.

- [ ] **Step 1: Write the failing tests**

Create `hugo-apps/src/media-diet/MediaDiet.test.ts`:

```typescript
// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import MediaDiet from './MediaDiet.vue';

const CHANNELS = [
  { name: 'SAP Learning', url: 'https://learning.sap.com', purpose: 'Official SAP learning portal', focusAreas: ['CAP', 'BTP'] },
  { name: 'SAP Community', url: 'https://community.sap.com', purpose: 'Discussion forums', focusAreas: ['BTP', 'ABAP'] },
  { name: 'SAP YouTube', url: 'https://youtube.com/sapdevs', purpose: 'Video tutorials', focusAreas: ['CAP', 'ABAP', 'BTP'] },
  { name: 'HANA Academy', url: 'https://hana.academy', purpose: 'HANA deep-dives', focusAreas: ['HANA'] },
];

describe('MediaDiet', () => {
  it('renders a list of unique focus areas for selection', () => {
    const wrapper = mount(MediaDiet, { props: { channels: CHANNELS } });
    const text = wrapper.text();
    expect(text).toContain('CAP');
    expect(text).toContain('BTP');
    expect(text).toContain('ABAP');
    expect(text).toContain('HANA');
  });

  it('filters channels client-side when a focus area is selected', async () => {
    const wrapper = mount(MediaDiet, { props: { channels: CHANNELS } });
    // Find the CAP focus area button/checkbox and click it
    const capToggle = wrapper.findAll('[data-focus-area]').find((el) =>
      el.text().includes('CAP'),
    );
    expect(capToggle).toBeDefined();
    await capToggle!.trigger('click');
    // After selecting CAP: SAP Learning, SAP YouTube should appear; HANA Academy should not
    const results = wrapper.find('[data-testid="results"]');
    expect(results.text()).toContain('SAP Learning');
    expect(results.text()).toContain('SAP YouTube');
    expect(results.text()).not.toContain('HANA Academy');
  });

  it('shows no more than 12 results', () => {
    const manyChannels = Array.from({ length: 20 }, (_, i) => ({
      name: `Channel ${i}`, url: `https://ch${i}.example`, purpose: `Purpose ${i}`,
      focusAreas: ['BTP'],
    }));
    const wrapper = mount(MediaDiet, { props: { channels: manyChannels } });
    const btpToggle = wrapper.findAll('[data-focus-area]').find((el) =>
      el.text().includes('BTP'),
    );
    expect(btpToggle).toBeDefined();
    btpToggle!.trigger('click');
    // Results should be capped at 12
    const resultItems = wrapper.findAll('[data-testid="result-item"]');
    expect(resultItems.length).toBeLessThanOrEqual(12);
  });

  it('ranks results by match count descending', async () => {
    const wrapper = mount(MediaDiet, { props: { channels: CHANNELS } });
    // Select both CAP and ABAP
    for (const label of ['CAP', 'ABAP']) {
      const toggle = wrapper.findAll('[data-focus-area]').find((el) => el.text().includes(label));
      if (toggle) await toggle.trigger('click');
    }
    const resultItems = wrapper.findAll('[data-testid="result-item"]');
    // SAP YouTube matches both CAP + ABAP (count=2) → should appear before single-match channels
    const names = resultItems.map((el) => el.find('.media-diet-result__name').text());
    const ytIndex = names.indexOf('SAP YouTube');
    const learningIndex = names.indexOf('SAP Learning'); // only CAP
    const communityIndex = names.indexOf('SAP Community'); // only ABAP
    expect(ytIndex).toBeLessThan(learningIndex);
    expect(ytIndex).toBeLessThan(communityIndex);
  });

  it('allows at most 3 focus areas selected simultaneously', async () => {
    const wrapper = mount(MediaDiet, { props: { channels: CHANNELS } });
    const toggles = wrapper.findAll('[data-focus-area]');
    // Click all 4 focus areas
    for (const toggle of toggles) await toggle.trigger('click');
    const selected = wrapper.findAll('[data-focus-area][aria-pressed="true"]');
    expect(selected.length).toBeLessThanOrEqual(3);
  });

  it('shows empty-state prompt when no focus area is selected', () => {
    const wrapper = mount(MediaDiet, { props: { channels: CHANNELS } });
    expect(wrapper.text()).toMatch(/pick|select|choose/i);
    const results = wrapper.findAll('[data-testid="result-item"]');
    expect(results).toHaveLength(0);
  });

  it('handles channels with no focusAreas gracefully', () => {
    const sparse = [
      { name: 'Sparse', url: 'https://sparse.example', purpose: 'No focus areas', focusAreas: undefined },
      ...CHANNELS,
    ];
    const wrapper = mount(MediaDiet, { props: { channels: sparse as any } });
    // Should not throw — focus areas list excludes the sparse channel
    expect(wrapper.text()).toContain('CAP');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest --project unit run hugo-apps/src/media-diet/MediaDiet.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Add media-diet entry to vite.config.ts**

In `hugo-apps/vite.config.ts`, inside `rollupOptions.input`, add after the `'channels-health'` entry from Task 4:

```typescript
'media-diet': resolve(__dirname, 'src/media-diet/index.ts'),
```

- [ ] **Step 4: Create the island entry index.ts**

Create `hugo-apps/src/media-diet/index.ts`:

```typescript
import { createApp } from 'vue';
import MediaDiet from './MediaDiet.vue';

function boot() {
  document.querySelectorAll('[data-island="media-diet"]').forEach((el) => {
    const dataEl = document.getElementById('media-diet-channels-data');
    let channels: unknown[] = [];
    try { channels = JSON.parse(dataEl?.textContent || '[]'); } catch { channels = []; }
    // PHASE 2 SEAM: signed-in path would check /auth/user here (body.authenticated === true,
    // NOT r.ok), then call GET /api/media-diet/my-picks to infer channels from completions.
    // The anon picker (channels prop) is the complete Phase 1 experience.
    createApp(MediaDiet, { channels }).mount(el);
  });
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
```

- [ ] **Step 5: Create MediaDiet.vue**

Create `hugo-apps/src/media-diet/MediaDiet.vue`:

```vue
<script setup lang="ts">
import { ref, computed } from 'vue';

interface Channel {
  name: string;
  url: string;
  purpose?: string;
  focusAreas?: string[];
}

const props = defineProps<{ channels: Channel[] }>();

const MAX_SELECTED = 3;
const MAX_RESULTS = 12;

// Derive unique, sorted focus areas from the channels array.
const focusAreas = computed(() => {
  const set = new Set<string>();
  for (const ch of props.channels) {
    for (const f of ch.focusAreas ?? []) set.add(f);
  }
  return [...set].sort();
});

const selected = ref<Set<string>>(new Set());

function toggle(area: string) {
  const next = new Set(selected.value);
  if (next.has(area)) {
    next.delete(area);
  } else if (next.size < MAX_SELECTED) {
    next.add(area);
  }
  selected.value = next;
}

// Filter channels by any selected focus area, rank by match count descending, cap at 12.
const results = computed(() => {
  if (selected.value.size === 0) return [];
  return props.channels
    .map((ch) => {
      const matchCount = (ch.focusAreas ?? []).filter((f) => selected.value.has(f)).length;
      return { ch, matchCount };
    })
    .filter(({ matchCount }) => matchCount > 0)
    .sort((a, b) => b.matchCount - a.matchCount)
    .slice(0, MAX_RESULTS)
    .map(({ ch }) => ch);
});
</script>

<template>
  <div class="media-diet">
    <p class="media-diet__instruction">
      Pick up to {{ MAX_SELECTED }} focus areas to get a personalized channel bundle.
    </p>
    <ul class="media-diet__areas">
      <li v-for="area in focusAreas" :key="area">
        <button
          class="focus-area-btn"
          :class="{ 'focus-area-btn--selected': selected.has(area) }"
          :aria-pressed="selected.has(area)"
          :disabled="!selected.has(area) && selected.size >= MAX_SELECTED"
          data-focus-area
          @click="toggle(area)"
        >{{ area }}</button>
      </li>
    </ul>

    <p v-if="selected.size === 0" class="media-diet__prompt">
      Select at least one focus area to see recommended channels.
    </p>

    <ul v-else class="media-diet__results">
      <li v-for="ch in results" :key="ch.url" class="media-diet-result" data-testid="result-item">
        <a :href="ch.url" target="_blank" rel="noopener" class="media-diet-result__name">{{ ch.name }}</a>
        <p v-if="ch.purpose" class="media-diet-result__purpose">{{ ch.purpose }}</p>
      </li>
    </ul>

    <p v-if="selected.size > 0 && results.length === 0" class="media-diet__empty">
      No published channels match the selected focus areas yet.
    </p>

    <!-- PHASE 2 SEAM: export button (bookmarks + OPML) and signed-in inferred picks go here -->
  </div>
</template>

<style scoped>
.media-diet {
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}
.media-diet__instruction {
  margin: 0;
  color: var(--sapNeutralTextColor, #556b82);
}
.media-diet__areas {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}
.focus-area-btn {
  padding: 0.375rem 0.875rem;
  border: 1px solid var(--sapButton_BorderColor, #0070f2);
  border-radius: 1rem;
  background: transparent;
  color: var(--sapButton_TextColor, #0070f2);
  font: inherit;
  font-size: 0.875rem;
  cursor: pointer;
  transition: background 0.1s;
}
.focus-area-btn:hover:not(:disabled) {
  background: var(--sapButton_Hover_Background, #ebf3ff);
}
.focus-area-btn--selected {
  background: var(--sapButton_Active_Background, #0070f2);
  color: var(--sapButton_Active_TextColor, #fff);
}
.focus-area-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.media-diet__prompt,
.media-diet__empty {
  margin: 0;
  color: var(--sapNeutralTextColor, #556b82);
}
.media-diet__results {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(18rem, 1fr));
  gap: 0.75rem;
}
.media-diet-result {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
  padding: 0.875rem 1rem;
  border: 1px solid var(--sapList_BorderColor, #d9d9d9);
  border-radius: var(--sapElement_BorderCornerRadius, 0.75rem);
  background: var(--sapGroup_ContentBackground, #fff);
}
.media-diet-result__name {
  font-weight: 600;
  color: var(--sapLinkColor, #0070f2);
  text-decoration: none;
}
.media-diet-result__name:hover {
  text-decoration: underline;
}
.media-diet-result__purpose {
  margin: 0;
  font-size: 0.875rem;
  color: var(--sapTextColor, #1d2d3e);
}
</style>
```

- [ ] **Step 6: Run tests to verify they pass**

```bash
npx vitest --project unit run hugo-apps/src/media-diet/MediaDiet.test.ts
```

Expected: PASS (7 tests). If the rank-ordering test flakes on tied matches, ensure the `sort` is stable — add a secondary sort on `ch.name` if needed.

- [ ] **Step 7: Run full unit suite to catch regressions**

```bash
npm test
```

Expected: all previously-passing tests still pass; new tests pass.

- [ ] **Step 8: Commit**

```bash
git add hugo-apps/src/media-diet/ \
        hugo-apps/vite.config.ts
git commit -m "feat(channels): add media-diet Vue island and register in Vite"
```

---

## Self-Review

### Spec coverage check

| Spec requirement | Task |
|---|---|
| Hub band: one-paragraph explainer + 4 linked cards above filter/grid | Task 1 |
| Card icons already registered (org-chart, chain-link, sys-monitor, favorite) | Task 1 — verified in ui5-core.ts, no change needed |
| No new route for hub band | Task 1 — verified (no route added) |
| `/channels/health/` Hugo page + Vue island fed by `/build/channels-stats` | Tasks 2–4 |
| v1 metrics use only reliable fields (status, ownerType, category, subcategory, isSapOwned, isPublished) | Task 2 |
| Explicitly exclude linkStatus, lastChecked, updateFrequency | Task 2 (endpoint + test assertion) + Task 4 (island test) |
| Approuter route for `/build/channels-stats` | Task 2 Step 5 |
| `fetch-channels-stats.ts` → `hugo/data/channels-stats.json` | Task 2 |
| Wire `fetch-channels-stats` into `build:all` | Task 2 |
| `/channels/media-diet/` Hugo page + Vue island | Tasks 5–6 |
| Derive unique focusAreas client-side, user picks 1–3 | Task 6 |
| Filter `channels.filter(c => c.focusAreas?.some(f => selected.includes(f)))` ranked by match count, cap ~12 | Task 6 |
| Document Phase 2 seam (signed-in path, /auth/user probe with body.authenticated check) | Task 6 (PHASE 2 SEAM comments) |
| Unit tests for hub band, health island, media-diet island | Tasks 1, 4, 6 |
| Unit test asserting stats payload does NOT reference excluded fields | Task 2 (server-side test) + Task 4 (island test) |
| `ignore-scripts=true` — island-manifest is explicit build:all step | Task 2 wires the script; island-manifest step already exists in build:all |
| Target branch DEV, PR not direct-merge | Global constraint, confirmed — no merge steps in plan |

### Placeholder scan

No TBD, TODO, "implement later", or "fill in details" phrases found in any step. All code blocks are complete.

### Type consistency check

- `ChannelsStats` interface defined once in the payload contract section and matched in `ChannelsHealth.vue`.
- `Channel` interface in `MediaDiet.vue` matches the shape of the baked `channels.json` (`name`, `url`, `purpose`, `focusAreas`).
- Script block id `channels-stats-data` used in both `health.html` (Step 2) and `channels-health/index.ts` (Step 4).
- Script block id `media-diet-channels-data` used in both `media-diet.html` (Step 2) and `media-diet/index.ts` (Step 4).
- Data attribute `data-island="channels-health"` matches between `health.html` and `channels-health/index.ts`.
- Data attribute `data-island="media-diet"` matches between `media-diet.html` and `media-diet/index.ts`.
- `data-focus-area` attribute and `[aria-pressed="true"]` test selectors match the Vue template.
- `data-testid="result-item"` and `data-testid="results"` match between tests and template.
- Vite entry names `channels-health` and `media-diet` match the island-src.html partial calls in the layouts.
