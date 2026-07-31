# Devtoberfest Gameboard — Plan B: Scoring + Personalized View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax and are TDD (failing test → run → implement → pass → commit).

**Goal:** Build the real scoring engine on top of Plan A's foundation. Add a pure, unit-testable `srv/lib/scoring.js`, replace Plan A's `score:0`/`level:0` leaderboard stub with a TTL-cached computed ranking, and add a `getGameboard(scnId?)` public board plus a per-action-auth-gated personalized arm (`getMyGameboard()`) — all in the NEW repo `sap-community-gameboard`.

**Architecture:** Everything here lives in `sap-community-gameboard` and reads only through Plan A's already-deployed facades (`external.GameboardParticipantV1`, `external.GameboardCompletionV1`, `external.DtfActivityV1`). Scoring is DB-free and pure so it unit-tests with in-memory fixtures; the service layer joins the three facades, feeds them to the pure functions, and caches results with a short TTL modeled on the tutorial repo's `srv/lib/ttl-cache.js`. No new HANA views, no schema, no cross-container changes (those are Plan A). No UI (that is Plan C).

**Tech Stack:** SAP CAP (Node.js, `@sap/cds` v8 / CAP 10 baseline, CommonJS `srv/` modules per Plan A), SQLite for unit tests, HANA (via `cds bind --exec`) for hybrid tests, `vitest` + `chai`.

## Global Constraints

- **Reuse Plan A's frozen interface names verbatim.** `GameboardService @(path:'/gameboard') @(requires:'any')`; `type LeaderboardRow { rank, displayName, score, level, communityUrl }`; facades `external.GameboardParticipantV1` (`userId, firstName, lastInitial, communityId, communityLogin, joinedAt, eventId`), `external.GameboardCompletionV1` (`userId, tutorialSlug, taskType, completionDate, eventId`), `external.DtfActivityV1` (`id, title, trackId, status, week, points, tutorialSlug, tutorialTitle, tutorialId`); helper `srv/lib/active-event.js` `getActiveEventId(db, ParticipantV1)`. Do NOT rename or re-shape any of these.
- **`srv/lib/scoring.js` is PURE** — no `require('@sap/cds')`, no DB, no I/O, no `Date.now()`-dependent branches. Inputs are plain arrays/objects; outputs are plain values. This is what makes it unit-testable without HANA.
- **Slug matching is case-insensitive on both sides.** Lowercase `activity.tutorialSlug` and `completion.tutorialSlug` before comparing (tutorial slugs are lowercase-canonical, but never trust the input).
- **Level thresholds are CONFIG, not hardcoded logic.** Default seeded verbatim from the old `points.json` (`{1:3000, 2:14000, 3:22000, 4:30000}`); override per edition via the `GAMEBOARD_LEVEL_THRESHOLDS` env var (JSON array). No magic numbers in branches.
- **Event-window cutoff comes from the active event, never a hardcoded date.** Completions are already bounded by the active event through Plan A's views + `getActiveEventId`; the old `endDate = 2025-11-24` is gone. Do not reintroduce any date literal.
- **Fail-soft reads.** Any facade read fault degrades to an empty-but-valid response (`[]` / `null` personalized), never a 500. Log at `warn` via `cds.log('gameboard')`.
- **Never SELECT a HANA BLOB alongside metadata in one CDS QL query** — not applicable here (no BLOB columns in these facades), noted for the shared convention.
- **Cache reads cheaply so Plan C can re-fetch on a websocket `tutorialCompleted` event.** Short, env-tunable TTL + an explicit bust seam (Task 4). The realtime client subscription itself is Plan C — do NOT build UI here.
- **Personalized data is auth-gated at the endpoint boundary** via a per-action `@(requires:'authenticated-user')` override (the `srv/puzzle-service.cds` pattern in the tutorial repo), so anonymous callers get 401/403 before any handler runs.

## Interface Contracts (PRODUCED here — consumed by Plan C)

These names are frozen by this plan for downstream plans.

**Pure scoring API (`srv/lib/scoring.js`, CommonJS):**

```
computeScore(completions, activities) -> Integer
computeLevel(score, thresholds)       -> Integer            // thresholds optional; defaults to levelThresholds()
perWeekBreakdown(completions, activities) -> WeekTrackBreakdown[]
weekTrackTotals(activities)           -> WeekTrackTotal[]
avatarIndex(name)                     -> Integer 0..37       // ported from old stringScore()
levelThresholds()                     -> [{ level, points }] // env-configurable, points.json default
DEFAULT_LEVEL_THRESHOLDS              -> const array
ACTIVE_STATUSES                       -> ['PUBLISHED','ACTIVE']
```

**New OData surface on `GameboardService` (extends Plan A):**

```
type LevelThreshold     { level : Integer; points : Integer; }
type WeekTrackTotal     { week : String; trackId : String; totalPoints : Integer; totalCount : Integer; }
type WeekTrackBreakdown { week : String; trackId : String;
                          earnedPoints : Integer; earnedCount : Integer;
                          remainingPoints : Integer; remainingCount : Integer; }
type TrackRef           { trackId : String; title : String; }   // trackId -> human-readable title lookup
type MyGameboard        { userId : String; score : Integer; level : Integer;
                          avatarIndex : Integer; breakdown : array of WeekTrackBreakdown; }
type GameboardConfig    { thresholds : array of LevelThreshold;
                          totals : array of WeekTrackTotal;
                          tracks : array of TrackRef;             // trackId -> title (from planner DTF_TRACK_V1)
                          personalized : MyGameboard; }   // null unless caller authenticated & a participant

function getGameboard(scnId : String) returns GameboardConfig;      // @requires 'any'
@(requires: 'authenticated-user')
function getMyGameboard() returns MyGameboard;                      // personalized arm; anonymous -> 401/403
action   refreshGameboardCache() returns Boolean;                  // cache-bust seam (Task 4)
```

**Cache module (`srv/lib/gameboard-cache.js`):** exports `{ cached, invalidate, bust, KEY, LEADERBOARD_TTL_MS, CONFIG_TTL_MS }`. `KEY.leaderboard(top)` and `KEY.config` are the canonical cache keys; `bust()` clears both namespaces.

---

### Task 1: Pure scoring functions (`srv/lib/scoring.js`)

**Repo:** `sap-community-gameboard`. Pure/DB-free; unit-tested with in-memory fixtures.

**Files:**
- Create: `srv/lib/scoring.js`
- Test: `test/unit/scoring.test.js`

**Interfaces:**
- Consumes: nothing (pure). Fixtures mirror the facade element names (`tutorialSlug`, `points`, `status`, `week`, `trackId`).
- Produces: `computeScore`, `computeLevel`, `perWeekBreakdown`, `weekTrackTotals`, `avatarIndex`, `levelThresholds`, `DEFAULT_LEVEL_THRESHOLDS`, `ACTIVE_STATUSES`.

- [ ] **Step 1: Write the failing unit test**

`test/unit/scoring.test.js`:

```js
const { expect } = require('chai');
const {
  computeScore, computeLevel, perWeekBreakdown, weekTrackTotals,
  avatarIndex, levelThresholds, DEFAULT_LEVEL_THRESHOLDS
} = require('../../srv/lib/scoring');

const activities = [
  { id: 'a1', status: 'PUBLISHED', week: '1', trackId: 't-abap', points: 3000, tutorialSlug: 'Hello-World' },
  { id: 'a2', status: 'ACTIVE',    week: '1', trackId: 't-abap', points: 2000, tutorialSlug: 'cap-basics'  },
  { id: 'a3', status: 'PUBLISHED', week: '2', trackId: 't-btp',  points: 5000, tutorialSlug: 'deploy-btp'  },
  { id: 'a4', status: 'DRAFT',     week: '2', trackId: 't-btp',  points: 9999, tutorialSlug: 'secret-draft'}
];

describe('scoring.computeScore', () => {
  it('sums points for active activities whose slug was completed (case-insensitive)', () => {
    const completions = [{ tutorialSlug: 'hello-world' }, { tutorialSlug: 'DEPLOY-BTP' }];
    expect(computeScore(completions, activities)).to.equal(8000); // 3000 + 5000
  });
  it('ignores draft/inactive activities even when completed', () => {
    expect(computeScore([{ tutorialSlug: 'secret-draft' }], activities)).to.equal(0);
  });
  it('counts each activity once regardless of duplicate completions', () => {
    const dupes = [{ tutorialSlug: 'hello-world' }, { tutorialSlug: 'hello-world' }];
    expect(computeScore(dupes, activities)).to.equal(3000);
  });
  it('is empty-input safe', () => {
    expect(computeScore(null, null)).to.equal(0);
  });
});

describe('scoring.computeLevel', () => {
  it('uses the default points.json thresholds when none passed', () => {
    expect(DEFAULT_LEVEL_THRESHOLDS.map(t => t.points)).to.deep.equal([3000, 14000, 22000, 30000]);
    expect(computeLevel(0)).to.equal(0);
    expect(computeLevel(2999)).to.equal(0);
    expect(computeLevel(3000)).to.equal(1);
    expect(computeLevel(21000)).to.equal(2);
    expect(computeLevel(30000)).to.equal(4);
  });
  it('honors a custom (unsorted) threshold array', () => {
    const custom = [{ level: 2, points: 200 }, { level: 1, points: 100 }];
    expect(computeLevel(150, custom)).to.equal(1);
    expect(computeLevel(250, custom)).to.equal(2);
  });
});

describe('scoring.perWeekBreakdown', () => {
  it('groups earned/remaining points + counts by week|trackId over active activities', () => {
    const rows = perWeekBreakdown([{ tutorialSlug: 'hello-world' }], activities);
    const w1 = rows.find(r => r.week === '1' && r.trackId === 't-abap');
    expect(w1).to.deep.equal({
      week: '1', trackId: 't-abap',
      earnedPoints: 3000, earnedCount: 1, remainingPoints: 2000, remainingCount: 1
    });
    const w2 = rows.find(r => r.week === '2' && r.trackId === 't-btp');
    expect(w2).to.include({ earnedPoints: 0, earnedCount: 0, remainingPoints: 5000, remainingCount: 1 });
  });
});

describe('scoring.weekTrackTotals', () => {
  it('sums total points + count per week|trackId over active activities only', () => {
    const totals = weekTrackTotals(activities);
    const w1 = totals.find(r => r.week === '1');
    expect(w1).to.deep.equal({ week: '1', trackId: 't-abap', totalPoints: 5000, totalCount: 2 });
    expect(totals.some(r => r.totalPoints === 9999)).to.equal(false); // DRAFT excluded
  });
});

describe('scoring.avatarIndex', () => {
  it('is deterministic and within 0..37 (ported stringScore semantics)', () => {
    const idx = avatarIndex('Thomas Jung');
    expect(idx).to.be.within(0, 37);
    expect(avatarIndex('Thomas Jung')).to.equal(idx);
  });
  it('handles empty/nullish names', () => {
    expect(avatarIndex('')).to.equal(0);
    expect(avatarIndex(null)).to.equal(0);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run test/unit/scoring.test.js`
Expected: FAIL — `Cannot find module '../../srv/lib/scoring'`.

- [ ] **Step 3: Write `srv/lib/scoring.js`**

```js
'use strict';
// Pure, DB-free scoring helpers for the Devtoberfest gameboard.
// Ports the intent of sap-community-activity-badges/srv/routes/devtoberfest.js
// (points summation + level thresholds + stringScore avatar pick) and
// srv/util/points.json. NO @sap/cds, NO DB, NO I/O — unit-testable in isolation.

// Level thresholds seeded verbatim from the old points.json. Tunable per
// edition via GAMEBOARD_LEVEL_THRESHOLDS (JSON array of {level,points}).
const DEFAULT_LEVEL_THRESHOLDS = [
  { level: 1, points: 3000 },
  { level: 2, points: 14000 },
  { level: 3, points: 22000 },
  { level: 4, points: 30000 }
];

// Activity statuses that count toward scoring (published/active).
const ACTIVE_STATUSES = ['PUBLISHED', 'ACTIVE'];

const norm = (s) => (s == null ? '' : String(s).toLowerCase());
const isActive = (a) => ACTIVE_STATUSES.includes(String(a && a.status || '').toUpperCase());

function levelThresholds() {
  const raw = process.env.GAMEBOARD_LEVEL_THRESHOLDS;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length) return parsed;
    } catch { /* fall through to default */ }
  }
  return DEFAULT_LEVEL_THRESHOLDS;
}

// Σ activity.points for each ACTIVE activity whose tutorialSlug matches a
// completion's tutorialSlug (both lowercased). Each activity counts once.
function computeScore(completions, activities) {
  const done = new Set((completions || []).map((c) => norm(c.tutorialSlug)));
  let score = 0;
  for (const a of activities || []) {
    if (!isActive(a)) continue;
    if (done.has(norm(a.tutorialSlug))) score += Number(a.points) || 0;
  }
  return score;
}

// Highest threshold.level whose points floor the score. 0 below the first tier.
function computeLevel(score, thresholds) {
  const tiers = (thresholds && thresholds.length ? thresholds : levelThresholds())
    .slice()
    .sort((x, y) => x.points - y.points);
  let level = 0;
  for (const t of tiers) if (score >= t.points) level = t.level;
  return level;
}

function groupKey(a) {
  const week = a.week == null ? '' : String(a.week);
  const trackId = a.trackId == null ? '' : String(a.trackId);
  return { week, trackId, key: `${week}|${trackId}` };
}

const byWeekTrack = (x, y) => x.week.localeCompare(y.week) || x.trackId.localeCompare(y.trackId);

// Earned/remaining points + counts grouped by week|trackId (active activities).
function perWeekBreakdown(completions, activities) {
  const done = new Set((completions || []).map((c) => norm(c.tutorialSlug)));
  const groups = new Map();
  for (const a of activities || []) {
    if (!isActive(a)) continue;
    const { week, trackId, key } = groupKey(a);
    let g = groups.get(key);
    if (!g) {
      g = { week, trackId, earnedPoints: 0, earnedCount: 0, remainingPoints: 0, remainingCount: 0 };
      groups.set(key, g);
    }
    const pts = Number(a.points) || 0;
    if (done.has(norm(a.tutorialSlug))) { g.earnedPoints += pts; g.earnedCount += 1; }
    else { g.remainingPoints += pts; g.remainingCount += 1; }
  }
  return [...groups.values()].sort(byWeekTrack);
}

// Total points + count per week|trackId (active activities), completion-agnostic.
function weekTrackTotals(activities) {
  const groups = new Map();
  for (const a of activities || []) {
    if (!isActive(a)) continue;
    const { week, trackId, key } = groupKey(a);
    let g = groups.get(key);
    if (!g) { g = { week, trackId, totalPoints: 0, totalCount: 0 }; groups.set(key, g); }
    g.totalPoints += Number(a.points) || 0;
    g.totalCount += 1;
  }
  return [...groups.values()].sort(byWeekTrack);
}

// Deterministic avatar index (0..37) from a display name — ported verbatim
// from the old stringScore(): Σ charCodes, mod 38, then -1 when > 0.
function avatarIndex(name) {
  let score = 0;
  const str = String(name || '');
  for (let j = 0; j < str.length; j++) score += str.charCodeAt(j);
  score = ((score % 38) + 38) % 38;
  if (score > 0) score -= 1;
  return score;
}

module.exports = {
  DEFAULT_LEVEL_THRESHOLDS,
  ACTIVE_STATUSES,
  levelThresholds,
  computeScore,
  computeLevel,
  perWeekBreakdown,
  weekTrackTotals,
  avatarIndex
};
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run test/unit/scoring.test.js`
Expected: PASS — all cases green.

- [ ] **Step 5: Commit**

```bash
git add srv/lib/scoring.js test/unit/scoring.test.js
git commit -m "feat(gameboard): pure scoring lib (score/level/breakdown/avatar) with unit tests"
```

---

### Task 2: Wire real scoring into `getLeaderboard` (TTL-cached)

**Repo:** `sap-community-gameboard`. Replaces Plan A Task 4's `score:0`/`level:0` stub with a computed, ranked, cached leaderboard.

**Files:**
- Create: `srv/lib/ttl-cache.js` (CommonJS port of the tutorial repo's ESM `srv/lib/ttl-cache.js`)
- Create: `srv/lib/gameboard-cache.js` (cache keys + TTLs + `bust()`)
- Modify: `srv/gameboard-service.js`
- Test: `test/hybrid/leaderboard-scoring.test.js`

**Interfaces:**
- Consumes: `external.GameboardParticipantV1`, `external.GameboardCompletionV1`, `external.DtfActivityV1`, `getActiveEventId`, and `srv/lib/scoring.js`.
- Produces: `getLeaderboard(top)` returning `LeaderboardRow[]` ranked by `score` desc with real `score`/`level`; `srv/lib/gameboard-cache.js`.

- [ ] **Step 1: Write the failing hybrid test**

`test/hybrid/leaderboard-scoring.test.js`:

```js
const cds = require('@sap/cds');
const { expect } = require('chai');
const { GET } = cds.test(__dirname + '/../..');

describe('getLeaderboard computes real scores', () => {
  it('ranks by score desc and returns non-zero scores when completions exist', async () => {
    const { data } = await GET(`/gameboard/getLeaderboard(top=25)`);
    expect(data.value).to.be.an('array');
    // Ranks are contiguous from 1 and scores are non-increasing.
    data.value.forEach((row, i) => {
      expect(row.rank).to.equal(i + 1);
      expect(row).to.have.keys(['rank', 'displayName', 'score', 'level', 'communityUrl']);
      if (i > 0) expect(row.score).to.be.at.most(data.value[i - 1].score);
    });
    // On DEV data with completions, at least one participant has scored.
    if (data.value.length) {
      expect(data.value.some(r => r.score > 0)).to.equal(true);
    }
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run test/hybrid/leaderboard-scoring.test.js --project hybrid` (needs `cf login` + `cds bind`).
Expected: FAIL — current impl returns `score:0` for every row (the `some(r => r.score > 0)` assertion fails), and ordering is by `joinedAt`, not score.

- [ ] **Step 3: Port `srv/lib/ttl-cache.js` (read the original first)**

Read `<tutorials-ims>/srv/lib/ttl-cache.js` (ESM: `export function cached/invalidate`). Port to CommonJS here (this repo's `srv/` is CommonJS per Plan A):

```js
'use strict';
// TTL cache — ported from tutorials-ims srv/lib/ttl-cache.js (ESM there;
// CommonJS here to match this repo's srv module style). Identical semantics:
// memoize a value (or promise result) under `key` for `ttlMs`;
// `invalidate(prefix)` deletes every key starting with `prefix`.
const _store = new Map();

function cached(key, ttlMs, fn) {
  const entry = _store.get(key);
  if (entry && Date.now() < entry.expires) return entry.value;
  const value = fn();
  if (value && typeof value.then === 'function') {
    return value.then((result) => {
      _store.set(key, { value: result, expires: Date.now() + ttlMs });
      return result;
    });
  }
  _store.set(key, { value, expires: Date.now() + ttlMs });
  return value;
}

function invalidate(keyPrefix) {
  for (const key of _store.keys()) if (key.startsWith(keyPrefix)) _store.delete(key);
}

module.exports = { cached, invalidate };
```

- [ ] **Step 4: Write `srv/lib/gameboard-cache.js`**

```js
'use strict';
// Central cache seam for the gameboard read paths. Short, env-tunable TTLs so
// Plan C can cheaply re-fetch on a websocket 'tutorialCompleted' event; bust()
// is the explicit cache-clear the realtime path can trigger (see Task 4).
const { cached, invalidate } = require('./ttl-cache');

const LEADERBOARD_TTL_MS = Number(process.env.GAMEBOARD_LEADERBOARD_TTL_MS) || 30000;
const CONFIG_TTL_MS = Number(process.env.GAMEBOARD_CONFIG_TTL_MS) || 60000;

const KEY = {
  leaderboard: (top) => `leaderboard:top=${top}`,
  config: 'gameboard:config'
};

// Clears both cached read namespaces. Called by refreshGameboardCache (Task 4).
function bust() {
  invalidate('leaderboard');
  invalidate('gameboard');
}

module.exports = { cached, invalidate, bust, KEY, LEADERBOARD_TTL_MS, CONFIG_TTL_MS };
```

- [ ] **Step 5: Rewrite `getLeaderboard` in `srv/gameboard-service.js`**

Replace the Plan A `getLeaderboard` handler body. Keep the fail-soft `try/catch` and the display-name / community-url logic; add the join + compute + rank + cache:

```js
const cds = require('@sap/cds');
const { getActiveEventId } = require('./lib/active-event');
const { computeScore, computeLevel, levelThresholds } = require('./lib/scoring');
const { cached, KEY, LEADERBOARD_TTL_MS } = require('./lib/gameboard-cache');

module.exports = class GameboardService extends cds.ApplicationService {
  async init() {
    const db = await cds.connect.to('db');
    const { GameboardParticipantV1, GameboardCompletionV1, DtfActivityV1 } = db.entities('external');

    const displayName = (p) =>
      `${p.firstName} ${(p.lastInitial || '').toUpperCase()}.`
      + (p.communityLogin ? ' (community)' : '');
    const communityUrl = (p) =>
      p.communityId
        ? `https://community.sap.com/t5/user/viewprofilepage/user-id/${p.communityId}`
        : null;

    this.on('getLeaderboard', async (req) => {
      const top = req.data.top || 25;
      return cached(KEY.leaderboard(top), LEADERBOARD_TTL_MS, async () => {
        try {
          const eventId = await getActiveEventId(db, GameboardParticipantV1);
          if (!eventId) return [];
          const [participants, completions, activities] = await Promise.all([
            db.run(SELECT.from(GameboardParticipantV1).where({ eventId })),
            db.run(SELECT.from(GameboardCompletionV1).where({ eventId })),
            db.run(SELECT.from(DtfActivityV1))
          ]);
          const byUser = new Map();
          for (const c of completions) {
            if (!byUser.has(c.userId)) byUser.set(c.userId, []);
            byUser.get(c.userId).push(c);
          }
          const thresholds = levelThresholds();
          const scored = participants.map((p) => {
            const score = computeScore(byUser.get(p.userId) || [], activities);
            return { p, score, level: computeLevel(score, thresholds) };
          });
          scored.sort((a, b) => b.score - a.score);
          return scored.slice(0, top).map((s, i) => ({
            rank: i + 1,
            displayName: displayName(s.p),
            score: s.score,
            level: s.level,
            communityUrl: communityUrl(s.p)
          }));
        } catch (e) {
          cds.log('gameboard').warn('getLeaderboard failed, returning empty', e);
          return []; // fail-soft
        }
      });
    });

    return super.init();
  }
};
```

- [ ] **Step 6: Run the hybrid test**

Run: `npx vitest run test/hybrid/leaderboard-scoring.test.js --project hybrid`
Expected: PASS — ranks contiguous, scores non-increasing, at least one non-zero score on DEV data.

- [ ] **Step 7: Commit**

```bash
git add srv/lib/ttl-cache.js srv/lib/gameboard-cache.js srv/gameboard-service.js test/hybrid/leaderboard-scoring.test.js
git commit -m "feat(gameboard): computed TTL-cached leaderboard (real score + level, ranked)"
```

---

### Task 3: `getGameboard(scnId?)` + personalized arm `getMyGameboard()`

**Repo:** `sap-community-gameboard`. Adds the public board config (thresholds + global per-week/track totals) and the auth-gated personalized breakdown.

**Files:**
- Create: `db/external/planner.cds` addition — `DtfTrackV1` facade over the planner's `DTF_TRACK_V1`
- Create: `db/src/DTF_TRACK_V1.hdbsynonym` (+ `.hdbsynonymconfig`)
- Modify: `srv/gameboard-service.cds`
- Modify: `srv/gameboard-service.js`
- Test: `test/unit/personalized-auth.test.js` (anonymous 401 gate — no DB)
- Test: `test/hybrid/gameboard-personalized.test.js` (authenticated breakdown + `tracks` shape — real HANA)

**Interfaces:**
- Consumes: the three facades + a NEW `external.DtfTrackV1` facade (over planner `DTF_TRACK_V1`, already granted by `devtoberfest_reader` — no grants change) + `scoring.js` (`perWeekBreakdown`, `weekTrackTotals`, `computeScore`, `computeLevel`, `avatarIndex`, `levelThresholds`) + `gameboard-cache.js`.
- Produces: types `LevelThreshold`, `WeekTrackTotal`, `WeekTrackBreakdown`, `TrackRef`, `MyGameboard`, `GameboardConfig`; functions `getGameboard(scnId)` (`@requires:'any'`) and `getMyGameboard()` (`@requires:'authenticated-user'`); `external.DtfTrackV1` facade + its synonym.

- [ ] **Step 1: Write the failing tests**

`test/unit/personalized-auth.test.js` (auth gate is enforced pre-handler, so no facade read is needed → runs on the unit/SQLite profile):

```js
const cds = require('@sap/cds');
const { expect } = require('chai');
const { GET } = cds.test(__dirname + '/../..');

describe('personalized arm is auth-gated', () => {
  it('rejects anonymous getMyGameboard with 401/403', async () => {
    try {
      await GET(`/gameboard/getMyGameboard()`);
      expect.fail('expected an auth error');
    } catch (err) {
      expect([401, 403]).to.include(err.response ? err.response.status : err.status);
    }
  });
});
```

`test/hybrid/gameboard-personalized.test.js` (real data; a mocked user whose `id` equals a real DEV participant `USER_ID`):

```js
const cds = require('@sap/cds');
const { expect } = require('chai');
const { GET } = cds.test(__dirname + '/../..');

// PARTICIPANT_USER_ID must be a real Users.ID present in GAMEBOARD_PARTICIPANT_V1
// for the active DEVTOBERFEST event on DEV. Discover once via:
//   SELECT TOP 1 "USER_ID" FROM "GAMEBOARD_PARTICIPANT_V1"
// and configure it as a mocked user in package.json [hybrid].cds.requires.auth.users.
const USER = process.env.GAMEBOARD_TEST_USER || 'gameboard-test-participant';

describe('getGameboard + getMyGameboard personalized breakdown', () => {
  it('getGameboard is public and returns thresholds + totals + tracks with personalized:null anonymously', async () => {
    const { data } = await GET(`/gameboard/getGameboard()`);
    expect(data.thresholds).to.be.an('array').that.is.not.empty;
    expect(data.totals).to.be.an('array');
    expect(data.tracks).to.be.an('array'); // trackId -> title lookup; [] on fail-soft
    data.tracks.forEach((t) => expect(t).to.have.keys(['trackId', 'title']));
    expect(data.personalized).to.equal(null);
  });

  it('getMyGameboard returns a per-week breakdown for an authenticated participant', async () => {
    const { data } = await GET(`/gameboard/getMyGameboard()`).auth(USER, '');
    // Authenticated participant → structured breakdown; non-participant → null (fail-soft).
    if (data) {
      expect(data).to.have.keys(['userId', 'score', 'level', 'avatarIndex', 'breakdown']);
      expect(data.score).to.be.a('number').that.is.at.least(0);
      expect(data.avatarIndex).to.be.within(0, 37);
      expect(data.breakdown).to.be.an('array');
    }
  });
});
```

- [ ] **Step 2: Run them to confirm they fail**

Run: `npx vitest run test/unit/personalized-auth.test.js` — Expected: FAIL (`getMyGameboard` not defined → 404, not 401).
Run: `npx vitest run test/hybrid/gameboard-personalized.test.js --project hybrid` — Expected: FAIL (`getGameboard` not defined).

- [ ] **Step 3: Add the `DtfTrackV1` facade + synonym (planner track titles)**

Append to `db/external/planner.cds` (Plan A defined only `DtfActivityV1` here). `DTF_TRACK_V1` is already granted by the planner's `devtoberfest_reader` role — no `.hdbgrants` change:

```cds
// Proxy over DTF_TRACK_V1 (devtoberfest-planner-db), granted by devtoberfest_reader.
// camelCase elements resolve to UPPERCASE physical columns (workbook D4a).
@cds.persistence.exists
entity DtfTrackV1 {
  key id   : String(36);
      name : String(200);
}
```

`db/src/DTF_TRACK_V1.hdbsynonym`:

```json
{ "DTF_TRACK_V1": { "target": { "object": "DTF_TRACK_V1" } } }
```

`db/src/DTF_TRACK_V1.hdbsynonymconfig`:

```json
{ "DTF_TRACK_V1": { "target": { "object": "DTF_TRACK_V1", "schema.configure": "devtoberfest-planner-db/schema" } } }
```

Deploy the gameboard db-deployer (same path as Plan A Task 3 Step 7) so the new synonym + facade resolve before Step 6's read uses them.

- [ ] **Step 4: Extend `srv/gameboard-service.cds`**

Add the types + two functions alongside the existing `LeaderboardRow` / `getLeaderboard`:

```cds
service GameboardService @(path: '/gameboard') @(requires: 'any') {
  type LeaderboardRow {
    rank         : Integer;
    displayName  : String;
    score        : Integer;
    level        : Integer;
    communityUrl : String;
  }

  type LevelThreshold {
    level  : Integer;
    points : Integer;
  }
  type WeekTrackTotal {
    week        : String;
    trackId     : String;
    totalPoints : Integer;
    totalCount  : Integer;
  }
  type WeekTrackBreakdown {
    week            : String;
    trackId         : String;
    earnedPoints    : Integer;
    earnedCount     : Integer;
    remainingPoints : Integer;
    remainingCount  : Integer;
  }
  type TrackRef {
    trackId : String;
    title   : String;
  }
  type MyGameboard {
    userId      : String;
    score       : Integer;
    level       : Integer;
    avatarIndex : Integer;
    breakdown   : array of WeekTrackBreakdown;
  }
  type GameboardConfig {
    thresholds   : array of LevelThreshold;
    totals       : array of WeekTrackTotal;
    tracks       : array of TrackRef; // trackId -> human-readable title (planner DTF_TRACK_V1); [] on fail-soft
    personalized : MyGameboard; // null unless the caller is authenticated AND a participant
  }

  function getLeaderboard(top: Integer) returns array of LeaderboardRow;

  // Public board scaffold. `scnId` is reserved (accepted, currently unused —
  // personalized data always resolves from the JWT, never a caller-supplied id).
  function getGameboard(scnId: String) returns GameboardConfig;

  // Personalized arm: per-action auth override (srv/puzzle-service.cds pattern).
  @(requires: 'authenticated-user')
  function getMyGameboard() returns MyGameboard;
}
```

- [ ] **Step 5: Implement the handlers in `srv/gameboard-service.js`**

Inside `init()` (add imports `perWeekBreakdown`, `weekTrackTotals`, `avatarIndex`, and `KEY`, `CONFIG_TTL_MS` from the cache module; add `DtfTrackV1` to the `db.entities('external')` destructure), add a shared personalized helper and the two handlers:

```js
    // --- shared personalized computation (used by both getGameboard & getMyGameboard) ---
    async function computeMyGameboard(userId) {
      const eventId = await getActiveEventId(db, GameboardParticipantV1);
      if (!eventId || !userId) return null;
      const [me] = await db.run(
        SELECT.from(GameboardParticipantV1).where({ userId, eventId })
      );
      if (!me) return null; // authenticated but not a participant → fail-soft
      const [completions, activities] = await Promise.all([
        db.run(SELECT.from(GameboardCompletionV1).where({ userId, eventId })),
        db.run(SELECT.from(DtfActivityV1))
      ]);
      const thresholds = levelThresholds();
      const score = computeScore(completions, activities);
      return {
        userId,
        score,
        level: computeLevel(score, thresholds),
        avatarIndex: avatarIndex(`${me.firstName} ${me.lastInitial || ''}`),
        breakdown: perWeekBreakdown(completions, activities)
      };
    }

    // Public board config (thresholds + global per-week/track totals + track titles), TTL-cached.
    async function loadConfig() {
      return cached(KEY.config, CONFIG_TTL_MS, async () => {
        try {
          const activities = await db.run(SELECT.from(DtfActivityV1));
          const totals = weekTrackTotals(activities);
          // Resolve human-readable titles for the trackIds actually present.
          let tracks = [];
          try {
            const trackIds = [...new Set(activities.map((a) => a.trackId).filter(Boolean))];
            if (trackIds.length) {
              const rows = await db.run(SELECT.from(DtfTrackV1).where({ id: trackIds }));
              tracks = rows.map((t) => ({ trackId: t.id, title: t.name }));
            }
          } catch (te) {
            cds.log('gameboard').warn('track title read failed, labeling by trackId', te);
            tracks = []; // fail-soft: UI falls back to trackId labels
          }
          return { thresholds: levelThresholds(), totals, tracks };
        } catch (e) {
          cds.log('gameboard').warn('gameboard config load failed, returning empty', e);
          return { thresholds: levelThresholds(), totals: [], tracks: [] };
        }
      });
    }

    this.on('getGameboard', async (req) => {
      const config = await loadConfig();
      let personalized = null;
      // Personalized slice only for an authenticated caller; anonymous stays null
      // (the strictly-gated arm is getMyGameboard, which 401s anonymously).
      if (req.user && req.user.is && req.user.is('authenticated-user')) {
        try { personalized = await computeMyGameboard(req.user.id); }
        catch (e) { cds.log('gameboard').warn('personalized slice failed', e); }
      }
      return { ...config, personalized };
    });

    this.on('getMyGameboard', async (req) => {
      try {
        return await computeMyGameboard(req.user.id);
      } catch (e) {
        cds.log('gameboard').warn('getMyGameboard failed', e);
        return null; // fail-soft
      }
    });
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run test/unit/personalized-auth.test.js` — Expected: PASS (anonymous → 401/403).
Run: `npx vitest run test/hybrid/gameboard-personalized.test.js --project hybrid` — Expected: PASS (public config returns thresholds + totals + `tracks` of `{trackId,title}`; authenticated participant returns a breakdown).

- [ ] **Step 7: Commit**

```bash
git add srv/gameboard-service.cds srv/gameboard-service.js db/external/planner.cds db/src/DTF_TRACK_V1.hdbsynonym db/src/DTF_TRACK_V1.hdbsynonymconfig test/unit/personalized-auth.test.js test/hybrid/gameboard-personalized.test.js
git commit -m "feat(gameboard): getGameboard config (+track titles) + auth-gated getMyGameboard breakdown"
```

---

### Task 4: Realtime cache-bust seam (`refreshGameboardCache`)

**Repo:** `sap-community-gameboard`. Ensures the read paths are cheap + cached AND explicitly bustable, so Plan C's websocket `tutorialCompleted` handler can force fresh data without waiting out the TTL. No UI here.

**Files:**
- Modify: `srv/gameboard-service.cds` (add the `refreshGameboardCache` action)
- Modify: `srv/gameboard-service.js` (wire it to `bust()`)
- Test: `test/unit/cache-bust.test.js`

**Interfaces:**
- Consumes: `srv/lib/gameboard-cache.js` `bust()`.
- Produces: `action refreshGameboardCache() returns Boolean;` on `GameboardService` + a proven `bust()` seam clearing both `leaderboard:*` and `gameboard:*` cache keys.

- [ ] **Step 1: Write the failing unit test**

`test/unit/cache-bust.test.js` (pure — exercises the cache module directly, plus asserts the action is registered):

```js
const cds = require('@sap/cds');
const { expect } = require('chai');
const { cached, bust, KEY } = require('../../srv/lib/gameboard-cache');
const { POST } = cds.test(__dirname + '/../..');

describe('gameboard cache bust seam', () => {
  it('bust() clears both leaderboard and gameboard cache namespaces', () => {
    cached(KEY.leaderboard(10), 60000, () => 'LB');
    cached(KEY.config, 60000, () => 'CFG');
    // still cached (would return stale marker, not the new fn result)
    expect(cached(KEY.leaderboard(10), 60000, () => 'NEW')).to.equal('LB');
    bust();
    // after bust the fn runs again
    expect(cached(KEY.leaderboard(10), 60000, () => 'FRESH')).to.equal('FRESH');
    expect(cached(KEY.config, 60000, () => 'FRESH2')).to.equal('FRESH2');
  });

  it('exposes refreshGameboardCache action returning true', async () => {
    const { data } = await POST(`/gameboard/refreshGameboardCache`, {});
    expect(data.value).to.equal(true);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run test/unit/cache-bust.test.js`
Expected: FAIL — `refreshGameboardCache` not defined (404); the pure `bust()` assertion may pass but the action assertion fails.

- [ ] **Step 3: Add the action to `srv/gameboard-service.cds`**

Add inside the service (a plain action — realtime freshness trigger; no `@requires` override so the same-origin approuter/automation can call it, and the short TTL already bounds staleness):

```cds
  // Cache-bust seam for the realtime path (Plan C subscribes to /ws/event-stream
  // and can POST this on 'tutorialCompleted' to force a fresh leaderboard/board).
  action refreshGameboardCache() returns Boolean;
```

- [ ] **Step 4: Wire the handler in `srv/gameboard-service.js`**

Import `bust` from the cache module and register the handler in `init()`:

```js
    // (add `bust` to the existing require of ./lib/gameboard-cache)
    this.on('refreshGameboardCache', async () => {
      bust();
      return true;
    });
```

- [ ] **Step 5: Run the test**

Run: `npx vitest run test/unit/cache-bust.test.js`
Expected: PASS — `bust()` clears both namespaces and the action returns `true`.

- [ ] **Step 6: Full unit + hybrid regression**

Run: `npx vitest run` (all unit) then `npx vitest run --project hybrid` (needs `cf login` + `cds bind`).
Expected: PASS — scoring, leaderboard, personalized, and cache-bust suites all green.

- [ ] **Step 7: Commit**

```bash
git add srv/gameboard-service.cds srv/gameboard-service.js test/unit/cache-bust.test.js
git commit -m "feat(gameboard): refreshGameboardCache cache-bust seam for realtime refetch"
```

---

## No Placeholders

Every code step contains complete, runnable code — no TODOs, no stubs left behind (Plan A's `score:0` stub is fully replaced in Task 2). Concrete values are pinned: level thresholds default to `{1:3000, 2:14000, 3:22000, 4:30000}` (from `points.json`) and are overridable via `GAMEBOARD_LEVEL_THRESHOLDS`; TTLs default to 30s (leaderboard) / 60s (config), overridable via `GAMEBOARD_LEADERBOARD_TTL_MS` / `GAMEBOARD_CONFIG_TTL_MS`; `ACTIVE_STATUSES = ['PUBLISHED','ACTIVE']`; avatar index range is `0..37`. The one deliberately-inert item — `getGameboard`'s `scnId` param — is documented as reserved (personalized data always resolves from the JWT), not a placeholder to fill in later. The hybrid personalized test's `GAMEBOARD_TEST_USER` is documented with the exact SQL to discover a real participant `USER_ID` and the package.json mocked-user wiring it requires.

## Self-Review

**Spec coverage (Plan B scope):**
- Pure `computeScore` / `computeLevel` / `perWeekBreakdown` → Task 1 (+ `weekTrackTotals` and `avatarIndex` produced as documented additions). ✅
- Slug match lowercased both sides, active-status restriction → Task 1 `norm()` + `isActive()`, tested. ✅
- Real scoring wired into `getLeaderboard`, ranked desc, TTL-cached, stub removed → Task 2 (TTL cache modeled on and ported from the tutorial repo's `srv/lib/ttl-cache.js`, which Step 3 reads first). ✅
- `getGameboard(scnId?)` returns thresholds config + global per-week/track totals + track-title lookup (`tracks: TrackRef[]`); personalized breakdown/score/level/avatar when authenticated → Task 3 (`GameboardConfig.personalized`, `tracks` from new `DtfTrackV1` facade over planner `DTF_TRACK_V1`, fail-soft to `[]`). ✅
- Personalized arm auth-gated per-action (`@requires:'authenticated-user'`, puzzle-service.cds pattern); USER_ID resolved from `req.user.id` → matched to `GameboardParticipantV1` → Task 3 `getMyGameboard` + `computeMyGameboard`. ✅
- Level thresholds are CONFIG seeded from `points.json`, tunable per edition → `levelThresholds()` + `GAMEBOARD_LEVEL_THRESHOLDS`. ✅
- Event-window cutoff via active-event helper, no hardcoded date → Task 2/3 use `getActiveEventId`; no date literal anywhere. ✅
- Avatar selection ported as a pure helper from the old `stringScore()` → `avatarIndex(name)`. ✅
- Realtime prep: cheap + cached reads with short env-tunable TTL and an explicit bust seam Plan C can trigger → Task 4 `refreshGameboardCache` + `bust()`; UI/subscription deferred to Plan C. ✅
- Tests: unit (pure scoring, in-memory fixtures), hybrid (non-zero leaderboard scores), unit auth-gate (anonymous 401/403) + hybrid authenticated breakdown, unit cache-bust → Tasks 1–4. ✅

**Interface consistency:** `LeaderboardRow` keys unchanged from Plan A. Facade element names (`userId, firstName, lastInitial, communityId, communityLogin, joinedAt, eventId`; `tutorialSlug, taskType, completionDate`; `status, week, trackId, points, tutorialSlug`) match Plan A's `db/external/*.cds` verbatim. `getActiveEventId(db, ParticipantV1)` signature reused as-is. New types (`GameboardConfig`, `MyGameboard`, `WeekTrackTotal`, `WeekTrackBreakdown`, `LevelThreshold`) and the `scoring.js` field names align byte-for-byte between the CDS types, the `scoring.js` outputs, the service handlers, and the test assertions.

**Fail-soft audit:** `getLeaderboard`, `loadConfig`, `getGameboard`'s personalized slice, and `getMyGameboard` each catch and degrade to `[]` / `{thresholds, totals:[]}` / `null`, never a 500 — matching the repo convention.

**Purity audit:** `srv/lib/scoring.js` imports nothing, touches no DB, and is exercised entirely with in-memory fixtures in `test/unit/scoring.test.js` — the DB join lives only in the service layer (Tasks 2–3).
