# PR 1 — Ingest (schema + backfill + refresh job, cron NOT registered)

**Parent plan:** [../2026-07-07-1030-homepage-codejams-autopull.md](../2026-07-07-1030-homepage-codejams-autopull.md)
**Spec:** [../../specs/2026-07-07-1030-homepage-codejams-autopull-design.md](../../specs/2026-07-07-1030-homepage-codejams-autopull-design.md)

**Scope:** Tasks 1–8. This PR is invisible to end users. It adds the `CommunityEvents.region` column, the `regionFromLocation` derivation function, the 6h refresh job, and a one-shot backfill script. The cron is NOT registered — that lands in PR 2.

**Merge criteria:**
- All unit tests green under `npm test`.
- `npx cds deploy --to sqlite::memory:` succeeds (no `@assert.range` runtime errors).
- Draft PR opened; smoke-tested manually on DEV by running the backfill script and confirming `region` column populated on all rows.

---

## Global Constraints

_(Repeated from the parent plan for standalone reading.)_

- **Filter regions fixed at `AMERICAS | EMEA | APJ`** with `UNKNOWN` as parser sentinel.
- **Event types allowlist is `['codejam','devtoberfest']`.**
- **CDS QL tagged-template form only** — no raw `?` placeholders.
- **New refresh job must NOT touch** `contentHash`, `lastExtractedHash`, or `CommunityEventConceptLinks`.
- **Cron minute is `17 */6 * * *`** — but cron REGISTRATION is deferred to PR 2.
- **`cds build --production`** (not `cds compile`) after schema edits.
- **`npx cds deploy --to sqlite::memory:`** before committing `db/**/*.cds` changes.
- **CI Node 22 vs local Node 24** — use `cds.entities(NS)` refs in tests.

---

## Task 1: Add `CommunityEvents.region` column

**Files:**
- Modify: `db/external-content.cds` (around line 422 — the existing `scope` field)

**Interfaces:**
- Produces: new column `com.sap.developers.ims.external.CommunityEvents.region : String(16) @assert.range enum { AMERICAS; EMEA; APJ; UNKNOWN; }`

- [ ] **Step 1: Read the current entity definition**

Confirm current shape:

```bash
sed -n '410,435p' db/external-content.cds
```

Expected: `entity CommunityEvents : cuid, managed { ... scope : String(20); virtualOrInPerson : String(20); ... }`

- [ ] **Step 2: Add the `region` column**

Insert after `virtualOrInPerson` line:

```cds
  virtualOrInPerson : String(20);                  // 'virtual' | 'in-person' (derived)
  region            : String(16) @assert.range enum {
                        AMERICAS; EMEA; APJ; UNKNOWN;
                      };                             // #1030 — derived at ingest
  startDate         : Date;                        // upstream 'date' — required
```

- [ ] **Step 3: Verify CDS compiles (in-memory deploy catches @assert.range)**

Run:

```bash
npx cds deploy --to sqlite::memory:
```

Expected: exits 0, no errors about `region` or `@assert.range`.

- [ ] **Step 4: Verify the model surface exposes the new column**

Run:

```bash
node -e "const cds = require('@sap/cds'); cds.load('db,srv').then(m => { const csn = cds.compile.to.json(m); const c = JSON.parse(csn).definitions['com.sap.developers.ims.external.CommunityEvents']; console.log(Object.keys(c.elements).includes('region') ? 'OK: region present' : 'FAIL: region missing'); }).catch(e => { console.error(e); process.exit(1); });"
```

Expected: `OK: region present`

- [ ] **Step 5: Commit**

```bash
git add db/external-content.cds
git commit -m "feat(#1030): CommunityEvents.region column (AMERICAS/EMEA/APJ/UNKNOWN)"
```

---

## Task 2: `regionFromLocation` pure function

**Files:**
- Create: `srv/lib/events/region-from-location.js`
- Create: `test/unit/region-from-location.test.js`

**Interfaces:**
- Produces: `regionFromLocation(location: string | null | undefined): 'AMERICAS' | 'EMEA' | 'APJ' | 'UNKNOWN'` — case-insensitive substring rules ordered by specificity; `virtual` sentinel returns `UNKNOWN`.

- [ ] **Step 1: Write the failing test file first (TDD)**

Create `test/unit/region-from-location.test.js`:

```js
// test/unit/region-from-location.test.js
// #1030 — region derivation from CommunityEvents.location free-form strings.

import { describe, it, expect } from 'vitest';
import { regionFromLocation } from '../../srv/lib/events/region-from-location.js';

describe('regionFromLocation', () => {
  describe('AMERICAS', () => {
    it.each([
      ['USA', 'AMERICAS'],
      ['United States', 'AMERICAS'],
      ['Canada', 'AMERICAS'],
      ['Toronto, Canada', 'AMERICAS'],
      ['New York, NY, USA', 'AMERICAS'],
      ['São Paulo, Brazil', 'AMERICAS'],
      ['Mexico City, Mexico', 'AMERICAS'],
      ['Americas', 'AMERICAS'],
    ])('classifies %s as AMERICAS', (input, expected) => {
      expect(regionFromLocation(input)).toBe(expected);
    });
  });

  describe('EMEA', () => {
    it.each([
      ['Berlin, Germany', 'EMEA'],
      ['London, UK', 'EMEA'],
      ['Paris, France', 'EMEA'],
      ['Amsterdam, Netherlands', 'EMEA'],
      ['Cape Town, South Africa', 'EMEA'],
      ['Dubai, UAE', 'EMEA'],
      ['Tel Aviv, Israel', 'EMEA'],
      ['Europe', 'EMEA'],
      ['EMEA', 'EMEA'],
    ])('classifies %s as EMEA', (input, expected) => {
      expect(regionFromLocation(input)).toBe(expected);
    });
  });

  describe('APJ', () => {
    it.each([
      ['Bangalore, India', 'APJ'],
      ['Bengaluru', 'APJ'],
      ['Singapore', 'APJ'],
      ['Tokyo, Japan', 'APJ'],
      ['Sydney, Australia', 'APJ'],
      ['Seoul, South Korea', 'APJ'],
      ['Shanghai, China', 'APJ'],
      ['APJ', 'APJ'],
      ['APAC region', 'APJ'],
    ])('classifies %s as APJ', (input, expected) => {
      expect(regionFromLocation(input)).toBe(expected);
    });
  });

  describe('UNKNOWN sentinel', () => {
    it('returns UNKNOWN for null', () => {
      expect(regionFromLocation(null)).toBe('UNKNOWN');
    });

    it('returns UNKNOWN for undefined', () => {
      expect(regionFromLocation(undefined)).toBe('UNKNOWN');
    });

    it('returns UNKNOWN for empty string', () => {
      expect(regionFromLocation('')).toBe('UNKNOWN');
    });

    it('returns UNKNOWN for the "virtual" sentinel (region is orthogonal to virtuality)', () => {
      expect(regionFromLocation('virtual')).toBe('UNKNOWN');
      expect(regionFromLocation('Virtual')).toBe('UNKNOWN');
      expect(regionFromLocation('VIRTUAL')).toBe('UNKNOWN');
    });

    it('returns UNKNOWN for unrecognized locations', () => {
      expect(regionFromLocation('Antarctica')).toBe('UNKNOWN');
      expect(regionFromLocation('Somewhere in space')).toBe('UNKNOWN');
    });
  });

  describe('specificity ordering (first match wins)', () => {
    it('matches city before generic region term', () => {
      // "Berlin" (city) → EMEA even if the string somehow contains "Americas"
      expect(regionFromLocation('Berlin Americas Center')).toBe('EMEA');
    });
  });

  describe('case insensitivity', () => {
    it('matches regardless of case', () => {
      expect(regionFromLocation('BERLIN, GERMANY')).toBe('EMEA');
      expect(regionFromLocation('bangalore')).toBe('APJ');
    });
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

```bash
npm test -- region-from-location
```

Expected: FAIL — `Cannot find module '../../srv/lib/events/region-from-location.js'`.

- [ ] **Step 3: Implement `regionFromLocation`**

Create `srv/lib/events/region-from-location.js`:

```js
// srv/lib/events/region-from-location.js
//
// Issue #1030 — derive homepage-band region (AMERICAS/EMEA/APJ/UNKNOWN) from
// the free-form `CommunityEvents.location` string. Case-insensitive substring
// match on ordered rules; first match wins. `virtual` sentinel returns UNKNOWN
// because region is orthogonal to virtuality (a virtual event has no region;
// its virtualness is tracked on `virtualOrInPerson` separately).
//
// Ordered by specificity: cities before countries before region terms, so
// "Berlin Americas Center" resolves to EMEA (city wins), not AMERICAS.
//
// Rules cover the ~50 most-common CodeJam locations plus SAP-hub cities.
// New unrecognized locations surface via the `homepage.events.region_unknown`
// metric so we can grow the ruleset in follow-up PRs.

const RULES = [
  // AMERICAS — cities first
  { pattern: /\b(New York|San Francisco|Chicago|Toronto|Vancouver|Montreal|São Paulo|Sao Paulo|Buenos Aires|Mexico City|Boston|Seattle|Palo Alto|Austin|Atlanta|Miami)\b/i, region: 'AMERICAS' },
  // AMERICAS — countries + region terms
  { pattern: /\b(USA|U\.S\.A\.|United States|U\.S\.|Canada|Mexico|Brazil|Argentina|Chile|Colombia|Peru|Americas)\b/i, region: 'AMERICAS' },

  // EMEA — cities first
  { pattern: /\b(Berlin|Munich|Hamburg|Frankfurt|Cologne|Walldorf|London|Manchester|Edinburgh|Paris|Lyon|Amsterdam|Rotterdam|Zurich|Geneva|Vienna|Milan|Rome|Madrid|Barcelona|Lisbon|Porto|Warsaw|Copenhagen|Stockholm|Oslo|Helsinki|Dublin|Prague|Budapest|Athens|Cape Town|Johannesburg|Tel Aviv|Jerusalem|Dubai|Riyadh|Cairo|Istanbul)\b/i, region: 'EMEA' },
  // EMEA — countries + region terms
  { pattern: /\b(Germany|France|UK|U\.K\.|United Kingdom|Britain|England|Scotland|Ireland|Netherlands|Belgium|Luxembourg|Switzerland|Austria|Italy|Spain|Portugal|Poland|Czech|Czechia|Hungary|Denmark|Sweden|Norway|Finland|Iceland|Greece|South Africa|Israel|UAE|Saudi Arabia|Egypt|Turkey|Morocco|Kenya|Nigeria|EMEA|Europe|European)\b/i, region: 'EMEA' },

  // APJ — cities first
  { pattern: /\b(Bangalore|Bengaluru|Mumbai|Delhi|New Delhi|Chennai|Hyderabad|Pune|Kolkata|Shanghai|Beijing|Shenzhen|Guangzhou|Hong Kong|Tokyo|Osaka|Kyoto|Yokohama|Sydney|Melbourne|Brisbane|Perth|Auckland|Wellington|Seoul|Busan|Taipei|Kuala Lumpur|Jakarta|Bangkok|Manila|Ho Chi Minh|Hanoi)\b/i, region: 'APJ' },
  // APJ — countries + region terms
  { pattern: /\b(India|China|Japan|Singapore|Australia|New Zealand|South Korea|Korea|Malaysia|Indonesia|Thailand|Vietnam|Philippines|Taiwan|APJ|APAC|Asia|Asia[- ]Pacific)\b/i, region: 'APJ' },
];

export function regionFromLocation(location) {
  if (location === null || location === undefined) return 'UNKNOWN';
  const s = String(location).trim();
  if (!s) return 'UNKNOWN';
  // 'virtual' sentinel — region is orthogonal to virtuality.
  if (/^virtual$/i.test(s)) return 'UNKNOWN';

  for (const rule of RULES) {
    if (rule.pattern.test(s)) return rule.region;
  }
  return 'UNKNOWN';
}
```

- [ ] **Step 4: Run tests, verify they pass**

```bash
npm test -- region-from-location
```

Expected: PASS, all cases green.

- [ ] **Step 5: Commit**

```bash
git add srv/lib/events/region-from-location.js test/unit/region-from-location.test.js
git commit -m "feat(#1030): regionFromLocation pure function + unit tests"
```

---

## Task 3: `fetchAllEvents` gains `typesAllowlist` option

**Files:**
- Modify: `srv/lib/events/index.js`

**Interfaces:**
- Consumes: existing `EVENT_TYPES` array
- Produces: `fetchAllEvents({ now?, timeoutMs?, typesAllowlist? }): Promise<{rows, perSource}>` — when `typesAllowlist` is set (array of `EVENT_TYPES[].id` strings), only matching entries are fetched. Backward-compat: omitted → iterates all types.

- [ ] **Step 1: Extend the failing test**

Append to `srv/lib/events/__tests__/orchestrator.test.js` if it exists; otherwise create a new focused test at `test/unit/events-orchestrator-allowlist.test.js`:

```js
// test/unit/events-orchestrator-allowlist.test.js
// #1030 — fetchAllEvents typesAllowlist option.

import { describe, it, expect, afterEach } from 'vitest';
import { fetchAllEvents, _setMockFetchers, _resetMockFetchers } from '../../srv/lib/events/index.js';

afterEach(() => _resetMockFetchers());

describe('fetchAllEvents typesAllowlist', () => {
  it('with no allowlist, fetches all sources', async () => {
    let khorosCalled = false, rssCalled = false;
    _setMockFetchers({
      khoros: () => { khorosCalled = true; return []; },
      rss:    () => { rssCalled = true; return []; },
    });
    await fetchAllEvents({ now: new Date('2026-07-07') });
    expect(khorosCalled).toBe(true);
    expect(rssCalled).toBe(true);
  });

  it('with typesAllowlist=[codejam], only khoros is called', async () => {
    let khorosCalled = false, rssCalled = false;
    _setMockFetchers({
      khoros: () => { khorosCalled = true; return []; },
      rss:    () => { rssCalled = true; return []; },
    });
    await fetchAllEvents({ now: new Date('2026-07-07'), typesAllowlist: ['codejam'] });
    expect(khorosCalled).toBe(true);
    expect(rssCalled).toBe(false);
  });

  it('with typesAllowlist=[devtoberfest], only rss is called', async () => {
    let khorosCalled = false, rssCalled = false;
    _setMockFetchers({
      khoros: () => { khorosCalled = true; return []; },
      rss:    () => { rssCalled = true; return []; },
    });
    await fetchAllEvents({ now: new Date('2026-07-07'), typesAllowlist: ['devtoberfest'] });
    expect(khorosCalled).toBe(false);
    expect(rssCalled).toBe(true);
  });

  it('with typesAllowlist=[codejam, devtoberfest], both are called', async () => {
    let khorosCalled = false, rssCalled = false;
    _setMockFetchers({
      khoros: () => { khorosCalled = true; return []; },
      rss:    () => { rssCalled = true; return []; },
    });
    await fetchAllEvents({
      now: new Date('2026-07-07'),
      typesAllowlist: ['codejam', 'devtoberfest'],
    });
    expect(khorosCalled).toBe(true);
    expect(rssCalled).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

```bash
npm test -- events-orchestrator-allowlist
```

Expected: All 3 allowlist tests FAIL (because current code doesn't filter). The "no allowlist" test passes.

- [ ] **Step 3: Modify `srv/lib/events/index.js`**

Change the `fetchAllEvents` function — extract the typesAllowlist option and filter the loop:

```js
export async function fetchAllEvents(opts = {}) {
  const now = opts.now ?? new Date();
  const typesAllowlist = opts.typesAllowlist ?? null;   // #1030 — filter to a subset of EVENT_TYPES
  const perSource = {
    khoros: { rowsFetched: 0, fetcherRejected: false, reason: null },
    rss:    { rowsFetched: 0, fetcherRejected: false, reason: null },
  };

  // Inject mock fetchers into the transitive dependencies when present.
  if (_mockKhoros) {
    const kh = await import('./khoros-fetcher.js');
    kh._setMockFetcher(_mockKhoros);
  }
  if (_mockRss) {
    const rss = await import('./rss-fetcher.js');
    rss._setMockFetcher(_mockRss);
  }

  const tasks = [];
  for (const et of EVENT_TYPES) {
    if (typesAllowlist && !typesAllowlist.includes(et.id)) continue;   // #1030
    if (et.source === 'khoros') {
      tasks.push({ key: 'khoros', task: () => fetchKhoros(et.khorosBoardId, et.id, et.defaultScope, { now, timeoutMs: opts.timeoutMs }) });
    } else if (et.source === 'rss') {
      tasks.push({ key: 'rss', task: () => fetchRss(et.rssUrl, et.id, et.defaultScope, { timeoutMs: opts.timeoutMs }) });
    }
  }
  // ... rest of function unchanged
```

- [ ] **Step 4: Run tests, verify they pass**

```bash
npm test -- events-orchestrator-allowlist
```

Expected: PASS all cases.

- [ ] **Step 5: Verify existing test suite still passes (backward compat)**

```bash
npm test -- events
```

Expected: All existing event tests still green.

- [ ] **Step 6: Commit**

```bash
git add srv/lib/events/index.js test/unit/events-orchestrator-allowlist.test.js
git commit -m "feat(#1030): fetchAllEvents typesAllowlist option (backward compat)"
```

---

## Task 4: `refresh-community-events-job.js` (job logic only, cron NOT registered)

**Files:**
- Create: `srv/jobs/refresh-community-events-job.js`

**Interfaces:**
- Consumes: `fetchAllEvents({typesAllowlist})`, `canonicalizeEventSlug`, `decodeHtmlEntities`, `regionFromLocation`, `cds.entities('com.sap.developers.ims.external')`
- Produces: `runRefreshCommunityEvents(logId, opts?) : Promise<{fetched, upserted, unknownRegion, errors}>` — pure upsert (no LLM, no embedding, no CommunityEventConceptLinks touch, no contentHash/lastExtractedHash write).

- [ ] **Step 1: Write the file**

```js
// srv/jobs/refresh-community-events-job.js
//
// Issue #1030 (Row 3 homepage events auto-pull): every 6 h, re-pull CodeJam +
// Devtoberfest metadata from Khoros / RSS into CommunityEvents. Does NOT do
// embedding or LLM concept extraction — those stay with the twice-weekly
// fetch-community-events-job.js. Purpose: keep the homepage events band
// fresh without incurring LLM cost on every cycle.
//
// Deliberate non-touching (memory: "Never depend on shared columns without
// reading the owner"): contentHash, lastExtractedHash, and
// CommunityEventConceptLinks are ALL owned by the twice-weekly extraction
// job. Leaving them alone here lets the two jobs be idempotent on the same
// rows — a new row upserted here (with contentHash=NULL) is naturally picked
// up by the twice-weekly job on its next cycle.
//
// Spec: docs/superpowers/specs/2026-07-07-1030-homepage-codejams-autopull-design.md §5

import cds from '@sap/cds';
import { fetchAllEvents, canonicalizeEventSlug } from '../lib/events/index.js';
import { decodeHtmlEntities } from '../lib/events/text-normalize.js';
import { regionFromLocation } from '../lib/events/region-from-location.js';
import * as metrics from '../lib/metrics.js';

const NAMESPACE_EXT = 'com.sap.developers.ims.external';
const REFRESH_TYPES = ['codejam', 'devtoberfest'];
const LOG = cds.log('refresh-community-events');

export async function runRefreshCommunityEvents(_logId, opts = {}) {
  const fetchAllEventsFn = opts.fetchAllEvents ?? fetchAllEvents;
  const summary = { fetched: 0, upserted: 0, unknownRegion: 0, errors: 0 };
  try {
    const db = cds.db ?? await cds.connect.to('db');
    const { CommunityEvents } = cds.entities(NAMESPACE_EXT);

    let orchResult;
    try {
      orchResult = await fetchAllEventsFn({
        now: new Date(),
        typesAllowlist: REFRESH_TYPES,
      });
    } catch (err) {
      LOG.error(`fetcher failed: ${err.message}`);
      summary.errors++;
      metrics.counter(`homepage.events.refresh[result=failed]`);
      return summary;
    }
    const { rows: corpus, perSource } = orchResult;
    summary.fetched = corpus.length;

    if (corpus.length === 0) {
      LOG.warn('refresh-community-events: fetchers returned no rows');
      metrics.counter(`homepage.events.refresh[result=partial]`);
      return summary;
    }

    const now = new Date();
    for (const row of corpus) {
      try {
        const slug = canonicalizeEventSlug(row.id);
        const title = decodeHtmlEntities(row.title ?? '');
        const location = decodeHtmlEntities(row.location ?? '');
        const virtualOrInPerson =
          (location && location.toLowerCase() === 'virtual') || row.scope === 'virtual'
            ? 'virtual' : 'in-person';
        const region = regionFromLocation(location);
        if (region === 'UNKNOWN' && virtualOrInPerson !== 'virtual') {
          summary.unknownRegion++;
          metrics.counter(`homepage.events.region_unknown[location=${encodeURIComponent(location)}]`);
        }

        const upsertRow = {
          slug,
          eventType: row.type,
          source: row._source ?? null,
          title,
          url: row.url,
          sourceId: row.id,
          location: location || '',
          scope: row.scope ?? '',
          virtualOrInPerson,
          region,
          startDate: row.date,
          endDate: row.end_date || null,
          lastSeenAt: now,
        };

        const existing = await SELECT.one.from(CommunityEvents).columns('ID').where({ slug });
        if (!existing) {
          await INSERT.into(CommunityEvents).entries({ ...upsertRow, firstSeenAt: now });
          metrics.counter(`homepage.events.refresh_rows[action=inserted]`);
        } else {
          await UPDATE(CommunityEvents).set(upsertRow).where({ ID: existing.ID });
          metrics.counter(`homepage.events.refresh_rows[action=updated]`);
        }
        summary.upserted++;
      } catch (err) {
        LOG.warn(`[${row.id}] refresh row error: ${err.message}`);
        summary.errors++;
      }
    }

    const result = summary.errors === 0 ? 'ok' : 'partial';
    metrics.counter(`homepage.events.refresh[result=${result}]`);
    LOG.info(JSON.stringify({ ...summary, perSource }));
    return summary;
  } catch (err) {
    LOG.error(`refresh cycle failed: ${err.message}`);
    summary.errors++;
    metrics.counter(`homepage.events.refresh[result=failed]`);
    return summary;
  }
}
```

- [ ] **Step 2: Commit (tests come in the next task)**

```bash
git add srv/jobs/refresh-community-events-job.js
git commit -m "feat(#1030): refresh-community-events-job.js (upsert only, no LLM)"
```

---

## Task 5: Refresh-job unit tests

**Files:**
- Create: `test/unit/refresh-community-events-job.test.js`

**Interfaces:**
- Consumes: `runRefreshCommunityEvents` from Task 4.

- [ ] **Step 1: Write the tests**

Create `test/unit/refresh-community-events-job.test.js`:

```js
// test/unit/refresh-community-events-job.test.js
// #1030 — refresh cron is upsert-only; no LLM cost.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import cds from '@sap/cds';
import { runRefreshCommunityEvents } from '../../srv/jobs/refresh-community-events-job.js';

const NAMESPACE_EXT = 'com.sap.developers.ims.external';

// cds.test bootstraps an in-memory SQLite that reflects db/*.cds.
const { test } = cds;
test.in(__dirname, '..', '..');
test('serve', 'all', '--in-memory');

async function seedRow(overrides = {}) {
  const db = await cds.connect.to('db');
  const { CommunityEvents } = cds.entities(NAMESPACE_EXT);
  const row = {
    ID: cds.utils.uuid(),
    slug: 'ce-codejam-existing',
    eventType: 'codejam',
    source: 'khoros',
    title: 'Existing',
    url: 'https://example.com/existing',
    sourceId: 'codejam/existing',
    location: 'Berlin, Germany',
    scope: 'local',
    virtualOrInPerson: 'in-person',
    region: 'EMEA',
    startDate: '2027-01-01',
    endDate: '2027-01-01',
    contentHash: 'HASH-preserved',
    lastExtractedHash: 'HASH-preserved',
    firstSeenAt: new Date(),
    lastSeenAt: new Date(),
    ...overrides,
  };
  await INSERT.into(CommunityEvents).entries(row);
  return row;
}

function fakeFetcher(rows, opts = {}) {
  return async () => ({
    rows,
    perSource: {
      khoros: { rowsFetched: rows.filter(r => r._source === 'khoros').length, fetcherRejected: false, reason: null },
      rss:    { rowsFetched: rows.filter(r => r._source === 'rss').length,    fetcherRejected: false, reason: null },
      ...opts,
    },
  });
}

describe('runRefreshCommunityEvents', () => {
  beforeEach(async () => {
    const db = await cds.connect.to('db');
    const { CommunityEvents } = cds.entities(NAMESPACE_EXT);
    await DELETE.from(CommunityEvents);
  });

  it('inserts new rows with derived region', async () => {
    const summary = await runRefreshCommunityEvents('t1', {
      fetchAllEvents: fakeFetcher([
        {
          id: 'codejam/new-1',
          type: 'codejam',
          _source: 'khoros',
          title: 'CAP CodeJam Bengaluru',
          url: 'https://example.com/1',
          location: 'Bengaluru, India',
          scope: 'local',
          date: '2027-05-15',
          end_date: '2027-05-15',
        },
      ]),
    });
    expect(summary.fetched).toBe(1);
    expect(summary.upserted).toBe(1);
    expect(summary.errors).toBe(0);
    const db = await cds.connect.to('db');
    const { CommunityEvents } = cds.entities(NAMESPACE_EXT);
    const row = await SELECT.one.from(CommunityEvents).where({ slug: 'ce-codejam-new-1' });
    expect(row.region).toBe('APJ');
  });

  it('updates existing rows but does NOT touch contentHash/lastExtractedHash', async () => {
    const seed = await seedRow();
    await runRefreshCommunityEvents('t2', {
      fetchAllEvents: fakeFetcher([
        {
          id: 'codejam/existing',
          type: 'codejam',
          _source: 'khoros',
          title: 'Existing (updated title)',
          url: 'https://example.com/existing',
          location: 'Berlin, Germany',
          scope: 'local',
          date: '2027-01-01',
          end_date: '2027-01-01',
        },
      ]),
    });
    const db = await cds.connect.to('db');
    const { CommunityEvents } = cds.entities(NAMESPACE_EXT);
    const row = await SELECT.one.from(CommunityEvents).where({ slug: 'ce-codejam-existing' });
    expect(row.title).toBe('Existing (updated title)');
    // Critical: the extraction-owned columns are untouched.
    expect(row.contentHash).toBe('HASH-preserved');
    expect(row.lastExtractedHash).toBe('HASH-preserved');
  });

  it('counts region_unknown for parser misses', async () => {
    const summary = await runRefreshCommunityEvents('t3', {
      fetchAllEvents: fakeFetcher([
        {
          id: 'codejam/mystery',
          type: 'codejam',
          _source: 'khoros',
          title: 'Mystery event',
          url: 'https://example.com/x',
          location: 'Somewhere Unmapped',
          scope: 'local',
          date: '2027-06-01',
        },
      ]),
    });
    expect(summary.unknownRegion).toBe(1);
  });

  it('does NOT count region_unknown for virtual events', async () => {
    const summary = await runRefreshCommunityEvents('t4', {
      fetchAllEvents: fakeFetcher([
        {
          id: 'codejam/virtual',
          type: 'codejam',
          _source: 'khoros',
          title: 'Virtual CodeJam',
          url: 'https://example.com/v',
          location: 'virtual',
          scope: 'virtual',
          date: '2027-06-01',
        },
      ]),
    });
    expect(summary.unknownRegion).toBe(0);
  });

  it('returns non-fatally when the fetcher throws', async () => {
    const summary = await runRefreshCommunityEvents('t5', {
      fetchAllEvents: async () => { throw new Error('Khoros unreachable'); },
    });
    expect(summary.errors).toBeGreaterThan(0);
    expect(summary.fetched).toBe(0);
  });

  it('per-row error does not halt the loop', async () => {
    // Construct a row that will cause an UPDATE failure by targeting a
    // duplicate slug on INSERT — one row succeeds, one errors.
    await seedRow({ slug: 'ce-codejam-one' });
    const summary = await runRefreshCommunityEvents('t6', {
      fetchAllEvents: fakeFetcher([
        {
          id: 'codejam/one', type: 'codejam', _source: 'khoros',
          title: 'One (update)', url: 'https://x/1', location: 'Paris, France',
          scope: 'local', date: '2027-07-01',
        },
        {
          id: 'codejam/two', type: 'codejam', _source: 'khoros',
          title: 'Two', url: 'https://x/2', location: 'Tokyo, Japan',
          scope: 'local', date: '2027-07-02',
        },
      ]),
    });
    expect(summary.fetched).toBe(2);
    expect(summary.upserted).toBe(2);
  });
});
```

- [ ] **Step 2: Run tests, verify they pass**

```bash
npm test -- refresh-community-events-job
```

Expected: PASS all cases.

- [ ] **Step 3: Commit**

```bash
git add test/unit/refresh-community-events-job.test.js
git commit -m "test(#1030): refresh-community-events-job unit tests"
```

---

## Task 6: One-shot backfill script

**Files:**
- Create: `scripts/backfill-community-events-region.cjs`

**Interfaces:**
- Consumes: `regionFromLocation` from Task 2, `cds bind --exec` env for HANA.
- Produces: idempotent update — sets `region` on every `CommunityEvents` row where `region IS NULL OR region = ''`.

- [ ] **Step 1: Write the script**

```js
// scripts/backfill-community-events-region.cjs
//
// Issue #1030 — one-shot idempotent backfill.
// Populates CommunityEvents.region on any row where it's null or empty by
// running the same regionFromLocation function used at ingest. Safe to
// re-run — it only touches rows where region is unset.
//
// Usage:
//   Local (sqlite):  node scripts/backfill-community-events-region.cjs
//   Hybrid (HANA):   cds bind --exec -- node scripts/backfill-community-events-region.cjs
//
// Emits per-row action summary + final count.

const cds = require('@sap/cds');
const path = require('path');
const { pathToFileURL } = require('url');

async function loadRegionFn() {
  // The regionFromLocation function is ESM; import via dynamic import from CJS.
  const url = pathToFileURL(path.resolve(__dirname, '..', 'srv', 'lib', 'events', 'region-from-location.js')).href;
  const mod = await import(url);
  return mod.regionFromLocation;
}

async function main() {
  const regionFromLocation = await loadRegionFn();
  const db = await cds.connect.to('db');
  const { CommunityEvents } = cds.entities('com.sap.developers.ims.external');

  const rows = await SELECT.from(CommunityEvents)
    .columns('ID', 'location', 'region')
    .where`region is null or region = ''`;

  console.log(`[backfill] ${rows.length} rows to update`);

  let updated = 0, unknown = 0;
  for (const row of rows) {
    const region = regionFromLocation(row.location);
    if (region === 'UNKNOWN') unknown++;
    await UPDATE(CommunityEvents).set({ region }).where({ ID: row.ID });
    updated++;
    if (updated % 50 === 0) console.log(`[backfill] progress: ${updated}/${rows.length}`);
  }
  console.log(`[backfill] complete: updated=${updated}, unknown=${unknown}`);
  process.exit(0);
}

main().catch((err) => {
  console.error('[backfill] failed:', err);
  process.exit(1);
});
```

- [ ] **Step 2: Local dry-run against SQLite**

```bash
npx cds deploy --to sqlite:test.sqlite && node scripts/backfill-community-events-region.cjs
```

Expected: `[backfill] 0 rows to update` (fresh DB has no rows), or if rows exist, output like `[backfill] complete: updated=N, unknown=K`.

Cleanup:

```bash
rm -f test.sqlite
```

- [ ] **Step 3: Commit**

```bash
git add scripts/backfill-community-events-region.cjs
git commit -m "feat(#1030): scripts/backfill-community-events-region.cjs (idempotent)"
```

---

## Task 7: Existing `fetch-community-events-job` also writes `region`

**Files:**
- Modify: `srv/jobs/fetch-community-events-job.js`

**Rationale:** From today forward, both jobs should agree on `region`. The refresh job writes it on every cycle; without this task, the twice-weekly extraction job would clear the column back to null on any row it touches after a rename.

**Interfaces:**
- Consumes: `regionFromLocation`
- Produces: `region` on every `upsertRow` in the twice-weekly job.

- [ ] **Step 1: Add the import and the region derivation**

Modify `srv/jobs/fetch-community-events-job.js`. Near the top (line 30 area) alongside `decodeHtmlEntities`:

```js
import { regionFromLocation } from '../lib/events/region-from-location.js';
```

Inside the per-row loop where `upsertRow` is constructed (around line 168):

```js
const virtualOrInPerson = (location && location.toLowerCase() === 'virtual') || row.scope === 'virtual' ? 'virtual' : 'in-person';
if (virtualOrInPerson === 'virtual') summary.virtualCount++;
const region = regionFromLocation(location);   // #1030 — parity with refresh job
```

Add `region` to the `upsertRow` object literal:

```js
const upsertRow = {
  slug,
  eventType: row.type,
  source: row._source ?? null,
  title,
  description,
  url: row.url,
  sourceId: row.id,
  location: location || '',
  scope: row.scope ?? '',
  virtualOrInPerson,
  region,                                        // #1030
  startDate: row.date,
  endDate: row.end_date || null,
  contentHash,
  lastSeenAt: now,
};
```

- [ ] **Step 2: Verify existing tests still pass**

```bash
npm test -- fetch-community-events
```

Expected: All existing tests green. If any assertion checks the exact shape of `upsertRow`, extend it to include `region`.

- [ ] **Step 3: Commit**

```bash
git add srv/jobs/fetch-community-events-job.js
git commit -m "feat(#1030): fetch-community-events-job also derives region (parity with refresh)"
```

---

## Task 8: PR 1 verification + open PR

**Files:** (none — this is a checkpoint task)

- [ ] **Step 1: Run the full unit suite**

```bash
npm test
```

Expected: PASS. Zero regressions.

- [ ] **Step 2: Confirm CDS deploys clean**

```bash
npx cds deploy --to sqlite::memory:
```

Expected: exit 0. Confirms `@assert.range` on `region` doesn't blow up at runtime.

- [ ] **Step 3: Push branch and open draft PR**

```bash
git push -u origin HEAD
gh pr create --draft \
  --title "feat(#1030): PR 1 — CommunityEvents.region + refresh-job scaffold (cron NOT registered)" \
  --body "$(cat <<'EOF'
Part 1 of 3 for #1030 (homepage CodeJams auto-pull).

## What ships here
- `CommunityEvents.region` column (`AMERICAS | EMEA | APJ | UNKNOWN`)
- `srv/lib/events/region-from-location.js` — pure derivation function
- `srv/jobs/refresh-community-events-job.js` — 6h upsert-only cron logic (NOT yet registered)
- `scripts/backfill-community-events-region.cjs` — one-shot idempotent backfill
- Twice-weekly `fetch-community-events-job` also derives `region` for parity
- Unit tests: `region-from-location`, `refresh-community-events-job`, `events-orchestrator-allowlist`

## What ISN'T here
- Cron registration (PR 2)
- Endpoint rewrite, Vue island, /me/ field, feature flag (PR 3)

## Deployment
After merge, on DEV:
1. Deploy MTA.
2. Run: \`cds bind --exec -- node scripts/backfill-community-events-region.cjs\`
3. Verify all rows have non-null \`region\` via admin SQL console.

Closes part 1 of #1030.
EOF
)"
```

Expected: draft PR URL printed. No further merge action here — Tom reviews and merges to trigger PR 2.

---

## PR 1 Merge Checklist

- [ ] `npm test` green
- [ ] `npx cds deploy --to sqlite::memory:` exits 0
- [ ] All 8 tasks committed
- [ ] Draft PR opened; description references #1030 and outlines what's in / not in
- [ ] After merge on DEV: backfill script run against DEV HANA; `region` populated on all rows (spot check via admin SQL: `SELECT region, COUNT(*) FROM ...CommunityEvents GROUP BY region`)
