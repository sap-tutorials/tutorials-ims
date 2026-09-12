# KTT — Kasimir Teaches TLAs — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a mostly-fun `/explore/ktt/` page: a Duolingo-style, story-driven, animated-Kasimir experience that teaches SAP three-letter acronyms, with progress that reuses the platform's existing completion model.

**Architecture:** A Hugo page under "Explore" mounts a single Vue 3 island (mirroring the `puzzle` island) that runs the whole game. A thin CAP service (`/ktt`) records lesson completions as `TaskRecords` rows (new `KTT_LESSON` task type) so they surface in MyCompletions, syncs local↔HANA progress on login, and returns an optional fail-open AI "banter" line. Lesson content is a git-committed, build-time-generated, human-reviewed JSON data file.

**Tech Stack:** SAP CAP (Node.js, `cds.ql`), SAP HANA Cloud, Vue 3 + Vite (hugo-apps islands), Hugo, `@cap-js/ai`, Vitest (`--project unit`), Playwright (post-deploy e2e).

**Spec:** `docs/superpowers/specs/2026-09-11-ktt-kasimir-teaches-tlas-design.md`

## Global Constraints

- **Never write raw SQL** — use `cds.ql` / CQL. (SQLite unit tests only; never SELECT a HANA BLOB — N/A here, no BLOBs.)
- **`@requires` on write paths** — `completeLesson`/`syncProgress` are `@(requires: 'authenticated-user')`; read/`banter` may be `@requires: 'any'`.
- **Feature flags are DB config, never env** — register in `srv/lib/feature-flags/registry.js` (`kind:'db'`), read with `isFlagEnabled('KTT_ENABLED')`. Default OFF.
- **SAP facts grounded, not invented** — TLA→expansion values are verified against `sap-devs-server`/`cds-mcp`/official docs and human-reviewed before commit. AI drafts only jokes + distractors.
- **NGDS autosend excluded for KTT in v1** — do not add a KTT branch to `srv/lib/ngds-client.js`.
- **`ignore-scripts=true` globally** — new build steps must be explicit entries in `build:all`, never `pre*/post*` hooks.
- **New persisted entity ⇒ `db/persistence.cds` journal entry**, and run `npx cds deploy --to sqlite::memory:` before committing model changes.
- **`TaskRecords.taskType` is NVARCHAR** — adding `KTT_LESSON` needs **no** `.hdbmigrationtable` ALTER (comment at `db/schema.cds:191`).
- **Built island JS is content-hashed** (`/js/ktt-<hash>.js`); reference it only via `{{ partial "island-src.html" "ktt" }}`, never a literal path.
- **hugo-apps `.vue`/`.ts` tests run from repo root** via `npm test` (`vitest run --project unit`); `.vue` tests need `// @vitest-environment happy-dom` as the first line.
- **Resolve users by `sapId`, not uuid**, when keying test/lookup logic.
- **srv/lib cp-list audit** — if any new file under `srv/lib/` becomes reachable from `srv/lib/content-store.js`, re-walk `.deploy/mta.yaml`'s `srv-qa` `cp` list. (KTT files are self-contained; expected not reachable — verify in Task 12.)

---

## File Structure

**Backend / model**
- `db/schema.cds` (modify) — add `KTT_LESSON` to `type TaskType` (`:19`) and `TaskRecords.taskType` (`:195`).
- `db/ktt.cds` (create) — `KttLessons` catalog entity.
- `db/persistence.cds` (modify) — journal entry for `KttLessons`.
- `srv/ktt-service.cds` (create) — `@path:'/ktt'` service: `KttLessons` projection + actions.
- `srv/ktt-service.js` (create) — handlers: `completeLesson`, `syncProgress`, `banter`, `getKttProgress`.
- `srv/lib/ktt/completion.js` (create) — pure helper: build the `TaskRecords` entry + idempotency guard (kept out of the `content-store.js` import graph).
- `srv/lib/ktt/merge.js` (create) — pure local↔remote progress merge (union mastered, max XP/streak).
- `srv/lib/user-progress.js` (modify) — surface `KTT_LESSON` in MyCompletions.
- `srv/lib/feature-flags/registry.js` (modify) — register `KTT_ENABLED`.

**Content pipeline**
- `scripts/generate-ktt-lessons.ts` (create) — build-time generator (facts curated+grounded, jokes/distractors AI-drafted).
- `scripts/lib/ktt-lessons-schema.ts` (create) — shared TS types + `validateLessons()`.
- `hugo/data/ktt_lessons.json` (create) — the reviewed content (source of truth).
- `package.json` (modify) — add `generate-ktt-lessons` npm script + wire into `build:all`.

**Frontend island (`hugo-apps/src/ktt/`)**
- `main.ts` (create) — mount on `#ktt-mount`.
- `App.vue` (create) — router-less screen switch (landing / map / lesson / results).
- `lib/engine.ts` (create) — pure lesson engine (beat sequencing, drill scoring, re-queue, XP/streak).
- `lib/progress.ts` (create) — localStorage load/save + `mergeProgress`.
- `lib/server.ts` (create) — CAP client (`fetchLessons`, `completeLesson`, `syncProgress`, `fetchBanter`, `isAuthenticated`).
- `components/KasimirStage.vue` (create) — rigged SVG Kasimir + mood state machine.
- `components/SkillTreeMap.vue` (create) — units → lesson nodes.
- `components/Lesson.vue` (create) — story beats + drills.
- `components/Results.vue` (create) — streak/XP/mastered.
- `hugo-apps/vite.config.ts` (modify) — add `ktt` to `rollupOptions.input`.
- `hugo-apps/src/ktt/__tests__/*.test.ts` (create) — engine, merge, KasimirStage, App.

**Hugo page + nav**
- `hugo/content/explore/ktt/_index.md` (create) — page front-matter.
- `hugo/layouts/explore/ktt.html` (create) — SSR shell + island mount.
- `hugo/data/navigation.yaml` (modify) — Explore menu entry (`:82` group).

**e2e**
- `test/e2e/ktt.spec.ts` (create) — post-deploy, self-skipping Playwright smoke.

**Deferred (documented, not built in v1):** unit-level rollup (seed each unit as a mission parent + `CompletionPathItems` `KTT_LESSON:<legacyId>` tokens so `completion-rollup.js:159` produces "unit mastered" rows); endless mode; per-acronym `STEP` rows; NGDS autosend. See "Deferred Work" at end.

---

## Phase A — Data model & backend

### Task 1: Add `KTT_LESSON` task type + `KttLessons` catalog entity

**Files:**
- Modify: `db/schema.cds:19` and `db/schema.cds:195`
- Create: `db/ktt.cds`
- Modify: `db/persistence.cds`
- Test: `test/unit/ktt-model.test.js`

**Interfaces:**
- Produces: `com.sap.developers.ims.KttLessons { key ID: UUID; legacyId: Integer; slug: String(120); unitId: String(60); title: String(200); order: Integer }`; `TaskRecords.taskType` and `type TaskType` both accept `'KTT_LESSON'`.

- [ ] **Step 1: Write the failing test** — `test/unit/ktt-model.test.js`:

```js
const cds = require('@sap/cds');
const { test, expect } = require('vitest');

test('TaskRecords accepts KTT_LESSON and KttLessons entity exists', async () => {
  const model = await cds.load(['db', 'srv'], { root: process.cwd() });
  const csn = cds.linked(model);
  const tr = csn.definitions['com.sap.developers.ims.TaskRecords'];
  const enumVals = Object.keys(tr.elements.taskType.enum);
  expect(enumVals).toContain('KTT_LESSON');
  expect(csn.definitions['com.sap.developers.ims.KttLessons']).toBeDefined();
  expect(csn.definitions['com.sap.developers.ims.KttLessons'].elements.legacyId).toBeDefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/ktt-model.test.js`
Expected: FAIL (`KttLessons` undefined / enum lacks `KTT_LESSON`).

- [ ] **Step 3: Add the enum values.** In `db/schema.cds`, add `KTT_LESSON;` to the `type TaskType` enum block (near `:19`) and to the `TaskRecords.taskType` inline enum block (near `:195`). Add a trailing comment `// KTT (#KTT) — mostly-fun acronym trainer`.

- [ ] **Step 4: Create `db/ktt.cds`:**

```cds
namespace com.sap.developers.ims;
using { com.sap.developers.ims as ims } from './schema';

/** Catalog of KTT lessons — metadata only, so a KTT_LESSON completion
    row in TaskRecords can join to its title/kind in MyCompletions.
    Progress lives in TaskRecords, not here. Seeded from hugo/data/ktt_lessons.json. */
entity KttLessons : cuid {
  legacyId : Integer @assert.unique;   // stable int used as TaskRecords.taskLegacyId
  slug     : String(120) @assert.unique;
  unitId   : String(60);
  title    : String(200);
  order    : Integer default 0;
}
```

- [ ] **Step 5: Add the persistence journal entry.** In `db/persistence.cds`, add the `@cds.persistence.journal` annotation for `KttLessons` following the exact pattern of the neighboring entities in that file (mirror the closest `cuid` entity entry).

- [ ] **Step 6: Verify the model deploys**

Run: `npx cds deploy --to sqlite::memory:`
Expected: deploys with no error.

- [ ] **Step 7: Run test to verify it passes**

Run: `npx vitest run test/unit/ktt-model.test.js`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add db/schema.cds db/ktt.cds db/persistence.cds test/unit/ktt-model.test.js
git commit -m "feat(ktt): add KTT_LESSON task type and KttLessons catalog entity"
```

---

### Task 2: `KttService` + `completeLesson` (writes TaskRecords)

**Files:**
- Create: `srv/ktt-service.cds`, `srv/ktt-service.js`, `srv/lib/ktt/completion.js`
- Test: `test/unit/ktt-complete.test.js`

**Interfaces:**
- Consumes: `com.sap.developers.ims.{TaskRecords, KttLessons, Users}` (Task 1); `getNextLegacyId` from `srv/lib/legacy-id.js`; `stampSubmissionId` from `srv/lib/task-record-submission-id.js`.
- Produces: action `completeLesson(lessonSlug: String, legacyId: Integer, title: String) returns { ok: Boolean; alreadyDone: Boolean }` on service `KttService` at `@path:'/ktt'`; helper `buildKttCompletionEntry({ userId, legacyId, title, attemptNumber })` and `findExistingKttRecord(db, TaskRecords, userId, legacyId)` in `srv/lib/ktt/completion.js`.

- [ ] **Step 1: Write the failing test** — `test/unit/ktt-complete.test.js`:

```js
const cds = require('@sap/cds');
const { expect, test, beforeAll } = require('vitest');
const { GET, POST } = cds.test('serve', '--in-memory', '--project', process.cwd());

let authed;
beforeAll(() => { authed = { auth: { username: 'alice' } }; });

test('completeLesson writes one KTT_LESSON TaskRecord and is idempotent', async () => {
  const body = { lessonSlug: 'core-1', legacyId: 90001, title: 'Meet the Platform' };
  const r1 = await POST('/ktt/completeLesson', body, authed);
  expect(r1.data.ok).toBe(true);
  expect(r1.data.alreadyDone).toBe(false);
  const r2 = await POST('/ktt/completeLesson', body, authed);
  expect(r2.data.alreadyDone).toBe(true);
  const db = await cds.connect.to('db');
  const { TaskRecords } = db.entities('com.sap.developers.ims');
  const rows = await SELECT.from(TaskRecords).where({ taskLegacyId: 90001, taskType: 'KTT_LESSON' });
  expect(rows.length).toBe(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/ktt-complete.test.js`
Expected: FAIL (`/ktt/completeLesson` 404 — service not defined).

- [ ] **Step 3: Create `srv/ktt-service.cds`:**

```cds
using { com.sap.developers.ims as ims } from '../db/ktt';

@path: '/ktt'
@requires: 'any'
service KttService {

  @readonly entity Lessons as projection on ims.KttLessons;

  @(requires: 'authenticated-user')
  action completeLesson(lessonSlug: String, legacyId: Integer, title: String)
    returns { ok: Boolean; alreadyDone: Boolean };

  @(requires: 'authenticated-user')
  action syncProgress(localJson: LargeString)
    returns { xp: Integer; streak: Integer; mastered: array of String };

  function banter(context: String) returns String;
}
```

- [ ] **Step 4: Create `srv/lib/ktt/completion.js`:**

```js
import { stampSubmissionId } from '../task-record-submission-id.js';

/** Build a KTT_LESSON TaskRecords entry (does not set ID — CAP default handles it). */
export function buildKttCompletionEntry({ userId, legacyId, title, attemptNumber = 1, nextLegacyId }) {
  return stampSubmissionId({
    user_ID: userId,
    taskLegacyId: legacyId,
    taskType: 'KTT_LESSON',
    status: 'COMPLETED',
    progress: 100,
    completionDate: new Date().toISOString(),
    titleSnapshot: (title || '').slice(0, 255),
    legacyId: nextLegacyId,
    attemptNumber,
  });
}

/** Idempotency guard tuple (user_ID, taskLegacyId, KTT_LESSON) excluding SUPERSEDED. */
export async function findExistingKttRecord(TaskRecords, userId, legacyId) {
  return SELECT.one.from(TaskRecords).where({
    user_ID: userId, taskLegacyId: legacyId, taskType: 'KTT_LESSON', status: { '!=': 'SUPERSEDED' },
  });
}
```

- [ ] **Step 5: Create `srv/ktt-service.js`** (`completeLesson` only; other actions added in later tasks):

```js
import cds from '@sap/cds';
import { getNextLegacyId } from './lib/legacy-id.js';
import { buildKttCompletionEntry, findExistingKttRecord } from './lib/ktt/completion.js';

export default class KttService extends cds.ApplicationService {
  async init() {
    const db = await cds.connect.to('db');
    const { TaskRecords, Users } = cds.entities('com.sap.developers.ims');

    this.on('completeLesson', async (req) => {
      const { legacyId, title } = req.data;
      const dbUser = await SELECT.one.from(Users).where({ sapId: req.user.id });
      if (!dbUser) return req.reject(403, 'Unknown user');
      const existing = await findExistingKttRecord(TaskRecords, dbUser.ID, legacyId);
      if (existing) return { ok: true, alreadyDone: true };
      const entry = buildKttCompletionEntry({
        userId: dbUser.ID, legacyId, title,
        attemptNumber: 1, nextLegacyId: await getNextLegacyId('TaskRecords', db),
      });
      await INSERT.into(TaskRecords).entries(entry);
      return { ok: true, alreadyDone: false };
    });

    return super.init();
  }
}
```

> Note: resolve the user by `sapId` (`req.user.id`), matching the platform's test-key convention (`resolveUsers by sapId not uuid`).

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run test/unit/ktt-complete.test.js`
Expected: PASS (one row, second call `alreadyDone`).

- [ ] **Step 7: Commit**

```bash
git add srv/ktt-service.cds srv/ktt-service.js srv/lib/ktt/completion.js test/unit/ktt-complete.test.js
git commit -m "feat(ktt): KttService.completeLesson records KTT_LESSON TaskRecord (idempotent)"
```

---

### Task 3: Progress merge + `syncProgress`

**Files:**
- Create: `srv/lib/ktt/merge.js`
- Modify: `srv/ktt-service.js`
- Test: `test/unit/ktt-merge.test.js`

**Interfaces:**
- Produces: `mergeProgress(local, remote) => { xp, streak, mastered }` in `srv/lib/ktt/merge.js` — `mastered` = sorted union of arrays of lesson slugs, `xp`/`streak` = numeric max. Action `syncProgress(localJson)` reconstructs remote state from the user's `KTT_LESSON` TaskRecords, merges, records any newly-mastered lessons via the Task 2 path, and returns the merged totals.

- [ ] **Step 1: Write the failing test** — `test/unit/ktt-merge.test.js`:

```js
const { expect, test } = require('vitest');
const { mergeProgress } = require('../../srv/lib/ktt/merge.js');

test('mergeProgress unions mastered and takes max xp/streak', () => {
  const local = { xp: 120, streak: 3, mastered: ['core-1', 'core-2'] };
  const remote = { xp: 90, streak: 5, mastered: ['core-2', 'sec-1'] };
  expect(mergeProgress(local, remote)).toEqual({
    xp: 120, streak: 5, mastered: ['core-1', 'core-2', 'sec-1'],
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/ktt-merge.test.js`
Expected: FAIL (module not found).

- [ ] **Step 3: Create `srv/lib/ktt/merge.js`:**

```js
export function mergeProgress(local = {}, remote = {}) {
  const mastered = Array.from(new Set([...(local.mastered || []), ...(remote.mastered || [])])).sort();
  return {
    xp: Math.max(Number(local.xp) || 0, Number(remote.xp) || 0),
    streak: Math.max(Number(local.streak) || 0, Number(remote.streak) || 0),
    mastered,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/ktt-merge.test.js`
Expected: PASS.

- [ ] **Step 5: Add `syncProgress` handler** to `srv/ktt-service.js` `init()` (uses `mergeProgress` + Task 2 helpers). Import at top: `import { mergeProgress } from './lib/ktt/merge.js';` and `import { KttLessons } from` via `cds.entities`. Handler:

```js
this.on('syncProgress', async (req) => {
  const local = JSON.parse(req.data.localJson || '{}');
  const dbUser = await SELECT.one.from(Users).where({ sapId: req.user.id });
  if (!dbUser) return req.reject(403, 'Unknown user');
  const done = await SELECT.from(TaskRecords)
    .columns('taskLegacyId')
    .where({ user_ID: dbUser.ID, taskType: 'KTT_LESSON', status: { '!=': 'SUPERSEDED' } });
  const doneIds = done.map((r) => r.taskLegacyId);
  const catalog = await SELECT.from(KttLessons).columns('legacyId', 'slug');
  const slugByLegacy = new Map(catalog.map((c) => [c.legacyId, c.slug]));
  const remote = { xp: 0, streak: 0, mastered: doneIds.map((id) => slugByLegacy.get(id)).filter(Boolean) };
  const merged = mergeProgress(local, remote);
  // Record any locally-mastered lessons not yet in HANA (reuse completeLesson guard).
  const legacyBySlug = new Map(catalog.map((c) => [c.slug, c]));
  for (const slug of merged.mastered) {
    const cat = legacyBySlug.get(slug);
    if (!cat || doneIds.includes(cat.legacyId)) continue;
    const existing = await findExistingKttRecord(TaskRecords, dbUser.ID, cat.legacyId);
    if (existing) continue;
    await INSERT.into(TaskRecords).entries(buildKttCompletionEntry({
      userId: dbUser.ID, legacyId: cat.legacyId, title: cat.slug,
      nextLegacyId: await getNextLegacyId('TaskRecords', db),
    }));
  }
  return merged;
});
```

Add `KttLessons` to the `cds.entities('com.sap.developers.ims')` destructure at the top of `init()`.

- [ ] **Step 6: Extend the test** — add a served-mode assertion in `test/unit/ktt-complete.test.js` (or a new `ktt-sync.test.js`): seed one `KttLessons` row (`legacyId:90001, slug:'core-1'`), POST `/ktt/syncProgress` with `localJson='{"xp":50,"streak":2,"mastered":["core-1"]}'`, assert response `mastered` contains `core-1` and a `KTT_LESSON` TaskRecord for `90001` now exists.

- [ ] **Step 7: Run tests**

Run: `npx vitest run test/unit/ktt-merge.test.js test/unit/ktt-complete.test.js`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add srv/lib/ktt/merge.js srv/ktt-service.js test/unit/ktt-merge.test.js test/unit/ktt-complete.test.js
git commit -m "feat(ktt): syncProgress merges local and HANA progress on login"
```

---

### Task 4: Surface KTT lessons in MyCompletions

**Files:**
- Modify: `srv/lib/user-progress.js` (~`:175`, `:183`, `:213`)
- Test: `test/unit/ktt-mycompletions.test.js`

**Interfaces:**
- Consumes: `getMyCompletedTutorials(user)` in `srv/lib/user-progress.js` (called by `getMyCompletions` in `srv/developer-service.js:453`).
- Produces: entries with `kind:'ktt'` for KTT lesson completions.

- [ ] **Step 1: Write the failing test** — `test/unit/ktt-mycompletions.test.js` (served mode): seed a `KttLessons` row + a `KTT_LESSON` COMPLETED `TaskRecords` row for user `alice`, then call the `getMyCompletions` function and assert an entry with `{ kind: 'ktt', slug: 'core-1', title: 'Meet the Platform' }` is returned.

```js
const cds = require('@sap/cds');
const { expect, test } = require('vitest');
const { GET } = cds.test('serve', '--in-memory', '--project', process.cwd());

test('getMyCompletions includes KTT lessons as kind:ktt', async () => {
  // Arrange: insert KttLessons + TaskRecords for alice via db (see repo seed helpers).
  // Act:
  const res = await GET('/browse/getMyCompletions()', { auth: { username: 'alice' } });
  // Assert:
  expect(res.data.value.some((e) => e.kind === 'ktt' && e.slug === 'core-1')).toBe(true);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/unit/ktt-mycompletions.test.js`
Expected: FAIL (no `kind:'ktt'` entry).

- [ ] **Step 3: Extend `srv/lib/user-progress.js`:**
  - Add `'KTT_LESSON'` to the `taskType IN (...)` list near `:175`.
  - Add a `kttIds` bucket near `:183` collecting `taskLegacyId`s where `taskType==='KTT_LESSON'`.
  - Add a `SELECT.from(KttLessons).where({ legacyId: { in: kttIds } })` metadata fetch (import `KttLessons` from `cds.entities`).
  - Add a branch near `:213` mapping a KTT row to `{ kind: 'ktt', slug, title: titleSnapshot || lesson.title, completionDate, attemptNumber }`.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/unit/ktt-mycompletions.test.js`
Expected: PASS.

- [ ] **Step 5: Regression** — run the existing user-progress suite to confirm TUTORIAL/PUZZLE/PETOBERFEST still behave:

Run: `npx vitest run test/unit/user-progress.test.js` (adjust to the real filename if different)
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add srv/lib/user-progress.js test/unit/ktt-mycompletions.test.js
git commit -m "feat(ktt): surface KTT lessons in MyCompletions as kind:ktt"
```

---

### Task 5: `banter` AI action (fail-open)

**Files:**
- Modify: `srv/ktt-service.js`
- Test: `test/unit/ktt-banter.test.js`

**Interfaces:**
- Produces: `function banter(context: String) returns String` — returns a short in-character line; on any AI error/timeout returns a deterministic scripted fallback line (never throws).

- [ ] **Step 1: Write the failing test** — `test/unit/ktt-banter.test.js`:

```js
const { expect, test, vi } = require('vitest');

test('banter returns a fallback line when AICore fails', async () => {
  const { computeBanter } = require('../../srv/lib/ktt/banter.js');
  const brokenAi = { chat: vi.fn(async () => { throw new Error('AICore down'); }) };
  const line = await computeBanter(brokenAi, { event: 'streak', streak: 5 });
  expect(typeof line).toBe('string');
  expect(line.length).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/unit/ktt-banter.test.js`
Expected: FAIL (`srv/lib/ktt/banter.js` not found).

- [ ] **Step 3: Create `srv/lib/ktt/banter.js`** (pure, testable; the service wires the real AICore in):

```js
const FALLBACKS = {
  streak: "Purr-fect. Another one mastered — my nap is well earned.",
  wrong: "A miss! Even I cough up the occasional hairball. Try again.",
  correct: "Correct. You may pet me. Once.",
  default: "Acronyms: SAP's favorite indoor sport.",
};
const MAX_LEN = 160;

/** ai: object with async chat(prompt) → string, or null. Never throws. */
export async function computeBanter(ai, ctx = {}) {
  const fallback = FALLBACKS[ctx.event] || FALLBACKS.default;
  if (!ai || typeof ai.chat !== 'function') return fallback;
  try {
    const prompt = `You are Professor Kasimir, a witty SAP cat. One short, tongue-in-cheek line (<160 chars) for event "${ctx.event}". No emojis.`;
    const out = await Promise.race([
      ai.chat(prompt),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 2500)),
    ]);
    const line = String(out || '').trim().slice(0, MAX_LEN);
    return line || fallback;
  } catch {
    return fallback;
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/unit/ktt-banter.test.js`
Expected: PASS.

- [ ] **Step 5: Wire the action** in `srv/ktt-service.js` `init()`:

```js
import { computeBanter } from './lib/ktt/banter.js';
// ... inside init():
let ai = null;
try { ai = await cds.connect.to('AICore'); } catch { ai = null; }
const aiAdapter = ai ? { chat: async (p) => (await ai.send('POST', '/chat', { prompt: p }))?.text } : null;
this.on('banter', async (req) => computeBanter(aiAdapter, { event: req.data.context }));
```

> The exact AICore call shape follows the `@cap-js/ai` usage in the repo; `computeBanter` is agnostic to it and fail-open, so a wrong call shape degrades to the fallback rather than breaking the lesson. Local dev uses `AICore-mocked`; do not require a live model for tests.

- [ ] **Step 6: Commit**

```bash
git add srv/lib/ktt/banter.js srv/ktt-service.js test/unit/ktt-banter.test.js
git commit -m "feat(ktt): fail-open Kasimir banter action backed by @cap-js/ai"
```

---

### Task 6: Feature flag `KTT_ENABLED` + gate the service

**Files:**
- Modify: `srv/lib/feature-flags/registry.js`, `srv/ktt-service.js`
- Test: `test/unit/feature-flags-registry.test.js` (existing drift test must pass)

**Interfaces:**
- Produces: registry entry `KTT_ENABLED` (`imsConfigKey:'flag.ktt.enabled'`), read via `isFlagEnabled('KTT_ENABLED')`.

- [ ] **Step 1: Add the registry entry.** Append to the `FEATURE_FLAGS` array in `srv/lib/feature-flags/registry.js`:

```js
{
  key: 'KTT_ENABLED', label: 'KTT — Kasimir Teaches TLAs', category: 'Content',
  kind: 'db', imsConfigKey: 'flag.ktt.enabled',
  valueType: 'boolean', default: false, status: 'beta',
  description: 'Enables the /explore/ktt/ acronym trainer and its /ktt CAP endpoints. Off → completeLesson/syncProgress reject 503.',
  howToChange: featureFlagUpsert('KTT_ENABLED', 'flag.ktt.enabled'),
},
```

- [ ] **Step 2: Run the drift test to verify the registry is well-formed**

Run: `npx vitest run test/unit/feature-flags-registry.test.js`
Expected: PASS (the entry is valid; no drift).

- [ ] **Step 3: Gate the write actions.** At the top of `completeLesson` and `syncProgress` handlers in `srv/ktt-service.js`, add:

```js
import { isFlagEnabled } from './lib/feature-flags/db-flags.js';
// first line of each write handler:
if (!isFlagEnabled('KTT_ENABLED')) return req.reject(503, 'KTT is not enabled');
```

- [ ] **Step 4: Add a served test** asserting `completeLesson` rejects `503` when the flag default (OFF) is in effect, and passes when the flag is forced on (set the ImsConfig row / mock `isFlagEnabled` per the repo's existing flag-test pattern). Guard any DB-flag boot-seed behind `!process.env.VITEST`.

- [ ] **Step 5: Commit**

```bash
git add srv/lib/feature-flags/registry.js srv/ktt-service.js test/unit/*.test.js
git commit -m "feat(ktt): register KTT_ENABLED db flag and gate /ktt write actions"
```

---

## Phase B — Content pipeline

### Task 7: Lesson schema, generator, and reviewed data file

**Files:**
- Create: `scripts/lib/ktt-lessons-schema.ts`, `scripts/generate-ktt-lessons.ts`, `hugo/data/ktt_lessons.json`
- Modify: `package.json` (script only; `build:all` wiring in Task 16)
- Test: `test/unit/ktt-lessons-data.test.ts`

**Interfaces:**
- Produces: TS types `KttLesson`, `KttUnit`, `KttBeat`, and `validateLessons(data): string[]` (returns error messages; empty = valid) in `scripts/lib/ktt-lessons-schema.ts`. The generated `hugo/data/ktt_lessons.json` matches the spec §5 shape.

- [ ] **Step 1: Write the failing validation test** — `test/unit/ktt-lessons-data.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { validateLessons } from '../../scripts/lib/ktt-lessons-schema';

describe('ktt_lessons.json', () => {
  const data = JSON.parse(readFileSync('hugo/data/ktt_lessons.json', 'utf8'));
  it('has 3-4 units and passes structural validation', () => {
    expect(data.units.length).toBeGreaterThanOrEqual(3);
    expect(data.units.length).toBeLessThanOrEqual(4);
    expect(validateLessons(data)).toEqual([]);
  });
  it('every drill has an answer and >=2 distractors; legacyIds unique', () => {
    const errs = validateLessons(data);
    expect(errs).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/unit/ktt-lessons-data.test.ts`
Expected: FAIL (schema module + data file missing).

- [ ] **Step 3: Create `scripts/lib/ktt-lessons-schema.ts`:**

```ts
export interface KttAcronym { tla: string; expansion: string; blurb: string; category: string; }
export interface KttDrill {
  type: 'drill'; kind: 'mc' | 'match' | 'type'; tla: string; prompt: string;
  answer: string; distractors: string[]; kasimirRight: string; kasimirWrong: string;
}
export interface KttStory { type: 'story'; kasimir: string; mood: 'idle'|'teaching'|'thinking'|'correct'|'wrong'|'celebrate'; }
export type KttBeat = KttStory | KttDrill;
export interface KttLesson { id: string; legacyId: number; title: string; acronyms: KttAcronym[]; beats: KttBeat[]; }
export interface KttUnit { id: string; title: string; icon: string; order: number; lessons: KttLesson[]; }
export interface KttData { units: KttUnit[]; }

export function validateLessons(data: KttData): string[] {
  const errs: string[] = [];
  const legacyIds = new Set<number>();
  for (const u of data.units || []) {
    for (const l of u.lessons || []) {
      if (typeof l.legacyId !== 'number') errs.push(`${l.id}: missing numeric legacyId`);
      if (legacyIds.has(l.legacyId)) errs.push(`${l.id}: duplicate legacyId ${l.legacyId}`);
      legacyIds.add(l.legacyId);
      for (const a of l.acronyms || []) if (!a.expansion) errs.push(`${l.id}/${a.tla}: missing expansion`);
      for (const b of l.beats || []) {
        if (b.type === 'drill') {
          if (!b.answer) errs.push(`${l.id}: drill for ${b.tla} missing answer`);
          if (!b.distractors || b.distractors.length < 2) errs.push(`${l.id}: drill for ${b.tla} needs >=2 distractors`);
        }
      }
    }
  }
  return errs;
}
```

- [ ] **Step 4: Create `scripts/generate-ktt-lessons.ts`.** It (a) reads a curated seed list of `{tla, expansion, category, unitId}` embedded in the script (facts grounded against `sap-devs`/`cds-mcp`/official docs during authoring — NOT invented), (b) optionally calls the AI drafting step for `kasimir*` lines + `distractors` when `--draft` is passed, (c) assembles `KttData`, (d) runs `validateLessons` and **exits non-zero on any error**, (e) writes `hugo/data/ktt_lessons.json` with stable ordering. Skeleton:

```ts
import { writeFileSync } from 'node:fs';
import { validateLessons, KttData } from './lib/ktt-lessons-schema';

const SEED = [/* curated + grounded TLA facts, assigned to units + legacyIds */];

function assemble(): KttData { /* group SEED by unitId, build beats (story+drills) */ return { units: [] }; }

const data = assemble();
const errs = validateLessons(data);
if (errs.length) { console.error('KTT lesson validation failed:\n' + errs.join('\n')); process.exit(1); }
writeFileSync('hugo/data/ktt_lessons.json', JSON.stringify(data, null, 2) + '\n');
console.log(`Wrote ${data.units.length} units.`);
```

- [ ] **Step 5: Author the reviewed data file.** Run the generator (or hand-author) to produce `hugo/data/ktt_lessons.json` with 3–4 units and ~50–60 acronyms. **The TLA→expansion facts are human-reviewed for correctness before commit** (Global Constraints). This is the content-authoring step — grounded, not model-guessed.

- [ ] **Step 6: Add the npm script** to `package.json` `scripts`:

```json
"generate-ktt-lessons": "npx tsx scripts/generate-ktt-lessons.ts"
```

- [ ] **Step 7: Run the validation test to verify it passes**

Run: `npx vitest run test/unit/ktt-lessons-data.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add scripts/lib/ktt-lessons-schema.ts scripts/generate-ktt-lessons.ts hugo/data/ktt_lessons.json package.json test/unit/ktt-lessons-data.test.ts
git commit -m "feat(ktt): lesson schema, generator, and reviewed content data file"
```

---

## Phase C — Frontend island

### Task 8: Scaffold `ktt` island + register in Vite

**Files:**
- Create: `hugo-apps/src/ktt/main.ts`, `hugo-apps/src/ktt/App.vue`
- Modify: `hugo-apps/vite.config.ts` (add `ktt` to `rollupOptions.input`, near `:349`)
- Test: `hugo-apps/src/ktt/__tests__/App.test.ts`

**Interfaces:**
- Produces: island entry mounting `App.vue` on `#ktt-mount`, reading `data-api` (default `/ktt`) and `data-lessons` (path to `ktt_lessons.json`, default `/data/ktt_lessons.json`... — see note). Screen switch driven by a `screen` ref: `'landing'|'map'|'lesson'|'results'`.

> Lessons data note: Hugo bakes `hugo/data/ktt_lessons.json` into the page; pass it to the island via a `data-lessons` attribute containing the JSON (or a URL). Simplest: emit the JSON inline in the layout (Task 14) and read `mount.dataset.lessons`. The island therefore does NOT fetch lessons from CAP in v1.

- [ ] **Step 1: Write the failing test** — `hugo-apps/src/ktt/__tests__/App.test.ts`:

```ts
// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import App from '../App.vue';

const LESSONS = { units: [{ id: 'core', title: 'Core Platform', icon: 'home', order: 1,
  lessons: [{ id: 'core-1', legacyId: 90001, title: 'Meet the Platform', acronyms: [], beats: [] }] }] };

describe('KTT App', () => {
  it('renders the landing screen with a start CTA', () => {
    const wrapper = mount(App, { props: { apiUrl: '/ktt', lessons: LESSONS } });
    expect(wrapper.text()).toContain('Kasimir');
    expect(wrapper.find('[data-testid="ktt-start"]').exists()).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- hugo-apps/src/ktt/__tests__/App.test.ts`
Expected: FAIL (`App.vue` missing).

- [ ] **Step 3: Create `hugo-apps/src/ktt/main.ts`:**

```ts
import { createApp } from 'vue';
import App from './App.vue';

const mount = document.getElementById('ktt-mount') as HTMLElement | null;
if (mount) {
  let lessons = {};
  try { lessons = JSON.parse(mount.dataset.lessons || '{}'); } catch { lessons = {}; }
  createApp(App, { apiUrl: mount.dataset.api || '/ktt', lessons }).mount(mount);
}
```

- [ ] **Step 4: Create a minimal `hugo-apps/src/ktt/App.vue`** (landing only for now; screens added in later tasks):

```vue
<script setup lang="ts">
import { ref } from 'vue';
import KasimirStage from './components/KasimirStage.vue';
const props = defineProps<{ apiUrl: string; lessons: any }>();
const screen = ref<'landing'|'map'|'lesson'|'results'>('landing');
</script>
<template>
  <div class="ktt-root" :data-screen="screen">
    <section v-if="screen === 'landing'" class="ktt-landing">
      <KasimirStage mood="idle" />
      <h1>Professor Kasimir Teaches TLAs</h1>
      <p>SAP has more three-letter acronyms than a cat has naps. Let's fix that.</p>
      <button data-testid="ktt-start" @click="screen = 'map'">Start</button>
    </section>
    <!-- map / lesson / results mounted in later tasks -->
  </div>
</template>
```

> This imports `KasimirStage` (Task 10). To keep Task 8 independently green, create a one-line stub `components/KasimirStage.vue` now (`<template><div class="kasimir" aria-hidden="true"/></template>`) and replace it in Task 10.

- [ ] **Step 5: Register the island** in `hugo-apps/vite.config.ts` `rollupOptions.input` (near `:349`, beside `puzzle`):

```ts
ktt: resolve(__dirname, 'src/ktt/main.ts'),
```

- [ ] **Step 6: Run to verify it passes**

Run: `npm test -- hugo-apps/src/ktt/__tests__/App.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add hugo-apps/src/ktt hugo-apps/vite.config.ts
git commit -m "feat(ktt): scaffold ktt Vue island and register Vite entry"
```

---

### Task 9: Lesson engine (pure)

**Files:**
- Create: `hugo-apps/src/ktt/lib/engine.ts`
- Test: `hugo-apps/src/ktt/__tests__/engine.test.ts`

**Interfaces:**
- Produces:
  - `createSession(lesson: KttLesson): Session` where `Session = { beats: KttBeat[]; index: number; xp: number; correct: number; wrong: number; queue: number[] }`.
  - `currentBeat(s): KttBeat | null`
  - `answerDrill(s, answer: string): { correct: boolean; requeued: boolean }` — wrong answers push the beat index to the end of `queue` (re-queue once); correct awards `XP_PER_CORRECT`.
  - `advance(s): void` — moves to the next queued beat.
  - `isComplete(s): boolean`
  - constant `XP_PER_CORRECT = 10`.

- [ ] **Step 1: Write the failing test** — `hugo-apps/src/ktt/__tests__/engine.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createSession, currentBeat, answerDrill, advance, isComplete, XP_PER_CORRECT } from '../lib/engine';

const lesson = { id: 'core-1', legacyId: 90001, title: 't', acronyms: [], beats: [
  { type: 'story', kasimir: 'hi', mood: 'teaching' },
  { type: 'drill', kind: 'mc', tla: 'BTP', prompt: '?', answer: 'Business Technology Platform',
    distractors: ['a','b'], kasimirRight: 'y', kasimirWrong: 'n' },
]} as any;

describe('engine', () => {
  it('awards XP on correct and re-queues on wrong', () => {
    const s = createSession(lesson);
    advance(s); // move past story to drill
    expect(currentBeat(s).type).toBe('drill');
    const wrong = answerDrill(s, 'a');
    expect(wrong.correct).toBe(false);
    expect(wrong.requeued).toBe(true);
    advance(s);
    const right = answerDrill(s, 'Business Technology Platform');
    expect(right.correct).toBe(true);
    expect(s.xp).toBe(XP_PER_CORRECT);
    advance(s);
    expect(isComplete(s)).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- hugo-apps/src/ktt/__tests__/engine.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `hugo-apps/src/ktt/lib/engine.ts`** to satisfy the interface above (session tracks a `queue` of remaining beat indices; `answerDrill` compares case-insensitively; wrong beats re-queue at most once via a `requeuedSet`).

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- hugo-apps/src/ktt/__tests__/engine.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hugo-apps/src/ktt/lib/engine.ts hugo-apps/src/ktt/__tests__/engine.test.ts
git commit -m "feat(ktt): pure lesson engine — scoring, XP, wrong-answer re-queue"
```

---

### Task 10: `KasimirStage` — rigged SVG + mood state machine

**Files:**
- Replace stub: `hugo-apps/src/ktt/components/KasimirStage.vue`
- Test: `hugo-apps/src/ktt/__tests__/KasimirStage.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: component prop `mood: 'idle'|'teaching'|'thinking'|'correct'|'wrong'|'celebrate'`. Root element carries `class="kasimir kasimir--<mood>"` and `aria-hidden="true"`. Honors `prefers-reduced-motion` by adding `kasimir--still`.

- [ ] **Step 1: Write the failing test** — `hugo-apps/src/ktt/__tests__/KasimirStage.test.ts`:

```ts
// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import KasimirStage from '../components/KasimirStage.vue';

describe('KasimirStage', () => {
  it('reflects mood in the root class and is aria-hidden', () => {
    const w = mount(KasimirStage, { props: { mood: 'celebrate' } });
    const root = w.find('.kasimir');
    expect(root.classes()).toContain('kasimir--celebrate');
    expect(root.attributes('aria-hidden')).toBe('true');
    expect(w.find('svg').exists()).toBe(true);
  });
  it('switches class when mood changes', async () => {
    const w = mount(KasimirStage, { props: { mood: 'idle' } });
    await w.setProps({ mood: 'wrong' });
    expect(w.find('.kasimir').classes()).toContain('kasimir--wrong');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- hugo-apps/src/ktt/__tests__/KasimirStage.test.ts`
Expected: FAIL (stub has no `svg`/mood class).

- [ ] **Step 3: Implement `KasimirStage.vue`.** Build an **original stylized SVG Kasimir** (grey tuxedo body, white blaze/muzzle/chest/paws, big blue eyes + pupils, pink nose, dark collar + blue SAP-arrow tag) with each animated part as its own `<g id="...">` (`ears`, `eyelids`, `pupils`, `mouth`, `whiskers`, `tail`, `pawLeft`, `pawRight`, `head`, `body`). Root binds the mood class; CSS keyframes per mood drive the rig; `prefers-reduced-motion` freezes to a calm pose. Structure:

```vue
<script setup lang="ts">
defineProps<{ mood: 'idle'|'teaching'|'thinking'|'correct'|'wrong'|'celebrate' }>();
</script>
<template>
  <div class="kasimir" :class="`kasimir--${mood}`" aria-hidden="true">
    <svg viewBox="0 0 200 200" role="img">
      <g id="tail" class="k-tail"><!-- grey tail w/ white tip --></g>
      <g id="body" class="k-body"><!-- grey body, white chest --></g>
      <g id="head" class="k-head">
        <g id="ears" class="k-ears"><!-- two ears --></g>
        <!-- white blaze + muzzle -->
        <g id="eyelids" class="k-eyelids"><!-- blink --></g>
        <g id="pupils" class="k-pupils"><!-- big blue eyes --></g>
        <path id="nose" class="k-nose"/><!-- pink nose -->
        <g id="mouth" class="k-mouth"/>
        <g id="whiskers" class="k-whiskers"/>
      </g>
      <g id="pawLeft" class="k-paw-left"/><g id="pawRight" class="k-paw-right"/>
      <g id="collar" class="k-collar"><!-- dark collar + blue SAP-arrow tag --></g>
    </svg>
  </div>
</template>
<style scoped>
/* idle: breathing + tail flick + periodic blink; teaching: gesture; thinking: ear twitch + eyes up;
   correct: ears perk + sparkle; wrong: facepalm paw + flat ears; celebrate: hop + confetti.
   Mood classes toggle animations on the .k-* groups. */
@media (prefers-reduced-motion: reduce) { .kasimir * { animation: none !important; } }
.kasimir--idle .k-tail { animation: k-tail-flick 3.5s ease-in-out infinite; }
@keyframes k-tail-flick { 0%,100% { transform: rotate(0); } 50% { transform: rotate(6deg); } }
/* ...remaining per-mood keyframes... */
</style>
```

> The functional contract (prop → root class → `svg` present → reduced-motion) is fully tested here. **Visual refinement of the SVG paths against the reference images is an in-task iteration** using `run` to view the island in a browser; the art is original stylized vector work (SAP-owned likeness, recreated — not a copy of the source illustrations). Ship a recognizable Kasimir; polish is expected before the flag flips ON.

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- hugo-apps/src/ktt/__tests__/KasimirStage.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hugo-apps/src/ktt/components/KasimirStage.vue hugo-apps/src/ktt/__tests__/KasimirStage.test.ts
git commit -m "feat(ktt): rigged SVG Kasimir with mood state machine + reduced-motion"
```

---

### Task 11: `SkillTreeMap` component

**Files:**
- Create: `hugo-apps/src/ktt/components/SkillTreeMap.vue`
- Test: `hugo-apps/src/ktt/__tests__/SkillTreeMap.test.ts`

**Interfaces:**
- Consumes: `lessons: KttData`, `mastered: string[]` (lesson ids), emits `select(lessonId: string)`.
- Produces: renders one node per lesson; a node is `is-locked` unless it's the first of a unit or its previous sibling id is in `mastered`; mastered nodes get `is-done`.

- [ ] **Step 1: Write the failing test** — assert: given two lessons in a unit and `mastered=[]`, the first node is selectable and the second has class `is-locked`; clicking the first emits `select` with its id; with `mastered=['core-1']`, `core-2` is unlocked.

- [ ] **Step 2: Run to verify it fails.** Run: `npm test -- hugo-apps/src/ktt/__tests__/SkillTreeMap.test.ts` → FAIL.

- [ ] **Step 3: Implement `SkillTreeMap.vue`** to satisfy the lock/unlock/done + emit contract above. Include a `<KasimirStage mood="idle" />` beside the map.

- [ ] **Step 4: Run to verify it passes.** Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hugo-apps/src/ktt/components/SkillTreeMap.vue hugo-apps/src/ktt/__tests__/SkillTreeMap.test.ts
git commit -m "feat(ktt): skill-tree map with lesson lock/unlock/done states"
```

---

### Task 12: `Lesson` component + wire App screens + local progress + server client

**Files:**
- Create: `hugo-apps/src/ktt/components/Lesson.vue`, `hugo-apps/src/ktt/components/Results.vue`, `hugo-apps/src/ktt/lib/progress.ts`, `hugo-apps/src/ktt/lib/server.ts`
- Modify: `hugo-apps/src/ktt/App.vue`
- Test: `hugo-apps/src/ktt/__tests__/progress.test.ts`, `hugo-apps/src/ktt/__tests__/Lesson.test.ts`

**Interfaces:**
- Produces:
  - `progress.ts`: `loadLocal(): { xp:number; streak:number; mastered:string[] }`, `saveLocal(p)`, `mergeProgress(local, remote)` (same union/max semantics as the backend `srv/lib/ktt/merge.js`).
  - `server.ts`: `isAuthenticated(): Promise<boolean>` (probes `/auth/user`, checks JSON `body.authenticated`, NOT `r.ok`), `completeLesson(apiUrl, {lessonSlug, legacyId, title})`, `syncProgress(apiUrl, local)`, `fetchBanter(apiUrl, context)`. All server calls are best-effort: failures are caught and never throw into the UI.
  - `Lesson.vue`: props `lesson`, drives the Task 9 engine, shows current beat, binds `KasimirStage` mood (`teaching` on story, `correct`/`wrong` after answers, `celebrate` on complete), emits `complete(lessonId)`.

- [ ] **Step 1: Write failing `progress.test.ts`** — assert `saveLocal`/`loadLocal` round-trip via `localStorage` (happy-dom), and `mergeProgress` matches the backend semantics (union mastered, max xp/streak). Reuse the exact expectation from `test/unit/ktt-merge.test.js`.

- [ ] **Step 2: Run to verify it fails.** Run: `npm test -- hugo-apps/src/ktt/__tests__/progress.test.ts` → FAIL.

- [ ] **Step 3: Implement `progress.ts` and `server.ts`.** `isAuthenticated` must parse JSON and check `body.authenticated` (per the platform's auth-probe gotcha). `server.ts` uses native `fetch`.

- [ ] **Step 4: Write failing `Lesson.test.ts`** — mount `Lesson` with a two-beat lesson (story + one drill), simulate a correct answer, assert XP shows and `complete` is emitted after the last beat; assert Kasimir mood becomes `celebrate` on completion. Stub `server.ts` via `vi.mock`.

- [ ] **Step 5: Run to verify it fails.** → FAIL.

- [ ] **Step 6: Implement `Lesson.vue` + `Results.vue`, and wire `App.vue`:** landing → map (`SkillTreeMap`) → lesson (`Lesson`) → results (`Results`). On `Lesson`'s `complete`: update local progress (`saveLocal`), then if `isAuthenticated()` call `completeLesson` + `syncProgress` (best-effort), then show `Results` / return to map with the node marked done. Fetch a `banter` line opportunistically (fail-open — never block).

- [ ] **Step 7: Run all ktt island tests.** Run: `npm test -- hugo-apps/src/ktt` → PASS.

- [ ] **Step 8: srv/lib cp-list audit.** Confirm no new `srv/lib/ktt/*` file is imported (transitively) by `srv/lib/content-store.js`:

Run: `npx ast-grep -p "require('./ktt/$_')" srv/lib/content-store.js` (and grep for `ktt/` import specifiers reachable from it). Expected: no matches → no `.deploy/mta.yaml` `srv-qa` cp-list change needed. If any match appears, add the file(s) to the `srv-qa` `cp` list.

- [ ] **Step 9: Commit**

```bash
git add hugo-apps/src/ktt
git commit -m "feat(ktt): lesson runner, results, local progress + best-effort server sync"
```

---

## Phase D — Hugo page, nav, build wiring, e2e

### Task 13: Hugo page + layout (SSR shell + island mount)

**Files:**
- Create: `hugo/content/explore/ktt/_index.md`, `hugo/layouts/explore/ktt.html`
- Test: manual Hugo render (`npm run dev`) — verified in Task 16 build.

**Interfaces:**
- Consumes: `hugo/data/ktt_lessons.json` (Task 7); `island-src.html` partial (`ktt`).
- Produces: `/explore/ktt/` route rendering an SSR shell + `#ktt-mount` with `data-api="/ktt"` and `data-lessons` = the baked lessons JSON.

- [ ] **Step 1: Create `hugo/content/explore/ktt/_index.md`:**

```yaml
---
title: "KTT — Kasimir Teaches TLAs"
description: "Professor Kasimir teaches you SAP's endless three-letter acronyms — a mostly-fun, tongue-in-cheek trainer."
type: explore
layout: ktt
slug: ktt
---
```

- [ ] **Step 2: Create `hugo/layouts/explore/ktt.html`:**

```html
{{ define "main" }}
<main id="ktt-mount"
      data-page-kind="ktt"
      data-api="/ktt"
      data-lessons='{{ site.Data.ktt_lessons | jsonify }}'>
  <!-- SSR shell so the route is not an empty div for crawlers -->
  <section class="ktt-ssr">
    <h1>{{ .Title }}</h1>
    <p>{{ .Description }}</p>
    <ul>
      {{ range site.Data.ktt_lessons.units }}<li>{{ .title }}</li>{{ end }}
    </ul>
  </section>
</main>
<noscript><p>KTT needs JavaScript to play. The unit list above summarizes what Kasimir covers.</p></noscript>
<script type="module" src="{{ partial "island-src.html" "ktt" }}" defer></script>
{{ end }}
```

- [ ] **Step 3: Commit**

```bash
git add hugo/content/explore/ktt/_index.md hugo/layouts/explore/ktt.html
git commit -m "feat(ktt): Hugo page + layout with SSR shell and island mount"
```

---

### Task 14: Explore nav entry

**Files:**
- Modify: `hugo/data/navigation.yaml` (under the `id: explore` group, `:82`)

- [ ] **Step 1: Add the menu item** under the Explore group (mirror the existing explore items' fields):

```yaml
- id: explore-ktt
  label: "Kasimir Teaches TLAs"
  href: /explore/ktt/
  icon: learning-assistant
  paletteLabel: "KTT — Kasimir Teaches TLAs"
  keywords: ["acronym", "tla", "kasimir", "quiz", "learn"]
```

- [ ] **Step 2: Verify Hugo builds the nav** — `npm run dev`, load `/`, confirm "Kasimir Teaches TLAs" appears under Explore and links to `/explore/ktt/`.

- [ ] **Step 3: Commit**

```bash
git add hugo/data/navigation.yaml
git commit -m "feat(ktt): add KTT to the Explore navigation menu"
```

---

### Task 15: Wire content generation into `build:all`

**Files:**
- Modify: `package.json` (`build:all`)

- [ ] **Step 1: Insert `generate-ktt-lessons`** into the leading `fetch-*` chain of `build:all` (before `build:apps`), analogous to `fetch-tutorials`:

```
... && npm run fetch-featured-topics && npm run fetch-topic-clusters && npm run generate-ktt-lessons && npm run build:icon-subset && ...
```

- [ ] **Step 2: Run a scoped build to verify wiring** — regenerate lessons + build apps + manifest + hugo:

Run: `npm run generate-ktt-lessons && npm run build:apps && npm run build:island-manifest`
Expected: `hugo/data/ktt_lessons.json` regenerated; `hugo/static/js/ktt-<hash>.js` produced; `ktt` key present in `hugo/data/island_manifest.json`.

- [ ] **Step 3: Verify the page renders end-to-end** — `npm run build:hugo` then serve `hugo/public/explore/ktt/index.html`; confirm the `#ktt-mount` `data-lessons` is populated and the script src is the hashed `/js/ktt-<hash>.js`.

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -m "build(ktt): generate ktt lessons as part of build:all"
```

---

### Task 16: Post-deploy e2e smoke (self-skipping)

**Files:**
- Create: `test/e2e/ktt.spec.ts`

**Interfaces:**
- Consumes: `SMOKE_BASE_URL` env (self-skips when absent, per the platform e2e pattern).

- [ ] **Step 1: Write `test/e2e/ktt.spec.ts`** — skip unless `SMOKE_BASE_URL` set; navigate to `${SMOKE_BASE_URL}/explore/ktt/`; assert the SSR shell `<h1>` and unit list render; click `[data-testid="ktt-start"]`; assert the map screen appears; start the first lesson; answer one drill; assert Kasimir/feedback updates. Follow the structure in `test/e2e/README.md`.

- [ ] **Step 2: Local self-skip check**

Run: `npm run test:e2e` (with `SMOKE_BASE_URL` unset)
Expected: test self-skips (no failure).

- [ ] **Step 3: Commit**

```bash
git add test/e2e/ktt.spec.ts
git commit -m "test(ktt): post-deploy e2e smoke for /explore/ktt/ (self-skipping)"
```

---

## Final verification (before opening the PR)

- [ ] Run the full unit suite: `npm test` → PASS (KTT + no regressions).
- [ ] `npx cds deploy --to sqlite::memory:` → clean.
- [ ] `npm run build:all` (with `CAP_BASE_URL` pointed at the deployed backend per repo convention) → completes; `ktt` island hashed + in manifest; `/explore/ktt/` renders.
- [ ] Confirm `KTT_ENABLED` is **OFF** by default (route/endpoints fail closed) — flip ON only after DEV verification.
- [ ] `git fetch origin` and diff the branch against `origin/DEV` (KTT work targets DEV, not main).
- [ ] Open a PR to **DEV** (`gh pr create`), not a direct merge.

---

## Deferred Work (explicitly out of v1 scope)

1. **Unit-level rollup.** Seed each unit as a mission-style parent (`Missions`/`Groups` row) with `CompletionPathItems` children `KTT_LESSON:<legacyId>`, and add a `rollUpParentsForCompletion({ task:{ taskType:'KTT_LESSON', taskLegacyId } })` call in `completeLesson`. `completion-rollup.js:159` then produces "unit mastered" rows with no rollup-code change. Requires confirming the Missions/`CompletionPathItems` seed shape first (not specified here to avoid guessing).
2. **Endless mode** over the full acronym firehose — the engine's beat source is already pluggable; add a CAP-backed acronym feed.
3. **Per-acronym `STEP` completion rows** for finer mastery tracking.
4. **NGDS autosend** for KTT completions.
5. **Homepage/featured surfacing** and gameboard scoring tie-ins.
