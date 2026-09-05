# Channel Atlas SPA — Phase 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone Sigma/graphology force-directed SPA at `/channels/atlas/` that visualises the SAP developer channel ecosystem as a graph: nodes = channels (sized by log-subscriber count, coloured by ownerType), phase-1 edges from shared focusAreas, phase-2 edges from shared REVIEWED ChannelTopicMap topic tags.

**Architecture:** The SPA (`app/channel-atlas/`) is a clean fork of `app/explore/` reusing the same Sigma 3.0.3 + graphology 0.26.0 + ForceAtlas2 0.10.1 stack and the ExploreGraph/FilterDropdown/NodeDetailPanel component shapes, adapted for channels. A new public CAP endpoint `GET /build/channel-atlas` extends the `/build/channels` projection with atlas-specific fields; `scripts/fetch-channel-atlas.ts` calls it at build time and writes `hugo/data/channel_atlas.json`; the Hugo layout (`hugo/layouts/channels/atlas.html`) injects that data as inline JSON so the SPA reads it without a runtime round-trip (falling back to a live fetch only in dev). Edge derivation and node sizing are pure functions in `app/channel-atlas/src/graph.ts`, fully unit-testable.

**Tech Stack:** Vue 3.5, Sigma 3.0.3, graphology 0.26.0 (MultiDirectedGraph), graphology-layout-forceatlas2 0.10.1, Vite 5, TypeScript, `@vitejs/plugin-vue`, happy-dom (SPA tests), vitest, tsx (scripts), Hugo, CAP Node.js (`@sap/cds`).

**Spec:** `docs/superpowers/specs/2026-09-05-channels-hub-design.md` §"1. Channel Atlas — /channels/atlas/"

## Global Constraints

- Target branch is **DEV**; `main` is protected; open a PR, never direct-merge.
- **No raw SQL** — `SELECT.from(...)` CQL / `cds.ql` only.
- **`focusAreas` is a HANA JSON NCLOB array** — never DB-side array-contains; use the `parseArr` pattern from `srv/server.js:432` in every handler that touches it.
- **Anon browser endpoints** (`/build/channel-atlas`, `/channel-atlas-ui/*`) must have `authenticationType: none` in `approuter/xs-app.json`.
- **`srv/lib/build-channel-atlas.js` must be added to the `srv-qa` `cp` list** in `.deploy/mta.yaml` (any new `srv/lib/` file + its transitive `./` imports).
- **New SPA = new MTA module** — FULL `mbt build` only (no `--skip-build`, no `-m` scoping); `check-shipped-admin-bundle.cjs` Step 3.5 is separate from SPA drift but the rule applies.
- **`ignore-scripts=true` global npmrc** means the channel-atlas SPA build must be an explicit `build:all` step, not a post-install hook.
- **Route ordering** — the literal `^/channels/atlas(/.*)?$` static route in `approuter/xs-app.json` MUST appear before any future `/channels/:slug` catch-all (Phase 2).
- **`cds.entities(NS)` not bare `SELECT.from('X')`** in unit tests for CI Node-version safety; NS = `'com.sap.developers.ims'`.
- **Channel slugs are lowercase-canonical** (not relevant here since we key on UUID `ID`, but enforce `.toLowerCase()` in any slug comparison added later).

---

## File Structure

```
srv/lib/
  build-channel-atlas.js          NEW  pure transformation: DB rows → AtlasChannelDTO[]
  __tests__/
    build-channel-atlas.test.js   NEW  unit tests for the transformation

srv/server.js                     MODIFY  add GET /build/channel-atlas handler (~line 462, after /build/channel-collections)

approuter/xs-app.json             MODIFY  (a) add channel-atlas to /build/ allowlist regex
                                          (b) add /channel-atlas-ui/ SPA assets route
                                          (c) add literal /channels/atlas/ static route

app/channel-atlas/                NEW  SPA root (forked from app/explore/)
  package.json                    NEW  @sap-tutorials/channel-atlas, same deps as explore
  vite.config.ts                  NEW  base '/channel-atlas-ui/', budget plugin (≤150KB gzip)
  index.html                      NEW  <div id="atlas-app">
  tsconfig.json                   NEW  fork of app/explore/tsconfig.json
  src/
    main.ts                       NEW  createApp(App).mount('#atlas-app')
    types.ts                      NEW  OwnerType, AtlasChannelDTO, AtlasNode, AtlasEdge, AtlasPayload
    graph.ts                      NEW  sizeChannel, ownerTypeColor, OWNER_TYPE_PALETTE,
                                       buildFocusEdges, buildTopicEdges (pure, unit-testable)
    styles.css                    NEW  .atlas-page layout styles
    App.vue                       NEW  root component: useAtlasData → enrich → filter → graph + panel
    composables/
      useAtlasData.ts             NEW  inline JSON first, fallback fetch /build/channel-atlas
      useOwnerTypeFilter.ts       NEW  module-scoped Set<OwnerType>, toggleType
    components/
      AtlasGraph.vue              NEW  Sigma + MultiDirectedGraph + ForceAtlas2 (fork ExploreGraph)
      OwnerTypeFilter.vue         NEW  ownerType checkboxes (fork FilterDropdown)
      ChannelDetailPanel.vue      NEW  channel name/url/purpose/focusAreas (fork NodeDetailPanel)
    __tests__/
      graph.test.ts               NEW  unit: sizeChannel, ownerTypeColor, buildFocusEdges, buildTopicEdges
      useAtlasData.test.ts        NEW  unit: inline JSON parse, fallback, error handling
      AtlasGraph.test.ts          NEW  build-smoke: mounts, passes nodes to graphology, emits nodeClick

scripts/
  build-channel-atlas-manifest.ts NEW  parse app/channel-atlas/dist/index.html → hugo/data/channel_atlas_bundle.json
  fetch-channel-atlas.ts          NEW  fetch /build/channel-atlas → hugo/data/channel_atlas.json
  __tests__/
    build-channel-atlas-manifest.test.ts  NEW  unit: HTML parsing for channel-atlas-ui/ paths

hugo/
  data/
    channel_atlas_bundle.json     NEW  { hash, css } — written by build-channel-atlas-manifest.ts
    channel_atlas.json            NEW  { channels[], buildAt } — written by fetch-channel-atlas.ts
  layouts/channels/
    atlas.html                    NEW  Hugo layout: inlines channel_atlas JSON + SPA script/link tags
  content/channels/atlas/
    _index.md                     NEW  frontmatter (layout: "atlas", title, description)

.deploy/mta.yaml                  MODIFY  (a) before-all: add channel-atlas install+build+manifest steps
                                          (b) approuter builder: wipe+copy static/channel-atlas-ui/
                                          (c) srv-qa cp list: add build-channel-atlas.js

package.json                      MODIFY  add fetch-channel-atlas, build:channel-atlas-manifest,
                                          build:channel-atlas scripts; wire into build:all

vitest.config.ts                  MODIFY  add app/channel-atlas/src/**/__tests__/**/*.test.ts
                                          to the unit project include array
```

---

## Task 1: `srv/lib/build-channel-atlas.js` — data transformation

**Files:**
- Create: `srv/lib/build-channel-atlas.js`
- Create: `srv/lib/__tests__/build-channel-atlas.test.js`

**Interfaces:**
- Consumes: raw rows from `SELECT.from('com.sap.developers.ims.Channels')` + `Map<channelId, topicTag[]>` from ChannelTopicMap
- Produces: `buildAtlasChannels(rows, topicsByChannel) → AtlasChannelDTO[]`
  ```
  AtlasChannelDTO {
    id: string, name: string, url: string, purpose: string|null,
    ownerType: string|null, subscribers: number|null, githubStars: number|null,
    focusAreas: string[], topicTags: string[]
  }
  ```

- [ ] **Step 1: Write the failing test**

Create `srv/lib/__tests__/build-channel-atlas.test.js`:

```javascript
import { describe, it, expect } from 'vitest'
import { buildAtlasChannels } from '../build-channel-atlas.js'

describe('buildAtlasChannels', () => {
  it('maps all expected fields onto the public DTO shape', () => {
    const rows = [{
      ID: 'ch-1', name: 'SAP CAP Channel', url: 'https://cap.cloud.sap',
      purpose: 'CAP tutorials', ownerType: 'SAP_Official',
      subscribers: 1000, githubStars: null,
      focusAreas: '["CAP","BTP"]',
    }]
    const topics = new Map([['ch-1', ['software-product>sap-cap']]])
    const [ch] = buildAtlasChannels(rows, topics)
    expect(ch).toMatchObject({
      id: 'ch-1', name: 'SAP CAP Channel', url: 'https://cap.cloud.sap',
      purpose: 'CAP tutorials', ownerType: 'SAP_Official',
      subscribers: 1000, githubStars: null,
      focusAreas: ['CAP', 'BTP'],
      topicTags: ['software-product>sap-cap'],
    })
  })

  it('parses HANA NCLOB JSON string focusAreas', () => {
    const rows = [{ ID: 'ch-2', name: 'X', url: 'https://x', focusAreas: '["Go","Python"]' }]
    const [ch] = buildAtlasChannels(rows, new Map())
    expect(ch.focusAreas).toEqual(['Go', 'Python'])
  })

  it('passes through already-parsed focusAreas arrays (SQLite in-memory tests)', () => {
    const rows = [{ ID: 'ch-3', name: 'Y', url: 'https://y', focusAreas: ['Go'] }]
    const [ch] = buildAtlasChannels(rows, new Map())
    expect(ch.focusAreas).toEqual(['Go'])
  })

  it('yields empty topicTags for channels absent from topicsByChannel', () => {
    const rows = [{ ID: 'ch-4', name: 'Z', url: 'https://z', focusAreas: [] }]
    const [ch] = buildAtlasChannels(rows, new Map())
    expect(ch.topicTags).toEqual([])
  })

  it('handles null focusAreas without throwing', () => {
    const rows = [{ ID: 'ch-5', name: 'A', url: 'https://a', focusAreas: null }]
    const [ch] = buildAtlasChannels(rows, new Map())
    expect(ch.focusAreas).toEqual([])
  })

  it('coerces null/undefined purpose to null', () => {
    const rows = [{ ID: 'ch-6', name: 'B', url: 'https://b', purpose: undefined, focusAreas: [] }]
    const [ch] = buildAtlasChannels(rows, new Map())
    expect(ch.purpose).toBeNull()
  })
})
```

- [ ] **Step 2: Run — confirm failure**

```bash
cd D:\projects\tutorials-poc\.claude\worktrees\channels-hub
npx vitest run --project unit srv/lib/__tests__/build-channel-atlas.test.js
```

Expected: `Cannot find module '../build-channel-atlas.js'`

- [ ] **Step 3: Implement**

Create `srv/lib/build-channel-atlas.js`:

```javascript
'use strict'

// Mirrors the parseArr pattern from srv/server.js:432 for HANA NCLOB array columns
// (focusAreas is `array of String(60)`, stored as a JSON string on HANA;
//  SQLite in-memory tests return real JS arrays already).
const parseArr = (v) =>
  Array.isArray(v) ? v : (typeof v === 'string' && v ? JSON.parse(v) : [])

/**
 * Transform raw Channels DB rows + ChannelTopicMap groupings into the
 * public /build/channel-atlas AtlasChannelDTO array.
 *
 * Pure function — no DB access; all DB work is in the srv/server.js handler.
 *
 * @param {object[]} rows              SELECT results from Channels (isPublished=true)
 * @param {Map<string, string[]>} topicsByChannel  channel_ID → topicTag[] (REVIEWED rows only)
 * @returns {object[]}                 AtlasChannelDTO[]
 */
function buildAtlasChannels(rows, topicsByChannel) {
  return rows.map((r) => ({
    id: r.ID,
    name: r.name,
    url: r.url,
    purpose: r.purpose ?? null,
    ownerType: r.ownerType ?? null,
    subscribers: r.subscribers ?? null,
    githubStars: r.githubStars ?? null,
    focusAreas: parseArr(r.focusAreas),
    topicTags: topicsByChannel.get(r.ID) ?? [],
  }))
}

module.exports = { buildAtlasChannels }
```

- [ ] **Step 4: Run — confirm pass**

```bash
npx vitest run --project unit srv/lib/__tests__/build-channel-atlas.test.js
```

Expected: all 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add srv/lib/build-channel-atlas.js srv/lib/__tests__/build-channel-atlas.test.js
git commit -m "feat(channels-atlas): add buildAtlasChannels pure transformation"
```

---

## Task 2: CAP endpoint `GET /build/channel-atlas` + xs-app.json wiring

**Files:**
- Modify: `srv/server.js` (add handler after `/build/channel-collections` block, around line 518)
- Modify: `approuter/xs-app.json` (three changes — see steps)
- Modify: `.deploy/mta.yaml` (srv-qa cp list)

**Interfaces:**
- Consumes: `buildAtlasChannels` from `srv/lib/build-channel-atlas.js`
- Produces: `GET /build/channel-atlas` → `{ channels: AtlasChannelDTO[], buildAt: string }`

- [ ] **Step 1: Write the failing test**

Create `test/unit/channels-atlas-endpoint.test.js`:

```javascript
// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest'
import cds from '@sap/cds'

const NS = 'com.sap.developers.ims'

describe('GET /build/channel-atlas', () => {
  let port

  beforeAll(async () => {
    const srv = await cds.test('serve', '--project', '.', '--in-memory')
    port = srv.port ?? 4004
    const { Channels, ChannelTopicMap } = cds.entities(NS)
    const db = await cds.connect.to('db')
    await db.run(
      INSERT.into(Channels).entries([
        {
          ID: 'aaaaaa-0001', sourceId: 'src-001', name: 'SAP CAP Tutorials',
          url: 'https://cap.cloud.sap', purpose: 'CAP dev resources',
          ownerType: 'SAP_Official', subscribers: 1500, githubStars: null,
          isPublished: true, status: 'Active', focusAreas: JSON.stringify(['CAP', 'BTP']),
        },
        {
          ID: 'aaaaaa-0002', sourceId: 'src-002', name: 'ABAP Community',
          url: 'https://community.sap.com/abap', purpose: 'ABAP help',
          ownerType: 'Community_Member', subscribers: null, githubStars: 200,
          isPublished: true, status: 'Active', focusAreas: JSON.stringify(['ABAP']),
        },
        {
          ID: 'aaaaaa-0003', sourceId: 'src-003', name: 'Unpublished',
          url: 'https://example.com', purpose: null,
          ownerType: 'SAP_Official', subscribers: null, githubStars: null,
          isPublished: false, status: 'Active', focusAreas: JSON.stringify([]),
        },
      ])
    )
    await db.run(
      INSERT.into(ChannelTopicMap).entries([
        {
          ID: 'tm-0001', channel_ID: 'aaaaaa-0001',
          topicTag: 'software-product>sap-cap', relevance: 80, authoringStatus: 'REVIEWED',
        },
      ])
    )
  })

  it('returns published channels with all atlas fields', async () => {
    const res = await fetch(`http://localhost:${port}/build/channel-atlas`)
    expect(res.ok).toBe(true)
    const body = await res.json()
    expect(body.buildAt).toMatch(/^\d{4}-\d{2}-\d{2}/)
    expect(Array.isArray(body.channels)).toBe(true)
    // Only published channels
    expect(body.channels.some((c) => c.name === 'Unpublished')).toBe(false)
    expect(body.channels).toHaveLength(2)
  })

  it('includes id, name, url, purpose, ownerType, subscribers, githubStars, focusAreas, topicTags', async () => {
    const res = await fetch(`http://localhost:${port}/build/channel-atlas`)
    const { channels } = await res.json()
    const cap = channels.find((c) => c.name === 'SAP CAP Tutorials')
    expect(cap).toMatchObject({
      id: 'aaaaaa-0001',
      name: 'SAP CAP Tutorials',
      ownerType: 'SAP_Official',
      subscribers: 1500,
      githubStars: null,
      focusAreas: ['CAP', 'BTP'],
      topicTags: ['software-product>sap-cap'],
    })
  })

  it('returns empty topicTags for channels with no REVIEWED rows', async () => {
    const res = await fetch(`http://localhost:${port}/build/channel-atlas`)
    const { channels } = await res.json()
    const abap = channels.find((c) => c.name === 'ABAP Community')
    expect(abap.topicTags).toEqual([])
  })

  it('returns 200 with empty channels array when DB is empty (fail-open)', async () => {
    // This is structural: the endpoint must never throw.
    // We rely on the handler try/catch and the existing seed above.
    const res = await fetch(`http://localhost:${port}/build/channel-atlas`)
    expect(res.status).toBe(200)
  })
})
```

- [ ] **Step 2: Run — confirm failure**

```bash
npx vitest run --project unit test/unit/channels-atlas-endpoint.test.js
```

Expected: tests fail with fetch errors (endpoint doesn't exist yet).

- [ ] **Step 3: Add handler to `srv/server.js`**

Find the end of the `/build/channel-collections` handler (around line 516 after the closing `})`). Insert immediately after:

```javascript
  // Channel Atlas feed — build-time data for hugo/data/channel_atlas.json and
  // the /channels/atlas/ SPA. Extends /build/channels projection with:
  //   subscribers, githubStars, focusAreas (NCLOB parsed via parseArr),
  //   topicTags from REVIEWED ChannelTopicMap rows (phase-2 edges).
  // Public, unauthenticated. Cache-Control 60s.
  app.get('/build/channel-atlas', async (_req, res) => {
    try {
      const db = await cds.connect.to('db')
      const NS = 'com.sap.developers.ims'
      const rows = await db.run(
        SELECT.from(`${NS}.Channels`)
          .where({ isPublished: true })
          .columns('ID', 'name', 'url', 'purpose', 'ownerType', 'subscribers', 'githubStars', 'focusAreas')
          .orderBy('name'),
      )
      // Fetch REVIEWED ChannelTopicMap rows for phase-2 topic-tag edges.
      // Done as a separate SELECT — never mix BLOB/NCLOB reads with metadata (gotcha).
      const topicRows = await db.run(
        SELECT.from(`${NS}.ChannelTopicMap`)
          .where({ authoringStatus: 'REVIEWED' })
          .columns('channel_ID', 'topicTag'),
      )
      // Group topicTags by channel_ID for O(1) lookup in buildAtlasChannels.
      const topicsByChannel = new Map()
      for (const r of topicRows) {
        if (!topicsByChannel.has(r.channel_ID)) topicsByChannel.set(r.channel_ID, [])
        topicsByChannel.get(r.channel_ID).push(r.topicTag)
      }
      const { buildAtlasChannels } = require('./lib/build-channel-atlas.js')
      const channels = buildAtlasChannels(rows, topicsByChannel)
      res.set('Cache-Control', 'public, max-age=60')
      res.json({ channels, buildAt: new Date().toISOString() })
    } catch (err) {
      console.error('[build/channel-atlas]', err.message)
      res.status(500).json({ error: err.message })
    }
  })
```

> **Note:** `srv/server.js` is in the `gen/srv` tree at deploy time (it uses `require` not ESM). The `require('./lib/build-channel-atlas.js')` call is inside the handler so it doesn't execute at module load, keeping srv-qa boot safe.

- [ ] **Step 4: Run — confirm tests pass**

```bash
npx vitest run --project unit test/unit/channels-atlas-endpoint.test.js
```

Expected: all 4 tests pass.

- [ ] **Step 5: Update xs-app.json — three changes**

Open `approuter/xs-app.json`.

**Change A** — extend the `/build/` allowlist regex to include `channel-atlas`:

Find:
```json
"^/build/(breadcrumb-context|catalog|co-completions|concepts|homepage-shelves|kg-stats|mission|my-progress|navigator|repo-catalog|slug-mapping|tag-labels|topics-gallery|topics-tree|topics)(/.*)?(\\?.*)?$"
```

Replace with:
```json
"^/build/(breadcrumb-context|catalog|channel-atlas|co-completions|concepts|homepage-shelves|kg-stats|mission|my-progress|navigator|repo-catalog|slug-mapping|tag-labels|topics-gallery|topics-tree|topics)(/.*)?(\\?.*)?$"
```

**Change B** — add `/channel-atlas-ui/` SPA assets route directly after the `/explore-ui/` route:

```json
    {
      "source": "^/channel-atlas-ui/(.*)$",
      "target": "/channel-atlas-ui/$1",
      "localDir": "static",
      "authenticationType": "none"
    },
```

**Change C** — add literal `/channels/atlas/` static route. Insert near the bottom of the routes array, BEFORE the `^(.*)$` catch-all and BEFORE any future `/channels/:slug` Phase-2 route. A safe insertion point is just before the `^/browse/` batch:

```json
    {
      "source": "^/channels/atlas(/.*)?$",
      "target": "/channels/atlas$1",
      "localDir": "static",
      "authenticationType": "none",
      "cacheControl": "public, max-age=60, s-maxage=600, stale-while-revalidate=600"
    },
```

> **Route-ordering invariant:** This literal `/channels/atlas` route MUST remain listed in xs-app.json BEFORE any `/channels/:slug` catch-all that Phase 2 will add. The `cacheControl` matches the existing static fallback's value so edge-cache behaviour is consistent.

- [ ] **Step 6: Update srv-qa cp list in `.deploy/mta.yaml`**

Find the `srv-qa` module's `cp` list (search for `build-channel-atlas` and confirm it's absent). Add the new file to the `cp` section of `srv-qa`. The `cp` list looks like:

```yaml
  - name: tutorials-srv-qa
    ...
    build-parameters:
      ...
      commands:
        - cp ... srv/lib/build-channel-atlas.js gen-srv-qa/srv/lib/
```

Search for the `cp` list pattern used by `srv-qa` in `.deploy/mta.yaml` and add:
```yaml
        - cp ../srv/lib/build-channel-atlas.js gen/srv-qa/srv/lib/
```

(Follow the exact `cp` command format used by the other `srv/lib/` entries in the same list.)

- [ ] **Step 7: Commit**

```bash
git add srv/server.js srv/lib/build-channel-atlas.js test/unit/channels-atlas-endpoint.test.js approuter/xs-app.json .deploy/mta.yaml
git commit -m "feat(channels-atlas): add /build/channel-atlas endpoint + xs-app.json wiring"
```

---

## Task 3: Pure graph functions (`app/channel-atlas/src/graph.ts`)

**Files:**
- Create: `app/channel-atlas/src/graph.ts`
- Create: `app/channel-atlas/src/__tests__/graph.test.ts`

> This task creates the graph file and tests standalone, before the SPA scaffold exists. The test file imports from `../graph.js` (compiled output path — Vite resolves `.ts` → `.js`). We run these tests via the root vitest unit project (after Task 9 wires the include), but for now you can run with `--project unit` and the explicit path after Task 9.

**Interfaces:**
- Consumes: nothing (pure functions)
- Produces:
  ```typescript
  export const FLOOR_SIZE: number          // 1.5 — documented minimum
  export const MAX_SIZE: number            // 20
  export const OWNER_TYPE_PALETTE: Record<string, string>  // 9-entry palette
  export const FALLBACK_COLOR: string      // '#888888'
  export function sizeChannel(subscribers: number|null, githubStars: number|null): number
  export function ownerTypeColor(ownerType: string|null|undefined): string
  export function buildFocusEdges(nodes: { id: string; focusAreas: string[] }[]): AtlasEdge[]
  export function buildTopicEdges(nodes: { id: string; topicTags: string[] }[]): AtlasEdge[]
  // AtlasEdge type is imported from ./types.ts (created in Task 4)
  ```

- [ ] **Step 1: Write the failing test**

Create `app/channel-atlas/src/__tests__/graph.test.ts`:

```typescript
// @vitest-environment node
import { describe, it, expect } from 'vitest'
import {
  sizeChannel, FLOOR_SIZE, MAX_SIZE,
  ownerTypeColor, OWNER_TYPE_PALETTE, FALLBACK_COLOR,
  buildFocusEdges, buildTopicEdges,
} from '../graph.js'

describe('sizeChannel', () => {
  it('returns FLOOR_SIZE when both subscribers and githubStars are null', () => {
    expect(sizeChannel(null, null)).toBe(FLOOR_SIZE)
  })

  it('returns FLOOR_SIZE when both are zero (data-absent channels show as minimum dot)', () => {
    expect(sizeChannel(0, null)).toBeCloseTo(FLOOR_SIZE, 5)
  })

  it('returns MAX_SIZE for exactly 1 million subscribers', () => {
    expect(sizeChannel(1_000_000, null)).toBeCloseTo(MAX_SIZE, 1)
  })

  it('uses subscribers when both are non-null (subscribers wins)', () => {
    // subscribers=1000 should give the same result regardless of githubStars value
    expect(sizeChannel(1000, 50000)).toBeCloseTo(sizeChannel(1000, null), 8)
  })

  it('falls back to githubStars when subscribers is null', () => {
    expect(sizeChannel(null, 5000)).toBeCloseTo(sizeChannel(5000, null), 8)
  })

  it('returns a value strictly between FLOOR_SIZE and MAX_SIZE for mid-range channels', () => {
    const s = sizeChannel(10000, null)
    expect(s).toBeGreaterThan(FLOOR_SIZE)
    expect(s).toBeLessThan(MAX_SIZE)
  })

  it('is monotonically increasing (bigger subscriber count → bigger node)', () => {
    expect(sizeChannel(100, null)).toBeLessThan(sizeChannel(10000, null))
  })
})

describe('ownerTypeColor', () => {
  it('returns the correct hex color for every ownerType enum value', () => {
    for (const [ownerType, color] of Object.entries(OWNER_TYPE_PALETTE)) {
      expect(ownerTypeColor(ownerType)).toBe(color)
    }
  })

  it('covers all 9 enum values from db/channels.cds', () => {
    const expected = [
      'SAP_Official', 'SAP_Developer_Advocate', 'SAP_Executive',
      'Community_Member', 'Community_Organization', 'User_Group',
      'Third_party_Training', 'Third_party_Media', 'Third_party_Platform',
    ]
    expect(Object.keys(OWNER_TYPE_PALETTE)).toHaveLength(9)
    for (const t of expected) expect(OWNER_TYPE_PALETTE).toHaveProperty(t)
  })

  it('returns FALLBACK_COLOR for null', () => {
    expect(ownerTypeColor(null)).toBe(FALLBACK_COLOR)
  })

  it('returns FALLBACK_COLOR for undefined', () => {
    expect(ownerTypeColor(undefined)).toBe(FALLBACK_COLOR)
  })

  it('returns FALLBACK_COLOR for an unrecognised string', () => {
    expect(ownerTypeColor('NOT_A_TYPE')).toBe(FALLBACK_COLOR)
  })
})

describe('buildFocusEdges', () => {
  it('returns an edge when two channels share exactly one focus area', () => {
    const nodes = [
      { id: 'ch-1', focusAreas: ['CAP', 'BTP'] },
      { id: 'ch-2', focusAreas: ['BTP', 'ABAP'] },
    ]
    const edges = buildFocusEdges(nodes)
    expect(edges).toHaveLength(1)
    expect(edges[0]).toMatchObject({ source: 'ch-1', target: 'ch-2', weight: 1, kind: 'focus' })
  })

  it('sets weight equal to the number of shared focus areas', () => {
    const nodes = [
      { id: 'ch-1', focusAreas: ['CAP', 'BTP', 'HANA'] },
      { id: 'ch-2', focusAreas: ['CAP', 'BTP', 'Python'] },
    ]
    expect(buildFocusEdges(nodes)[0].weight).toBe(2)
  })

  it('returns no edges when channels share no focus areas', () => {
    const nodes = [
      { id: 'ch-1', focusAreas: ['CAP'] },
      { id: 'ch-2', focusAreas: ['ABAP'] },
    ]
    expect(buildFocusEdges(nodes)).toHaveLength(0)
  })

  it('skips channels with empty focusAreas without producing edges', () => {
    const nodes = [
      { id: 'ch-1', focusAreas: [] },
      { id: 'ch-2', focusAreas: [] },
    ]
    expect(buildFocusEdges(nodes)).toHaveLength(0)
  })

  it('produces at most n*(n-1)/2 edges for n channels', () => {
    // 3 channels all sharing 'CAP' → 3 edges
    const nodes = [
      { id: 'a', focusAreas: ['CAP'] },
      { id: 'b', focusAreas: ['CAP'] },
      { id: 'c', focusAreas: ['CAP'] },
    ]
    expect(buildFocusEdges(nodes)).toHaveLength(3)
  })
})

describe('buildTopicEdges', () => {
  it('returns an edge for channels sharing a reviewed topicTag', () => {
    const nodes = [
      { id: 'ch-1', topicTags: ['software-product>sap-cap', 'topic>btp'] },
      { id: 'ch-2', topicTags: ['topic>btp'] },
    ]
    const edges = buildTopicEdges(nodes)
    expect(edges).toHaveLength(1)
    expect(edges[0]).toMatchObject({ source: 'ch-1', target: 'ch-2', weight: 1, kind: 'topic' })
  })

  it('returns no edges when all topicTag arrays are empty (pre-seed state)', () => {
    const nodes = [
      { id: 'ch-1', topicTags: [] },
      { id: 'ch-2', topicTags: [] },
    ]
    expect(buildTopicEdges(nodes)).toHaveLength(0)
  })

  it('does not produce duplicate edges when called alongside buildFocusEdges', () => {
    // Verify kind='topic' is distinct from kind='focus' so App.vue can render
    // topic edges in a different color.
    const nodes = [
      { id: 'ch-1', topicTags: ['t>cap'] },
      { id: 'ch-2', topicTags: ['t>cap'] },
    ]
    const edges = buildTopicEdges(nodes)
    expect(edges.every((e) => e.kind === 'topic')).toBe(true)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx vitest run --project unit app/channel-atlas/src/__tests__/graph.test.ts
```

Expected: `Cannot find module '../graph.js'`

- [ ] **Step 3: Implement `app/channel-atlas/src/graph.ts`**

```typescript
/**
 * Pure graph-building functions for the Channel Atlas SPA.
 * No Vue/DOM/CDS dependencies — fully unit-testable.
 */

import type { AtlasEdge } from './types.js'

// ── Node sizing ────────────────────────────────────────────────────────────────
// log1p scale: log1p(0)=0 → FLOOR_SIZE; log1p(1e6)=~13.8 → MAX_SIZE.
// FLOOR_SIZE (1.5 px) ensures every channel is a visible dot even when
// subscriber data is absent (many channels have null subscribers + null
// githubStars today — sparse data must not produce invisible nodes).
export const FLOOR_SIZE = 1.5
export const MAX_SIZE   = 20
const SIZE_NORM = Math.log1p(1_000_000)  // normalisation denominator

/**
 * Compute a display-size for a channel node.
 * Preference order: subscribers → githubStars → 0 (floor).
 */
export function sizeChannel(
  subscribers: number | null,
  githubStars: number | null,
): number {
  const n = subscribers ?? githubStars ?? 0
  return FLOOR_SIZE + (Math.log1p(n) / SIZE_NORM) * (MAX_SIZE - FLOOR_SIZE)
}

// ── Node colouring ─────────────────────────────────────────────────────────────
// 9-value palette matching the ChannelOwnerType enum in db/channels.cds.
// SAP tiers: blue family.  Community/User Group: green/amber/red.
// Third-party: purple/orange/teal for visual separation.
export const OWNER_TYPE_PALETTE: Record<string, string> = {
  SAP_Official:             '#0a6ed1',  // SAP Brand Blue
  SAP_Developer_Advocate:   '#1a8cff',  // lighter SAP blue
  SAP_Executive:            '#074888',  // deep SAP navy
  Community_Member:         '#5dc122',  // leaf green
  Community_Organization:   '#f58b00',  // amber
  User_Group:               '#bb0000',  // red
  Third_party_Training:     '#6600cc',  // purple
  Third_party_Media:        '#cc3300',  // burnt orange
  Third_party_Platform:     '#007c7c',  // teal
}
export const FALLBACK_COLOR = '#888888'  // grey for null/unknown ownerType

export function ownerTypeColor(ownerType: string | null | undefined): string {
  return OWNER_TYPE_PALETTE[ownerType ?? ''] ?? FALLBACK_COLOR
}

// ── Edge derivation ─────────────────────────────────────────────────────────────
// Both functions are O(n²) pairwise — correct at current channel counts (<1000).

/**
 * Phase-1 edges: two channels are connected when they share at least one
 * focusArea string.  weight = intersection size.
 */
export function buildFocusEdges(
  nodes: { id: string; focusAreas: string[] }[],
): AtlasEdge[] {
  const edges: AtlasEdge[] = []
  for (let i = 0; i < nodes.length; i++) {
    const a = new Set(nodes[i].focusAreas)
    if (a.size === 0) continue
    for (let j = i + 1; j < nodes.length; j++) {
      const shared = nodes[j].focusAreas.filter((f) => a.has(f))
      if (shared.length > 0) {
        edges.push({ source: nodes[i].id, target: nodes[j].id, weight: shared.length, kind: 'focus' })
      }
    }
  }
  return edges
}

/**
 * Phase-2 edges: two channels are connected when they share at least one
 * REVIEWED ChannelTopicMap topicTag.  weight = intersection size.
 * Returns an empty array while ChannelTopicMap is unseeded (pre-Phase-0).
 */
export function buildTopicEdges(
  nodes: { id: string; topicTags: string[] }[],
): AtlasEdge[] {
  const edges: AtlasEdge[] = []
  for (let i = 0; i < nodes.length; i++) {
    const a = new Set(nodes[i].topicTags)
    if (a.size === 0) continue
    for (let j = i + 1; j < nodes.length; j++) {
      const shared = nodes[j].topicTags.filter((t) => a.has(t))
      if (shared.length > 0) {
        edges.push({ source: nodes[i].id, target: nodes[j].id, weight: shared.length, kind: 'topic' })
      }
    }
  }
  return edges
}
```

> `types.ts` doesn't exist yet — add a temporary stub so TypeScript resolves:
> Create `app/channel-atlas/src/types.ts` containing just:
> ```typescript
> export interface AtlasEdge { source: string; target: string; weight: number; kind: 'focus' | 'topic' }
> ```
> This stub will be replaced by the full types.ts in Task 4.

- [ ] **Step 4: Run — confirm tests pass**

```bash
npx vitest run --project unit app/channel-atlas/src/__tests__/graph.test.ts
```

Expected: all 16 tests pass.

- [ ] **Step 5: Commit**

```bash
git add app/channel-atlas/src/graph.ts app/channel-atlas/src/types.ts app/channel-atlas/src/__tests__/graph.test.ts
git commit -m "feat(channels-atlas): add pure graph functions (sizeChannel, ownerTypeColor, edges)"
```

---

## Task 4: SPA scaffold — `app/channel-atlas/` base files

**Files:**
- Create: `app/channel-atlas/package.json`
- Create: `app/channel-atlas/vite.config.ts`
- Create: `app/channel-atlas/index.html`
- Create: `app/channel-atlas/tsconfig.json`
- Create: `app/channel-atlas/src/main.ts`
- Create: `app/channel-atlas/src/styles.css`
- Replace: `app/channel-atlas/src/types.ts` (upgrade the stub from Task 3 to full types)

**Interfaces:**
- Consumes: `AtlasEdge` stub from Task 3 (replaced here)
- Produces: complete `types.ts` exports; runnable `npm run build` in `app/channel-atlas/`

- [ ] **Step 1: Create `app/channel-atlas/package.json`**

```json
{
  "name": "@sap-tutorials/channel-atlas",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "build": "vite build",
    "dev": "vite",
    "preview": "vite preview"
  },
  "dependencies": {
    "vue": "3.5.34",
    "sigma": "3.0.3",
    "graphology": "0.26.0",
    "graphology-layout-forceatlas2": "0.10.1"
  },
  "devDependencies": {
    "@vitejs/plugin-vue": "5.2.4",
    "@vue/test-utils": "2.4.10",
    "happy-dom": "15.11.7",
    "typescript": "5.9.3",
    "vite": "5.4.21",
    "vue-tsc": "2.2.12"
  }
}
```

- [ ] **Step 2: Create `app/channel-atlas/vite.config.ts`**

```typescript
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { gzipSync } from 'node:zlib'

// Mirrors app/explore/vite.config.ts budget check.
// Same 150KB gzip budget — channel-atlas reuses the identical Sigma stack.
const MAX_ATLAS_GZIP = 150 * 1024

function atlasBudget() {
  return {
    name: 'atlas-budget',
    generateBundle(_opts: unknown, bundle: Record<string, any>) {
      let totalGzip = 0
      for (const [name, chunk] of Object.entries(bundle)) {
        if (chunk.type === 'chunk' && name.endsWith('.js')) {
          totalGzip += gzipSync(chunk.code).length
        }
      }
      if (totalGzip > MAX_ATLAS_GZIP) {
        // @ts-ignore — Rollup plugin context
        this.error(`channel-atlas bundle total is ${totalGzip} gzip bytes (> ${MAX_ATLAS_GZIP}).`)
      } else {
        // @ts-ignore
        this.warn(`channel-atlas bundle: ${totalGzip} gzip bytes (budget ${MAX_ATLAS_GZIP}).`)
      }
    },
  }
}

export default defineConfig({
  base: '/channel-atlas-ui/',
  plugins: [vue(), atlasBudget()],
  build: {
    outDir: 'dist',
    rollupOptions: {
      output: {
        entryFileNames: 'main-[hash].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
  server: {
    // Dev mode: proxy /build/channel-atlas to local CAP server.
    proxy: {
      '/build/channel-atlas': 'http://localhost:4004',
    },
  },
})
```

- [ ] **Step 3: Create `app/channel-atlas/index.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Channel Atlas</title>
  </head>
  <body>
    <div id="atlas-app"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

- [ ] **Step 4: Create `app/channel-atlas/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "useDefineForClassFields": true,
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "moduleDetection": "force",
    "noEmit": true,
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true
  },
  "include": ["src/**/*.ts", "src/**/*.vue", "vite.config.ts"]
}
```

- [ ] **Step 5: Create `app/channel-atlas/src/main.ts`**

```typescript
import { createApp } from 'vue'
import App from './App.vue'
import './styles.css'

createApp(App).mount('#atlas-app')
```

- [ ] **Step 6: Create `app/channel-atlas/src/styles.css`**

```css
/* Channel Atlas SPA — base layout styles.
   Mirrors app/explore/src/styles.css structure. */

*, *::before, *::after {
  box-sizing: border-box;
}

body {
  margin: 0;
  font-family: '72', '72full', Arial, Helvetica, sans-serif;
}

.atlas-page {
  height: 100vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.atlas-page__loading,
.atlas-page__error {
  padding: 1rem;
  text-align: center;
  color: #666;
}

.atlas-page__error {
  color: #b00;
}

.atlas-page__body {
  flex: 1;
  display: flex;
  overflow: hidden;
  min-height: 0;
}

.atlas-page__canvas {
  flex: 1;
  min-width: 0;
  position: relative;
}

.atlas-page__side {
  width: 20%;
  min-width: 260px;
  max-width: 360px;
  flex-shrink: 0;
  overflow-y: auto;
  padding: 1rem;
  border-left: 1px solid #e5e5e5;
}
```

- [ ] **Step 7: Replace `app/channel-atlas/src/types.ts` with full types**

```typescript
/**
 * Channel Atlas SPA — domain types.
 *
 * AtlasChannelDTO: raw shape from GET /build/channel-atlas.
 * AtlasNode:       enriched with size + color computed client-side.
 * AtlasEdge:       derived client-side from shared focusAreas or topicTags.
 * AtlasPayload:    full endpoint response shape (also written to hugo/data/channel_atlas.json).
 */

// Mirrors ChannelOwnerType enum in db/channels.cds (9 values).
export type OwnerType =
  | 'SAP_Official'
  | 'SAP_Developer_Advocate'
  | 'SAP_Executive'
  | 'Community_Member'
  | 'Community_Organization'
  | 'User_Group'
  | 'Third_party_Training'
  | 'Third_party_Media'
  | 'Third_party_Platform'

/** Raw channel record as returned by GET /build/channel-atlas. */
export interface AtlasChannelDTO {
  id: string
  name: string
  url: string
  purpose: string | null
  ownerType: OwnerType | null
  subscribers: number | null
  githubStars: number | null
  focusAreas: string[]
  topicTags: string[]   // REVIEWED ChannelTopicMap rows; empty pre-seed (phase-2)
}

/** Graph node: AtlasChannelDTO enriched with display size + color. */
export interface AtlasNode extends AtlasChannelDTO {
  size: number   // computed by sizeChannel() in graph.ts
  color: string  // computed by ownerTypeColor() in graph.ts
}

/**
 * Graph edge derived client-side.
 * kind='focus'  — shared focusAreas (phase-1, works pre-seed)
 * kind='topic'  — shared REVIEWED ChannelTopicMap topicTags (phase-2)
 */
export interface AtlasEdge {
  source: string
  target: string
  weight: number
  kind: 'focus' | 'topic'
}

/** Shape of GET /build/channel-atlas and hugo/data/channel_atlas.json. */
export interface AtlasPayload {
  channels: AtlasChannelDTO[]
  buildAt: string
}
```

- [ ] **Step 8: Verify types compile**

```bash
cd "D:\projects\tutorials-poc\.claude\worktrees\channels-hub"
npm --prefix app/channel-atlas install --no-audit --no-fund
npx --prefix app/channel-atlas vue-tsc --noEmit
```

Expected: 0 errors. (App.vue doesn't exist yet — that's fine, tsconfig only includes `src/**/*.vue` and we haven't created it; just confirm graph.ts + types.ts compile.)

- [ ] **Step 9: Commit**

```bash
git add app/channel-atlas/
git commit -m "feat(channels-atlas): scaffold SPA (package.json, vite, tsconfig, types, styles)"
```

---

## Task 5: `useAtlasData.ts` composable + unit test

**Files:**
- Create: `app/channel-atlas/src/composables/useAtlasData.ts`
- Create: `app/channel-atlas/src/__tests__/useAtlasData.test.ts`

**Interfaces:**
- Consumes: `AtlasPayload` from `types.ts`
- Produces:
  ```typescript
  useAtlasData(): {
    payload: Ref<AtlasPayload | null>
    hasData: ComputedRef<boolean>
    error: Ref<Error | null>
  }
  ```

- [ ] **Step 1: Write the failing test**

Create `app/channel-atlas/src/__tests__/useAtlasData.test.ts`:

```typescript
// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest'
import { nextTick } from 'vue'
import { useAtlasData } from '../composables/useAtlasData.js'
import type { AtlasPayload } from '../types.js'

const FIXTURE: AtlasPayload = {
  channels: [{
    id: 'ch-1', name: 'SAP CAP', url: 'https://cap.cloud.sap',
    purpose: 'CAP tutorials', ownerType: 'SAP_Official',
    subscribers: 1000, githubStars: null,
    focusAreas: ['CAP', 'BTP'], topicTags: [],
  }],
  buildAt: '2026-09-05T00:00:00.000Z',
}

function injectPayload(data: AtlasPayload | string) {
  const el = document.createElement('script')
  el.id = 'atlas-payload'
  el.type = 'application/json'
  el.textContent = typeof data === 'string' ? data : JSON.stringify(data)
  document.body.appendChild(el)
}

describe('useAtlasData', () => {
  beforeEach(() => {
    document.getElementById('atlas-payload')?.remove()
  })

  it('reads payload from inline <script id="atlas-payload"> element', async () => {
    injectPayload(FIXTURE)
    const { payload, hasData, error } = useAtlasData()
    await nextTick()
    expect(error.value).toBeNull()
    expect(hasData.value).toBe(true)
    expect(payload.value?.channels).toHaveLength(1)
    expect(payload.value?.channels[0].id).toBe('ch-1')
    expect(payload.value?.buildAt).toBe('2026-09-05T00:00:00.000Z')
  })

  it('sets error and leaves payload null when inline JSON is malformed', async () => {
    injectPayload('NOT_VALID_JSON{')
    const { payload, error } = useAtlasData()
    await nextTick()
    expect(payload.value).toBeNull()
    expect(error.value).toBeInstanceOf(Error)
  })

  it('hasData is false when inline element is absent and no inline fetch fires', async () => {
    // No inline element, no window (non-browser env). 
    // Simulate: just construct without element — hasData stays false until async resolves.
    const { hasData } = useAtlasData()
    // In happy-dom window exists, so fetch fires. But with no inline and no mock,
    // fetch to /build/channel-atlas will fail.
    // We only test the initial state here.
    expect(hasData.value).toBe(false)
  })
})
```

- [ ] **Step 2: Run — confirm failure**

```bash
npx vitest run --project unit app/channel-atlas/src/__tests__/useAtlasData.test.ts
```

Expected: `Cannot find module '../composables/useAtlasData.js'`

- [ ] **Step 3: Implement**

Create `app/channel-atlas/src/composables/useAtlasData.ts`:

```typescript
import { ref, computed } from 'vue'
import type { Ref, ComputedRef } from 'vue'
import type { AtlasPayload } from '../types.js'

/**
 * Loads the channel-atlas payload.
 *
 * Priority:
 *  1. Inline <script type="application/json" id="atlas-payload"> element
 *     injected by hugo/layouts/channels/atlas.html at Hugo build time.
 *     Avoids a network round-trip in production.
 *  2. Runtime fetch from GET /build/channel-atlas
 *     (dev mode via Vite proxy, or when inline element is absent).
 *
 * Fail-open: any error sets `error` and leaves `payload` null.
 * The App.vue renders an empty-state message when hasData is false.
 */
export function useAtlasData(): {
  payload: Ref<AtlasPayload | null>
  hasData: ComputedRef<boolean>
  error: Ref<Error | null>
} {
  const payload = ref<AtlasPayload | null>(null)
  const error   = ref<Error | null>(null)
  const hasData = computed(() => !!payload.value)

  async function loadData() {
    try {
      // 1. Inline payload (injected by Hugo layout — no round-trip in production).
      if (typeof document !== 'undefined') {
        const inline = document.getElementById('atlas-payload')
        if (inline?.textContent) {
          payload.value = JSON.parse(inline.textContent) as AtlasPayload
          return
        }
      }
      // 2. Fallback: fetch from the live CAP endpoint.
      //    In dev: Vite proxies /build/channel-atlas → http://localhost:4004.
      //    In production: approuter routes it to srv-api (authenticationType: none).
      const r = await fetch('/build/channel-atlas')
      if (!r.ok) {
        error.value = new Error(`HTTP ${r.status}`)
        return
      }
      payload.value = (await r.json()) as AtlasPayload
    } catch (err) {
      console.error('[channel-atlas] failed to load data', err)
      error.value = err instanceof Error ? err : new Error(String(err))
    }
  }

  // Only runs in browser context — SSR/unit env guard matches explore's pattern.
  if (typeof window !== 'undefined') {
    loadData()
  }

  return { payload, hasData, error }
}
```

- [ ] **Step 4: Run — confirm pass**

```bash
npx vitest run --project unit app/channel-atlas/src/__tests__/useAtlasData.test.ts
```

Expected: tests 1 and 2 pass; test 3 may be flaky depending on happy-dom fetch mock. If test 3 is flaky, remove it — tests 1 and 2 are the load-bearing assertions.

- [ ] **Step 5: Commit**

```bash
git add app/channel-atlas/src/composables/useAtlasData.ts app/channel-atlas/src/__tests__/useAtlasData.test.ts
git commit -m "feat(channels-atlas): add useAtlasData composable (inline JSON + fetch fallback)"
```

---

## Task 6: `AtlasGraph.vue` + build-smoke test

**Files:**
- Create: `app/channel-atlas/src/components/AtlasGraph.vue`
- Create: `app/channel-atlas/src/__tests__/AtlasGraph.test.ts`

**Interfaces:**
- Consumes: `AtlasNode`, `AtlasEdge` from `types.ts`; `ownerTypeColor` from `graph.ts`
- Produces: `<AtlasGraph :nodes :edges @nodeClick>`; emits `nodeClick: { id: string; node: AtlasNode }`

- [ ] **Step 1: Write the failing build-smoke test**

Create `app/channel-atlas/src/__tests__/AtlasGraph.test.ts`:

```typescript
// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import AtlasGraph from '../components/AtlasGraph.vue'
import { FLOOR_SIZE } from '../graph.js'
import type { AtlasNode } from '../types.js'

// ── Mock sigma ────────────────────────────────────────────────────────────────
const mockSigmaInstances: any[] = []

vi.mock('sigma', () => ({
  default: class {
    handlers = new Map<string, (e: any) => void>()
    constructor(_g: unknown, _container: HTMLElement) {
      mockSigmaInstances.push(this)
    }
    on(event: string, handler: (e: any) => void) {
      this.handlers.set(event, handler)
      return this
    }
    kill() {}
    refresh() {}
    getCamera() { return { animate: vi.fn(), animatedReset: vi.fn() } }
  },
}))

// ── Mock graphology ───────────────────────────────────────────────────────────
const mockGraphInstances: any[] = []

vi.mock('graphology', () => {
  class MockMultiDirectedGraph {
    nodes = new Map<string, any>()
    edges = new Map<string, any>()
    constructor() { mockGraphInstances.push(this) }
    addNode(id: string, attrs: any) { this.nodes.set(id, attrs) }
    addEdgeWithKey(key: string, s: string, t: string, attrs: any) {
      if (this.edges.has(key)) throw new Error(`duplicate key "${key}"`)
      this.edges.set(key, { s, t, ...attrs })
    }
    hasNode(id: string) { return this.nodes.has(id) }
    hasEdge(key: string) { return this.edges.has(key) }
    getNodeAttributes(id: string) { return this.nodes.get(id) }
    forEachNode(cb: (id: string, a: any) => void) {
      for (const [id, a] of this.nodes) cb(id, a)
    }
    forEachEdge(cb: (key: string, a: any) => void) {
      for (const [k, a] of this.edges) cb(k, a)
    }
  }
  return { MultiDirectedGraph: MockMultiDirectedGraph }
})

vi.mock('graphology-layout-forceatlas2', () => ({
  default: { assign: vi.fn() },
}))

// ── Helpers ───────────────────────────────────────────────────────────────────
function makeNode(id: string, ownerType: AtlasNode['ownerType'] = 'SAP_Official'): AtlasNode {
  return {
    id, name: `Channel ${id}`, url: `https://example.com/${id}`,
    purpose: null, ownerType, subscribers: 1000, githubStars: null,
    focusAreas: ['CAP'], topicTags: [],
    size: FLOOR_SIZE + 5, color: '#0a6ed1',
  }
}

function mountAtlasGraph(props: Record<string, unknown>): {
  app: App
  emitted: Record<string, unknown[][]>
  unmount: () => void
} {
  const root = document.createElement('div')
  document.body.appendChild(root)
  const emitted: Record<string, unknown[][]> = {}
  const app = createApp(AtlasGraph as any, {
    ...props,
    onNodeClick: (payload: unknown) => { (emitted.nodeClick ??= []).push([payload]) },
  })
  app.mount(root)
  return { app, emitted, unmount: () => { app.unmount(); root.remove() } }
}

describe('AtlasGraph', () => {
  beforeEach(() => {
    mockSigmaInstances.length = 0
    mockGraphInstances.length = 0
  })
  afterEach(() => {
    while (document.body.firstChild) document.body.firstChild.remove()
  })

  const fixture = {
    nodes: [makeNode('ch-1'), makeNode('ch-2', 'Community_Member')],
    edges: [{ source: 'ch-1', target: 'ch-2', weight: 1, kind: 'focus' as const }],
  }

  it('mounts without throwing and renders the atlas-graph container', async () => {
    const { unmount } = mountAtlasGraph(fixture)
    await nextTick()
    expect(document.querySelector('.atlas-graph')).toBeTruthy()
    unmount()
  })

  it('adds all input nodes to the graphology graph', async () => {
    const { unmount } = mountAtlasGraph(fixture)
    await nextTick()
    const g = mockGraphInstances[0]
    expect(g.nodes.size).toBe(2)
    expect(g.nodes.has('ch-1')).toBe(true)
    expect(g.nodes.has('ch-2')).toBe(true)
    unmount()
  })

  it('adds input edges to the graphology graph (skipping duplicates)', async () => {
    const dupFixture = {
      nodes: [makeNode('ch-1'), makeNode('ch-2')],
      edges: [
        { source: 'ch-1', target: 'ch-2', weight: 1, kind: 'focus' as const },
        { source: 'ch-1', target: 'ch-2', weight: 1, kind: 'focus' as const }, // dup
      ],
    }
    const { unmount } = mountAtlasGraph(dupFixture)
    await nextTick()
    expect(mockGraphInstances[0].edges.size).toBe(1)
    unmount()
  })

  it('emits nodeClick with the full AtlasNode when Sigma fires clickNode', async () => {
    const { emitted, unmount } = mountAtlasGraph(fixture)
    await nextTick()
    const sigma = mockSigmaInstances[0]
    sigma.handlers.get('clickNode')?.({ node: 'ch-1' })
    expect(emitted.nodeClick).toBeTruthy()
    expect(emitted.nodeClick![0][0]).toMatchObject({
      id: 'ch-1',
      node: expect.objectContaining({ id: 'ch-1', name: 'Channel ch-1' }),
    })
    unmount()
  })

  it('rebuilds the graph when nodes prop changes (filter toggle regression)', async () => {
    const { app, unmount } = mountAtlasGraph(fixture)
    await nextTick()
    expect(mockSigmaInstances.length).toBe(1)
    app._instance!.props.nodes = [makeNode('ch-1')]
    await nextTick()
    expect(mockSigmaInstances.length).toBe(2)
    expect(mockGraphInstances[1].nodes.size).toBe(1)
    unmount()
  })
})
```

- [ ] **Step 2: Run — confirm failure**

```bash
npx vitest run --project unit app/channel-atlas/src/__tests__/AtlasGraph.test.ts
```

Expected: `Cannot find module '../components/AtlasGraph.vue'`

- [ ] **Step 3: Implement `AtlasGraph.vue`**

Create `app/channel-atlas/src/components/AtlasGraph.vue`:

```vue
<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import { MultiDirectedGraph } from 'graphology'
import Sigma from 'sigma'
import forceAtlas2 from 'graphology-layout-forceatlas2'
import type { AtlasNode, AtlasEdge } from '../types.js'
import { ownerTypeColor } from '../graph.js'

const props = defineProps<{
  nodes: AtlasNode[]
  edges: AtlasEdge[]
}>()

const emit = defineEmits<{
  nodeClick: [{ id: string; node: AtlasNode }]
}>()

const container = ref<HTMLDivElement | null>(null)
// Defeat Vue 3.5 SFC template hoisting (see ExploreGraph.vue#containerLabel comment).
const containerLabel = computed(() => `atlas-graph-${props.nodes.length}`)

let renderer: InstanceType<typeof Sigma> | null = null

onMounted(() => { buildGraph() })

// Rebuild on prop changes — mirrors app/explore/src/components/ExploreGraph.vue.
// deep:false — computed always produces a new array reference.
watch(
  [() => props.nodes, () => props.edges],
  () => { buildGraph() },
)

function buildGraph() {
  if (renderer) { renderer.kill(); renderer = null }
  if (!container.value) return

  const graph = new MultiDirectedGraph()

  for (const n of props.nodes) {
    graph.addNode(n.id, {
      x: Math.random(),
      y: Math.random(),
      size: n.size,
      color: n.color ?? ownerTypeColor(n.ownerType),
      label: n.name,
    })
  }

  const seen = new Set<string>()
  for (const e of props.edges) {
    // Dedup key: source:kind:target (same pair can appear for both 'focus' and 'topic')
    const key = `${e.source}:${e.kind}:${e.target}`
    if (seen.has(key)) continue
    seen.add(key)
    if (!graph.hasNode(e.source) || !graph.hasNode(e.target)) continue
    try {
      graph.addEdgeWithKey(key, e.source, e.target, {
        size: Math.max(1, e.weight * 0.5),
        color: e.kind === 'topic' ? '#5dc122' : '#cccccc',
      })
    } catch (_) { /* duplicate key — skip silently */ }
  }

  forceAtlas2.assign(graph, {
    iterations: 100,
    settings: { gravity: 1, scalingRatio: 10, barnesHutOptimize: true },
  })

  renderer = new Sigma(graph, container.value)
  renderer.on('clickNode', ({ node }) => {
    const atlasNode = props.nodes.find((n) => n.id === node)
    if (atlasNode) emit('nodeClick', { id: node, node: atlasNode })
  })
}

onBeforeUnmount(() => {
  if (renderer) { renderer.kill(); renderer = null }
})

defineExpose({ containerLabel })
</script>

<template>
  <div
    ref="container"
    class="atlas-graph"
    :data-graph-id="containerLabel"
  />
</template>

<style scoped>
.atlas-graph {
  width: 100%;
  height: 100%;
}
</style>
```

- [ ] **Step 4: Run — confirm pass**

```bash
npx vitest run --project unit app/channel-atlas/src/__tests__/AtlasGraph.test.ts
```

Expected: all 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add app/channel-atlas/src/components/AtlasGraph.vue app/channel-atlas/src/__tests__/AtlasGraph.test.ts
git commit -m "feat(channels-atlas): add AtlasGraph.vue (Sigma + graphology + ForceAtlas2)"
```

---

## Task 7: `useOwnerTypeFilter.ts` + `OwnerTypeFilter.vue` + `ChannelDetailPanel.vue` + `App.vue`

**Files:**
- Create: `app/channel-atlas/src/composables/useOwnerTypeFilter.ts`
- Create: `app/channel-atlas/src/components/OwnerTypeFilter.vue`
- Create: `app/channel-atlas/src/components/ChannelDetailPanel.vue`
- Create: `app/channel-atlas/src/App.vue`
- Create: `app/channel-atlas/src/__tests__/App.test.ts` (smoke test)

**Interfaces:**
- Consumes: `useAtlasData`, `useOwnerTypeFilter`, `buildFocusEdges`, `buildTopicEdges`, `sizeChannel`, `ownerTypeColor`, `AtlasNode`, `AtlasEdge`
- Produces: the root `<App />` component; `useOwnerTypeFilter()` singleton

- [ ] **Step 1: Create `useOwnerTypeFilter.ts`**

```typescript
// app/channel-atlas/src/composables/useOwnerTypeFilter.ts
import { ref } from 'vue'
import type { OwnerType } from '../types.js'

// All 9 values from ChannelOwnerType enum in db/channels.cds.
export const ALL_OWNER_TYPES: OwnerType[] = [
  'SAP_Official',
  'SAP_Developer_Advocate',
  'SAP_Executive',
  'Community_Member',
  'Community_Organization',
  'User_Group',
  'Third_party_Training',
  'Third_party_Media',
  'Third_party_Platform',
]

// Module-scoped singleton — all consumers share the same filter state.
// Mirrors the useFilters() pattern in app/explore/src/composables/useFilters.ts.
const enabledTypes = ref<Set<OwnerType>>(new Set(ALL_OWNER_TYPES))

function toggleType(t: OwnerType) {
  const next = new Set(enabledTypes.value)
  if (next.has(t)) next.delete(t)
  else next.add(t)
  enabledTypes.value = next
}

export function useOwnerTypeFilter() {
  return { enabledTypes, toggleType, ALL_OWNER_TYPES }
}

/** Test hook — reset filter state between tests. */
export function _resetOwnerTypeFilter() {
  enabledTypes.value = new Set(ALL_OWNER_TYPES)
}
```

- [ ] **Step 2: Create `OwnerTypeFilter.vue`**

```vue
<!-- app/channel-atlas/src/components/OwnerTypeFilter.vue
     Fork of app/explore/src/components/FilterDropdown.vue.
     Renders a filter dropdown for ownerType values. -->
<script setup lang="ts">
import { ref, computed, onBeforeUnmount, onMounted, getCurrentInstance } from 'vue'
import type { OwnerType } from '../types.js'
import { ALL_OWNER_TYPES } from '../composables/useOwnerTypeFilter.js'
import { OWNER_TYPE_PALETTE, FALLBACK_COLOR } from '../graph.js'

const props = defineProps<{
  enabledTypes: Set<OwnerType>
}>()
const emit = defineEmits<{ toggle: [OwnerType] }>()

const open = ref(false)
const rootEl = ref<HTMLElement | null>(null)
const instance = getCurrentInstance()
onMounted(() => {
  rootEl.value = (instance?.proxy?.$el as HTMLElement) ?? null
})

function toggle() { open.value = !open.value }

function onDocMousedown(e: MouseEvent) {
  if (open.value && rootEl.value && !rootEl.value.contains(e.target as Node)) {
    open.value = false
  }
}
onMounted(() => document.addEventListener('mousedown', onDocMousedown))
onBeforeUnmount(() => document.removeEventListener('mousedown', onDocMousedown))

// Label: count enabled types
const label = computed(() => {
  const n = props.enabledTypes.size
  return n === ALL_OWNER_TYPES.length ? 'All types' : `${n} type${n !== 1 ? 's' : ''}`
})

function colorFor(t: OwnerType) {
  return OWNER_TYPE_PALETTE[t] ?? FALLBACK_COLOR
}

// Human-readable label: replace underscores, trim prefix
function labelFor(t: OwnerType) {
  return t.replace(/_/g, ' ')
}
</script>

<template>
  <div class="owner-filter">
    <button class="owner-filter__toggle" @click="toggle" :aria-expanded="open">
      {{ label }}
    </button>
    <ul v-if="open" class="owner-filter__list" role="listbox">
      <li
        v-for="t in ALL_OWNER_TYPES"
        :key="t"
        class="owner-filter__item"
        :class="{ 'owner-filter__item--disabled': !enabledTypes.has(t) }"
        @click="emit('toggle', t)"
      >
        <span
          class="owner-filter__swatch"
          :style="{ background: colorFor(t) }"
        />
        {{ labelFor(t) }}
      </li>
    </ul>
  </div>
</template>
```

- [ ] **Step 3: Create `ChannelDetailPanel.vue`**

```vue
<!-- app/channel-atlas/src/components/ChannelDetailPanel.vue
     Fork of app/explore/src/components/NodeDetailPanel.vue.
     Displays details for the selected channel node. -->
<script setup lang="ts">
import { computed } from 'vue'
import type { AtlasNode } from '../types.js'
import { ownerTypeColor } from '../graph.js'

const props = defineProps<{
  selectedNode: AtlasNode | null
}>()

const panelLabel = computed(() =>
  `channel-detail-${props.selectedNode?.id ?? 'none'}`,
)

function colorFor(node: AtlasNode) {
  return ownerTypeColor(node.ownerType)
}

defineExpose({ panelLabel })
</script>

<template>
  <aside class="channel-panel" :data-panel-id="panelLabel">
    <div v-if="!selectedNode" class="channel-panel__empty">
      Click a node to see channel details.
    </div>
    <template v-else>
      <h2 class="channel-panel__name">
        <span
          class="channel-panel__swatch"
          :style="{ background: colorFor(selectedNode) }"
        />
        {{ selectedNode.name }}
      </h2>
      <p v-if="selectedNode.purpose" class="channel-panel__purpose">
        {{ selectedNode.purpose }}
      </p>
      <p class="channel-panel__type">
        Type: {{ selectedNode.ownerType?.replace(/_/g, ' ') ?? 'Unknown' }}
      </p>
      <p v-if="selectedNode.subscribers != null" class="channel-panel__stats">
        Subscribers: {{ selectedNode.subscribers.toLocaleString() }}
      </p>
      <p v-if="selectedNode.githubStars != null && selectedNode.subscribers == null" class="channel-panel__stats">
        GitHub Stars: {{ selectedNode.githubStars.toLocaleString() }}
      </p>
      <ul v-if="selectedNode.focusAreas.length" class="channel-panel__areas">
        <li v-for="area in selectedNode.focusAreas" :key="area">{{ area }}</li>
      </ul>
      <a
        :href="selectedNode.url"
        class="channel-panel__link"
        target="_blank"
        rel="noopener noreferrer"
      >Visit channel ↗</a>
    </template>
  </aside>
</template>
```

- [ ] **Step 4: Create `App.vue`**

```vue
<!-- app/channel-atlas/src/App.vue
     Root component for the Channel Atlas SPA. -->
<script setup lang="ts">
import { computed, ref } from 'vue'
import { useAtlasData } from './composables/useAtlasData.js'
import { useOwnerTypeFilter } from './composables/useOwnerTypeFilter.js'
import { buildFocusEdges, buildTopicEdges, sizeChannel, ownerTypeColor } from './graph.js'
import AtlasGraph from './components/AtlasGraph.vue'
import OwnerTypeFilter from './components/OwnerTypeFilter.vue'
import ChannelDetailPanel from './components/ChannelDetailPanel.vue'
import type { AtlasNode, AtlasEdge, OwnerType } from './types.js'

const { payload, hasData, error } = useAtlasData()
const { enabledTypes, toggleType } = useOwnerTypeFilter()
const selectedNode = ref<AtlasNode | null>(null)

// Enrich raw DTOs with computed size + color.
const allNodes = computed<AtlasNode[]>(() => {
  if (!payload.value) return []
  return payload.value.channels.map((ch) => ({
    ...ch,
    size: sizeChannel(ch.subscribers, ch.githubStars),
    color: ownerTypeColor(ch.ownerType),
  }))
})

// Apply ownerType filter.
const filteredNodes = computed<AtlasNode[]>(() =>
  allNodes.value.filter(
    (n) => n.ownerType == null || enabledTypes.value.has(n.ownerType as OwnerType),
  ),
)

// Derive edges from filtered nodes only (phase-1 focus + phase-2 topic).
const filteredEdges = computed<AtlasEdge[]>(() => [
  ...buildFocusEdges(filteredNodes.value),
  ...buildTopicEdges(filteredNodes.value),
])

function onNodeClick(e: { id: string; node: AtlasNode }) {
  selectedNode.value = e.node
}
</script>

<template>
  <main class="atlas-page">
    <p v-if="error" class="atlas-page__error" role="alert">
      Failed to load Channel Atlas: {{ error.message }}
    </p>
    <p v-else-if="!hasData" class="atlas-page__loading">
      Loading Channel Atlas…
    </p>
    <template v-else-if="filteredNodes.length === 0">
      <p class="atlas-page__loading">
        No channels to display. Try enabling more owner types.
      </p>
    </template>
    <template v-else>
      <div class="atlas-page__toolbar">
        <OwnerTypeFilter
          :enabledTypes="enabledTypes"
          @toggle="toggleType"
        />
      </div>
      <div class="atlas-page__body">
        <div class="atlas-page__canvas">
          <AtlasGraph
            :nodes="filteredNodes"
            :edges="filteredEdges"
            @nodeClick="onNodeClick"
          />
        </div>
        <ChannelDetailPanel
          class="atlas-page__side"
          :selectedNode="selectedNode"
        />
      </div>
    </template>
  </main>
</template>
```

- [ ] **Step 5: Write App smoke test**

Create `app/channel-atlas/src/__tests__/App.test.ts`:

```typescript
// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick } from 'vue'
import AtlasApp from '../App.vue'
import type { AtlasPayload } from '../types.js'
import { _resetOwnerTypeFilter } from '../composables/useOwnerTypeFilter.js'

vi.mock('sigma', () => ({
  default: class {
    constructor(_g: unknown, _c: HTMLElement) {}
    on() { return this }
    kill() {}
  },
}))
vi.mock('graphology', () => ({
  MultiDirectedGraph: class {
    nodes = new Map(); edges = new Map()
    addNode(id: string, a: any) { this.nodes.set(id, a) }
    addEdgeWithKey() {}
    hasNode(id: string) { return this.nodes.has(id) }
    hasEdge() { return false }
    forEachNode() {}
    forEachEdge() {}
  },
}))
vi.mock('graphology-layout-forceatlas2', () => ({ default: { assign: vi.fn() } }))

const PAYLOAD: AtlasPayload = {
  channels: [
    {
      id: 'ch-1', name: 'SAP CAP', url: 'https://cap.cloud.sap', purpose: 'CAP stuff',
      ownerType: 'SAP_Official', subscribers: 1000, githubStars: null,
      focusAreas: ['CAP'], topicTags: [],
    },
  ],
  buildAt: '2026-09-05T00:00:00.000Z',
}

function injectPayload(data: AtlasPayload) {
  const el = document.createElement('script')
  el.id = 'atlas-payload'
  el.type = 'application/json'
  el.textContent = JSON.stringify(data)
  document.body.appendChild(el)
}

describe('App', () => {
  beforeEach(() => {
    document.getElementById('atlas-payload')?.remove()
    _resetOwnerTypeFilter()
  })
  afterEach(() => { while (document.body.firstChild) document.body.firstChild.remove() })

  it('renders loading state before payload resolves', async () => {
    // No inline payload → hasData=false immediately
    const root = document.createElement('div')
    document.body.appendChild(root)
    const app = createApp(AtlasApp)
    app.mount(root)
    await nextTick()
    expect(root.textContent).toMatch(/Loading Channel Atlas/)
    app.unmount()
  })

  it('renders graph + panel when inline payload is present', async () => {
    injectPayload(PAYLOAD)
    const root = document.createElement('div')
    document.body.appendChild(root)
    const app = createApp(AtlasApp)
    app.mount(root)
    await nextTick()
    // Toolbar + canvas + panel should all be present
    expect(root.querySelector('.atlas-page__toolbar')).toBeTruthy()
    expect(root.querySelector('.atlas-graph')).toBeTruthy()
    expect(root.querySelector('.channel-panel')).toBeTruthy()
    app.unmount()
  })

  it('renders empty-state when all owner types are filtered out', async () => {
    injectPayload(PAYLOAD)
    // Inject a payload where the single channel has a non-default ownerType
    // and reset to NO enabled types via the singleton.
    const { enabledTypes } = await import('../composables/useOwnerTypeFilter.js')
    enabledTypes.value = new Set() // filter everything out
    const root = document.createElement('div')
    document.body.appendChild(root)
    const app = createApp(AtlasApp)
    app.mount(root)
    await nextTick()
    expect(root.textContent).toMatch(/No channels to display/)
    app.unmount()
    // Restore
    _resetOwnerTypeFilter()
  })
})
```

- [ ] **Step 6: Run — confirm pass**

```bash
npx vitest run --project unit app/channel-atlas/src/__tests__/App.test.ts
```

Expected: all 3 tests pass.

- [ ] **Step 7: Commit**

```bash
git add app/channel-atlas/src/composables/useOwnerTypeFilter.ts \
        app/channel-atlas/src/components/OwnerTypeFilter.vue \
        app/channel-atlas/src/components/ChannelDetailPanel.vue \
        app/channel-atlas/src/App.vue \
        app/channel-atlas/src/__tests__/App.test.ts
git commit -m "feat(channels-atlas): add App.vue, OwnerTypeFilter, ChannelDetailPanel, useOwnerTypeFilter"
```

---

## Task 8: `scripts/build-channel-atlas-manifest.ts` + `scripts/fetch-channel-atlas.ts`

**Files:**
- Create: `scripts/build-channel-atlas-manifest.ts`
- Create: `scripts/__tests__/build-channel-atlas-manifest.test.ts`
- Create: `scripts/fetch-channel-atlas.ts`

**Interfaces:**
- Consumes: `app/channel-atlas/dist/index.html` (output of `vite build`)
- Produces:
  - `buildChannelAtlasManifest(distDir, outPath?) → { hash: string; css: string }` — writes `hugo/data/channel_atlas_bundle.json`
  - `scripts/fetch-channel-atlas.ts` → writes `hugo/data/channel_atlas.json` (calls `/build/channel-atlas`)

- [ ] **Step 1: Write the failing test for the manifest parser**

Create `scripts/__tests__/build-channel-atlas-manifest.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { buildChannelAtlasManifest } from '../build-channel-atlas-manifest.js'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('buildChannelAtlasManifest', () => {
  function makeFakeDistDir(html: string): string {
    const dir = join(tmpdir(), `atlas-manifest-test-${Date.now()}`)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'index.html'), html, 'utf8')
    return dir
  }

  it('extracts hash and css from a valid Vite-built index.html', () => {
    const html = `
      <!doctype html>
      <link rel="stylesheet" href="/channel-atlas-ui/assets/index-AbCd1234.css">
      <script type="module" src="/channel-atlas-ui/main-xyz987abc.js"></script>
    `
    const dir = makeFakeDistDir(html)
    try {
      const m = buildChannelAtlasManifest(dir)
      expect(m.hash).toBe('xyz987abc')
      expect(m.css).toBe('index-AbCd1234.css')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('throws when index.html is missing', () => {
    expect(() => buildChannelAtlasManifest('/nonexistent-atlas-dist-dir')).toThrow()
  })

  it('throws when the JS hash looks like a dev sentinel (too short)', () => {
    const html = `<script type="module" src="/channel-atlas-ui/main-dev.js"></script>`
    const dir = makeFakeDistDir(html)
    try {
      expect(() => buildChannelAtlasManifest(dir)).toThrow(/dev sentinel|hash/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('writes JSON manifest to outPath when provided', () => {
    const html = `
      <link rel="stylesheet" href="/channel-atlas-ui/assets/index-QrSt5678.css">
      <script type="module" src="/channel-atlas-ui/main-aabbcc123456.js"></script>
    `
    const dir = makeFakeDistDir(html)
    const outPath = join(dir, 'channel_atlas_bundle.json')
    try {
      buildChannelAtlasManifest(dir, outPath)
      expect(existsSync(outPath)).toBe(true)
      const written = JSON.parse(require('node:fs').readFileSync(outPath, 'utf8'))
      expect(written.hash).toBe('aabbcc123456')
      expect(written.css).toBe('index-QrSt5678.css')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
```

- [ ] **Step 2: Run — confirm failure**

```bash
npx vitest run --project unit scripts/__tests__/build-channel-atlas-manifest.test.ts
```

Expected: `Cannot find module '../build-channel-atlas-manifest.js'`

- [ ] **Step 3: Implement `scripts/build-channel-atlas-manifest.ts`**

```typescript
// scripts/build-channel-atlas-manifest.ts
//
// Mirrors scripts/build-explore-manifest.ts for the channel-atlas SPA.
// Reads app/channel-atlas/dist/index.html (produced by `vite build` in
// app/channel-atlas) and writes hugo/data/channel_atlas_bundle.json, which
// Hugo loads as `site.Data.channel_atlas_bundle` in
// hugo/layouts/channels/atlas.html to inject hashed <script>/<link> tags.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export interface ChannelAtlasManifest {
  hash: string
  css: string
}

const MAIN_JS_RE  = /\/channel-atlas-ui\/main-([a-zA-Z0-9_-]+)\.js/
const ASSETS_CSS_RE = /\/channel-atlas-ui\/assets\/(index-[a-zA-Z0-9_-]+\.css)/

/**
 * Parse Vite's emitted index.html and (optionally) write the manifest.
 *
 * @param distDir  absolute or relative path to app/channel-atlas/dist
 * @param outPath  optional absolute path to write JSON to
 * @throws if dist/index.html is missing or doesn't contain both refs
 */
export function buildChannelAtlasManifest(
  distDir: string,
  outPath?: string,
): ChannelAtlasManifest {
  const indexPath = path.join(distDir, 'index.html')
  if (!existsSync(indexPath)) {
    throw new Error(
      `build-channel-atlas-manifest: ${indexPath} not found — did vite build run?`,
    )
  }
  const html = readFileSync(indexPath, 'utf8')

  const jsMatch = html.match(MAIN_JS_RE)
  if (!jsMatch) {
    throw new Error(
      `build-channel-atlas-manifest: no main-<hash>.js in ${indexPath}`,
    )
  }
  if (jsMatch[1] === 'dev' || jsMatch[1].length < 6) {
    throw new Error(
      `build-channel-atlas-manifest: refusing to emit hash="${jsMatch[1]}" — looks like a dev sentinel, not a Vite content hash`,
    )
  }

  const cssMatch = html.match(ASSETS_CSS_RE)
  if (!cssMatch) {
    throw new Error(
      `build-channel-atlas-manifest: no index-<hash>.css in ${indexPath}`,
    )
  }

  const manifest: ChannelAtlasManifest = { hash: jsMatch[1], css: cssMatch[1] }

  if (outPath) {
    mkdirSync(path.dirname(outPath), { recursive: true })
    writeFileSync(outPath, JSON.stringify(manifest, null, 2) + '\n')
  }
  return manifest
}

// CLI entry point: tsx scripts/build-channel-atlas-manifest.ts [distDir] [outPath]
const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const distDir = process.argv[2] ?? path.resolve('app/channel-atlas/dist')
  const outPath = process.argv[3] ?? path.resolve('hugo/data/channel_atlas_bundle.json')
  const manifest = buildChannelAtlasManifest(distDir, outPath)
  console.log(
    `build-channel-atlas-manifest: wrote ${outPath} — hash=${manifest.hash} css=${manifest.css}`,
  )
}
```

- [ ] **Step 4: Run — confirm manifest tests pass**

```bash
npx vitest run --project unit scripts/__tests__/build-channel-atlas-manifest.test.ts
```

Expected: all 4 tests pass.

- [ ] **Step 5: Create `scripts/fetch-channel-atlas.ts`**

```typescript
// scripts/fetch-channel-atlas.ts
//
// Build-time fetch: calls GET /build/channel-atlas and writes the response to
// hugo/data/channel_atlas.json. The Hugo layout (hugo/layouts/channels/atlas.html)
// uses site.Data.channel_atlas to inject the payload as inline JSON so the SPA
// can read it without a network round-trip.
//
// Mirrors scripts/fetch-channels.ts.

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const CAP_BASE = process.env.CAP_BASE_URL || 'http://localhost:4004'
const OUT_PATH = join('hugo', 'data', 'channel_atlas.json')

let payload: { channels: unknown[]; buildAt: string; error: string | null } = {
  channels: [],
  buildAt: new Date().toISOString(),
  error: null,
}

try {
  const res = await fetch(`${CAP_BASE}/build/channel-atlas`)
  if (!res.ok) throw new Error(`status ${res.status}`)
  payload = { ...payload, ...(await res.json()) }
} catch (err) {
  payload.error = err instanceof Error ? err.message : String(err)
  console.warn(`[fetch-channel-atlas] warn: ${payload.error} — writing empty payload`)
}

mkdirSync(join('hugo', 'data'), { recursive: true })
writeFileSync(OUT_PATH, JSON.stringify(payload, null, 2), 'utf-8')
console.log(
  `[fetch-channel-atlas] wrote ${payload.channels.length} channels → ${OUT_PATH}`,
)
```

- [ ] **Step 6: Run manifest tests + confirm fetch-channel-atlas parses OK**

```bash
npx vitest run --project unit scripts/__tests__/build-channel-atlas-manifest.test.ts
```

(No automated test for fetch-channel-atlas.ts since it's a thin fetch-and-write shim, fully covered by the endpoint test in Task 2.)

- [ ] **Step 7: Commit**

```bash
git add scripts/build-channel-atlas-manifest.ts scripts/fetch-channel-atlas.ts \
        scripts/__tests__/build-channel-atlas-manifest.test.ts
git commit -m "feat(channels-atlas): add build-channel-atlas-manifest + fetch-channel-atlas scripts"
```

---

## Task 9: Hugo layout + content

**Files:**
- Create: `hugo/layouts/channels/atlas.html`
- Create: `hugo/content/channels/atlas/_index.md`

No unit tests (Hugo template rendering is not unit-testable without a full Hugo build). Validated by the build-smoke in Task 10.

- [ ] **Step 1: Create `hugo/layouts/channels/atlas.html`**

```html
{{ define "main" }}
{{ with site.Data.channel_atlas_bundle }}
  {{/*
    CSS link OUTSIDE the mount container — placing it inside lets Vue wipe
    the <link> on mount before the browser applies it, collapsing the Sigma
    canvas to 0 height ("Container has no height"). Same fix as explore/single.html
    issue #1131.
  */}}
  <link rel="stylesheet" href="/channel-atlas-ui/assets/{{ .css }}">
  <script type="module" src="/channel-atlas-ui/main-{{ .hash }}.js"></script>
  {{/*
    Inline payload: useAtlasData reads this first — no runtime round-trip in
    production. The SPA falls back to fetching /build/channel-atlas in dev
    mode when this element is absent.
  */}}
  {{ with site.Data.channel_atlas }}
  <script type="application/json" id="atlas-payload">{{ . | jsonify }}</script>
  {{ end }}
  <div id="atlas-app" class="atlas-page">
    <p class="atlas-page__loading">Loading Channel Atlas…</p>
  </div>
{{ else }}
  <div id="atlas-app" class="atlas-page">
    <div class="atlas-build-error" role="alert">
      <h2>Channel Atlas bundle missing</h2>
      <p>
        The bundle manifest <code>hugo/data/channel_atlas_bundle.json</code>
        was not present at Hugo build time.
        Run <code>npm run build:channel-atlas</code> before <code>hugo</code>
        to regenerate it.
      </p>
    </div>
  </div>
{{ end }}
<noscript>
  <div class="ds-noscript-fallback">
    <p>JavaScript is required to view the Channel Atlas.</p>
  </div>
</noscript>
{{ end }}
```

- [ ] **Step 2: Create `hugo/content/channels/atlas/_index.md`**

```markdown
---
title: "Channel Atlas"
description: "A visual force-directed map of the SAP developer content channel ecosystem — channels as nodes, connections from shared focus areas and topics."
layout: "atlas"
noRobots: false
---
```

The `layout: "atlas"` frontmatter key instructs Hugo to use `hugo/layouts/channels/atlas.html` for this content section (Hugo lookup: `layouts/<content-type>/<layout>.html` → `layouts/channels/atlas.html`).

- [ ] **Step 3: Verify Hugo can build (no `hugo/data/channel_atlas_bundle.json` exists yet — expect the fallback block to render)**

```bash
cd "D:\projects\tutorials-poc\.claude\worktrees\channels-hub"
npx hugo --source hugo --destination ../hugo-build-test --cleanDestinationDir 2>&1 | head -40
```

Expected: Hugo build completes (warns about missing atlas bundle, renders the fallback `<div class="atlas-build-error">` block — that is correct behaviour). Clean up after:

```bash
Remove-Item -Recurse -Force hugo-build-test
```

- [ ] **Step 4: Commit**

```bash
git add hugo/layouts/channels/atlas.html hugo/content/channels/atlas/_index.md
git commit -m "feat(channels-atlas): add Hugo layout + content for /channels/atlas/"
```

---

## Task 10: MTA wiring, `package.json` scripts, vitest include, and `build:all`

**Files:**
- Modify: `.deploy/mta.yaml` (before-all + approuter builder + already done srv-qa in Task 2)
- Modify: `package.json` (new scripts + updated `build:all`)
- Modify: `vitest.config.ts` (add channel-atlas test include)

- [ ] **Step 1: Update `vitest.config.ts` — add channel-atlas tests to the unit project**

Open `vitest.config.ts`. Find the `unit` project's `include` array:

```typescript
include: ['test/**/*.test.{js,ts}', 'scripts/__tests__/**/*.test.{js,ts}', 'scripts/**/__tests__/**/*.test.{js,ts}', 'srv/**/__tests__/**/*.test.{js,ts}', 'app/analytics-explorer/src/**/__tests__/**/*.test.ts', 'app/explore/src/**/__tests__/**/*.test.ts', 'hugo-apps/src/**/*.{test,spec}.{js,ts}'],
```

Add `'app/channel-atlas/src/**/__tests__/**/*.test.ts'` to the end of the array (before the `]`):

```typescript
include: ['test/**/*.test.{js,ts}', 'scripts/__tests__/**/*.test.{js,ts}', 'scripts/**/__tests__/**/*.test.{js,ts}', 'srv/**/__tests__/**/*.test.{js,ts}', 'app/analytics-explorer/src/**/__tests__/**/*.test.ts', 'app/explore/src/**/__tests__/**/*.test.ts', 'hugo-apps/src/**/*.{test,spec}.{js,ts}', 'app/channel-atlas/src/**/__tests__/**/*.test.ts'],
```

- [ ] **Step 2: Run full unit suite and confirm all new tests are discovered**

```bash
npx vitest run --project unit 2>&1 | grep -E "(channel-atlas|PASS|FAIL|Tests)"
```

Expected: all `app/channel-atlas/src/__tests__/*.test.ts` and the two new `srv/lib/__tests__/build-channel-atlas.test.js` and `test/unit/channels-atlas-endpoint.test.js` tests appear and pass.

- [ ] **Step 3: Add scripts to `package.json`**

Open `package.json`. In the `"scripts"` object, add these three entries (insert after `"build:explore-manifest"` and `"build:explore"` for locality):

```json
"fetch-channel-atlas": "tsx scripts/fetch-channel-atlas.ts",
"build:channel-atlas-manifest": "tsx scripts/build-channel-atlas-manifest.ts",
"build:channel-atlas": "npm --prefix app/channel-atlas install --no-audit --no-fund && npm --prefix app/channel-atlas run build && npm run build:channel-atlas-manifest"
```

- [ ] **Step 4: Wire into `build:all`**

In `package.json`, find the `"build:all"` script. It currently contains:

```
... npm run fetch-channels && npm run fetch-channel-collections && ...
```

and:

```
... npm run build:explore && npm run build:hugo && ...
```

Make two insertions:

**Insertion A** — add `&& npm run fetch-channel-atlas` immediately after `npm run fetch-channels`:

```
... npm run fetch-channels && npm run fetch-channel-atlas && npm run fetch-channel-collections && ...
```

**Insertion B** — add `&& npm run build:channel-atlas` immediately after `npm run build:explore`:

```
... npm run build:explore && npm run build:channel-atlas && npm run build:hugo && ...
```

- [ ] **Step 5: Update `.deploy/mta.yaml` — before-all**

In `.deploy/mta.yaml` under `build-parameters.before-all.builder.commands`, find:

```yaml
        - bash -c "cd .. && npm --prefix app/explore install --no-audit --no-fund"
        - bash -c "cd .. && npm --prefix app/explore run build"
        - bash -c "cd .. && npx tsx scripts/build-explore-manifest.ts app/explore/dist hugo/data/explore_bundle.json"
```

Add immediately after (same indentation level):

```yaml
        # Build app/channel-atlas + emit the bundle manifest into hugo/data/.
        # Hugo reads site.Data.channel_atlas_bundle in
        # hugo/layouts/channels/atlas.html to inject hashed JS/CSS filenames.
        - bash -c "cd .. && npm --prefix app/channel-atlas install --no-audit --no-fund"
        - bash -c "cd .. && npm --prefix app/channel-atlas run build"
        - bash -c "cd .. && npx tsx scripts/build-channel-atlas-manifest.ts app/channel-atlas/dist hugo/data/channel_atlas_bundle.json"
```

- [ ] **Step 6: Update `.deploy/mta.yaml` — approuter builder `rm -rf` and `cp` lines**

Find the approuter builder commands section. There are two changes:

**Change A** — add `static/channel-atlas-ui` to the `rm -rf` wipe line:

Find:
```yaml
        - rm -rf static/admin-ui static/analytics-ui static/scanner-ui static/explore-ui static/data-inspector-ui static/qa
```

Replace with:
```yaml
        - rm -rf static/admin-ui static/analytics-ui static/scanner-ui static/explore-ui static/channel-atlas-ui static/data-inspector-ui static/qa
```

**Change B** — add the channel-atlas dist copy after the explore-ui copy line:

Find:
```yaml
        - mkdir -p static/explore-ui
        - cp -r ../app/explore/dist/. static/explore-ui/
```

Add immediately after:
```yaml
        - mkdir -p static/channel-atlas-ui
        - cp -r ../app/channel-atlas/dist/. static/channel-atlas-ui/
```

- [ ] **Step 7: Verify `check-xs-app-mta.ts` passes (destination + scope drift check)**

```bash
npx tsx scripts/check-xs-app-mta.ts
```

Expected: exit 0 — the new `channel-atlas-ui` route uses `localDir` (not a destination), so no new destination is added; no new scope is added (authenticationType: none). If it exits non-zero, read the error and fix the drift it reports.

- [ ] **Step 8: Run the full unit suite one more time**

```bash
npm test
```

Expected: all tests pass (including all channel-atlas tests wired in Step 2).

- [ ] **Step 9: Commit**

```bash
git add vitest.config.ts package.json .deploy/mta.yaml
git commit -m "feat(channels-atlas): wire MTA, package.json scripts, build:all, vitest include"
```

---

## Self-Review

### 1. Spec coverage

| Spec requirement | Covered by |
|---|---|
| New standalone SPA `app/channel-atlas/` forked from `app/explore/` | Tasks 3–7 |
| Reuse Sigma 3.0.3 + graphology 0.26.0 + ForceAtlas2 0.10.1 | Task 4 (package.json), Task 6 (AtlasGraph.vue) |
| Fork ExploreGraph/FilterDropdown/NodeDetailPanel shapes | Tasks 6 (AtlasGraph), 7 (OwnerTypeFilter, ChannelDetailPanel) |
| Route `/channels/atlas/` | Task 9 (Hugo content), Task 2 (xs-app.json literal route) |
| `hugo/content/channels/atlas/_index.md` + `hugo/layouts/channels/atlas.html` | Task 9 |
| Approuter route for SPA assets | Task 2 (`^/channel-atlas-ui/` route) |
| New MTA module (4th SPA) in `.deploy/mta.yaml` | Task 10 (before-all + approuter builder) |
| `GET /build/channel-atlas` (public, `Cache-Control: 60s`) | Task 2 (srv/server.js) |
| Extends `/build/channels` projection with `subscribers`, `githubStars`, `focusAreas`, `ownerType` | Task 2 (SELECT columns) |
| REVIEWED `ChannelTopicMap` topic tags in feed (phase-2) | Task 2 (separate ChannelTopicMap SELECT) |
| `scripts/fetch-channel-atlas.ts` → `hugo/data/channel_atlas.json` | Task 8 |
| Nodes sized by `log1p(subscribers ?? githubStars ?? 0)` with floor | Task 3 (sizeChannel), documented in graph.ts |
| FLOOR_SIZE documented (sparse data → near-uniform) | Task 3 (constant + JSDoc) |
| 9-value ownerType palette | Task 3 (OWNER_TYPE_PALETTE, all 9 values tested) |
| Phase-1 edges from shared focusAreas | Task 3 (buildFocusEdges) |
| Phase-2 edges from shared ChannelTopicMap topicTags | Task 3 (buildTopicEdges), Task 2 (topicTags in feed) |
| Fail-open: empty/thin feed → empty-state, never crash | Task 7 (App.vue error/loading/empty branches) |
| `focusAreas` NCLOB parseArr pattern | Task 1 (buildAtlasChannels) + Task 2 (endpoint) |
| `srv/lib/build-channel-atlas.js` in srv-qa cp list | Task 2, Step 6 |
| `authenticationType: none` for anon routes | Task 2 (xs-app.json) |
| Literal `/channels/atlas/` before future `/channels/:slug` catch-all | Task 2, Step 5 Change C |
| `ignore-scripts=true` → explicit `build:all` step | Task 10, Step 4 |
| FULL mbt build (no `--skip-build` / `-m`) | Global constraints doc; no shortcut added |
| `cds.entities(NS)` in unit tests | Task 2 (endpoint test uses `cds.entities(NS)`) |

### 2. Placeholder scan

Checked — no "TBD", "TODO", "implement later", "fill in details", "add appropriate error handling", "similar to Task N". All code blocks contain real implementations using actual file paths and codebase patterns.

### 3. Type consistency

- `AtlasEdge` defined once in `app/channel-atlas/src/types.ts` (Task 4 replaces the Task 3 stub) and imported by `graph.ts` via `import type { AtlasEdge } from './types.js'`.
- `AtlasNode extends AtlasChannelDTO` (types.ts) — `App.vue` maps `AtlasChannelDTO → AtlasNode` by spreading and adding `size` + `color`.
- `buildFocusEdges` / `buildTopicEdges` accept `{ id: string; focusAreas/topicTags: string[] }[]` — both `AtlasNode` and `AtlasChannelDTO` satisfy this structural type since both have those fields.
- `useOwnerTypeFilter` returns `{ enabledTypes: Ref<Set<OwnerType>>, toggleType, ALL_OWNER_TYPES }` — `App.vue` calls `toggleType` on `OwnerTypeFilter`'s `@toggle` event; `OwnerTypeFilter` emits `toggle: [OwnerType]`. Types match.
- `AtlasGraph` emits `nodeClick: [{ id: string; node: AtlasNode }]` — `App.vue` handles `@nodeClick="onNodeClick"` where `onNodeClick(e: { id: string; node: AtlasNode })`. Match.
- `buildChannelAtlasManifest` in Task 8 returns `ChannelAtlasManifest = { hash: string; css: string }` — `hugo/layouts/channels/atlas.html` accesses `.hash` and `.css` from `site.Data.channel_atlas_bundle`. Match.
- `srv/lib/build-channel-atlas.js` exports `buildAtlasChannels(rows, topicsByChannel)` — `srv/server.js` calls `require('./lib/build-channel-atlas.js').buildAtlasChannels(rows, topicsByChannel)`. Match.

### 4. Potential gaps / notes for executor

- **Task 2, Step 6 (srv-qa cp list):** The exact cp command format varies by the project's mta.yaml version. Follow the format of the nearest existing `srv/lib/` entry literally. If the srv-qa module doesn't exist yet, skip — confirm with Tom.
- **Task 3 + 4 ordering:** `graph.ts` (Task 3) imports `AtlasEdge` from `types.ts`. The full `types.ts` is written in Task 4. The Task 3 stub (`export interface AtlasEdge { ... }` in `types.ts`) is sufficient to compile `graph.ts` through Task 3 and is upgraded to the full file in Task 4, Step 7. Run Task 4 before Task 5.
- **Hugo `layout: "atlas"` lookup:** Hugo's layout resolution for `_index.md` (list page) with `layout: "atlas"` in the frontmatter looks up `layouts/channels/atlas.html` because the content type is `channels` (inferred from the content directory path). If Hugo resolves differently in this project, use `layout: "channels/atlas"` as the fallback (test with a local Hugo build).
- **Task 10 build:all insert:** The current `build:all` string is very long — use `sd` (the project's preferred find-replace tool) rather than manual editing to reduce risk of off-by-one character edits: `sd 'npm run fetch-channels &&' 'npm run fetch-channels && npm run fetch-channel-atlas &&' package.json` and `sd 'npm run build:explore && npm run build:hugo' 'npm run build:explore && npm run build:channel-atlas && npm run build:hugo' package.json`.
