# Devtoberfest Schedule & Activity Pages — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hand-written Devtoberfest schedule/activity blog posts with three dynamic, data-driven pages (unified schedule table, sessions grid, sessions calendar) that show completion + points for logged-in users.

**Architecture:** CAP backend refreshes its cross-container proxies to the planner's `DTF_SESSION_V1`/`DTF_ACTIVITY_V1` views and exposes a public read feed + an authenticated my-completions endpoint. Three Vue 3 Hugo islands (sharing one module) render the pages, merging completions by task slug and summing `Activity.points`.

**Tech Stack:** SAP CAP (Node.js), HANA HDI cross-container (synonyms + `@cds.persistence.exists` facades), Express public routes, Vue 3 + Vite islands, Hugo, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-01-devtoberfest-schedule-activity-pages-design.md`

## Global Constraints

- **Cross-container reads only within ONE HANA Cloud instance** — the planner (`devtoberfest-planner-db`) and tutorials-ims HDI containers must be co-located. Verify hosts via `cf` service keys, NEVER `cds bind`. (Task 1 gate.)
- **Facade element casing UPPERCASE-safe for underscore columns** — `USER_ID` not `userId`; camelCase only safe for single-word columns (else it folds to `USERID` and silently misses). Proxy column names/types MUST mirror the DEPLOYED view contract.
- **Never SELECT a HANA BLOB alongside metadata in one CDS QL query** — not applicable here (no BLOBs in the feed), but do not add `PHOTO`/`ABSTRACT`-as-BLOB reads to the feed query.
- **HANA stores columns UPPERCASE**; hand-authored `.hdbview`/facade SOURCE identifiers must be UPPERCASE.
- **Public endpoints** (`authenticationType: none`) MUST have a matching anonymous approuter route AND not be shadowed by an earlier `xsuaa` route — enforced by `test/unit/check-public-endpoints.test.ts`.
- **Slugs are lowercase canonical** — always `.toLowerCase()` before comparing a task slug to a completion slug.
- **Islands must NOT import `@ui5/webcomponents/*` directly** — register any `ui5-*` element once in `hugo/assets/js/ui5-bootstrap.ts`.
- **New island files use LF line endings** (Windows CRLF regressions break JS regex `$` and bundling).
- **Add each new island to `hugo-apps/vite.config.ts` `rollupOptions.input`** or it won't build.
- **Run `npx cds compile srv --to sql` (or `cds build`) before committing any `db/**/*.cds` change** to catch model errors early.
- **Work stays in the worktree** `D:\projects\tutorials-poc\.claude\worktrees\devtoberfest-schedule-activity`; commit frequently; open a PR, never merge to main.

## File Structure

**Backend (CAP):**
- `db/src/EXTERNAL_DEVTOBERFEST_ACTIVITY.hdbsynonym` (create) — synonym declaration
- `db/src/EXTERNAL_DEVTOBERFEST_ACTIVITY.hdbsynonymconfig` (create) — points at `DTF_ACTIVITY_V1`
- `db/external/devtoberfest.cds` (modify) — refresh `Session` facade, add `Activity` facade
- `srv/lib/devtoberfest-feed.js` (create) — pure feed-assembly + completion-merge helpers
- `srv/routes/devtoberfest-schedule.js` (create) — public `/api/devtoberfest/schedule` + authed `/api/devtoberfest/my-completions`
- `srv/server.js` (modify) — register the new route module
- `approuter/xs-app.json` (modify) — add `schedule` (none) + `my-completions` (xsuaa) routes
- `scripts/check-public-endpoints.ts` / `test/unit/check-public-endpoints.test.ts` (verify/extend)

**Frontend (islands):**
- `hugo-apps/src/devtoberfest-schedule-shared/` (create) — `types.ts`, `feed.ts`, `completion.ts`, `youtube.ts`, `useAuth.ts`, `EditionPicker.vue`, `DetailPanel.vue`, `PointsBanner.vue`
- `hugo-apps/src/devtoberfest-schedule/` (create) — `main.ts`, `App.vue`
- `hugo-apps/src/devtoberfest-sessions-grid/` (create) — `main.ts`, `App.vue`
- `hugo-apps/src/devtoberfest-sessions-calendar/` (create) — `main.ts`, `App.vue`, `calendar-grid.ts`
- `hugo-apps/vite.config.ts` (modify) — register 3 new inputs
- `hugo/content/devtoberfest/{schedule,sessions,calendar}/_index.md` (create)
- `hugo/layouts/devtoberfest/{schedule,sessions,calendar}.html` (create)
- `test/e2e/devtoberfest-schedule.test.js` (create)

---

### Task 1: Verify cross-container instance co-location & capture the deployed view contracts

**Files:** none modified (investigation gate). Records findings in the PR description.

**Interfaces:**
- Produces: the authoritative column list for `DTF_ACTIVITY_V1` and confirmation that `DTF_SESSION_V1` now exposes `ACTIVITY_ID`. All later backend tasks depend on these exact names.

- [ ] **Step 1: Confirm both HDI containers share one HANA instance**

Run (requires `cf login` to the tutorial-system dev space):
```bash
cf service-key tutorials-hana-hdi <existing-key> 2>/dev/null | grep -i host
cf service-key devtoberfest-planner-db-hdi <key> 2>/dev/null | grep -i host
```
Expected: identical `host`. If they differ, STOP — the "live from planner views" approach is invalid (see spec risk); escalate to Tom before continuing.

- [ ] **Step 2: Capture the live `DTF_ACTIVITY_V1` and `DTF_SESSION_V1` column contracts**

Using `hana-cli` (preferred) against the planner container, or read the source views in the planner repo at `D:\projects\devtoberfest-planner\db\src\DTF_ACTIVITY_V1.hdbview` and `DTF_SESSION_V1.hdbview`:
```bash
# planner repo is a known additional working dir
cat "D:/projects/devtoberfest-planner/db/src/DTF_ACTIVITY_V1.hdbview"
cat "D:/projects/devtoberfest-planner/db/src/DTF_SESSION_V1.hdbview"
```
Expected: record the exact UPPERCASE column names. Confirm `DTF_SESSION_V1` has `ACTIVITY_ID` (and no `TUTORIAL_*`). Confirm `DTF_ACTIVITY_V1` columns include at minimum `ID, TITLE, WEEK, POINTS, STATUS, TASKTYPE, TASKSLUG, TASKTITLE, TASK_ID, TRACK_ID` (+ managed columns). Note whether an edition key is reachable (Session→Track→EDITION_ID; Activity→Track→EDITION_ID).

- [ ] **Step 3: Record findings**

Write the confirmed column lists into the PR description / a scratch note. No commit. If `DTF_ACTIVITY_V1` lacks any column the plan assumes below, adjust the facade in Task 3 to match the live contract (the live contract wins over this plan's assumed names).

---

### Task 2: Add the `Activity` cross-container synonym

**Files:**
- Create: `db/src/EXTERNAL_DEVTOBERFEST_ACTIVITY.hdbsynonym`
- Create: `db/src/EXTERNAL_DEVTOBERFEST_ACTIVITY.hdbsynonymconfig`

**Interfaces:**
- Consumes: the `devtoberfest_reader` container role already granted in `db/src/devtoberfest-grants.hdbgrants` (grants the whole reader role, so the new view is covered — no grants change needed).
- Produces: synonym `EXTERNAL_DEVTOBERFEST_ACTIVITY` → `devtoberfest-planner-db/schema.DTF_ACTIVITY_V1`, consumed by the Task 3 facade.

- [ ] **Step 1: Create the synonym declaration**

`db/src/EXTERNAL_DEVTOBERFEST_ACTIVITY.hdbsynonym`:
```json
{
  "EXTERNAL_DEVTOBERFEST_ACTIVITY": {}
}
```

- [ ] **Step 2: Create the synonym config pointing at the planner view**

`db/src/EXTERNAL_DEVTOBERFEST_ACTIVITY.hdbsynonymconfig`:
```json
{
  "EXTERNAL_DEVTOBERFEST_ACTIVITY": {
    "target": {
      "schema.configure": "devtoberfest-planner-db/schema",
      "object": "DTF_ACTIVITY_V1"
    }
  }
}
```

- [ ] **Step 3: Verify the grants already cover the new view**

Read `db/src/devtoberfest-grants.hdbgrants` and confirm it grants the `devtoberfest_reader` container role (not per-object grants). It does (`container_roles: ["devtoberfest_reader"]`), so `DTF_ACTIVITY_V1` is covered. No change needed.

- [ ] **Step 4: Commit**

```bash
git add db/src/EXTERNAL_DEVTOBERFEST_ACTIVITY.hdbsynonym db/src/EXTERNAL_DEVTOBERFEST_ACTIVITY.hdbsynonymconfig
git commit -m "feat(devtoberfest): add cross-container synonym for DTF_ACTIVITY_V1"
```

---

### Task 3: Refresh the `Session` facade & add the `Activity` facade

**Files:**
- Modify: `db/external/devtoberfest.cds:44-72` (Session), and add a new `Activity` entity.

**Interfaces:**
- Consumes: the synonym from Task 2; the live column contract from Task 1.
- Produces: `external.devtoberfest.Session` with `ACTIVITY_ID` (no `TUTORIAL_*`); `external.devtoberfest.Activity` with `POINTS`, `WEEK`, `TASKTYPE`, `TASKSLUG`, `TASKTITLE`, `TASK_ID`, `TRACK_ID`, `STATUS`, `TITLE`. Consumed by `DevtoberfestService` (Task 4) and the feed helper (Task 5).

- [ ] **Step 1: Replace the stale Session tail (lines 69-71) with the Activity link**

In `db/external/devtoberfest.cds`, in `entity Session`, remove:
```cds
      TUTORIALSLUG          : String(255);
      TUTORIALTITLE         : String(255);
      TUTORIAL_ID           : String(36);
```
and replace with:
```cds
      ACTIVITY_ID           : String(36);
```
(If Task 1 found `DTF_SESSION_V1` still carries `TUTORIAL_*` in addition to `ACTIVITY_ID`, keep whichever the live view actually exposes — the deployed contract wins.)

- [ ] **Step 2: Add the Activity facade**

After the `Session` entity, add (adjust names to Task 1's confirmed contract):
```cds
@cds.persistence.exists
entity Activity {
  key ID                    : String(36);
      CREATEDAT             : Timestamp;
      CREATEDBY             : String(255);
      MODIFIEDAT            : Timestamp;
      MODIFIEDBY            : String(255);
      TITLE                 : String(200);
      TRACK_ID              : String(36);
      STATUS                : String(5000);
      WEEK                  : String(5000);
      POINTS                : Integer;
      TASK_ID               : String(36);
      TASKTYPE              : String(20);
      TASKSLUG              : String(255);
      TASKTITLE             : String(255);
}
```

- [ ] **Step 3: Compile the model to catch errors**

Run: `cd db && npx cds compile external/devtoberfest.cds` (or from repo root `npx cds compile db/external/devtoberfest.cds`)
Expected: compiles with no error; `Activity` and `Session` resolve.

- [ ] **Step 4: Commit**

```bash
git add db/external/devtoberfest.cds
git commit -m "feat(devtoberfest): refresh Session facade + add Activity facade for DTF_*_V1"
```

---

### Task 4: Expose Activity on `DevtoberfestService` (authenticated) + add an anonymous read pass-through note

**Files:**
- Modify: `srv/devtoberfest-service.cds:10` area — add the `Activity` projection.

**Interfaces:**
- Consumes: `ext.Activity` from Task 3.
- Produces: `DevtoberfestService.Activity` (`@requires:'authenticated-user'`, inherited) — used by the feed helper's DB reads (the helper connects to `db`, so it reads the facades directly; this projection is for admin/debug parity and OData access).

- [ ] **Step 1: Add the Activity projection**

In `srv/devtoberfest-service.cds`, after the `Session` line, add:
```cds
  @readonly entity Activity as projection on ext.Activity;
```

- [ ] **Step 2: Compile**

Run: `npx cds compile srv --to sql` (from repo root)
Expected: no error; `DevtoberfestService.Activity` present.

- [ ] **Step 3: Commit**

```bash
git add srv/devtoberfest-service.cds
git commit -m "feat(devtoberfest): expose Activity projection on DevtoberfestService"
```

---

### Task 5: Feed-assembly + completion-merge helper (pure, unit-tested)

**Files:**
- Create: `srv/lib/devtoberfest-feed.js`
- Test: `test/unit/devtoberfest-feed.test.js`

**Interfaces:**
- Produces:
  - `assembleFeed({ sessions, activities, tracks, editions, activeEditionId })` → `{ editions: [...], activeEditionId, sessions: [...], activities: [...] }` — pure shaping (maps track name/day, keeps only serializable fields, sorts).
  - `completedActivityPoints(activities, completedSlugSet)` → `{ earnedPoints, maxPoints, completedActivityIds: string[] }` — sums `POINTS` for activities whose `TASKSLUG.toLowerCase()` ∈ set, counted once each.
  - `normalizeSlugSet(rows)` → `Set<string>` of lowercased slugs from completion rows (`{ slug }` or `{ TASKSLUG }`).

- [ ] **Step 1: Write the failing test**

`test/unit/devtoberfest-feed.test.js`:
```js
import { describe, it, expect } from 'vitest';
import { assembleFeed, completedActivityPoints, normalizeSlugSet } from '../../srv/lib/devtoberfest-feed.js';

describe('devtoberfest-feed', () => {
  const tracks = [{ ID: 't1', NAME: 'ABAP', DAYOFWEEK: 'Monday' }];
  const sessions = [{ ID: 's1', TITLE: 'Intro', TRACK_ID: 't1', WEEK: '1', SCHEDULEDDATE: '2026-10-05', YOUTUBEURL: 'https://youtu.be/abc', ACTIVITY_ID: 'a1' }];
  const activities = [
    { ID: 'a1', TITLE: 'Do Intro', WEEK: '1', POINTS: 500, TASKTYPE: 'TUTORIAL', TASKSLUG: 'Intro-Slug', TRACK_ID: 't1' },
    { ID: 'a2', TITLE: 'Puzzle', WEEK: '1', POINTS: 300, TASKTYPE: 'PUZZLE', TASKSLUG: 'puz-1', TRACK_ID: 't1' },
  ];

  it('assembleFeed maps track name/day and keeps active edition', () => {
    const out = assembleFeed({ sessions, activities, tracks, editions: [{ ID: 'e1', NAME: '2026', ISCURRENT: true }], activeEditionId: 'e1' });
    expect(out.activeEditionId).toBe('e1');
    expect(out.sessions[0].trackName).toBe('ABAP');
    expect(out.sessions[0].trackDay).toBe('Monday');
    expect(out.activities).toHaveLength(2);
  });

  it('normalizeSlugSet lowercases and dedupes', () => {
    const set = normalizeSlugSet([{ slug: 'Intro-Slug' }, { TASKSLUG: 'PUZ-1' }]);
    expect(set.has('intro-slug')).toBe(true);
    expect(set.has('puz-1')).toBe(true);
  });

  it('completedActivityPoints sums points for completed slugs, counted once', () => {
    const set = normalizeSlugSet([{ slug: 'intro-slug' }]);
    const r = completedActivityPoints(activities, set);
    expect(r.earnedPoints).toBe(500);
    expect(r.maxPoints).toBe(800);
    expect(r.completedActivityIds).toEqual(['a1']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/devtoberfest-feed.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

`srv/lib/devtoberfest-feed.js`:
```js
// Pure helpers for the public Devtoberfest schedule feed. No cds/db access here
// so they are trivially unit-testable; the route module does the DB reads.

function normalizeSlugSet(rows) {
  const set = new Set();
  for (const r of rows || []) {
    const slug = r.slug ?? r.TASKSLUG ?? r.taskSlug;
    if (slug) set.add(String(slug).toLowerCase());
  }
  return set;
}

function assembleFeed({ sessions = [], activities = [], tracks = [], editions = [], activeEditionId = null }) {
  const trackById = new Map(tracks.map((t) => [t.ID, t]));
  const mapTrack = (id) => trackById.get(id) || {};
  return {
    activeEditionId,
    editions: editions
      .map((e) => ({ id: e.ID, name: e.NAME, year: e.YEAR, isCurrent: !!e.ISCURRENT, startDate: e.STARTDATE, endDate: e.ENDDATE }))
      .sort((a, b) => String(b.year || '').localeCompare(String(a.year || ''))),
    sessions: sessions
      .map((s) => ({
        id: s.ID, kind: 'session', title: s.TITLE, abstract: s.ABSTRACT,
        trackId: s.TRACK_ID, trackName: mapTrack(s.TRACK_ID).NAME || '', trackDay: mapTrack(s.TRACK_ID).DAYOFWEEK || '',
        week: s.WEEK, scheduledDate: s.SCHEDULEDDATE, scheduledTime: s.SCHEDULEDTIME,
        youtubeUrl: s.YOUTUBEURL || '', communityEventUrl: s.COMMUNITYEVENTURL || '',
        activityId: s.ACTIVITY_ID || null, status: s.STATUS,
      }))
      .sort(sortByWeekThenDate),
    activities: activities
      .map((a) => ({
        id: a.ID, kind: 'activity', title: a.TITLE, week: a.WEEK, points: a.POINTS || 0,
        trackId: a.TRACK_ID, trackName: mapTrack(a.TRACK_ID).NAME || '',
        taskType: a.TASKTYPE, taskSlug: a.TASKSLUG, taskTitle: a.TASKTITLE, taskId: a.TASK_ID, status: a.STATUS,
      }))
      .sort(sortByWeekThenTitle),
  };
}

function completedActivityPoints(activities = [], completedSlugSet = new Set()) {
  let earnedPoints = 0;
  let maxPoints = 0;
  const completedActivityIds = [];
  for (const a of activities) {
    const pts = a.POINTS || a.points || 0;
    maxPoints += pts;
    const slug = (a.TASKSLUG || a.taskSlug || '').toLowerCase();
    if (slug && completedSlugSet.has(slug)) {
      earnedPoints += pts;
      completedActivityIds.push(a.ID || a.id);
    }
  }
  return { earnedPoints, maxPoints, completedActivityIds };
}

function sortByWeekThenDate(a, b) {
  const w = String(a.week || '').localeCompare(String(b.week || ''));
  return w !== 0 ? w : String(a.scheduledDate || '').localeCompare(String(b.scheduledDate || ''));
}
function sortByWeekThenTitle(a, b) {
  const w = String(a.week || '').localeCompare(String(b.week || ''));
  return w !== 0 ? w : String(a.title || '').localeCompare(String(b.title || ''));
}

module.exports = { assembleFeed, completedActivityPoints, normalizeSlugSet };
```
Note: if the repo's `srv/lib` uses ESM (`export`) rather than CommonJS, match the surrounding files' style — check a neighbor like `srv/lib/resolve-db-user.js` and mirror its `export`/`module.exports` convention. (Task 1 of executing: verify and adapt.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/devtoberfest-feed.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add srv/lib/devtoberfest-feed.js test/unit/devtoberfest-feed.test.js
git commit -m "feat(devtoberfest): pure feed-assembly + completion-merge helpers"
```

---

### Task 6: Public `/api/devtoberfest/schedule` + authed `/api/devtoberfest/my-completions` routes

**Files:**
- Create: `srv/routes/devtoberfest-schedule.js`
- Modify: `srv/server.js:34` (import) and `:372` area (register)
- Test: `test/unit/devtoberfest-schedule-route.test.js`

**Interfaces:**
- Consumes: `assembleFeed`, `completedActivityPoints`, `normalizeSlugSet` (Task 5); `external.devtoberfest.{Session,Activity,Track,Edition}` (Tasks 3-4); `resolveUser` (`srv/lib/resolve-user.js`), `resolveUserSapId` (`srv/lib/resolve-db-user.js`), `getMyCompletedTutorials`/`getMyCompletions` pattern (`srv/lib/user-progress.js`).
- Produces:
  - `GET /api/devtoberfest/schedule?edition=<id>` (anonymous) → `assembleFeed(...)` JSON for the requested edition (default = current). 503 `EVENT_NOT_CONFIGURED` if no edition resolvable.
  - `GET /api/devtoberfest/my-completions?edition=<id>` (authed) → `{ authenticated, completedSlugs: string[], earnedPoints, maxPoints, completedActivityIds }`; `{ authenticated:false }` for anonymous (200, not 401).
  - `register(app)` — mirrors `devtoberfest-public.js`.

- [ ] **Step 1: Write the failing test**

`test/unit/devtoberfest-schedule-route.test.js`:
```js
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

// Boot the CAP server in-memory and hit the express routes.
describe('devtoberfest schedule route', () => {
  let GET;
  beforeAll(async () => {
    const test = cds.test('serve', '--project', '.', '--in-memory');
    ({ GET } = test);
    await test;
  });

  it('GET /api/devtoberfest/schedule is anonymous-accessible and returns the feed shape', async () => {
    const { status, data } = await GET('/api/devtoberfest/schedule').catch((e) => e.response || { status: e.code });
    // Either 200 with the shape, or 503 EVENT_NOT_CONFIGURED when no edition is seeded in the unit DB.
    expect([200, 503]).toContain(status);
    if (status === 200) {
      expect(data).toHaveProperty('sessions');
      expect(data).toHaveProperty('activities');
      expect(data).toHaveProperty('editions');
    }
  });

  it('GET /api/devtoberfest/my-completions returns authenticated:false for anonymous', async () => {
    const { status, data } = await GET('/api/devtoberfest/my-completions').catch((e) => e.response || { status: e.code });
    expect(status).toBe(200);
    expect(data.authenticated).toBe(false);
  });
});
```
(Note: the cross-container facades won't resolve against in-memory SQLite; the route must fail **soft** — wrap the facade reads in try/catch and return 503 or empty arrays when the entity is unavailable, so the unit DB returns a valid shape. The real read is exercised by the hybrid test in Task 7.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/devtoberfest-schedule-route.test.js`
Expected: FAIL — routes not registered / module missing.

- [ ] **Step 3: Implement the route module**

`srv/routes/devtoberfest-schedule.js`:
```js
// Public + authed read endpoints for the dynamic Devtoberfest schedule pages.
//   GET /api/devtoberfest/schedule?edition=<id>   (anonymous) -> feed
//   GET /api/devtoberfest/my-completions?edition=<id> (authed) -> completions+points
// Reads the cross-container planner facades (external.devtoberfest.*). Fails
// soft (503 / empty) when the facades are unavailable (e.g. unit SQLite).
import cds from '@sap/cds';
import { assembleFeed, completedActivityPoints, normalizeSlugSet } from '../lib/devtoberfest-feed.js';
import { resolveUser } from '../lib/resolve-user.js';
import { resolveUserSapId } from '../lib/resolve-db-user.js';

const LOG = cds.log('devtoberfest');

async function resolveEditionId(ext, requested) {
  if (requested) return requested;
  try {
    const cur = await SELECT.one.from(ext.Edition).columns('ID').where({ ISCURRENT: true });
    return cur?.ID || null;
  } catch { return null; }
}

async function scheduleHandler(req, res) {
  try {
    await cds.connect.to('db');
    const ext = cds.entities('external.devtoberfest');
    if (!ext?.Session || !ext?.Activity) return res.status(503).json({ error: 'EVENT_NOT_CONFIGURED' });

    const editionId = await resolveEditionId(ext, req.query.edition);
    // Tracks scope both sessions and activities to an edition.
    const tracks = editionId
      ? await SELECT.from(ext.Track).where({ EDITION_ID: editionId })
      : await SELECT.from(ext.Track);
    const trackIds = tracks.map((t) => t.ID);
    const editions = await SELECT.from(ext.Edition);

    const sessions = trackIds.length ? await SELECT.from(ext.Session).where({ TRACK_ID: { in: trackIds } }) : [];
    const activities = trackIds.length ? await SELECT.from(ext.Activity).where({ TRACK_ID: { in: trackIds } }) : [];

    return res.status(200).json(assembleFeed({ sessions, activities, tracks, editions, activeEditionId: editionId }));
  } catch (err) {
    LOG.error('GET /api/devtoberfest/schedule failed:', err);
    return res.status(500).json({ error: 'INTERNAL' });
  }
}

async function myCompletionsHandler(req, res) {
  try {
    await cds.connect.to('db');
    const user = resolveUser(req, cds);
    const sapId = user ? resolveUserSapId(user) : null;
    if (!sapId) return res.status(200).json({ authenticated: false });

    const ims = cds.entities('com.sap.developers.ims');
    const dbUser = await SELECT.one.from(ims.Users).columns('ID').where({ sapId });
    if (!dbUser) return res.status(200).json({ authenticated: true, completedSlugs: [], earnedPoints: 0, maxPoints: 0, completedActivityIds: [] });

    // Completed TUTORIAL + PUZZLE records, resolved to slugs via the Tasks view.
    const records = await SELECT.from(ims.TaskRecords)
      .columns('taskLegacyId', 'taskType')
      .where({ user_ID: dbUser.ID, status: 'COMPLETED', taskType: { in: ['TUTORIAL', 'PUZZLE'] } });
    const legacyIds = records.map((r) => r.taskLegacyId);
    const tasks = legacyIds.length
      ? await SELECT.from(ims.Tasks).columns('slug', 'legacyId').where({ legacyId: { in: legacyIds } })
      : [];
    const completedSlugSet = normalizeSlugSet(tasks);

    const ext = cds.entities('external.devtoberfest');
    let activities = [];
    try { if (ext?.Activity) activities = await SELECT.from(ext.Activity).columns('ID', 'POINTS', 'TASKSLUG'); } catch { /* facade unavailable */ }
    const { earnedPoints, maxPoints, completedActivityIds } = completedActivityPoints(activities, completedSlugSet);

    return res.status(200).json({ authenticated: true, completedSlugs: [...completedSlugSet], earnedPoints, maxPoints, completedActivityIds });
  } catch (err) {
    LOG.error('GET /api/devtoberfest/my-completions failed:', err);
    return res.status(500).json({ error: 'INTERNAL' });
  }
}

export function register(app) {
  const _contextMw = cds.middlewares?.context?.() || ((req, _res, next) => next());
  const _authMw = cds.middlewares?.auth?.() || ((req, _res, next) => next());
  app.get('/api/devtoberfest/schedule', _contextMw, _authMw, scheduleHandler);
  app.get('/api/devtoberfest/my-completions', _contextMw, _authMw, myCompletionsHandler);
}

export { scheduleHandler, myCompletionsHandler };
```
Note: confirm `ims.Tasks` exposes `slug` + `legacyId` (per `db/views.cds` union view); if the completion→slug join is done elsewhere (e.g. `srv/lib/user-progress.js` `getMyCompletedTutorials`), prefer reusing that helper instead of re-querying `Tasks`. Adapt during execution.

- [ ] **Step 4: Register the route module in server.js**

In `srv/server.js`, after line 34 add:
```js
import * as devtoberfestSchedule from './routes/devtoberfest-schedule.js';
```
and after line 372 (`devtoberfestPublic.register(app);`) add:
```js
  devtoberfestSchedule.register(app);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/unit/devtoberfest-schedule-route.test.js`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add srv/routes/devtoberfest-schedule.js srv/server.js test/unit/devtoberfest-schedule-route.test.js
git commit -m "feat(devtoberfest): public schedule feed + authed my-completions routes"
```

---

### Task 7: Approuter routes + public-endpoint guard

**Files:**
- Modify: `approuter/xs-app.json:130-140` (extend the devtoberfest route groups)
- Verify/extend: `test/unit/check-public-endpoints.test.ts`

**Interfaces:**
- Consumes: the two routes from Task 6.
- Produces: `/api/devtoberfest/schedule` (none) and `/api/devtoberfest/my-completions` (xsuaa) reachable through the approuter; guard test green.

- [ ] **Step 1: Add `schedule` to the public group and `my-completions` to the xsuaa group**

In `approuter/xs-app.json`, change the public route (line 130) source to include `schedule`:
```json
    {
      "source": "^/api/devtoberfest/(status|terms|banner|schedule)$",
      "target": "/api/devtoberfest/$1",
      "destination": "srv-api",
      "authenticationType": "none"
    },
```
and the xsuaa route (line 136) to include `my-completions`:
```json
    {
      "source": "^/api/devtoberfest/(join|me|my-completions)$",
      "target": "/api/devtoberfest/$1",
      "destination": "srv-api",
      "authenticationType": "xsuaa"
    },
```
The `srv-api` destination already sets `forwardAuthToken: true`, so the JWT reaches the authed handler.

- [ ] **Step 2: Run the public-endpoint guard test**

Run: `npx vitest run test/unit/check-public-endpoints.test.ts`
Expected: PASS — the new `schedule` public endpoint has a matching anonymous route and is not shadowed. (The guard keys off `@requires:'any'` CDS services; since our public feed is an Express route, confirm the guard's route-coverage check still passes. If the guard only inspects CDS services, no change is needed; if it also asserts route ordering, ensure `schedule` sits before any broader `/api/*` route.)

- [ ] **Step 3: Commit**

```bash
git add approuter/xs-app.json
git commit -m "feat(devtoberfest): approuter routes for schedule (public) + my-completions (xsuaa)"
```

- [ ] **Step 4: (Deferred) hybrid smoke of the live feed**

After deploy to DEV (not in this task's commit), verify the facades actually read the deployed views:
```bash
curl -s "$APPROUTER_URL/api/devtoberfest/schedule" | jq '{editions: (.editions|length), sessions: (.sessions|length), activities: (.activities|length)}'
```
Expected: non-empty counts for the active edition. This is the real cross-container check (guards the UPPERCASE/facade gotchas); record the result in the PR.

---

### Task 8: Shared island module (types, feed, completion, youtube, auth, UI primitives)

**Files:**
- Create: `hugo-apps/src/devtoberfest-schedule-shared/types.ts`
- Create: `hugo-apps/src/devtoberfest-schedule-shared/feed.ts`
- Create: `hugo-apps/src/devtoberfest-schedule-shared/completion.ts`
- Create: `hugo-apps/src/devtoberfest-schedule-shared/youtube.ts`
- Create: `hugo-apps/src/devtoberfest-schedule-shared/useAuth.ts`
- Create: `hugo-apps/src/devtoberfest-schedule-shared/EditionPicker.vue`
- Create: `hugo-apps/src/devtoberfest-schedule-shared/PointsBanner.vue`
- Create: `hugo-apps/src/devtoberfest-schedule-shared/DetailPanel.vue`
- Test: `hugo-apps/src/devtoberfest-schedule-shared/__tests__/shared.test.ts`

**Interfaces:**
- Produces:
  - `types.ts` — `Session`, `Activity`, `Edition`, `Feed`, `MyCompletions`, `ScheduleRow` types.
  - `feed.ts` — `fetchFeed(editionId?: string): Promise<Feed>`, `fetchMyCompletions(editionId?: string): Promise<MyCompletions>` (both same-origin, `credentials:'include'`, `{value:[]}`-safe / plain-JSON).
  - `completion.ts` — `youtubeThumb(url: string): string | null`; `mergeCompletion(feed, my): { rows: ScheduleRow[]; earnedPoints; maxPoints; completedActivityIds: Set<string> }`; a session is complete when its `activityId`'s activity is in `completedActivityIds`.
  - `youtube.ts` — `youtubeId(url: string): string | null` (handles `youtu.be/ID`, `watch?v=ID`, `embed/ID`).
  - `useAuth.ts` — `useAuth(): { isAuthenticated: Ref<boolean> }` reading `document.documentElement.dataset.authenticated` + listening for `auth-resolved`.
  - `EditionPicker.vue`, `PointsBanner.vue`, `DetailPanel.vue` — presentational components.

- [ ] **Step 1: Write the failing test (pure helpers)**

`hugo-apps/src/devtoberfest-schedule-shared/__tests__/shared.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { youtubeId } from '../youtube';
import { youtubeThumb, mergeCompletion } from '../completion';

describe('youtube helpers', () => {
  it('extracts id from youtu.be, watch, embed', () => {
    expect(youtubeId('https://youtu.be/abc123')).toBe('abc123');
    expect(youtubeId('https://www.youtube.com/watch?v=xyz789&t=1')).toBe('xyz789');
    expect(youtubeId('https://www.youtube.com/embed/def456')).toBe('def456');
    expect(youtubeId('')).toBeNull();
    expect(youtubeId('https://example.com')).toBeNull();
  });
  it('thumb returns hqdefault url or null', () => {
    expect(youtubeThumb('https://youtu.be/abc123')).toBe('https://img.youtube.com/vi/abc123/hqdefault.jpg');
    expect(youtubeThumb('nope')).toBeNull();
  });
});

describe('mergeCompletion', () => {
  const feed = {
    activeEditionId: 'e1', editions: [],
    sessions: [{ id: 's1', kind: 'session', title: 'S', activityId: 'a1', week: '1' }],
    activities: [
      { id: 'a1', kind: 'activity', title: 'A1', points: 500, taskSlug: 'slug-a', week: '1' },
      { id: 'a2', kind: 'activity', title: 'A2', points: 300, taskSlug: 'slug-b', week: '1' },
    ],
  } as any;

  it('marks sessions+activities complete and totals points', () => {
    const my = { authenticated: true, completedSlugs: ['slug-a'], earnedPoints: 500, maxPoints: 800, completedActivityIds: ['a1'] } as any;
    const out = mergeCompletion(feed, my);
    expect(out.earnedPoints).toBe(500);
    expect(out.maxPoints).toBe(800);
    const session = out.rows.find((r) => r.id === 's1')!;
    expect(session.complete).toBe(true); // via linked activity a1
    const a2 = out.rows.find((r) => r.id === 'a2')!;
    expect(a2.complete).toBe(false);
  });

  it('anonymous merge leaves everything incomplete', () => {
    const out = mergeCompletion(feed, { authenticated: false } as any);
    expect(out.rows.every((r) => !r.complete)).toBe(true);
    expect(out.earnedPoints).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd hugo-apps && npx vitest run src/devtoberfest-schedule-shared/__tests__/shared.test.ts`
Expected: FAIL — modules missing.

- [ ] **Step 3: Implement `youtube.ts`**

```ts
export function youtubeId(url: string): string | null {
  if (!url) return null;
  const m = url.match(/(?:youtu\.be\/|[?&]v=|\/embed\/)([\w-]{6,})/);
  return m ? m[1] : null;
}
```

- [ ] **Step 4: Implement `completion.ts`**

```ts
import { youtubeId } from './youtube';
import type { Feed, MyCompletions, ScheduleRow } from './types';

export function youtubeThumb(url: string): string | null {
  const id = youtubeId(url);
  return id ? `https://img.youtube.com/vi/${id}/hqdefault.jpg` : null;
}

export function mergeCompletion(feed: Feed, my: MyCompletions) {
  const completedActivityIds = new Set<string>(my?.authenticated ? my.completedActivityIds || [] : []);
  const completedSlugs = new Set<string>((my?.authenticated ? my.completedSlugs || [] : []).map((s) => s.toLowerCase()));

  const activityRows: ScheduleRow[] = feed.activities.map((a) => ({
    ...a,
    complete: completedActivityIds.has(a.id) || (!!a.taskSlug && completedSlugs.has(a.taskSlug.toLowerCase())),
  }));
  const sessionRows: ScheduleRow[] = feed.sessions.map((s) => ({
    ...s,
    complete: !!s.activityId && completedActivityIds.has(s.activityId),
  }));

  return {
    rows: [...sessionRows, ...activityRows],
    earnedPoints: my?.authenticated ? my.earnedPoints || 0 : 0,
    maxPoints: my?.authenticated ? my.maxPoints || feed.activities.reduce((n, a) => n + (a.points || 0), 0) : feed.activities.reduce((n, a) => n + (a.points || 0), 0),
    completedActivityIds,
  };
}
```

- [ ] **Step 5: Implement `types.ts`, `feed.ts`, `useAuth.ts` and the three `.vue` primitives**

`types.ts`:
```ts
export interface Edition { id: string; name: string; year?: string; isCurrent: boolean; startDate?: string; endDate?: string }
export interface Session { id: string; kind: 'session'; title: string; abstract?: string; trackId?: string; trackName?: string; trackDay?: string; week?: string; scheduledDate?: string; scheduledTime?: string; youtubeUrl?: string; communityEventUrl?: string; activityId?: string | null; status?: string }
export interface Activity { id: string; kind: 'activity'; title: string; week?: string; points: number; trackId?: string; trackName?: string; taskType?: string; taskSlug?: string; taskTitle?: string; taskId?: string; status?: string }
export interface Feed { activeEditionId: string | null; editions: Edition[]; sessions: Session[]; activities: Activity[] }
export interface MyCompletions { authenticated: boolean; completedSlugs?: string[]; earnedPoints?: number; maxPoints?: number; completedActivityIds?: string[] }
export type ScheduleRow = (Session | Activity) & { complete?: boolean };
```
`feed.ts`:
```ts
import type { Feed, MyCompletions } from './types';
const opts: RequestInit = { headers: { Accept: 'application/json' }, credentials: 'include' };
export async function fetchFeed(editionId?: string): Promise<Feed> {
  const q = editionId ? `?edition=${encodeURIComponent(editionId)}` : '';
  const r = await fetch(`/api/devtoberfest/schedule${q}`, opts);
  if (!r.ok) throw new Error(`schedule ${r.status}`);
  return r.json();
}
export async function fetchMyCompletions(editionId?: string): Promise<MyCompletions> {
  try {
    const q = editionId ? `?edition=${encodeURIComponent(editionId)}` : '';
    const r = await fetch(`/api/devtoberfest/my-completions${q}`, opts);
    if (!r.ok) return { authenticated: false };
    return r.json();
  } catch { return { authenticated: false }; }
}
```
`useAuth.ts`:
```ts
import { ref, onMounted, onUnmounted, type Ref } from 'vue';
export function useAuth(): { isAuthenticated: Ref<boolean> } {
  const isAuthenticated = ref(document.documentElement.dataset.authenticated === 'true');
  const onResolved = () => { isAuthenticated.value = document.documentElement.dataset.authenticated === 'true'; };
  onMounted(() => document.addEventListener('auth-resolved', onResolved));
  onUnmounted(() => document.removeEventListener('auth-resolved', onResolved));
  return { isAuthenticated };
}
```
For `EditionPicker.vue` (emits `update:edition`), `PointsBanner.vue` (props `earnedPoints`, `maxPoints`, `completeCount`, `isAuthenticated`; shows sign-in prompt when not authed), and `DetailPanel.vue` (props `row: ScheduleRow | null`; drawer with title/abstract/track/week/date/time/points/taskType + links to YouTube, community event, and task URL `/tutorials/<slug>` or `/puzzles/<slug>`) — follow the styling of `hugo-apps/src/advocates/App.vue` (SAP CSS vars) and use `ui5-illustrated-message` for empty states (registered in `ui5-bootstrap.ts`). Keep them presentational (no fetch).

- [ ] **Step 6: Run to verify it passes**

Run: `cd hugo-apps && npx vitest run src/devtoberfest-schedule-shared/__tests__/shared.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add hugo-apps/src/devtoberfest-schedule-shared
git commit -m "feat(devtoberfest): shared island module (feed, completion, youtube, auth, UI primitives)"
```

---

### Task 9: Unified Schedule table island + Hugo page

**Files:**
- Create: `hugo-apps/src/devtoberfest-schedule/main.ts`, `App.vue`
- Modify: `hugo-apps/vite.config.ts` (add input `'devtoberfest-schedule'`)
- Create: `hugo/content/devtoberfest/schedule/_index.md`, `hugo/layouts/devtoberfest/schedule.html`
- Test: `hugo-apps/src/devtoberfest-schedule/__tests__/App.test.ts`

**Interfaces:**
- Consumes: everything from Task 8.
- Produces: `/devtoberfest/schedule/` page rendering the unified table.

- [ ] **Step 1: Write the failing component test**

`hugo-apps/src/devtoberfest-schedule/__tests__/App.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import App from '../App.vue';

const feed = {
  activeEditionId: 'e1',
  editions: [{ id: 'e1', name: '2026', isCurrent: true }],
  sessions: [{ id: 's1', kind: 'session', title: 'Intro Session', trackName: 'ABAP', week: '1', scheduledDate: '2026-10-05', activityId: 'a1' }],
  activities: [{ id: 'a1', kind: 'activity', title: 'Do Intro', trackName: 'ABAP', week: '1', points: 500, taskType: 'TUTORIAL', taskSlug: 'intro' }],
};

beforeEach(() => {
  global.fetch = vi.fn((url: string) =>
    Promise.resolve({
      ok: true,
      json: () => Promise.resolve(String(url).includes('my-completions') ? { authenticated: false } : feed),
    } as any),
  ) as any;
});

describe('Schedule table', () => {
  it('renders both a session row and an activity row', async () => {
    const wrapper = mount(App);
    await flushPromises();
    expect(wrapper.text()).toContain('Intro Session');
    expect(wrapper.text()).toContain('Do Intro');
    expect(wrapper.text()).toContain('500');
  });

  it('filters by week', async () => {
    const wrapper = mount(App);
    await flushPromises();
    // both rows are week 1 → filtering to a non-existent week hides them
    await wrapper.vm.$nextTick();
    (wrapper.vm as any).filters.week = '9';
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).not.toContain('Intro Session');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd hugo-apps && npx vitest run src/devtoberfest-schedule/__tests__/App.test.ts`
Expected: FAIL — App.vue missing.

- [ ] **Step 3: Implement `App.vue`**

Build on the `me/AllCompletions.vue` table pattern: `onMounted` → `fetchFeed()` then `fetchMyCompletions()` → `mergeCompletion` → `rows`. Reactive `filters` (`week`, `type`, `track`, `q`), `filtered` computed, sortable `<th><button>` headers, `<table>` with columns Type · Title · Track · Week · Date/Time · Points · Links · Status(✓ when `row.complete` && authed). Include `<EditionPicker>`, `<PointsBanner>`, `<DetailPanel>` (opened on row click). Loading/error/empty states via `ui5-illustrated-message`. Expose `filters` on the instance for the test.

- [ ] **Step 4: Implement `main.ts`**

```ts
import { createApp } from 'vue';
import App from './App.vue';
const mount = document.getElementById('devtoberfest-schedule-mount');
if (mount) createApp(App).mount(mount);
```

- [ ] **Step 5: Register the Vite input**

In `hugo-apps/vite.config.ts` `rollupOptions.input`, add:
```ts
        'devtoberfest-schedule': resolve(__dirname, 'src/devtoberfest-schedule/main.ts'),
```

- [ ] **Step 6: Create the Hugo content + layout**

`hugo/content/devtoberfest/schedule/_index.md`:
```markdown
---
title: "Devtoberfest Schedule"
type: "devtoberfest"
layout: "schedule"
---
```
`hugo/layouts/devtoberfest/schedule.html` (model on `hugo/layouts/devtoberfest/gameboard.html`):
```html
{{ define "main" }}
<main id="devtoberfest-schedule-mount"></main>
<noscript>The Devtoberfest schedule requires JavaScript.</noscript>
<script type="module" src="{{ "/js/devtoberfest-schedule.js" | relURL }}?v={{ now.Unix }}"></script>
{{ end }}
```

- [ ] **Step 7: Run to verify it passes**

Run: `cd hugo-apps && npx vitest run src/devtoberfest-schedule/__tests__/App.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add hugo-apps/src/devtoberfest-schedule hugo-apps/vite.config.ts hugo/content/devtoberfest/schedule hugo/layouts/devtoberfest/schedule.html
git commit -m "feat(devtoberfest): unified schedule table island + /devtoberfest/schedule page"
```

---

### Task 10: Sessions Grid island + Hugo page

**Files:**
- Create: `hugo-apps/src/devtoberfest-sessions-grid/main.ts`, `App.vue`
- Modify: `hugo-apps/vite.config.ts` (add input)
- Create: `hugo/content/devtoberfest/sessions/_index.md`, `hugo/layouts/devtoberfest/sessions.html`
- Test: `hugo-apps/src/devtoberfest-sessions-grid/__tests__/App.test.ts`

**Interfaces:**
- Consumes: Task 8 module.
- Produces: `/devtoberfest/sessions/` card grid with YouTube thumbnails.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import App from '../App.vue';

const feed = {
  activeEditionId: 'e1', editions: [{ id: 'e1', name: '2026', isCurrent: true }],
  sessions: [
    { id: 's1', kind: 'session', title: 'With Video', week: '1', youtubeUrl: 'https://youtu.be/abc123', communityEventUrl: 'https://community.sap.com/x' },
    { id: 's2', kind: 'session', title: 'No Video', week: '1', youtubeUrl: '' },
  ],
  activities: [],
};
beforeEach(() => {
  global.fetch = vi.fn((url: string) => Promise.resolve({ ok: true, json: () => Promise.resolve(String(url).includes('my-completions') ? { authenticated: false } : feed) } as any)) as any;
});

describe('Sessions grid', () => {
  it('renders a card per session with a youtube thumbnail when available', async () => {
    const wrapper = mount(App);
    await flushPromises();
    expect(wrapper.text()).toContain('With Video');
    expect(wrapper.text()).toContain('No Video');
    const imgs = wrapper.findAll('img').map((i) => i.attributes('src') || '');
    expect(imgs.some((s) => s.includes('img.youtube.com/vi/abc123'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd hugo-apps && npx vitest run src/devtoberfest-sessions-grid/__tests__/App.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `App.vue`**

Model on `homepage-bands/EventsBand.vue` card grid. For each session render a card: thumbnail = `youtubeThumb(session.youtubeUrl)` with an `@error` handler swapping to a placeholder (or a CSS placeholder when null), title, track badge, week, date/time, links (YouTube, community event, linked activity → open `DetailPanel`), completion tick when authed & complete. Include `<EditionPicker>`, `<PointsBanner>`, week/track filters, `<DetailPanel>`. Loading/error/empty states.

- [ ] **Step 4: Implement `main.ts`** (mount id `devtoberfest-sessions-grid-mount`, same shape as Task 9 Step 4).

- [ ] **Step 5: Register the Vite input** `'devtoberfest-sessions-grid': resolve(__dirname, 'src/devtoberfest-sessions-grid/main.ts')`.

- [ ] **Step 6: Create Hugo content + layout** (`hugo/content/devtoberfest/sessions/_index.md` with `layout: "sessions"`; `hugo/layouts/devtoberfest/sessions.html` mounting `/js/devtoberfest-sessions-grid.js`).

- [ ] **Step 7: Run to verify it passes**

Run: `cd hugo-apps && npx vitest run src/devtoberfest-sessions-grid/__tests__/App.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add hugo-apps/src/devtoberfest-sessions-grid hugo-apps/vite.config.ts hugo/content/devtoberfest/sessions hugo/layouts/devtoberfest/sessions.html
git commit -m "feat(devtoberfest): sessions grid island + /devtoberfest/sessions page"
```

---

### Task 11: Sessions Calendar island (data-derived week × weekday grid) + Hugo page

**Files:**
- Create: `hugo-apps/src/devtoberfest-sessions-calendar/calendar-grid.ts` (pure), `main.ts`, `App.vue`
- Modify: `hugo-apps/vite.config.ts` (add input)
- Create: `hugo/content/devtoberfest/calendar/_index.md`, `hugo/layouts/devtoberfest/calendar.html`
- Test: `hugo-apps/src/devtoberfest-sessions-calendar/__tests__/calendar-grid.test.ts`

**Interfaces:**
- Consumes: Task 8 module.
- Produces:
  - `buildCalendar(sessions: Session[]): { weeks: string[]; weekdays: string[]; cells: Record<string, Record<string, Session[]>> }` — rows = distinct `week` values present (sorted), columns = weekdays present derived from `scheduledDate` (ordered Mon→Sun but only those that occur; supports weekend + non-contiguous weeks). NO hardcoded week count or weekday span.
  - `/devtoberfest/calendar/` page.

- [ ] **Step 1: Write the failing test (pure grid builder)**

```ts
import { describe, it, expect } from 'vitest';
import { buildCalendar, weekdayOf } from '../calendar-grid';

describe('buildCalendar', () => {
  it('derives weeks and weekdays from data, omitting empties, supporting non-contiguous weeks + weekend', () => {
    const sessions = [
      { id: '1', week: '1', scheduledDate: '2026-10-05' }, // Monday
      { id: '2', week: '1', scheduledDate: '2026-10-09' }, // Friday
      { id: '3', week: '3', scheduledDate: '2026-10-24' }, // Saturday (weekend), note week 2 absent
    ] as any;
    const cal = buildCalendar(sessions);
    expect(cal.weeks).toEqual(['1', '3']);            // week 2 omitted (non-contiguous)
    expect(cal.weekdays).toEqual(['Monday', 'Friday', 'Saturday']); // only present days, in week order
    expect(cal.cells['1']['Monday'].map((s: any) => s.id)).toEqual(['1']);
    expect(cal.cells['3']['Saturday'].map((s: any) => s.id)).toEqual(['3']);
    expect(cal.cells['1']['Saturday']).toBeUndefined();
  });

  it('weekdayOf returns English weekday name', () => {
    expect(weekdayOf('2026-10-05')).toBe('Monday');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd hugo-apps && npx vitest run src/devtoberfest-sessions-calendar/__tests__/calendar-grid.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `calendar-grid.ts`**

```ts
import type { Session } from '../devtoberfest-schedule-shared/types';

const ORDER = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

export function weekdayOf(date?: string): string | null {
  if (!date) return null;
  const d = new Date(date + 'T00:00:00Z');
  if (isNaN(d.getTime())) return null;
  return ORDER[(d.getUTCDay() + 6) % 7]; // getUTCDay: 0=Sun → shift so Monday=0
}

export function buildCalendar(sessions: Session[]) {
  const weeks = [...new Set(sessions.map((s) => s.week).filter(Boolean) as string[])].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const presentDays = new Set<string>();
  const cells: Record<string, Record<string, Session[]>> = {};
  for (const s of sessions) {
    const wd = weekdayOf(s.scheduledDate);
    if (!s.week || !wd) continue;
    presentDays.add(wd);
    (cells[s.week] ??= {})[wd] ??= [];
    cells[s.week][wd].push(s);
  }
  const weekdays = ORDER.filter((d) => presentDays.has(d));
  return { weeks, weekdays, cells };
}
```

- [ ] **Step 4: Implement `App.vue` + `main.ts`**

`App.vue`: fetch feed + completions, `buildCalendar(sessions)`, render a table/grid with `weeks` as rows and `weekdays` as columns; each cell renders `cells[week][day]` as compact session cards (thumbnail, title, time, completion tick), card click → `DetailPanel`. Include `<EditionPicker>`, `<PointsBanner>`, and a track/type filter. Empty state when `weeks.length === 0`. `main.ts` mounts id `devtoberfest-sessions-calendar-mount`.

- [ ] **Step 5: Register the Vite input** `'devtoberfest-sessions-calendar': resolve(__dirname, 'src/devtoberfest-sessions-calendar/main.ts')`.

- [ ] **Step 6: Create Hugo content + layout** (`hugo/content/devtoberfest/calendar/_index.md` with `layout: "calendar"`; `hugo/layouts/devtoberfest/calendar.html` mounting `/js/devtoberfest-sessions-calendar.js`).

- [ ] **Step 7: Run to verify it passes**

Run: `cd hugo-apps && npx vitest run src/devtoberfest-sessions-calendar/__tests__/calendar-grid.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add hugo-apps/src/devtoberfest-sessions-calendar hugo-apps/vite.config.ts hugo/content/devtoberfest/calendar hugo/layouts/devtoberfest/calendar.html
git commit -m "feat(devtoberfest): sessions calendar island (data-derived grid) + /devtoberfest/calendar page"
```

---

### Task 12: e2e Playwright spec (committed, post-deploy)

**Files:**
- Create: `test/e2e/devtoberfest-schedule.test.js`

**Interfaces:**
- Consumes: the three deployed pages + the public feed.
- Produces: a committed e2e spec that self-skips when `SMOKE_BASE_URL`/`PLAYWRIGHT_BASE_URL` is absent (per the project's e2e convention).

- [ ] **Step 1: Write the spec**

Model on the existing `test/e2e/gameboard.test.js`. Self-skip when no base URL. Cases:
1. Anonymous: `/devtoberfest/schedule/` renders the table with ≥1 row; no points banner / shows sign-in prompt.
2. Anonymous: `/devtoberfest/sessions/` renders ≥1 card; a card with a YouTube URL shows an `img.youtube.com` thumbnail.
3. Anonymous: `/devtoberfest/calendar/` renders a grid with ≥1 week row.
4. Logged-in (via `SMOKE_TECH_USER`/`SMOKE_TECH_PASSWORD` basic auth, as gameboard e2e does): points banner appears; at least the "earned/max" text is present.
5. Public feed: `GET /api/devtoberfest/schedule` returns 200 with `sessions`/`activities`/`editions` keys.

```js
// test/e2e/devtoberfest-schedule.test.js
const { test, expect } = require('@playwright/test');
const BASE = process.env.PLAYWRIGHT_BASE_URL || process.env.SMOKE_BASE_URL;
test.skip(!BASE, 'No base URL; post-deploy only');

test('anonymous schedule table renders rows', async ({ page }) => {
  await page.goto(`${BASE}/devtoberfest/schedule/`);
  await expect(page.locator('table tbody tr').first()).toBeVisible();
});
// ... remaining cases per the list above.
```

- [ ] **Step 2: Run locally (expected skip without base URL)**

Run: `npx playwright test test/e2e/devtoberfest-schedule.test.js`
Expected: SKIPPED (no base URL) — confirms the guard works.

- [ ] **Step 3: Commit**

```bash
git add test/e2e/devtoberfest-schedule.test.js
git commit -m "test(devtoberfest): e2e spec for schedule/sessions/calendar pages (post-deploy)"
```

---

## Self-Review

**Spec coverage:**
- Unified table (sessions+activities, filter/sort) → Task 9 ✓
- Sessions grid + YouTube thumbnails → Task 10 ✓
- Sessions calendar (data-derived week×weekday) → Task 11 ✓
- Completion via linked Activity/Task → Task 5 (`completedActivityPoints`), Task 8 (`mergeCompletion`) ✓
- Per-item points + earned total → Tasks 5, 8, `PointsBanner` ✓
- Edition picker (active + past) → Task 6 (`edition` param), Task 8 (`EditionPicker`) ✓
- Click-to-expand detail panel → Task 8 (`DetailPanel`), used in 9-11 ✓
- Public feed / gated completion split → Tasks 6, 7 ✓
- Refresh stale proxies + Activity facade → Tasks 2, 3, 4 ✓
- Cross-container instance risk → Task 1 gate ✓
- Testing (unit/hybrid/e2e/public-guard) → Tasks 5, 6, 7(hybrid curl), 9-12 ✓

**Placeholder scan:** No "TBD/TODO/handle edge cases" — each code step has real content; the two "adapt to live contract" notes (Task 3, Task 6) are deliberate and gated by Task 1's verification, not hand-waving.

**Type consistency:** `assembleFeed`/`completedActivityPoints`/`normalizeSlugSet` (Task 5) match their consumers (Task 6). Frontend `Feed`/`MyCompletions`/`ScheduleRow` (Task 8 `types.ts`) match `mergeCompletion` and all three App tests. `youtubeId`/`youtubeThumb` names consistent across Tasks 8, 10. Mount ids consistent between each `main.ts` and its Hugo layout.

**Open risk carried into execution:** exact `DTF_ACTIVITY_V1` column names are assumed from research and MUST be reconciled against the live view in Task 1 before Tasks 3/6 lock them in.
