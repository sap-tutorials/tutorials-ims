# Tutorial Navigator Card Completion Indicators — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show per-user completion progress (corner ring + percent) on tutorial, mission, and group cards in the public Tutorial Navigator.

**Architecture:** A new public-but-auth-aware CAP endpoint `GET /build/my-progress` returns the signed-in user's completion data (or an empty payload for anonymous visitors). The Navigator Vue island fires this fetch in parallel with its existing two fetches and renders a small SVG progress ring on cards where progress > 0. A pure helper module computes per-card state from the wire data and is unit-tested independently of the component.

**Tech Stack:** SAP CAP (Node.js) backend, existing `getUserProgress` lib, Vue 3 Composition API island bundled by Vite, Vitest for unit + smoke tests, scoped CSS for styling.

**Spec:** [docs/superpowers/specs/2026-05-27-navigator-card-completion-design.md](../specs/2026-05-27-navigator-card-completion-design.md)

**Issue:** [sap-tutorials/tutorials-ims#80](https://github.com/sap-tutorials/tutorials-ims/issues/80)

---

## File Structure

| Path | Status | Responsibility |
|---|---|---|
| `srv/server.js` | Modify | Register `GET /build/my-progress` express handler that calls `getUserProgress` and reshapes its result into the wire format. |
| `srv/lib/user-progress.js` | Read-only | Existing lib, no changes; already returns empty arrays for anonymous users. |
| `approuter/xs-app.json` | No change | Existing `^/build/(.*)$` route at line 178 already matches with `authenticationType: "none"`. |
| `test/unit/build-my-progress.test.js` | Create | Unit tests for the new handler (anonymous, signed-in, 0%-filter, error). |
| `test/smoke/public-endpoints.test.js` | Modify | Add one anonymous-200 case for `GET /build/my-progress`. |
| `hugo-apps/src/navigator/cardProgress.ts` | Create | Pure function: given wire payload + a `CardItem`, return `{ percent, complete } \| null`. Testable with no Vue/DOM. |
| `hugo-apps/src/navigator/cardProgress.test.ts` | Create | Vitest unit tests for the helper (all card types, no-progress, slug stripping). |
| `hugo-apps/src/shared/ProgressRing.vue` | Create | Pure presentational SVG ring. Props: `percent: number`, `complete?: boolean`. |
| `hugo-apps/src/navigator/TutorialNavigator.vue` | Modify | Third parallel fetch + `progress` ref + import helper + ring slot in card template + indent CSS + fade-in. |
| `vitest.config.ts` | Inspect / extend if needed | Confirm the `unit` project picks up `hugo-apps/**/*.test.ts` (or extend `include` if not). |

The `cardProgress` helper is broken out specifically because the project has no `@vue/test-utils` setup — keeping the slug-stripping + lookup logic in plain TypeScript lets us TDD it without adding a render harness.

---

## Task 1: Backend handler — failing test first

**Files:**
- Test: `test/unit/build-my-progress.test.js` (create)

This task seeds a SQLite in-memory schema, simulates the express handler by calling it directly with a fake `req`/`res`, and asserts the wire-format contract. Mirrors the seed pattern from [test/unit/user-progress.test.js](../../../test/unit/user-progress.test.js).

- [ ] **Step 1: Write the failing test file**

```javascript
// test/unit/build-my-progress.test.js
import { describe, it, expect, beforeEach, vi } from 'vitest';
import path from 'node:path';
import cds from '@sap/cds';
import { myProgressHandler } from '../../srv/lib/my-progress-handler.js';

const schemaPath = path.join(process.cwd(), 'db', 'schema.cds');

const USER_UUID = 'mp-test-user-001';
const USER_ID = '00000000-0000-0000-0000-000000000aa1';

async function seed() {
  const { Users, Tutorials, Missions, CompletionPaths, TaskRecords } = cds.entities('com.sap.developers.ims');
  await DELETE.from(TaskRecords);
  await DELETE.from(Tutorials);
  await DELETE.from(Missions);
  await DELETE.from(CompletionPaths);
  await DELETE.from(Users);

  await INSERT.into(Users).entries({
    ID: USER_ID, uuid: USER_UUID, legacyId: 9101, firstName: 'X', lastName: 'Y', email: 'x@y'
  });
  await INSERT.into(Tutorials).entries([
    { ID: '11111111-0000-0000-0000-000000000a01', legacyId: 500, slug: 'done-tut',     title: 'Done Tut' },
    { ID: '11111111-0000-0000-0000-000000000a02', legacyId: 501, slug: 'inprog-tut',   title: 'In Progress Tut' },
    { ID: '11111111-0000-0000-0000-000000000a03', legacyId: 502, slug: 'zero-tut',     title: 'Zero Tut' }
  ]);
  await INSERT.into(Missions).entries([
    { ID: '22222222-0000-0000-0000-000000000a01', legacyId: 600, slug: 'done-mission', title: 'Done Mission' }
  ]);
  await INSERT.into(CompletionPaths).entries([
    { ID: '33333333-0000-0000-0000-000000000a01', legacyId: 700, slug: 'done-group', name: 'Done Group' }
  ]);
  await INSERT.into(TaskRecords).entries([
    { ID: 'aaaaaaaa-0000-0000-0000-000000000a01', user_ID: USER_ID, taskLegacyId: 500, taskType: 'TUTORIAL', status: 'COMPLETED', progress: 100 },
    { ID: 'aaaaaaaa-0000-0000-0000-000000000a02', user_ID: USER_ID, taskLegacyId: 501, taskType: 'TUTORIAL', status: 'IN_PROGRESS', progress: 60, modifiedAt: '2026-05-20T10:00:00Z' },
    { ID: 'aaaaaaaa-0000-0000-0000-000000000a03', user_ID: USER_ID, taskLegacyId: 502, taskType: 'TUTORIAL', status: 'IN_PROGRESS', progress: 0,  modifiedAt: '2026-05-19T10:00:00Z' },
    { ID: 'aaaaaaaa-0000-0000-0000-000000000a04', user_ID: USER_ID, taskLegacyId: 600, taskType: 'MISSION',  status: 'COMPLETED', progress: 100 },
    { ID: 'aaaaaaaa-0000-0000-0000-000000000a05', user_ID: USER_ID, taskLegacyId: 700, taskType: 'GROUP',    status: 'COMPLETED', progress: 100 }
  ]);
}

function fakeRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: undefined,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; }
  };
  return res;
}

describe('GET /build/my-progress handler', () => {
  beforeEach(async () => {
    await cds.deploy(schemaPath).to('sqlite::memory:');
    await seed();
  });

  it('returns empty-shape payload with 200 for anonymous user', async () => {
    const req = { user: { id: 'anonymous' } };
    const res = fakeRes();
    await myProgressHandler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.body).toEqual({
      authenticated: false,
      tutorials: { completedSlugs: [], inProgress: [] },
      missionSlugs: [],
      groupSlugs: []
    });
  });

  it('returns populated payload for signed-in user', async () => {
    const req = { user: { id: USER_UUID } };
    const res = fakeRes();
    await myProgressHandler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.authenticated).toBe(true);
    expect(res.body.tutorials.completedSlugs).toEqual(['done-tut']);
    expect(res.body.tutorials.inProgress).toEqual([
      { slug: 'inprog-tut', progressPercent: 60 }
    ]);
    expect(res.body.missionSlugs).toEqual(['done-mission']);
    expect(res.body.groupSlugs).toEqual(['done-group']);
  });

  it('filters out inProgress entries with progressPercent === 0', async () => {
    const req = { user: { id: USER_UUID } };
    const res = fakeRes();
    await myProgressHandler(req, res);
    const slugs = res.body.tutorials.inProgress.map(p => p.slug);
    expect(slugs).not.toContain('zero-tut');
  });

  it('returns empty-shape payload with 200 when getUserProgress throws', async () => {
    const { Users } = cds.entities('com.sap.developers.ims');
    const spy = vi.spyOn(cds.db, 'run').mockImplementationOnce(() => { throw new Error('db down'); });
    const req = { user: { id: USER_UUID } };
    const res = fakeRes();
    await myProgressHandler(req, res);
    spy.mockRestore();
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      authenticated: false,
      tutorials: { completedSlugs: [], inProgress: [] },
      missionSlugs: [],
      groupSlugs: []
    });
    void Users;
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

```bash
npx vitest run --project unit test/unit/build-my-progress.test.js
```

Expected: FAIL — `Cannot find module '../../srv/lib/my-progress-handler.js'`.

- [ ] **Step 3: Commit the failing test**

```bash
git add test/unit/build-my-progress.test.js
git commit -m "test(navigator): failing test for GET /build/my-progress handler"
```

---

## Task 2: Backend handler — implementation

**Files:**
- Create: `srv/lib/my-progress-handler.js`

Extract the handler into its own module so the test file can import it without booting express. `srv/server.js` will pull it in via the same pattern used by other lib handlers.

- [ ] **Step 1: Implement the handler**

```javascript
// srv/lib/my-progress-handler.js
import cds from '@sap/cds';
import { getUserProgress } from './user-progress.js';

const LOG = cds.log('navigator');

const EMPTY_PAYLOAD = Object.freeze({
  authenticated: false,
  tutorials: { completedSlugs: [], inProgress: [] },
  missionSlugs: [],
  groupSlugs: []
});

export async function myProgressHandler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  const user = req.user || cds.context?.user;
  const isAnonymous = !user?.id || user.id === 'anonymous';

  if (isAnonymous) {
    return res.status(200).json(EMPTY_PAYLOAD);
  }

  try {
    const progress = await getUserProgress(user, { limit: 25 });
    const inProgress = progress.inProgress
      .filter(t => typeof t.progressPercent === 'number' && t.progressPercent > 0)
      .map(t => ({ slug: t.slug, progressPercent: t.progressPercent }));

    return res.status(200).json({
      authenticated: true,
      tutorials: {
        completedSlugs: progress.completedSlugs,
        inProgress
      },
      missionSlugs: progress.completedMissionSlugs,
      groupSlugs: progress.completedGroupSlugs
    });
  } catch (err) {
    LOG.warn('my-progress handler failed', err.message);
    return res.status(200).json(EMPTY_PAYLOAD);
  }
}
```

- [ ] **Step 2: Run the unit test, expect PASS**

```bash
npx vitest run --project unit test/unit/build-my-progress.test.js
```

Expected: 4 passing.

- [ ] **Step 3: Commit**

```bash
git add srv/lib/my-progress-handler.js
git commit -m "feat(navigator): add /build/my-progress handler with empty-shape fallback"
```

---

## Task 3: Wire the handler into the express bootstrap

**Files:**
- Modify: `srv/server.js` — add import + `app.get` registration alongside the other `/build/*` routes.

- [ ] **Step 1: Import + register**

In `srv/server.js`, locate the imports block at the top and add:

```javascript
import { myProgressHandler } from './lib/my-progress-handler.js';
```

Then locate the existing `/build/*` registrations (currently lines ~114–123) and append:

```javascript
app.get('/build/my-progress', myProgressHandler);
```

Place it adjacent to `app.get('/build/navigator', navigatorCatalogHandler);`.

- [ ] **Step 2: Boot smoke check**

```bash
npm run dev
# in another terminal:
curl -s -i http://localhost:4004/build/my-progress
```

Expected: HTTP/1.1 200, header `cache-control: private, no-store`, body equal to the empty-shape payload (the dev server is anonymous).

Stop the dev server (Ctrl+C).

- [ ] **Step 3: Commit**

```bash
git add srv/server.js
git commit -m "feat(navigator): mount /build/my-progress handler"
```

---

## Task 4: Smoke test for the deployed endpoint

**Files:**
- Modify: `test/smoke/public-endpoints.test.js`

- [ ] **Step 1: Add a smoke case**

Insert a new `it()` block inside the existing `describe('Public endpoints', ...)` immediately after the `/build/navigator` case:

```javascript
  it('GET /build/my-progress returns empty payload for anonymous client', async () => {
    const res = await fetchWithRetry(`${SRV_URL}/build/my-progress`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toMatch(/private/);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);

    const body = await res.json();
    expect(body.authenticated).toBe(false);
    expect(body.tutorials).toEqual({ completedSlugs: [], inProgress: [] });
    expect(body.missionSlugs).toEqual([]);
    expect(body.groupSlugs).toEqual([]);
  });
```

- [ ] **Step 2: (Cannot run locally without deploy — verify the test parses)**

```bash
npx vitest run --project smoke test/smoke/public-endpoints.test.js --reporter=basic
```

Expected: it'll attempt to hit `SMOKE_SRV_URL`. Without the env vars set, vitest skips. Test failure here is OK — we just want zero parse errors.

- [ ] **Step 3: Commit**

```bash
git add test/smoke/public-endpoints.test.js
git commit -m "test(smoke): cover anonymous GET /build/my-progress"
```

---

## Task 5: Frontend helper — failing test first

**Files:**
- Create: `hugo-apps/src/navigator/cardProgress.test.ts`

This is a pure-function test. The helper handles the two slug-extraction shapes (`/tutorials/mission-...`, `/tutorials/group-...`, `/tutorials/<slug>`) and merges three input collections.

- [ ] **Step 1: Confirm vitest already picks up `hugo-apps/**`**

```bash
grep -n "include\|projects" vitest.config.ts | head -20
```

If `unit` project's `include` glob does not already cover `hugo-apps/**/*.test.ts`, extend it:

```diff
       name: 'unit',
-      include: ['test/unit/**/*.test.{js,ts}', 'test/lib/**/*.test.{js,ts}'],
+      include: ['test/unit/**/*.test.{js,ts}', 'test/lib/**/*.test.{js,ts}', 'hugo-apps/src/**/*.test.{js,ts}'],
```

(Apply the actual diff line-by-line — file structure may vary.)

- [ ] **Step 2: Write the failing test file**

```typescript
// hugo-apps/src/navigator/cardProgress.test.ts
import { describe, it, expect } from 'vitest';
import { cardProgress, type ProgressPayload } from './cardProgress';
import type { CardItem } from '@shared/types';

function makeProgress(overrides: Partial<ProgressPayload> = {}): ProgressPayload {
  return {
    authenticated: true,
    tutorials: {
      completedSlugs: new Set(['done-tut']),
      inProgress: new Map([['inprog-tut', 60]])
    },
    missionSlugs: new Set(['done-mission']),
    groupSlugs: new Set(['done-group']),
    ...overrides
  };
}

const tutorialCard = (slug: string): CardItem => ({
  type: 'tutorial', id: slug, title: 't', description: '', time: 5,
  level: 'beginner', tutorialCount: 1, primaryTag: 'CAP', displayTags: [],
  href: `/tutorials/${slug}`, stepCount: 3
} as unknown as CardItem);

const missionCard = (slug: string): CardItem => ({
  type: 'mission', id: `mission-${slug}`, title: 'm', description: '', time: 10,
  level: 'beginner', tutorialCount: 3, primaryTag: 'CAP', displayTags: [],
  href: `/tutorials/mission-${slug}`, stepCount: 9
} as unknown as CardItem);

const groupCard = (slug: string): CardItem => ({
  type: 'group', id: `group-${slug}`, title: 'g', description: '', time: 8,
  level: 'beginner', tutorialCount: 2, primaryTag: 'CAP', displayTags: [],
  href: `/tutorials/group-${slug}`, stepCount: 6
} as unknown as CardItem);

describe('cardProgress', () => {
  it('returns null for unstarted tutorial card', () => {
    expect(cardProgress(tutorialCard('not-touched'), makeProgress())).toBeNull();
  });

  it('returns 100/complete for completed tutorial card', () => {
    expect(cardProgress(tutorialCard('done-tut'), makeProgress()))
      .toEqual({ percent: 100, complete: true });
  });

  it('returns in-progress percent for tutorial card with active record', () => {
    expect(cardProgress(tutorialCard('inprog-tut'), makeProgress()))
      .toEqual({ percent: 60, complete: false });
  });

  it('returns 100/complete for completed mission card', () => {
    expect(cardProgress(missionCard('done-mission'), makeProgress()))
      .toEqual({ percent: 100, complete: true });
  });

  it('returns null for incomplete mission card', () => {
    expect(cardProgress(missionCard('untouched-mission'), makeProgress())).toBeNull();
  });

  it('returns 100/complete for completed group card', () => {
    expect(cardProgress(groupCard('done-group'), makeProgress()))
      .toEqual({ percent: 100, complete: true });
  });

  it('does not collide group/mission slugs that share a name', () => {
    const progress = makeProgress({
      missionSlugs: new Set(['shared']),
      groupSlugs:   new Set([])
    });
    expect(cardProgress(missionCard('shared'), progress))
      .toEqual({ percent: 100, complete: true });
    expect(cardProgress(groupCard('shared'),   progress)).toBeNull();
  });

  it('returns null when payload is the empty-shape default', () => {
    const empty: ProgressPayload = {
      authenticated: false,
      tutorials: { completedSlugs: new Set(), inProgress: new Map() },
      missionSlugs: new Set(), groupSlugs: new Set()
    };
    expect(cardProgress(tutorialCard('any'),  empty)).toBeNull();
    expect(cardProgress(missionCard('any'),   empty)).toBeNull();
    expect(cardProgress(groupCard('any'),     empty)).toBeNull();
  });
});
```

- [ ] **Step 3: Run, expect fail**

```bash
npx vitest run --project unit hugo-apps/src/navigator/cardProgress.test.ts
```

Expected: FAIL — `Cannot find module './cardProgress'`.

- [ ] **Step 4: Commit failing test (and any vitest config tweak from Step 1)**

```bash
git add hugo-apps/src/navigator/cardProgress.test.ts vitest.config.ts
git commit -m "test(navigator): failing test for cardProgress helper"
```

---

## Task 6: Frontend helper — implementation

**Files:**
- Create: `hugo-apps/src/navigator/cardProgress.ts`

- [ ] **Step 1: Implement**

```typescript
// hugo-apps/src/navigator/cardProgress.ts
import type { CardItem } from '@shared/types';

export interface ProgressPayload {
  authenticated: boolean;
  tutorials: {
    completedSlugs: Set<string>;
    inProgress:     Map<string, number>;
  };
  missionSlugs: Set<string>;
  groupSlugs:   Set<string>;
}

export interface CardProgress {
  percent: number;
  complete: boolean;
}

export function emptyProgress(): ProgressPayload {
  return {
    authenticated: false,
    tutorials: { completedSlugs: new Set(), inProgress: new Map() },
    missionSlugs: new Set(),
    groupSlugs: new Set()
  };
}

export function cardProgress(item: CardItem, p: ProgressPayload): CardProgress | null {
  if (item.type === 'tutorial') {
    const slug = item.href.replace(/^\/tutorials\//, '');
    if (p.tutorials.completedSlugs.has(slug)) return { percent: 100, complete: true };
    const pct = p.tutorials.inProgress.get(slug);
    return typeof pct === 'number' && pct > 0 ? { percent: pct, complete: false } : null;
  }
  if (item.type === 'mission') {
    const slug = item.href.replace(/^\/tutorials\/mission-/, '');
    return p.missionSlugs.has(slug) ? { percent: 100, complete: true } : null;
  }
  if (item.type === 'group') {
    const slug = item.href.replace(/^\/tutorials\/group-/, '');
    return p.groupSlugs.has(slug) ? { percent: 100, complete: true } : null;
  }
  return null;
}

// Convert the wire-format JSON (arrays/objects) into the lookup shape used
// at runtime (Sets/Map). Keeps the network payload slim while giving the
// component O(1) per-card checks.
export function toLookup(json: any): ProgressPayload {
  if (!json || typeof json !== 'object') return emptyProgress();
  return {
    authenticated: !!json.authenticated,
    tutorials: {
      completedSlugs: new Set(Array.isArray(json.tutorials?.completedSlugs) ? json.tutorials.completedSlugs : []),
      inProgress: new Map(
        Array.isArray(json.tutorials?.inProgress)
          ? json.tutorials.inProgress
              .filter((x: any) => x && typeof x.slug === 'string' && typeof x.progressPercent === 'number' && x.progressPercent > 0)
              .map((x: any) => [x.slug, x.progressPercent])
          : []
      )
    },
    missionSlugs: new Set(Array.isArray(json.missionSlugs) ? json.missionSlugs : []),
    groupSlugs:   new Set(Array.isArray(json.groupSlugs)   ? json.groupSlugs   : [])
  };
}
```

- [ ] **Step 2: Run the test, expect PASS**

```bash
npx vitest run --project unit hugo-apps/src/navigator/cardProgress.test.ts
```

Expected: 8 passing.

- [ ] **Step 3: Commit**

```bash
git add hugo-apps/src/navigator/cardProgress.ts
git commit -m "feat(navigator): add cardProgress helper for per-card completion lookup"
```

---

## Task 7: Add a `toLookup` round-trip test

**Files:**
- Modify: `hugo-apps/src/navigator/cardProgress.test.ts`

Belt-and-suspenders — confirms the helper survives the wire shape exactly as the handler emits it (including the 0%-filter on the client side).

- [ ] **Step 1: Append a new describe block**

```typescript
describe('toLookup', () => {
  it('round-trips the wire-format payload', () => {
    const wire = {
      authenticated: true,
      tutorials: {
        completedSlugs: ['done-tut'],
        inProgress: [{ slug: 'inprog-tut', progressPercent: 60 }]
      },
      missionSlugs: ['done-mission'],
      groupSlugs:   ['done-group']
    };
    const p = toLookup(wire);
    expect(p.tutorials.completedSlugs.has('done-tut')).toBe(true);
    expect(p.tutorials.inProgress.get('inprog-tut')).toBe(60);
    expect(p.missionSlugs.has('done-mission')).toBe(true);
    expect(p.groupSlugs.has('done-group')).toBe(true);
  });

  it('client-side filters 0% entries even if server includes them', () => {
    const wire = {
      authenticated: true,
      tutorials: {
        completedSlugs: [],
        inProgress: [{ slug: 'zero-tut', progressPercent: 0 }, { slug: 'real', progressPercent: 30 }]
      },
      missionSlugs: [],
      groupSlugs: []
    };
    const p = toLookup(wire);
    expect(p.tutorials.inProgress.has('zero-tut')).toBe(false);
    expect(p.tutorials.inProgress.get('real')).toBe(30);
  });

  it('returns empty-shape on garbage input', () => {
    const p = toLookup(null);
    expect(p.authenticated).toBe(false);
    expect(p.tutorials.completedSlugs.size).toBe(0);
    expect(p.tutorials.inProgress.size).toBe(0);
  });
});
```

Add `import { toLookup } from './cardProgress';` to the existing import line.

- [ ] **Step 2: Run, expect PASS**

```bash
npx vitest run --project unit hugo-apps/src/navigator/cardProgress.test.ts
```

Expected: 11 passing.

- [ ] **Step 3: Commit**

```bash
git add hugo-apps/src/navigator/cardProgress.test.ts
git commit -m "test(navigator): cover toLookup wire-format round-trip"
```

---

## Task 8: Create the ProgressRing component

**Files:**
- Create: `hugo-apps/src/shared/ProgressRing.vue`

Pure presentational component — no fetching, no stores. Lifts SVG geometry from [AppSpace.vue:319-329](../../../hugo-apps/src/app-space/AppSpace.vue#L319-L329) and CSS from [AppSpace.vue:662-697](../../../hugo-apps/src/app-space/AppSpace.vue#L662-L697), generalizes the selectors.

- [ ] **Step 1: Write the component**

```vue
<!-- hugo-apps/src/shared/ProgressRing.vue -->
<script setup lang="ts">
const props = defineProps<{
  percent: number
  complete?: boolean
}>()

const safePercent = () => Math.max(0, Math.min(100, Math.round(props.percent ?? 0)))
const ariaLabel = () => props.complete ? 'Completed' : `${safePercent()}% complete`
</script>

<template>
  <div
    class="progress-ring"
    :class="{ 'progress-ring--complete': complete }"
    :aria-label="ariaLabel()"
    role="img"
  >
    <svg viewBox="0 0 36 36" class="progress-ring__svg" aria-hidden="true">
      <path class="progress-ring__bg"
        d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
        fill="none" stroke-width="3" />
      <path class="progress-ring__fill"
        d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
        fill="none" stroke-width="3" stroke-linecap="round"
        :stroke-dasharray="`${safePercent()}, 100`" />
    </svg>
    <span class="progress-ring__text" aria-hidden="true">
      <template v-if="complete">&#10003;</template>
      <template v-else>{{ safePercent() }}%</template>
    </span>
  </div>
</template>

<style scoped>
.progress-ring {
  position: relative;
  width: 2.5rem;
  height: 2.5rem;
  flex-shrink: 0;
}
.progress-ring__svg {
  width: 100%;
  height: 100%;
  transform: rotate(-90deg);
}
.progress-ring__bg {
  stroke: var(--sapNeutralBorderColor, #d9d9d9);
}
.progress-ring__fill {
  stroke: var(--sapBrandColor, #0070f2);
  transition: stroke-dasharray 0.4s ease;
}
.progress-ring--complete .progress-ring__fill {
  stroke: var(--sapPositiveColor, #107e3e);
}
.progress-ring__text {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.625rem;
  font-weight: 700;
  color: var(--sapTextColor, #32363a);
}
.progress-ring--complete .progress-ring__text {
  color: var(--sapPositiveColor, #107e3e);
  font-size: 0.875rem;
}
</style>
```

- [ ] **Step 2: Type-check the file**

```bash
cd hugo-apps && npx vue-tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add hugo-apps/src/shared/ProgressRing.vue
git commit -m "feat(navigator): add shared ProgressRing component"
```

---

## Task 9: Wire the Navigator to fetch and render

**Files:**
- Modify: `hugo-apps/src/navigator/TutorialNavigator.vue`

Five edits in one file:
1. Imports
2. New refs
3. Third parallel fetch in `onMounted`
4. Template insert + `nav-card--has-progress` class
5. CSS for indent + fade-in

- [ ] **Step 1: Add imports**

Locate the existing `<script setup lang="ts">` import block (around line 1–6) and add:

```typescript
import ProgressRing from '@shared/ProgressRing.vue'
import { cardProgress, toLookup, emptyProgress, type ProgressPayload } from './cardProgress'
```

- [ ] **Step 2: Add refs**

Below `const tutorials = ref<TutorialEntry[]>([])` (line 8):

```typescript
const progress = ref<ProgressPayload>(emptyProgress())
const progressLoaded = ref(false)
```

- [ ] **Step 3: Extend onMounted with the third fetch**

Locate the existing `Promise.all([...])` block (around line 38–41). Change to:

```typescript
  const [navRes, catalogRes, progRes] = await Promise.all([
    fetch('/tutorials/_nav.json'),
    fetch('/build/navigator'),
    fetch('/build/my-progress', { credentials: 'include' }).catch(() => null),
  ])
```

After the existing `if (catalogRes.ok) { ... }` block (ends at line 72), add:

```typescript
  if (progRes && progRes.ok) {
    try {
      const json = await progRes.json()
      progress.value = toLookup(json)
    } catch {
      // leave progress at emptyProgress default
    }
  }
  progressLoaded.value = true
```

- [ ] **Step 4: Update card template**

Locate the `<a v-for="item in displayedItems" ...>` block (line 700-736). Change the opening `<a>` tag's `:class` and insert the ring as the first child:

```vue
        <a
          v-for="item in displayedItems"
          :key="item.id"
          :href="item.href"
          class="nav-card"
          :class="{
            'nav-card--new': item.isNew,
            'nav-card--has-progress': !!cardProgress(item, progress),
          }"
        >
          <ProgressRing
            v-if="cardProgress(item, progress)"
            class="nav-card__progress"
            v-bind="cardProgress(item, progress)!"
          />
          <span v-if="item.isNew" class="nav-card__new-badge" aria-label="New tutorial">NEW</span>
          <!-- (rest of the card body unchanged) -->
```

Also add `:data-progress-loaded="progressLoaded"` to the navigator root `<div class="tutorial-navigator">` (whatever the outermost element is — verify by reading lines ~561+).

- [ ] **Step 5: Add CSS to the existing scoped `<style>` block**

Append at the bottom of the scoped style block (just before `</style>`):

```css
.nav-card__progress {
  position: absolute;
  top: 0.75rem;
  left: 0.75rem;
  opacity: 0;
  transition: opacity 0.15s ease-out;
}
.tutorial-navigator[data-progress-loaded="true"] .nav-card__progress {
  opacity: 1;
}
.nav-card--has-progress .nav-card__type,
.nav-card--has-progress .nav-card__title,
.nav-card--has-progress .nav-card__desc {
  padding-left: 3rem;
}
.nav-card--has-progress .nav-card__new-badge {
  /* keep NEW badge in its current top-right position; do not push down */
}
```

- [ ] **Step 6: Sanity-check the build**

```bash
cd hugo-apps && npx vite build
```

Expected: clean build, no resolution errors.

- [ ] **Step 7: Commit**

```bash
git add hugo-apps/src/navigator/TutorialNavigator.vue
git commit -m "feat(navigator): render completion ring on cards via /build/my-progress"
```

---

## Task 10: Manual verification

**Files:**
- None (browser smoke).

The CLAUDE.md project rule: "For UI or frontend changes, start the dev server and use the feature in a browser before reporting the task as complete."

- [ ] **Step 1: Boot hybrid dev mode (real HANA)**

```bash
npm run bind:setup     # only needed once per workstation, see CLAUDE.md
npm run dev:hybrid
```

In a separate shell:
```bash
npm run start:approuter
```

Open <http://localhost:5000/tutorials/>.

- [ ] **Step 2: Verify signed-in path**

- Sign in via `/login`.
- Confirm at least one card shows a green-filled ring with `✓` (a tutorial you've completed). Pick a known account from the DEV space.
- Confirm at least one card shows a partial blue ring with a percent (a tutorial in progress).
- Confirm cards without progress have *no* ring — no reserved corner space, padding identical to before.
- Open DevTools network tab → `/build/my-progress` request returns 200 with non-empty body.

- [ ] **Step 3: Verify anonymous path**

- Open the same URL in an incognito window.
- Confirm zero rings on any card.
- Confirm `/build/my-progress` returns 200 with the empty-shape body — no 401, no auth redirect.
- Confirm visual layout is pixel-identical to today's (compare against a screenshot of `main`).

- [ ] **Step 4: Capture before/after screenshots**

Save to `.local/screenshots/navigator-before.png` and `navigator-after.png` for the PR description. (`.local/` is gitignored.)

- [ ] **Step 5: Commit if any tweaks were needed**

If the manual run revealed visual issues, fix them and commit. Otherwise this task has no commit.

---

## Task 11: Open the PR

**Files:**
- None.

- [ ] **Step 1: Push the branch**

```bash
git push -u origin <branch-name>
```

- [ ] **Step 2: Open PR with `gh`**

```bash
gh pr create --title "feat(navigator): show completion progress on cards" --body "$(cat <<'EOF'
## Summary
- Adds public-but-auth-aware `GET /build/my-progress` endpoint backed by the existing `getUserProgress` lib.
- New shared `ProgressRing` Vue component (corner SVG ring with percent or check).
- Tutorial Navigator fetches per-user progress in parallel with existing data and renders the ring on cards with progress > 0.
- Anonymous users see no visual change (200 with empty payload, no auth redirect).

## Test plan
- [x] `npm test` — unit (handler + cardProgress + toLookup)
- [ ] Hybrid: existing `getUserProgress` coverage is sufficient; no new HANA paths.
- [ ] `npm run test:smoke` after deploy
- [ ] Manual: signed-in user sees rings; anonymous sees zero rings, no 401s.

## Screenshots
[before](./.local/screenshots/navigator-before.png) / [after](./.local/screenshots/navigator-after.png)

Closes #80
EOF
)"
```

(Per memory: PR Over Direct Merge — do not fast-merge.)

- [ ] **Step 3: Wait for CI + reviewer**

After CI passes and Tom approves, the merge happens through the PR. After deploy, run smoke tests.

---

## Risks and mitigations

- **Route order in xs-app.json**: not a risk for this PR — the existing catch-all `^/build/(.*)$` already covers `/build/my-progress` with `authenticationType: "none"`. No new route entry.
- **Vitest does not pick up `hugo-apps/**`**: handled in Task 5 Step 1 — extend `include` glob if needed.
- **Vue-tsc on the new ProgressRing**: addressed in Task 8 Step 2.
- **Layout shift between cards-with-ring and cards-without-ring**: only ringed cards get `padding-left: 3rem` via the `nav-card--has-progress` class — non-ringed cards keep current padding.
- **Indent overlap with NEW badge**: NEW badge sits top-right (`.nav-card__new-badge`), ring sits top-left — no overlap.
- **Stale lookup after sign-in within an open tab**: out of scope per spec D6 / Non-Goals.

---

## Verification checklist (before requesting review)

- [ ] All commits are scoped (one logical change per commit)
- [ ] `npm test` — green
- [ ] `cd hugo-apps && npx vite build` — green
- [ ] `cd hugo-apps && npx vue-tsc --noEmit` — green
- [ ] Manual signed-in path — rings render correctly
- [ ] Manual incognito path — zero rings, layout unchanged
- [ ] Before/after screenshots captured
