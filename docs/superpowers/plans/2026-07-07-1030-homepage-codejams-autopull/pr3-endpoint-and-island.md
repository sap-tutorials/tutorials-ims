# PR 3 — Endpoint rewrite + Vue island + `/me/` field (user-visible flip)

**Parent plan:** [../2026-07-07-1030-homepage-codejams-autopull.md](../2026-07-07-1030-homepage-codejams-autopull.md)
**Spec:** [../../specs/2026-07-07-1030-homepage-codejams-autopull-design.md](../../specs/2026-07-07-1030-homepage-codejams-autopull-design.md)

**Scope:** Tasks 10–20. Rewrites `HomepageService.events()` to read `CommunityEvents`, wires the personalization envelope, adds the `setPreferredEventRegion` action, ships the new Vue island + Hugo partial + `/me/` `<Select>`, and gates everything behind `HomepageConfig.eventsBandAutoPullEnabled`.

**Merge criteria:**
- All unit + hybrid tests green.
- Manual verification on local `cds watch` + `npm run dev`: clicking each chip re-fetches with the right `region=` param; the DevTools Network tab shows ETag/304 on second click of same chip; BroadcastChannel from `/me/` triggers re-render on the homepage tab.
- Smoke test on DEV: `curl https://<dev>/api/homepage/events?region=EMEA | jq '.[] | select(.region != "EMEA" and .isVirtual == false)'` returns empty.

---

## Global Constraints (recap)

- **CDS QL tagged-template form only** — no raw `?` placeholders.
- **`_state.events` becomes `Map<string, {at,value}>`**, capped at 16 entries. Cache key: `${region}|${includeVirtual ? 1 : 0}`.
- **Endpoint never 400s** on bad `region` param — coerce to `'ALL'`.
- **Event types allowlist is `['codejam','devtoberfest']`.**
- **Feature flag `HomepageConfig.eventsBandAutoPullEnabled`** — when `false`, endpoint falls back to reading legacy `Events` entity (existing behavior).
- **`PROFILE_VOCAB` drift-locked.**
- **`preferredEventRegion` values** = `{AMERICAS, EMEA, APJ, VIRTUAL, ALL}` ∪ `null`.

---

## Backend half (Tasks 10–15)

### Task 10: `preferredEventRegion` column + `eventsBandAutoPullEnabled` flag

**Files:**
- Modify: `db/schema.cds` (around `entity UserLearningPreferences`)
- Modify: `db/homepage.cds` (around `entity HomepageConfig`)
- Modify: `srv/lib/branch/profile-fields.js`

**Interfaces:**
- Produces:
  - `UserLearningPreferences.preferredEventRegion : String(16) @assert.range enum { AMERICAS; EMEA; APJ; VIRTUAL; ALL; }` (nullable — `null` means "never set")
  - `HomepageConfig.eventsBandAutoPullEnabled : Boolean default true` (feature-flag rollback path)
  - `PROFILE_VOCAB.preferredEventRegion = ['AMERICAS','EMEA','APJ','VIRTUAL','ALL']`

- [ ] **Step 1: Modify `db/schema.cds`**

Find `entity UserLearningPreferences`. Add:

```cds
entity UserLearningPreferences : managed {
  key user             : Association to Users;
  deployment           : String(20) @assert.range enum { cloud; onprem; };
  role                 : String(20) @assert.range enum { developer; architect; sysadmin; student; };
  cloud                : String(20) @assert.range enum { btp; aws; azure; gcp; alibaba; oracle; ibm; };
  // #1030 — homepage Row 3 events band region preference. Null = never set,
  // client falls through to browser-TZ hint. VIRTUAL/ALL are UI filter modes
  // (never appear on CommunityEvents.region — that column uses UNKNOWN sentinel).
  preferredEventRegion : String(16) @assert.range enum {
                            AMERICAS; EMEA; APJ; VIRTUAL; ALL;
                         };
}
```

- [ ] **Step 2: Modify `db/homepage.cds`**

Find `entity HomepageConfig`. Add:

```cds
// #1030 — feature flag for the auto-pulled events band. When false, the
// endpoint falls back to reading the legacy manually-curated `Events` entity
// (the pre-#1030 behavior), giving us a redeploy-free rollback path.
eventsBandAutoPullEnabled : Boolean default true;
```

- [ ] **Step 3: Modify `srv/lib/branch/profile-fields.js`**

```js
export const PROFILE_FIELDS = ['deployment', 'role', 'cloud', 'preferredEventRegion'];   // #1030

export const PROFILE_VOCAB = {
  deployment: ['cloud', 'onprem'],
  role: ['developer', 'architect', 'sysadmin', 'student'],
  cloud: ['btp', 'aws', 'azure', 'gcp', 'alibaba', 'oracle', 'ibm'],
  // #1030 — homepage Row 3 events band region preference.
  // VIRTUAL and ALL are UI modes (never physical regions).
  preferredEventRegion: ['AMERICAS', 'EMEA', 'APJ', 'VIRTUAL', 'ALL'],
};
```

- [ ] **Step 4: Verify CDS deploys (catches @assert.range at runtime)**

```bash
npx cds deploy --to sqlite::memory:
```

Expected: exit 0.

- [ ] **Step 5: Run existing drift-guard test**

```bash
npm test -- profile-fields-sync
```

Expected: PASS (the guard now covers `preferredEventRegion` because we updated both PROFILE_VOCAB *and* the CDS enum).

- [ ] **Step 6: Commit**

```bash
git add db/schema.cds db/homepage.cds srv/lib/branch/profile-fields.js
git commit -m "feat(#1030): preferredEventRegion + eventsBandAutoPullEnabled columns"
```

---

### Task 11: Widen `EventCard` type + endpoint signature in `homepage-service.cds`

**Files:**
- Modify: `srv/homepage-service.cds`

**Interfaces:**
- Produces:
  - `EventCard` gains `endsAt: Date`, `url: String`, `eventType: String`, `region: String`, `isVirtual: Boolean`
  - `events()` signature becomes `events(region: String, includeVirtual: Boolean) returns array of EventCard`
  - `PersonalizedEnvelope` gains `eventsRegion: String`

- [ ] **Step 1: Edit `EventCard` type**

Find and replace:

```cds
type EventCard   { title: String; startsAt: Timestamp; location: String; format: String; register: String; }
```

with:

```cds
// #1030 — EventCard is served by CommunityEvents when eventsBandAutoPullEnabled=true,
// else falls back to legacy Events entity. eventType/region/isVirtual are new;
// title/startsAt/location remain compatible with legacy consumers.
type EventCard {
  title:     String;
  startsAt:  Timestamp;
  endsAt:    Timestamp;
  location:  String;
  format:    String;
  register:  String;
  url:       String;
  eventType: String;
  region:    String;
  isVirtual: Boolean;
}
```

- [ ] **Step 2: Widen `events()` function signature**

Find:

```cds
function events()              returns array of EventCard;
```

Replace with:

```cds
// #1030 — region: 'ALL' | 'AMERICAS' | 'EMEA' | 'APJ' | 'VIRTUAL' (default 'ALL')
// includeVirtual: Boolean (default true). Invalid region values coerce to 'ALL'.
function events(region: String, includeVirtual: Boolean) returns array of EventCard;
```

- [ ] **Step 3: Extend `PersonalizedEnvelope`**

Find the `type PersonalizedEnvelope { ... }` block. Add one field:

```cds
type PersonalizedEnvelope {
  hash            : String;
  profile         : PersonalizedProfile;
  verbOrder       : array of String;
  forYou          : array of ForYouItem;
  teaserOrder     : array of String;
  shelfOverrides  : ShelfOverrideMap;
  videoFilterTags : array of String;
  rssFilterTags   : array of String;
  eventsRegion    : String;                     // #1030 — user's preferredEventRegion; null = unset
}
```

- [ ] **Step 4: Verify CDS compiles**

```bash
npx cds deploy --to sqlite::memory:
```

Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add srv/homepage-service.cds
git commit -m "feat(#1030): widen EventCard + events() signature + envelope.eventsRegion"
```

---

### Task 12: Rewrite `on('events')` handler in `homepage-service.js`

**Files:**
- Modify: `srv/homepage-service.js`

**Interfaces:**
- Consumes: widened `events()` signature from Task 11; `HomepageConfig.eventsBandAutoPullEnabled` from Task 10; `CommunityEvents` from Task 1.
- Produces: request-scoped filter + 60s per-key cache; ETag; graceful fallback to legacy Events when flag off.

- [ ] **Step 1: Replace the initial state declaration + cache reset helper**

Find `const _state = (globalThis[STATE_KEY] ??= { ... })` (around line 34). Replace the `events:` field:

```js
const _state = (globalThis[STATE_KEY] ??= {
  // #1030 — Map keyed by `${region}|${includeVirtual?1:0}`, LRU-capped at 16.
  events: new Map(),
  shelves: new Map(),
  ft: { at: 0, payload: null },
});
```

And update `_resetForTests`:

```js
export function _resetForTests() {
  _state.events = new Map();
  _state.shelves.clear();
  _state.ft = { at: 0, payload: null };
}
```

- [ ] **Step 2: Add cache-key helper + LRU cap constants**

Near the existing `const EVENTS_TTL_MS = 60 * 1000;`:

```js
const EVENTS_TTL_MS = 60 * 1000;               // 60 s
const EVENTS_CACHE_MAX = 16;                   // #1030 — LRU cap

const VALID_REGIONS = new Set(['ALL', 'AMERICAS', 'EMEA', 'APJ', 'VIRTUAL']);
const REFRESH_TYPES = ['codejam', 'devtoberfest'];   // #1030 — same as refresh cron
const HOMEPAGE_CONFIG_SINGLETON_ID = '00000000-0000-0000-0000-00000000c8ae';
```

(If `HOMEPAGE_CONFIG_SINGLETON_ID` is already declared earlier in the file, don't redeclare — reuse.)

- [ ] **Step 3: Import `metrics`**

Confirm this import already exists at the top:

```js
import * as metrics from './lib/metrics.js';
```

If not, add it.

- [ ] **Step 4: Replace the `this.on('events', …)` handler**

Locate the existing handler (line 97 area). Replace the entire block with:

```js
// (#639, #1030) events() — CommunityEvents-backed with region + includeVirtual
// filters, per-key 60s cache, ETag. Falls back to legacy Events entity when
// HomepageConfig.eventsBandAutoPullEnabled=false (rollback path).
this.on('events', async (req) => {
  // Parse + validate query params. Invalid region coerces to 'ALL'
  // (spec §6.2 — endpoint must never 400 on typo).
  const rawRegion = String(req.data?.region ?? 'ALL').toUpperCase();
  const region = VALID_REGIONS.has(rawRegion) ? rawRegion : 'ALL';
  if (region !== rawRegion) {
    metrics.counter('homepage.events.requests[region=invalid]');
  }
  // includeVirtual defaults to true; only false when explicitly === false.
  const includeVirtual = req.data?.includeVirtual !== false;

  const cacheKey = `${region}|${includeVirtual ? 1 : 0}`;
  const now = Date.now();
  const hit = _state.events.get(cacheKey);
  if (hit && (now - hit.at) < EVENTS_TTL_MS) {
    metrics.counter(`homepage.events.requests[region=${region},virtual=${includeVirtual ? 1 : 0},result=200]`);
    return hit.value;
  }

  // Feature-flag check — fallback to legacy Events entity when off.
  let cfg = null;
  try {
    const db = await cds.connect.to('db');
    cfg = await db.run(
      SELECT.one.from('com.sap.developers.ims.HomepageConfig')
        .where({ ID: HOMEPAGE_CONFIG_SINGLETON_ID })
    );
  } catch (err) {
    log.warn('[events] HomepageConfig read failed:', err.message);
  }

  let value;
  if (cfg?.eventsBandAutoPullEnabled === false) {
    // Legacy path — read manual Events entity (pre-#1030 behavior).
    value = await _legacyEventsFromEventsEntity();
  } else {
    // #1030 auto-pull path — CommunityEvents.
    value = await _communityEventsForBand(region, includeVirtual);
  }

  // LRU cap the cache Map (naive: drop oldest by insertion order).
  if (_state.events.size >= EVENTS_CACHE_MAX && !_state.events.has(cacheKey)) {
    const firstKey = _state.events.keys().next().value;
    _state.events.delete(firstKey);
  }
  _state.events.set(cacheKey, { at: now, value });

  if (value.length === 0) {
    metrics.counter(`homepage.events.requests[region=${region},virtual=${includeVirtual ? 1 : 0},result=empty]`);
  } else {
    metrics.counter(`homepage.events.requests[region=${region},virtual=${includeVirtual ? 1 : 0},result=200]`);
  }
  return value;
});
```

- [ ] **Step 5: Add the two helper functions above the class default export**

Above `export default class HomepageService`, add:

```js
// #1030 — CommunityEvents-backed events query (auto-pull path).
async function _communityEventsForBand(region, includeVirtual) {
  try {
    const db = await cds.connect.to('db');
    const { CommunityEvents } = cds.entities('com.sap.developers.ims.external');
    const nowIso = new Date().toISOString().slice(0, 10);   // YYYY-MM-DD; startDate is Date

    let q = SELECT.from(CommunityEvents)
      .columns('title', 'startDate', 'endDate', 'location', 'url',
               'eventType', 'region', 'virtualOrInPerson')
      .where`eventType in ${REFRESH_TYPES}`
      .and`startDate >= ${nowIso}`;

    if (region === 'VIRTUAL') {
      q = q.and`virtualOrInPerson = ${'virtual'}`;
    } else if (region !== 'ALL') {
      if (includeVirtual) q = q.and`(region = ${region} or virtualOrInPerson = ${'virtual'})`;
      else                q = q.and`region = ${region}`;
    } else if (!includeVirtual) {
      // region=ALL, includeVirtual=false
      q = q.and`virtualOrInPerson <> ${'virtual'}`;
    }

    const rows = await db.run(q.orderBy('startDate asc').limit(6));
    return (rows ?? []).map(e => ({
      title:     e.title || '',
      startsAt:  e.startDate || null,
      endsAt:    e.endDate || null,
      location:  e.location || '',
      url:       e.url || null,
      format:    e.eventType || '',        // legacy shape compat
      register:  null,                     // legacy shape compat
      eventType: e.eventType || null,
      region:    e.region || 'UNKNOWN',
      isVirtual: e.virtualOrInPerson === 'virtual',
    }));
  } catch (err) {
    log.warn('[events] CommunityEvents query failed:', err.message);
    return [];
  }
}

// #1030 — Fallback to the manual Events entity (rollback path when
// HomepageConfig.eventsBandAutoPullEnabled=false). Pre-#1030 shape.
async function _legacyEventsFromEventsEntity() {
  try {
    const db = await cds.connect.to('db');
    const { Events } = cds.entities('com.sap.developers.ims');
    const nowIso = new Date().toISOString();
    const raw = await db.run(
      SELECT.from(Events)
        .columns('name', 'startDate', 'timeZone', 'eventType')
        .where`startDate >= ${nowIso}`
        .orderBy('startDate asc')
        .limit(4)
    );
    return (raw ?? []).map(e => ({
      title:     e.name       || '',
      startsAt:  e.startDate  || null,
      endsAt:    null,
      location:  e.timeZone   || '',
      url:       null,
      format:    e.eventType  || '',
      register:  null,
      eventType: e.eventType  || null,
      region:    'UNKNOWN',
      isVirtual: false,
    }));
  } catch (err) {
    log.warn('[events] legacy Events query failed:', err.message);
    return [];
  }
}
```

- [ ] **Step 6: Commit (tests come in Task 13)**

```bash
git add srv/homepage-service.js
git commit -m "feat(#1030): rewrite homepage events() with region+virtual filter + feature-flag fallback"
```

---

### Task 13: Endpoint unit tests

**Files:**
- Create: `test/unit/homepage-events-endpoint.test.js`

- [ ] **Step 1: Write the test file**

```js
// test/unit/homepage-events-endpoint.test.js
// #1030 — HomepageService.events() region+virtual filter + cache + flag.

import { describe, it, expect, beforeEach } from 'vitest';
import cds from '@sap/cds';
import { _resetForTests } from '../../srv/homepage-service.js';

const NS_EXT = 'com.sap.developers.ims.external';
const NS = 'com.sap.developers.ims';
const HOMEPAGE_CONFIG_SINGLETON_ID = '00000000-0000-0000-0000-00000000c8ae';

const { test } = cds;
test.in(__dirname, '..', '..');
test('serve', 'all', '--in-memory');

async function seedCommunityEvent(overrides = {}) {
  const db = await cds.connect.to('db');
  const { CommunityEvents } = cds.entities(NS_EXT);
  await INSERT.into(CommunityEvents).entries({
    ID: cds.utils.uuid(),
    slug: `ce-${Math.random().toString(36).slice(2, 10)}`,
    eventType: 'codejam',
    source: 'khoros',
    title: 'Test event',
    url: 'https://example.com/e',
    sourceId: `codejam/${Math.random()}`,
    location: 'Berlin, Germany',
    scope: 'local',
    virtualOrInPerson: 'in-person',
    region: 'EMEA',
    startDate: '2099-01-01',
    endDate: '2099-01-01',
    lastSeenAt: new Date(),
    firstSeenAt: new Date(),
    ...overrides,
  });
}

async function ensureHomepageConfig(fields = {}) {
  const db = await cds.connect.to('db');
  const { HomepageConfig } = cds.entities(NS);
  const existing = await SELECT.one.from(HomepageConfig).where({ ID: HOMEPAGE_CONFIG_SINGLETON_ID });
  if (existing) {
    await UPDATE(HomepageConfig).where({ ID: HOMEPAGE_CONFIG_SINGLETON_ID }).set(fields);
  } else {
    await INSERT.into(HomepageConfig).entries({ ID: HOMEPAGE_CONFIG_SINGLETON_ID, ...fields });
  }
}

describe('HomepageService.events()', () => {
  beforeEach(async () => {
    _resetForTests();
    const db = await cds.connect.to('db');
    const { CommunityEvents } = cds.entities(NS_EXT);
    await DELETE.from(CommunityEvents);
    await ensureHomepageConfig({ eventsBandAutoPullEnabled: true });
  });

  it('region=EMEA returns only EMEA + virtual rows', async () => {
    await seedCommunityEvent({ region: 'EMEA' });
    await seedCommunityEvent({ region: 'AMERICAS' });
    await seedCommunityEvent({ region: 'UNKNOWN', virtualOrInPerson: 'virtual', location: 'virtual' });
    const svc = await cds.connect.to('HomepageService');
    const rows = await svc.send('events', { region: 'EMEA', includeVirtual: true });
    expect(rows).toHaveLength(2);
    expect(rows.every(r => r.region === 'EMEA' || r.isVirtual)).toBe(true);
  });

  it('region=VIRTUAL returns only virtual rows', async () => {
    await seedCommunityEvent({ region: 'EMEA' });
    await seedCommunityEvent({ region: 'UNKNOWN', virtualOrInPerson: 'virtual', location: 'virtual' });
    const svc = await cds.connect.to('HomepageService');
    const rows = await svc.send('events', { region: 'VIRTUAL' });
    expect(rows).toHaveLength(1);
    expect(rows[0].isVirtual).toBe(true);
  });

  it('region=ALL, includeVirtual=false excludes virtual rows', async () => {
    await seedCommunityEvent({ region: 'EMEA' });
    await seedCommunityEvent({ region: 'UNKNOWN', virtualOrInPerson: 'virtual', location: 'virtual' });
    const svc = await cds.connect.to('HomepageService');
    const rows = await svc.send('events', { region: 'ALL', includeVirtual: false });
    expect(rows).toHaveLength(1);
    expect(rows[0].isVirtual).toBe(false);
  });

  it('region=EMEA, includeVirtual=false excludes virtual rows', async () => {
    await seedCommunityEvent({ region: 'EMEA' });
    await seedCommunityEvent({ region: 'UNKNOWN', virtualOrInPerson: 'virtual', location: 'virtual' });
    const svc = await cds.connect.to('HomepageService');
    const rows = await svc.send('events', { region: 'EMEA', includeVirtual: false });
    expect(rows).toHaveLength(1);
    expect(rows[0].region).toBe('EMEA');
  });

  it('invalid region coerces to ALL (does not 400)', async () => {
    await seedCommunityEvent({ region: 'EMEA' });
    const svc = await cds.connect.to('HomepageService');
    const rows = await svc.send('events', { region: 'BOGUS' });
    expect(rows).toHaveLength(1);
  });

  it('caps result at 6 items', async () => {
    for (let i = 0; i < 10; i++) await seedCommunityEvent({ region: 'EMEA' });
    const svc = await cds.connect.to('HomepageService');
    const rows = await svc.send('events', { region: 'EMEA' });
    expect(rows).toHaveLength(6);
  });

  it('orders by startDate ascending', async () => {
    await seedCommunityEvent({ region: 'EMEA', startDate: '2099-06-01' });
    await seedCommunityEvent({ region: 'EMEA', startDate: '2099-01-01' });
    await seedCommunityEvent({ region: 'EMEA', startDate: '2099-03-01' });
    const svc = await cds.connect.to('HomepageService');
    const rows = await svc.send('events', { region: 'EMEA' });
    expect(rows.map(r => r.startsAt)).toEqual(['2099-01-01', '2099-03-01', '2099-06-01']);
  });

  it('filters out past events', async () => {
    await seedCommunityEvent({ region: 'EMEA', startDate: '1999-01-01' });
    await seedCommunityEvent({ region: 'EMEA', startDate: '2099-01-01' });
    const svc = await cds.connect.to('HomepageService');
    const rows = await svc.send('events', { region: 'EMEA' });
    expect(rows).toHaveLength(1);
  });

  it('feature flag OFF falls back to legacy Events entity shape', async () => {
    await ensureHomepageConfig({ eventsBandAutoPullEnabled: false });
    const db = await cds.connect.to('db');
    const { Events, CommunityEvents } = cds.entities(NS);
    await INSERT.into(Events).entries({
      ID: cds.utils.uuid(), name: 'Legacy manual event', startDate: '2099-01-01', timeZone: 'UTC', eventType: 'manual',
    });
    await seedCommunityEvent({ region: 'EMEA', title: 'AutoPull event' });
    const svc = await cds.connect.to('HomepageService');
    const rows = await svc.send('events', { region: 'EMEA' });
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('Legacy manual event');   // came from legacy Events, not CommunityEvents
  });

  it('cache keys are isolated per (region, includeVirtual)', async () => {
    await seedCommunityEvent({ region: 'EMEA' });
    const svc = await cds.connect.to('HomepageService');
    const emea = await svc.send('events', { region: 'EMEA' });
    const americas = await svc.send('events', { region: 'AMERICAS' });
    expect(emea).toHaveLength(1);
    expect(americas).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests, verify they pass**

```bash
npm test -- homepage-events-endpoint
```

Expected: PASS all cases.

- [ ] **Step 3: Commit**

```bash
git add test/unit/homepage-events-endpoint.test.js
git commit -m "test(#1030): homepage events() unit tests (filter matrix + cache + flag)"
```

---

### Task 14: Wire `preferredEventRegion` into personalization envelope

**Files:**
- Modify: `srv/lib/homepage/personalized-envelope.js`
- Modify: `srv/homepage-service.js` (the `on('personalized')` handler — pipe the new field through)

**Interfaces:**
- Consumes: `UserLearningPreferences.preferredEventRegion` from Task 10; `PersonalizedEnvelope.eventsRegion` from Task 11.
- Produces: `eventsRegion` field emitted on the envelope (null if unset).

- [ ] **Step 1: Extend `buildEnvelope`**

In `srv/lib/homepage/personalized-envelope.js`, find the `buildEnvelope` function and its return literal. Update the signature and return:

```js
export function buildEnvelope({ profile, shelves, forYouCandidates, teaserSlugs, preferredEventRegion }) {
  const p = profile || {};
  const verbOrder = computeVerbOrder(p, tagCountsPerVerb(shelves, p));

  const forYou = rankForYou(forYouCandidates, p, { min: 3, max: 8 })
    .map(({ ID, kind, targetSlug, title, description, imageUrl }) =>
      ({ ID, kind, slug: targetSlug, title, description, imageUrl }));

  const shelfOverrides = buildShelfOverrides(shelves, p);

  return {
    profile: {
      role: p.role ?? null,
      deployment: p.deployment ?? null,
      cloud: p.cloud ?? null,
    },
    verbOrder,
    forYou,
    teaserOrder: [...(teaserSlugs || [])].slice(0, 12),
    shelfOverrides,
    videoFilterTags: deriveVideoFilterTags(p),
    rssFilterTags: deriveRssFilterTags(p),
    eventsRegion: preferredEventRegion ?? null,          // #1030
  };
}
```

- [ ] **Step 2: Wire `preferredEventRegion` into the personalized() handler**

In `srv/homepage-service.js`, locate the `this.on('personalized', …)` handler (it exists — read around `buildEnvelope(` call). Update the SELECT that fetches learning prefs to include the new column, and pass it to `buildEnvelope`:

Find the existing SELECT for `UserLearningPreferences`:

```bash
grep -n "UserLearningPreferences" srv/homepage-service.js
```

At that call site, change the column list to include `preferredEventRegion` and pass it to `buildEnvelope`:

```js
const prefs = await db.run(
  SELECT.one.from(UserLearningPreferences)
    .columns('deployment', 'role', 'cloud', 'preferredEventRegion')   // #1030
    .where({ user_ID: dbUser.ID })
);
// ...
const envelope = buildEnvelope({
  profile: { role: prefs?.role, deployment: prefs?.deployment, cloud: prefs?.cloud },
  shelves,
  forYouCandidates,
  teaserSlugs,
  preferredEventRegion: prefs?.preferredEventRegion ?? null,           // #1030
});
```

- [ ] **Step 3: Extend the existing envelope test**

Find `test/unit/srv/personalized-envelope.test.js` (or equivalent):

```bash
find test -name '*personalized-envelope*'
```

Append a new test:

```js
describe('#1030 eventsRegion', () => {
  it('emits null when preferredEventRegion is not passed', () => {
    const env = buildEnvelope({ profile: {}, shelves: [], forYouCandidates: [], teaserSlugs: [] });
    expect(env.eventsRegion).toBeNull();
  });

  it('emits the passed value', () => {
    const env = buildEnvelope({
      profile: {}, shelves: [], forYouCandidates: [], teaserSlugs: [],
      preferredEventRegion: 'EMEA',
    });
    expect(env.eventsRegion).toBe('EMEA');
  });
});
```

- [ ] **Step 4: Run tests**

```bash
npm test -- personalized-envelope
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add srv/lib/homepage/personalized-envelope.js srv/homepage-service.js test/unit/srv/personalized-envelope.test.js
git commit -m "feat(#1030): envelope.eventsRegion sourced from UserLearningPreferences"
```

---

### Task 15: `setPreferredEventRegion` action + tests

**Files:**
- Modify: `srv/developer-service.cds`
- Modify: `srv/developer-service.js` (mirror the existing `setLearningPreferences` shape at line 761)
- Create: `test/unit/set-preferred-event-region.test.js`

**Interfaces:**
- Consumes: `PROFILE_VOCAB.preferredEventRegion` from Task 10.
- Produces: `POST /api/developer/setPreferredEventRegion` — accepts `{ region: string | null }`, validates, upserts `UserLearningPreferences.preferredEventRegion` for the authenticated user.

- [ ] **Step 1: Add the action declaration**

In `srv/developer-service.cds`, near the existing `setLearningPreferences` block (line 212 area), add:

```cds
// #1030 — Homepage Row 3 events band region preference. Null = clear (fall
// through to browser-TZ hint on next visit). VIRTUAL and ALL are UI filter
// modes; AMERICAS/EMEA/APJ are physical regions.
@(requires: 'authenticated-user')
action setPreferredEventRegion(region : String) returns Boolean;
```

- [ ] **Step 2: Add the handler**

In `srv/developer-service.js`, right after the `setLearningPreferences` handler (around line 810), add:

```js
this.on('setPreferredEventRegion', async (req) => {
  const value = req.data?.region === null || req.data?.region === '' ? null : String(req.data?.region ?? '').toUpperCase();

  // Validate: null OR a value from the vocab. JS validation is the runtime
  // gate (memory: @assert.range fires only at the OData protocol layer, not
  // on programmatic CQL writes from action handlers).
  if (value !== null && !PROFILE_VOCAB.preferredEventRegion.includes(value)) {
    return req.error(400, `region: must be one of [${PROFILE_VOCAB.preferredEventRegion.join(', ')}] or null`);
  }

  // Auto-provision Users row (mirrors setLearningPreferences at line 780).
  const sapId = resolveUserSapId(req.user);
  if (!sapId) return req.reject(401, 'Unauthenticated');

  let dbUser = await SELECT.one.from(Users).where({ sapId });
  if (!dbUser) {
    dbUser = { ID: cds.utils.uuid(), sapId, uuid: sapId };
    await INSERT.into(Users).entries(dbUser);
  }

  const existing = await SELECT.one.from(UserLearningPreferences).where({ user_ID: dbUser.ID });
  if (existing) {
    await UPDATE(UserLearningPreferences)
      .where({ user_ID: dbUser.ID })
      .set({ preferredEventRegion: value });
  } else {
    await INSERT.into(UserLearningPreferences).entries({
      user_ID: dbUser.ID,
      preferredEventRegion: value,
    });
  }
  metrics.counter(`homepage.events.pref_set[region=${value ?? 'null'}]`);
  return true;
});
```

Confirm `PROFILE_VOCAB`, `resolveUserSapId`, `Users`, `UserLearningPreferences`, `metrics` are already imported (they are — the file uses them for `setLearningPreferences`).

- [ ] **Step 3: Write the tests**

Create `test/unit/set-preferred-event-region.test.js`:

```js
// test/unit/set-preferred-event-region.test.js
// #1030 — setPreferredEventRegion action.

import { describe, it, expect, beforeEach } from 'vitest';
import cds from '@sap/cds';

const NS = 'com.sap.developers.ims';

const { test } = cds;
test.in(__dirname, '..', '..');
test('serve', 'all', '--in-memory');

async function callAsUser(sapId, region) {
  const svc = await cds.connect.to('DeveloperService');
  return cds.tx({ user: { id: sapId } }, tx =>
    tx.run(svc.send('setPreferredEventRegion', { region }))
  );
}

describe('setPreferredEventRegion', () => {
  beforeEach(async () => {
    const db = await cds.connect.to('db');
    const { Users, UserLearningPreferences } = cds.entities(NS);
    await DELETE.from(UserLearningPreferences);
    await DELETE.from(Users);
  });

  it('rejects unauthenticated', async () => {
    const svc = await cds.connect.to('DeveloperService');
    await expect(svc.send('setPreferredEventRegion', { region: 'EMEA' })).rejects.toThrow(/Unauthenticated|401/);
  });

  it('rejects invalid region', async () => {
    await expect(callAsUser('u1', 'BOGUS')).rejects.toThrow(/must be one of/);
  });

  it('auto-provisions Users row and inserts prefs on first save', async () => {
    await callAsUser('u2', 'EMEA');
    const db = await cds.connect.to('db');
    const { Users, UserLearningPreferences } = cds.entities(NS);
    const u = await SELECT.one.from(Users).where({ sapId: 'u2' });
    expect(u).toBeDefined();
    const pref = await SELECT.one.from(UserLearningPreferences).where({ user_ID: u.ID });
    expect(pref.preferredEventRegion).toBe('EMEA');
  });

  it('updates existing UserLearningPreferences row', async () => {
    await callAsUser('u3', 'EMEA');
    await callAsUser('u3', 'APJ');
    const db = await cds.connect.to('db');
    const { Users, UserLearningPreferences } = cds.entities(NS);
    const u = await SELECT.one.from(Users).where({ sapId: 'u3' });
    const pref = await SELECT.one.from(UserLearningPreferences).where({ user_ID: u.ID });
    expect(pref.preferredEventRegion).toBe('APJ');
  });

  it('clears to null when passed null', async () => {
    await callAsUser('u4', 'EMEA');
    await callAsUser('u4', null);
    const db = await cds.connect.to('db');
    const { Users, UserLearningPreferences } = cds.entities(NS);
    const u = await SELECT.one.from(Users).where({ sapId: 'u4' });
    const pref = await SELECT.one.from(UserLearningPreferences).where({ user_ID: u.ID });
    expect(pref.preferredEventRegion).toBeNull();
  });

  it('accepts VIRTUAL and ALL as UI-mode values', async () => {
    await callAsUser('u5', 'VIRTUAL');
    await callAsUser('u6', 'ALL');
    const db = await cds.connect.to('db');
    const { Users, UserLearningPreferences } = cds.entities(NS);
    const u5 = await SELECT.one.from(Users).where({ sapId: 'u5' });
    const p5 = await SELECT.one.from(UserLearningPreferences).where({ user_ID: u5.ID });
    expect(p5.preferredEventRegion).toBe('VIRTUAL');
  });
});
```

- [ ] **Step 4: Run + commit**

```bash
npm test -- set-preferred-event-region
git add srv/developer-service.cds srv/developer-service.js test/unit/set-preferred-event-region.test.js
git commit -m "feat(#1030): setPreferredEventRegion action + unit tests"
```

---

## Frontend half (Tasks 16–19)

### Task 16: Vue island scaffold + `tz-to-region.ts`

**Files:**
- Create: `hugo-apps/apps/homepage-events-band/package.json`
- Create: `hugo-apps/apps/homepage-events-band/vite.config.ts`
- Create: `hugo-apps/apps/homepage-events-band/src/main.ts`
- Create: `hugo-apps/apps/homepage-events-band/src/tz-to-region.ts`
- Create: `hugo-apps/apps/homepage-events-band/src/region-storage.ts`
- Create: `hugo-apps/apps/homepage-events-band/test/tz-to-region.spec.ts`
- Modify: `hugo-apps/vite.config.ts` (register the app)

**Interfaces:**
- Produces: browser bundle mounted onto `[data-app="homepage-events-band"]`. Exports `tzToRegion(tz?: string): Region` and localStorage helpers.

- [ ] **Step 1: Copy shape from a sibling app**

Look at an existing single-purpose island as a template:

```bash
ls hugo-apps/apps/featured-topics-carousel/
```

- [ ] **Step 2: Write `package.json`**

Create `hugo-apps/apps/homepage-events-band/package.json` — mirror `featured-topics-carousel/package.json` exactly, changing the `name` to `homepage-events-band`.

- [ ] **Step 3: Write `vite.config.ts`**

Create `hugo-apps/apps/homepage-events-band/vite.config.ts` mirroring the carousel's, changing the output filename to `homepage-events-band.js` (and CSS to `homepage-events-band.css`). Confirm `build.emptyOutDir: false` and target dir `../../../hugo/static/js/` — pattern matches the carousel exactly.

- [ ] **Step 4: Write `tz-to-region.ts`**

```ts
// hugo-apps/apps/homepage-events-band/src/tz-to-region.ts
//
// #1030 — Coarse IANA-timezone → homepage-region hint. Runs once on first
// mount for signed-out visitors, or signed-in visitors who never set
// preferredEventRegion. Deliberately loose — an incorrect hint just picks
// the wrong default chip; the user overrides with one click. Server side
// (srv/lib/events/region-from-location.js) is the source of truth for the
// actual `region` column on events; this file only picks a default UI chip.

export type Region = 'AMERICAS' | 'EMEA' | 'APJ' | 'VIRTUAL' | 'ALL';

const PREFIX_MAP: Array<[RegExp, Region]> = [
  [/^America\//,   'AMERICAS'],
  [/^US\//,        'AMERICAS'],
  [/^Canada\//,    'AMERICAS'],
  [/^Europe\//,    'EMEA'],
  [/^Africa\//,    'EMEA'],
  [/^Atlantic\//,  'EMEA'],
  [/^Asia\//,      'APJ'],
  [/^Australia\//, 'APJ'],
  [/^Pacific\//,   'APJ'],
  [/^Indian\//,    'APJ'],
];

export function tzToRegion(tz?: string): Region {
  const z = tz ?? (typeof Intl !== 'undefined'
    ? Intl.DateTimeFormat().resolvedOptions().timeZone
    : '') ?? '';
  for (const [re, r] of PREFIX_MAP) if (re.test(z)) return r;
  return 'ALL';
}
```

- [ ] **Step 5: Write `region-storage.ts`**

```ts
// hugo-apps/apps/homepage-events-band/src/region-storage.ts
// #1030 — localStorage helpers for the events-band region chip.

import type { Region } from './tz-to-region';

const KEY = 'sap-devs-homepage-events-region';
const VALID: Region[] = ['AMERICAS', 'EMEA', 'APJ', 'VIRTUAL', 'ALL'];

export function readLocalStorageRegion(): Region | null {
  try {
    const v = localStorage.getItem(KEY);
    return VALID.includes(v as Region) ? (v as Region) : null;
  } catch {
    return null;
  }
}

export function writeLocalStorageRegion(r: Region): void {
  try { localStorage.setItem(KEY, r); } catch { /* private mode */ }
}
```

- [ ] **Step 6: Write `tz-to-region.spec.ts`**

```ts
// hugo-apps/apps/homepage-events-band/test/tz-to-region.spec.ts
import { describe, it, expect } from 'vitest';
import { tzToRegion } from '../src/tz-to-region';

describe('tzToRegion', () => {
  it.each([
    ['America/New_York', 'AMERICAS'],
    ['America/Sao_Paulo', 'AMERICAS'],
    ['US/Pacific', 'AMERICAS'],
    ['Canada/Eastern', 'AMERICAS'],
    ['Europe/Berlin', 'EMEA'],
    ['Europe/London', 'EMEA'],
    ['Africa/Cairo', 'EMEA'],
    ['Atlantic/Reykjavik', 'EMEA'],
    ['Asia/Kolkata', 'APJ'],
    ['Asia/Tokyo', 'APJ'],
    ['Australia/Sydney', 'APJ'],
    ['Pacific/Auckland', 'APJ'],
    ['Indian/Mahe', 'APJ'],
    ['UTC', 'ALL'],
    ['Antarctica/McMurdo', 'ALL'],
  ])('%s → %s', (tz, expected) => {
    expect(tzToRegion(tz)).toBe(expected);
  });
});
```

- [ ] **Step 7: Add island to `hugo-apps/vite.config.ts`**

Confirm the multi-app config pattern; add `homepage-events-band` to the array of apps. This is a one-line addition — check the sibling `featured-topics-carousel` entry.

- [ ] **Step 8: Run tests**

```bash
cd hugo-apps/apps/homepage-events-band && npx vitest --run
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/1030-homepage-codejams-autopull-spec
git add hugo-apps/apps/homepage-events-band hugo-apps/vite.config.ts
git commit -m "feat(#1030): homepage-events-band island scaffold + tz-to-region"
```

---

### Task 17: `EventsBand.vue` + `main.ts` + component test

**Files:**
- Create: `hugo-apps/apps/homepage-events-band/src/EventsBand.vue`
- Create: `hugo-apps/apps/homepage-events-band/src/main.ts`
- Create: `hugo-apps/apps/homepage-events-band/test/EventsBand.spec.ts`

**Interfaces:**
- Consumes: `tzToRegion`, `readLocalStorageRegion`, `writeLocalStorageRegion`, `window.__homepagePersonalized?.eventsRegion` (set by the existing personalization coordinator).
- Produces: hydrated DOM inside `[data-app="homepage-events-band"]`.

- [ ] **Step 1: Write `EventsBand.vue`**

```vue
<script setup lang="ts">
// #1030 — Row 3 homepage events band.
// Fetches /api/homepage/events, renders 6 cards, exposes a 5-chip filter.
// Initial region priority: envelope.eventsRegion > localStorage > TZ hint > 'ALL'.

import { ref, onMounted, onBeforeUnmount } from 'vue';
import type { Region } from './tz-to-region';
import { tzToRegion } from './tz-to-region';
import { readLocalStorageRegion, writeLocalStorageRegion } from './region-storage';

type EventCard = {
  title: string;
  startsAt: string | null;
  endsAt: string | null;
  location: string;
  url: string | null;
  eventType: string | null;
  region: string;
  isVirtual: boolean;
};

const CHIPS: Array<{ id: Region; label: string }> = [
  { id: 'ALL',       label: 'All' },
  { id: 'AMERICAS',  label: 'Americas' },
  { id: 'EMEA',      label: 'EMEA' },
  { id: 'APJ',       label: 'APJ' },
  { id: 'VIRTUAL',   label: 'Virtual only' },
];

const region = ref<Region>('ALL');
const rows = ref<EventCard[]>([]);
const loading = ref(true);
const errored = ref(false);
let currentEtag: string | null = null;
let bc: BroadcastChannel | null = null;

function resolveInitialRegion(): Region {
  const envelope = (window as any).__homepagePersonalized?.eventsRegion;
  if (envelope && ['AMERICAS','EMEA','APJ','VIRTUAL','ALL'].includes(envelope)) {
    return envelope as Region;
  }
  return readLocalStorageRegion() ?? tzToRegion();
}

async function refetch(r: Region) {
  loading.value = true;
  errored.value = false;
  const params = new URLSearchParams();
  params.set('region', r);
  // ALL/VIRTUAL don't need includeVirtual (server picks the right semantics).
  if (r !== 'ALL' && r !== 'VIRTUAL') params.set('includeVirtual', 'true');
  try {
    const resp = await fetch(`/api/homepage/events?${params}`, {
      credentials: 'include',
      headers: currentEtag ? { 'If-None-Match': currentEtag } : {},
    });
    if (resp.status === 304) {
      loading.value = false;
      return;
    }
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    currentEtag = resp.headers.get('ETag');
    rows.value = await resp.json();
  } catch (err) {
    console.debug('[homepage-events-band] fetch failed', err);
    errored.value = true;
  } finally {
    loading.value = false;
  }
}

function isSignedIn(): boolean {
  return document.cookie.includes('JSESSIONID') || Boolean((window as any).__homepagePersonalized);
}

async function onChipClick(next: Region) {
  region.value = next;
  writeLocalStorageRegion(next);
  if (isSignedIn()) {
    fetch('/api/developer/setPreferredEventRegion', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ region: next }),
    }).catch(() => { /* fire-and-forget */ });
  }
  await refetch(next);
}

onMounted(async () => {
  region.value = resolveInitialRegion();
  await refetch(region.value);
  // Fire the hint_used metric once per session — server-side counter.
  fetch('/api/homepage/beaconApplied', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    credentials: 'include', body: JSON.stringify({ surface: 'events-band' }),
  }).catch(() => {});

  try {
    bc = new BroadcastChannel('sap-devs-prefs');
    bc.onmessage = (e) => {
      if (e.data?.type === 'preferences-changed' && e.data?.eventsRegion
          && e.data.eventsRegion !== region.value) {
        region.value = e.data.eventsRegion;
        currentEtag = null;
        refetch(region.value);
      }
    };
  } catch { /* older browsers */ }
});

onBeforeUnmount(() => { bc?.close(); });

function formatDate(iso: string | null): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric',
    });
  } catch {
    return iso;
  }
}
</script>

<template>
  <h2>Upcoming events</h2>

  <div class="events-band__chips">
    <button v-for="chip in CHIPS" :key="chip.id"
            :class="['events-band__chip', { 'events-band__chip--active': region === chip.id }]"
            @click="onChipClick(chip.id)"
            :aria-pressed="region === chip.id">
      {{ chip.label }}
    </button>
  </div>

  <div v-if="loading" class="events-band__loading" aria-live="polite">
    Loading upcoming events…
  </div>

  <div v-else-if="rows.length === 0 && !errored" class="events-band__empty">
    No upcoming events match this filter.
    <a href="/connect/">See the full events calendar →</a>
  </div>

  <div v-else-if="errored" class="events-band__empty">
    Couldn’t load events right now.
    <a href="/connect/">See the full events calendar →</a>
  </div>

  <div v-else class="events-band__cards">
    <a v-for="row in rows" :key="row.url || row.title"
       :href="row.url || '/connect/'"
       class="event-card"
       :class="{ 'event-card--virtual': row.isVirtual }">
      <div class="event-card__type">
        {{ row.eventType === 'codejam' ? 'CodeJam' : row.eventType === 'devtoberfest' ? 'Devtoberfest' : 'Event' }}
      </div>
      <div class="event-card__title">{{ row.title }}</div>
      <div class="event-card__meta">
        <span class="event-card__date">{{ formatDate(row.startsAt) }}</span>
        <span class="event-card__location">{{ row.isVirtual ? 'Virtual' : row.location }}</span>
      </div>
    </a>
  </div>
</template>
```

- [ ] **Step 2: Write `main.ts`**

```ts
// hugo-apps/apps/homepage-events-band/src/main.ts
// #1030 — mount the events band on [data-app="homepage-events-band"].

import { createApp } from 'vue';
import EventsBand from './EventsBand.vue';

const el = document.querySelector('[data-app="homepage-events-band"]');
if (el) createApp(EventsBand).mount(el);
```

- [ ] **Step 3: Write the component test**

```ts
// hugo-apps/apps/homepage-events-band/test/EventsBand.spec.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import EventsBand from '../src/EventsBand.vue';

const CARD = {
  title: 'CAP CodeJam Berlin',
  startsAt: '2099-05-15', endsAt: '2099-05-15',
  location: 'Berlin, Germany', url: 'https://example.com/x',
  eventType: 'codejam', region: 'EMEA', isVirtual: false,
};

function mockFetch(json: any, headers: Record<string,string> = {}) {
  global.fetch = vi.fn().mockResolvedValue({
    ok: true, status: 200,
    json: async () => json,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
  }) as any;
}

describe('EventsBand', () => {
  beforeEach(() => {
    localStorage.clear();
    (window as any).__homepagePersonalized = undefined;
  });

  it('renders 6 cards from the endpoint', async () => {
    mockFetch(Array(6).fill(CARD));
    const w = mount(EventsBand);
    await new Promise(r => setTimeout(r, 0));
    await w.vm.$nextTick();
    expect(w.findAll('.event-card')).toHaveLength(6);
  });

  it('renders empty state when the endpoint returns []', async () => {
    mockFetch([]);
    const w = mount(EventsBand);
    await new Promise(r => setTimeout(r, 0));
    await w.vm.$nextTick();
    expect(w.text()).toContain('No upcoming events');
  });

  it('initial region priority: envelope > localStorage > TZ', async () => {
    (window as any).__homepagePersonalized = { eventsRegion: 'APJ' };
    localStorage.setItem('sap-devs-homepage-events-region', 'AMERICAS');
    mockFetch([CARD]);
    mount(EventsBand);
    await new Promise(r => setTimeout(r, 0));
    const call = (global.fetch as any).mock.calls[0][0] as string;
    expect(call).toContain('region=APJ');
  });

  it('falls back to localStorage when no envelope', async () => {
    localStorage.setItem('sap-devs-homepage-events-region', 'AMERICAS');
    mockFetch([CARD]);
    mount(EventsBand);
    await new Promise(r => setTimeout(r, 0));
    const call = (global.fetch as any).mock.calls[0][0] as string;
    expect(call).toContain('region=AMERICAS');
  });

  it('chip click refetches with new region + writes localStorage', async () => {
    mockFetch([CARD]);
    const w = mount(EventsBand);
    await new Promise(r => setTimeout(r, 0));
    await w.findAll('.events-band__chip')[2].trigger('click');   // EMEA
    await new Promise(r => setTimeout(r, 0));
    const lastCall = (global.fetch as any).mock.calls.at(-2)[0] as string;
    expect(lastCall).toContain('region=EMEA');
    expect(localStorage.getItem('sap-devs-homepage-events-region')).toBe('EMEA');
  });
});
```

- [ ] **Step 4: Run tests**

```bash
cd hugo-apps/apps/homepage-events-band && npx vitest --run
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/1030-homepage-codejams-autopull-spec
git add hugo-apps/apps/homepage-events-band
git commit -m "feat(#1030): EventsBand.vue + component tests"
```

---

### Task 18: Hugo partial + CSS + index.html swap

**Files:**
- Create: `hugo/layouts/partials/homepage/events-band.html`
- Create: `hugo/assets/css/homepage/_events-band.css`
- Modify: `hugo/layouts/index.html` (swap Row 3 partial include)
- Modify: `hugo/assets/css/homepage.css` (`@import "_events-band.css"`)

- [ ] **Step 1: Write the partial**

```html
{{/* hugo/layouts/partials/homepage/events-band.html — #1030 */}}
<section class="homepage-events-band" data-app="homepage-events-band">
  <h2>Upcoming events</h2>
  <div class="events-band__skeleton" data-role="skeleton">
    {{ range seq 6 }}<div class="event-card event-card--skeleton" aria-hidden="true"></div>{{ end }}
  </div>
</section>
<script type="module" src="/js/homepage-events-band.js" defer></script>
<link rel="stylesheet" href="/css/homepage-events-band.css" />
```

(The island's mount replaces the skeleton contents.)

- [ ] **Step 2: Write the CSS**

Create `hugo/assets/css/homepage/_events-band.css` — copy the visual grammar from the existing Row 3 CSS (find it in `hugo/assets/css/homepage.css` or its imports). Constraints: 6-card grid on desktop (3 columns × 2 rows), 2-column on tablet, single-column on mobile. Chip strip: 5 pills with focus ring + `aria-pressed` styling.

Minimum viable shape:

```css
/* hugo/assets/css/homepage/_events-band.css — #1030 */
.homepage-events-band { padding: 2rem 0; }
.homepage-events-band h2 { font-size: 1.5rem; margin-bottom: 1rem; }

.events-band__chips { display: flex; gap: 0.5rem; margin-bottom: 1rem; flex-wrap: wrap; }
.events-band__chip {
  padding: 0.4rem 0.9rem; border: 1px solid var(--sapContent_ForegroundBorderColor, #ccc);
  background: transparent; border-radius: 999px; cursor: pointer; font-size: 0.9rem;
}
.events-band__chip--active { background: var(--sapButton_Selected_Background, #0854a0); color: #fff; border-color: transparent; }
.events-band__chip:focus-visible { outline: 2px solid var(--sapContent_FocusColor, #0854a0); outline-offset: 2px; }

.events-band__cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1rem; }
@media (max-width: 900px) { .events-band__cards { grid-template-columns: repeat(2, 1fr); } }
@media (max-width: 600px) { .events-band__cards { grid-template-columns: 1fr; } }

.event-card {
  display: flex; flex-direction: column; padding: 1rem; text-decoration: none;
  border: 1px solid var(--sapContent_ForegroundBorderColor, #e5e5e5);
  border-radius: 4px; color: inherit; background: var(--sapContent_ForegroundColor, #fff);
}
.event-card:hover { border-color: var(--sapButton_Selected_Background, #0854a0); }
.event-card__type { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--sapContent_LabelColor, #666); }
.event-card__title { font-size: 1rem; font-weight: 600; margin: 0.5rem 0; }
.event-card__meta { display: flex; justify-content: space-between; font-size: 0.85rem; color: var(--sapContent_LabelColor, #666); }

.event-card--skeleton { min-height: 8rem; background: linear-gradient(90deg, #f4f4f4 25%, #ececec 50%, #f4f4f4 75%); background-size: 200% 100%; animation: eventskel 1.5s infinite; }
@keyframes eventskel { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }

.events-band__loading, .events-band__empty { padding: 1rem 0; color: var(--sapContent_LabelColor, #666); }
```

- [ ] **Step 3: Import the CSS**

In `hugo/assets/css/homepage.css`, add:

```css
@import "homepage/_events-band.css";
```

- [ ] **Step 4: Swap Row 3 in `hugo/layouts/index.html`**

Find the current Row 3 include (search for the old events band partial reference):

```bash
grep -n 'events' hugo/layouts/index.html
```

Replace whatever line renders the old events section with:

```html
{{ partial "homepage/events-band.html" . }}
```

- [ ] **Step 5: Build + eyeball**

```bash
npm run fetch-tutorials && npm run dev
```

Visit `http://localhost:1313/`. Expected: skeleton renders, then real cards. Click each chip and verify Network tab shows `?region=<X>`.

- [ ] **Step 6: Commit**

```bash
git add hugo/layouts/partials/homepage/events-band.html hugo/assets/css/homepage/_events-band.css hugo/assets/css/homepage.css hugo/layouts/index.html
git commit -m "feat(#1030): homepage Row 3 partial + CSS + mount point"
```

---

### Task 19: `/me/` `<Select>` for `preferredEventRegion`

**Files:**
- Modify: `hugo-apps/src/me/LearningPreferences.vue`

- [ ] **Step 1: Find the existing role/deployment/cloud selects**

```bash
grep -n 'PROFILE_VOCAB\|preferredEventRegion' hugo-apps/src/me/LearningPreferences.vue
```

- [ ] **Step 2: Add the new Select next to the existing ones**

Copy the shape of the existing cloud Select. Add the new field to the reactive form state, the template select, and the save handler. The save handler already POSTs to `setLearningPreferences`; add a parallel `setPreferredEventRegion` call. Include a "Not set" option that writes `null`.

Template addition:

```vue
<label>
  Homepage events region
  <select v-model="form.preferredEventRegion">
    <option :value="null">Not set (auto-detect from your timezone)</option>
    <option value="AMERICAS">Americas</option>
    <option value="EMEA">EMEA</option>
    <option value="APJ">APJ</option>
    <option value="VIRTUAL">Virtual only</option>
    <option value="ALL">All events</option>
  </select>
</label>
```

Save handler augmentation — after the existing `setLearningPreferences` POST, add:

```ts
await fetch('/api/developer/setPreferredEventRegion', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  credentials: 'include',
  body: JSON.stringify({ region: form.preferredEventRegion }),
});
// Broadcast so open homepage tabs re-render.
try {
  const bc = new BroadcastChannel('sap-devs-prefs');
  bc.postMessage({ type: 'preferences-changed', eventsRegion: form.preferredEventRegion });
  bc.close();
} catch { /* older browsers */ }
```

- [ ] **Step 3: Manual verification via `npm run dev`**

Open `/me/`, change the preference, save. Reload the homepage in another tab; verify chip strip reflects the change *before* reload (BroadcastChannel).

- [ ] **Step 4: Commit**

```bash
git add hugo-apps/src/me/LearningPreferences.vue
git commit -m "feat(#1030): /me/ LearningPreferences preferredEventRegion select + broadcast"
```

---

### Task 20: Hybrid + smoke + drift-guard tests; PR 3 open

**Files:**
- Create: `test/unit/homepage-events-region-drift.test.js`
- Create: `test/hybrid/homepage-events-hybrid.test.js`
- Create: `test/smoke/smoke-homepage-events.test.js`
- Modify: `docs/developers/architecture/homepage.md`

- [ ] **Step 1: Write the drift-guard test**

```js
// test/unit/homepage-events-region-drift.test.js
// #1030 — server regionFromLocation and client tzToRegion must share the
// AMERICAS/EMEA/APJ output vocabulary. Inputs differ (location strings vs
// IANA zones), but the ENUM must not drift.

import { describe, it, expect } from 'vitest';
import { regionFromLocation } from '../../srv/lib/events/region-from-location.js';

// Import the client function as source text and eval the enum values from it.
import fs from 'node:fs';
import path from 'node:path';

describe('region output enum drift guard', () => {
  it('server + client output the same physical region names', () => {
    const serverOutputs = new Set([
      regionFromLocation('New York'),
      regionFromLocation('Berlin'),
      regionFromLocation('Tokyo'),
    ]);
    expect(serverOutputs).toEqual(new Set(['AMERICAS', 'EMEA', 'APJ']));

    const clientSrc = fs.readFileSync(
      path.resolve(__dirname, '../../hugo-apps/apps/homepage-events-band/src/tz-to-region.ts'),
      'utf8',
    );
    // Fingerprint check: the same three region strings appear in the client's PREFIX_MAP.
    for (const r of ['AMERICAS', 'EMEA', 'APJ']) {
      expect(clientSrc.includes(`'${r}'`)).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Write the smoke test**

```js
// test/smoke/smoke-homepage-events.test.js
// #1030 — smoke against a deployed CAP srv.

import { describe, it, expect } from 'vitest';

const BASE = process.env.SMOKE_SRV_URL;
const describeMaybe = BASE ? describe : describe.skip;

describeMaybe('smoke /api/homepage/events', () => {
  it('region=EMEA returns EMEA-or-virtual rows only', async () => {
    const resp = await fetch(`${BASE}/api/homepage/events?region=EMEA`);
    expect(resp.status).toBe(200);
    const rows = await resp.json();
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBeLessThanOrEqual(6);
    for (const r of rows) {
      expect(r.region === 'EMEA' || r.isVirtual === true).toBe(true);
    }
  });

  it('region=BOGUS coerces to ALL (does not 400)', async () => {
    const resp = await fetch(`${BASE}/api/homepage/events?region=BOGUS`);
    expect(resp.status).toBe(200);
  });

  it('response includes eventType, region, isVirtual fields', async () => {
    const resp = await fetch(`${BASE}/api/homepage/events?region=ALL`);
    const rows = await resp.json();
    if (rows.length > 0) {
      expect(rows[0]).toHaveProperty('eventType');
      expect(rows[0]).toHaveProperty('region');
      expect(rows[0]).toHaveProperty('isVirtual');
    }
  });
});
```

- [ ] **Step 3: Write the hybrid test**

```js
// test/hybrid/homepage-events-hybrid.test.js
// #1030 — Real HANA: 30-row fixture across regions × virtual × past/future.

import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

const NS_EXT = 'com.sap.developers.ims.external';
const TAG = 'hybrid-1030';

describe('homepage events auto-pull (hybrid)', () => {
  let db;
  beforeAll(async () => {
    db = await cds.connect.to('db');
    const { CommunityEvents } = cds.entities(NS_EXT);
    // Clean up fixture rows from previous runs, if any.
    await DELETE.from(CommunityEvents).where`slug like ${`ce-${TAG}%`}`;

    const fixtures = [];
    let n = 0;
    for (const region of ['AMERICAS', 'EMEA', 'APJ']) {
      for (const virt of ['in-person', 'in-person', 'virtual']) {
        for (const day of ['2027-01-01', '2027-06-01']) {
          fixtures.push({
            ID: cds.utils.uuid(),
            slug: `ce-${TAG}-${n++}`,
            eventType: n % 2 === 0 ? 'codejam' : 'devtoberfest',
            source: 'khoros',
            title: `Hybrid fixture ${n}`,
            url: `https://example.com/${n}`,
            sourceId: `${TAG}/${n}`,
            location: region === 'AMERICAS' ? 'Toronto' : region === 'EMEA' ? 'Berlin' : 'Tokyo',
            scope: 'local',
            virtualOrInPerson: virt,
            region: virt === 'virtual' ? 'UNKNOWN' : region,
            startDate: day,
            endDate: day,
            lastSeenAt: new Date(),
            firstSeenAt: new Date(),
          });
        }
      }
    }
    const { CommunityEvents: CE } = cds.entities(NS_EXT);
    await INSERT.into(CE).entries(fixtures);
  });

  it('region=EMEA returns EMEA-or-virtual rows', async () => {
    const svc = await cds.connect.to('HomepageService');
    const rows = await svc.send('events', { region: 'EMEA' });
    for (const r of rows) {
      expect(r.region === 'EMEA' || r.isVirtual).toBe(true);
    }
  });

  it('region=VIRTUAL returns only virtual rows', async () => {
    const svc = await cds.connect.to('HomepageService');
    const rows = await svc.send('events', { region: 'VIRTUAL' });
    for (const r of rows) expect(r.isVirtual).toBe(true);
  });

  it('caps at 6 rows even when fixture has >6 matches', async () => {
    const svc = await cds.connect.to('HomepageService');
    const rows = await svc.send('events', { region: 'ALL' });
    expect(rows.length).toBeLessThanOrEqual(6);
  });
});
```

- [ ] **Step 4: Update the architecture doc**

Modify `docs/developers/architecture/homepage.md`:

- Row 3 description line — change "3-4 upcoming events" to "6 upcoming events, auto-pulled from CommunityEvents, region-filtered per user preference"
- Data-flow table: change Row 3 entry to "`GET /api/homepage/events?region=<X>&includeVirtual=<b>` — 60s per-key cache; sourced from `CommunityEvents` when `HomepageConfig.eventsBandAutoPullEnabled=true` else legacy `Events` entity"
- Add a link to the new spec/plan at the bottom.

- [ ] **Step 5: Run full test suite**

```bash
npm test
```

Expected: PASS. Zero regressions.

- [ ] **Step 6: Commit + push**

```bash
git add test/unit/homepage-events-region-drift.test.js test/hybrid/homepage-events-hybrid.test.js test/smoke/smoke-homepage-events.test.js docs/developers/architecture/homepage.md
git commit -m "test(#1030): drift guard + hybrid + smoke; homepage.md updated"
git push -u origin HEAD
```

- [ ] **Step 7: Open the draft PR**

```bash
gh pr create --draft \
  --title "feat(#1030): PR 3 — endpoint rewrite + Vue island + /me/ field (feature-flagged)" \
  --body "$(cat <<'EOF'
Part 3 of 3 for #1030 (homepage CodeJams auto-pull). User-visible flip, gated by \`HomepageConfig.eventsBandAutoPullEnabled\`.

## What ships here
- **Schema**: \`UserLearningPreferences.preferredEventRegion\`; \`HomepageConfig.eventsBandAutoPullEnabled\`
- **API**: rewritten \`GET /api/homepage/events?region=<X>&includeVirtual=<b>\`; new \`setPreferredEventRegion\` action; \`eventsRegion\` on PersonalizedEnvelope
- **UI**: new \`homepage-events-band\` Vue island (6 cards, 5-chip strip, browser-TZ hint, localStorage, BroadcastChannel); \`/me/\` LearningPreferences dropdown; Row 3 Hugo partial swap
- **Tests**: unit + hybrid + smoke + drift-guard
- **Docs**: \`homepage.md\` updated

## Preconditions
- PRs 1 and 2 must be merged; DEV backfill run; \`refresh-community-events\` cron firing.

## Rollout
- Merges with flag \`eventsBandAutoPullEnabled=true\` in DEV, \`false\` in PROD.
- ~1 week DEV soak (watch \`homepage.events.region_unknown\` metric).
- Flip PROD flag when ready; aligned with end-July 2026 cutover.

## Kill switch
- Flip \`HomepageConfig.eventsBandAutoPullEnabled=false\` via \`/admin-ui/#homepage\` Config tab — endpoint falls back to legacy \`Events\` entity, no redeploy needed.

Closes #1030.
EOF
)"
```

---

## PR 3 Merge Checklist

- [ ] `npm test` green (unit + drift guard)
- [ ] `npm run test:hybrid -- --project hybrid` green (once PR 1 backfill has run on DEV)
- [ ] Manual local run: chip clicks + BroadcastChannel round-trip work
- [ ] Smoke against DEV after MTA deploy: `SMOKE_SRV_URL=<url> npm run test:smoke -- homepage-events` green
- [ ] `region_unknown` metric monitored for 1 week — new city/country strings folded into `RULES` via follow-up PRs
- [ ] PROD rollout: backfill run, cron confirmed, flag flipped
