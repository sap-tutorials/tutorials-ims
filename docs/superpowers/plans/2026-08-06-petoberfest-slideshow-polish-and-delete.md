# Petoberfest Slideshow Polish + Admin Delete Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the public Petoberfest slideshow a fixed-height framed "stage" with pause/resume + prev/next + dot controls (killing the input-jump), and add a guarded permanent-delete to the Admin UI for HIDDEN submissions (single- and multi-row).

**Architecture:** Two independent pieces. (1) Frontend — rework the existing Vue island `hugo-apps/src/petoberfest/App.vue` (fixed-aspect letterbox stage, scoped festive styles, slideshow controls). No backend touched. (2) Backend + Admin — a new guarded `purge()` bound action on `AdminService.PetSubmissions` that hard-DELETEs a row (and its image BLOB columns) only when `moderation === 'HIDDEN'`, surfaced as a "Delete" `DataFieldForAction` in the Fiori Elements List Report (multi-select, `ForceMulti` already enabled) and Object Page.

**Tech Stack:** Vue 3 (`<script setup>` + scoped `<style>`, Vite island), SAP CAP (Node.js, CDS), SAP Fiori Elements (OData V4 annotations), Vitest.

## Global Constraints

- Island styling convention: scoped `<style>` block on the `.vue` file (no global CSS file for this island). Copied verbatim from spec.
- Admin moderation auth gate: `@(requires: ['Tutorial.Author', 'Admin'])` on each action; `AdminService` is `@requires:'Admin'` at service level (ANDs).
- Delete is permitted ONLY when `moderation === 'HIDDEN'`. Non-HIDDEN rows reject with 400.
- Keep `Capabilities.DeleteRestrictions.Deletable: false` on `PetSubmissions` — delete flows through the guarded action, not native OData DELETE.
- Bound-action key resolution pattern: `req.params?.[0]?.ID ?? req.params?.[0]`.
- Never SELECT a HANA BLOB alongside metadata in one CDS QL query (LOB locators expire). The purge guard SELECTs only the `moderation` scalar; the DELETE removes BLOB columns as a side effect of row removal — no BLOB read.
- Admin UI5 fragment/annotation changes require an `applicationVersion` bump in the app manifest (IndexedDB cache bust) and a FULL `mbt build` deploy (no `--skip-build`/`-m` scoping) — deploy is out of scope for this plan but the version bump is in scope.
- Unit tests bootstrap with `cds.test('serve', '--project', '.', '--in-memory')`; `req.reject(404)` surfaces as `{ code: 404 }`. Rejections asserted via `.rejects.toMatchObject({ code: N })`.

---

## File Structure

- `hugo-apps/src/petoberfest/App.vue` — MODIFY. Add stage wrapper, controls, pause state, scoped styles.
- `srv/admin-service.cds` — MODIFY. Declare `action purge()` on `PetSubmissions`.
- `srv/admin-service.js` — MODIFY. Add `purge` handler with HIDDEN guard next to `approve`/`hide`.
- `app/admin-annotations.cds` — MODIFY. Add Delete `DataFieldForAction` to `PetSubmissions` `UI.LineItem` + `UI.Identification`.
- `app/admin/petoberfest/webapp/manifest.json` — MODIFY. Bump `applicationVersion`.
- `test/unit/petoberfest-admin.test.js` — MODIFY. Add purge success + guard-rejection tests.
- `hugo-apps/src/petoberfest/__tests__/` — MODIFY/CREATE. Add a component test for pause/nav behavior (see Task 1 for existing-file check).

---

## Task 1: Slideshow controls + fixed-height stage (frontend)

**Files:**
- Modify: `hugo-apps/src/petoberfest/App.vue`
- Test: `hugo-apps/src/petoberfest/__tests__/App.test.ts` (check first whether it exists; the dir `__tests__` is present)

**Interfaces:**
- Consumes: `fetchSlideshow`, `fetchMyUploads`, `uploadPet`, `probeAuth`, `photoUrl`, `SlideEntry`, `MyUpload` from `./lib/server` (unchanged signatures).
- Produces: no exported symbols; this is a leaf UI component. Behavior contract: component exposes reactive `paused`, `idx` and functions `next()`, `prev()`, `goTo(i)`, `togglePlay()` used by the template.

- [ ] **Step 1: Inspect existing island tests**

Run: `ls hugo-apps/src/petoberfest/__tests__/` and read any file there.
Purpose: match the existing test harness style (Vitest + `@vue/test-utils` `mount`, or plain function tests). Adopt whatever pattern is already used in this island or a sibling island (e.g. `hugo-apps/src/concepts-filter/`). If no test util is set up for this island, write a logic-only test around the timer/pause functions by extracting them, OR mount with `@vue/test-utils` if that's the sibling convention.

- [ ] **Step 2: Write the failing test for pause + manual nav**

Create/extend `hugo-apps/src/petoberfest/__tests__/App.test.ts`. Mock `./lib/server` so `fetchSlideshow` returns 3 slides, `probeAuth` returns `false` (skip upload branch), `fetchMyUploads` returns `[]`.

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';

vi.mock('../lib/server', () => ({
  fetchSlideshow: vi.fn().mockResolvedValue([
    { id: 'a', petName: 'Rex', uploaderName: 'Tom', uploadedAt: '' },
    { id: 'b', petName: 'Milo', uploaderName: 'Sam', uploadedAt: '' },
    { id: 'c', petName: 'Kit', uploaderName: 'Lee', uploadedAt: '' },
  ]),
  fetchMyUploads: vi.fn().mockResolvedValue([]),
  uploadPet: vi.fn(),
  probeAuth: vi.fn().mockResolvedValue(false),
  photoUrl: (id: string) => `/petoberfest-api/photo/${id}?size=display`,
}));

import App from '../App.vue';

describe('petoberfest slideshow controls', () => {
  beforeEach(() => vi.useFakeTimers());

  it('advances automatically when playing, stops when paused', async () => {
    const w = mount(App, { props: { slug: 'petoberfest-2026' } });
    await flushPromises();               // resolve fetchSlideshow
    expect(w.vm.idx).toBe(0);
    vi.advanceTimersByTime(5000);
    expect(w.vm.idx).toBe(1);            // auto-advanced
    w.vm.togglePlay();                    // pause
    vi.advanceTimersByTime(5000);
    expect(w.vm.idx).toBe(1);            // stayed put while paused
  });

  it('prev/next/goTo change the slide regardless of pause', async () => {
    const w = mount(App, { props: { slug: 'petoberfest-2026' } });
    await flushPromises();
    w.vm.togglePlay();                    // pause first
    w.vm.next(); expect(w.vm.idx).toBe(1);
    w.vm.next(); expect(w.vm.idx).toBe(2);
    w.vm.next(); expect(w.vm.idx).toBe(0);   // wraps
    w.vm.prev(); expect(w.vm.idx).toBe(2);   // wraps back
    w.vm.goTo(1); expect(w.vm.idx).toBe(1);
  });
});
```

Note: `w.vm.<fn>` access requires the functions/refs to be returned from `<script setup>` (they are auto-exposed to the template; `@vue/test-utils` exposes template-referenced bindings on `vm`). If the sibling-island convention differs, adapt the assertion mechanism but keep the same three behaviors.

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd hugo-apps && npx vitest run src/petoberfest/__tests__/App.test.ts`
Expected: FAIL — `togglePlay`/`next`/`prev`/`goTo` are not defined yet, or `idx` doesn't advance/pause as asserted.

- [ ] **Step 4: Implement the script changes in `App.vue`**

Replace the `<script setup>` timer/advance section. Add `paused`, `goTo`, `next`, `prev`, `togglePlay`, and make the interval respect `paused`. Reset the timer on manual nav while playing.

```ts
const paused = ref(false);
let timer: number | undefined;

function startTimer() {
  if (timer !== undefined) { clearInterval(timer); timer = undefined; }
  if (slides.value.length > 1) {
    timer = window.setInterval(() => { if (!paused.value) advance(); }, 5000);
  }
}
function advance() { if (slides.value.length) idx.value = (idx.value + 1) % slides.value.length; }
function next() {
  if (!slides.value.length) return;
  idx.value = (idx.value + 1) % slides.value.length;
  if (!paused.value) startTimer();          // full interval after manual step
}
function prev() {
  if (!slides.value.length) return;
  idx.value = (idx.value - 1 + slides.value.length) % slides.value.length;
  if (!paused.value) startTimer();
}
function goTo(i: number) {
  if (i < 0 || i >= slides.value.length) return;
  idx.value = i;
  if (!paused.value) startTimer();
}
function togglePlay() { paused.value = !paused.value; }
```

In `onMounted`, after `slides.value = await fetchSlideshow(...)`, call `startTimer()` (replacing the old `if (slides.value.length > 1) timer = window.setInterval(advance, 5000)`). Keep `onUnmounted(() => { if (timer !== undefined) clearInterval(timer); })`.

- [ ] **Step 5: Update the template to render controls + stage**

Replace the `.pet-slideshow` section. Structure: festive title band, fixed-aspect `.pet-stage` holding the image + overlaid arrows + caption plate, and a control bar with play-pause toggle and dots.

```html
<section class="pet-slideshow" v-if="slides.length">
  <div class="pet-titleband">🐾 Petoberfest 🐾</div>
  <div class="pet-frame">
    <button class="pet-nav pet-nav--prev" @click="prev" aria-label="Previous pet">‹</button>
    <div class="pet-stage">
      <img :src="photoUrl(slides[idx].id, 'display')" :alt="slides[idx].petName || 'pet'" />
    </div>
    <button class="pet-nav pet-nav--next" @click="next" aria-label="Next pet">›</button>
    <p class="pet-caption">
      <strong>{{ slides[idx].petName || 'A good pet' }}</strong>
      <span v-if="slides[idx].uploaderName"> — {{ slides[idx].uploaderName }}</span>
    </p>
  </div>
  <div class="pet-controls">
    <button class="pet-play" @click="togglePlay"
            :aria-label="paused ? 'Play slideshow' : 'Pause slideshow'">
      {{ paused ? '▶' : '⏸' }}
    </button>
    <div class="pet-dots">
      <button v-for="(s, i) in slides" :key="s.id"
              class="pet-dot" :class="{ 'pet-dot--active': i === idx }"
              @click="goTo(i)" :aria-label="`Go to pet ${i + 1}`"></button>
    </div>
  </div>
</section>
<p v-else class="pet-empty">No pets yet — be the first! 🐾</p>
```

- [ ] **Step 6: Add the scoped festive styles**

Append a `<style scoped>` block to `App.vue`. The load-bearing rules are the fixed-aspect stage and `object-fit: contain` (this is what stops the jump).

```html
<style scoped>
.pet-slideshow { max-width: 720px; margin: 1.5rem auto; text-align: center; }
.pet-titleband {
  font-size: 1.4rem; font-weight: 700; letter-spacing: .02em;
  color: #7a3e00; margin-bottom: .5rem;
}
.pet-frame {
  position: relative; background: #fff8f0;
  border: 1px solid #e8d3b8; border-radius: 16px;
  box-shadow: 0 6px 24px rgba(122, 62, 0, .12);
  padding: 12px 12px 8px; overflow: hidden;
}
/* Fixed-aspect stage: image letterboxed, never reflows the page. */
.pet-stage {
  aspect-ratio: 16 / 10; max-height: 60vh;
  display: flex; align-items: center; justify-content: center;
  background: #2b2b2b; border-radius: 10px; overflow: hidden;
}
.pet-stage img { max-width: 100%; max-height: 100%; object-fit: contain; display: block; }
.pet-caption {
  margin: .6rem 0 .2rem; color: #5a4632; font-size: 1rem;
}
.pet-nav {
  position: absolute; top: 50%; transform: translateY(-50%);
  z-index: 2; border: none; cursor: pointer;
  width: 40px; height: 40px; border-radius: 50%;
  background: rgba(255,255,255,.85); color: #7a3e00;
  font-size: 1.6rem; line-height: 1;
  box-shadow: 0 2px 6px rgba(0,0,0,.2);
}
.pet-nav--prev { left: 18px; }
.pet-nav--next { right: 18px; }
.pet-nav:hover { background: #fff; }
.pet-controls {
  display: flex; align-items: center; justify-content: center;
  gap: 1rem; margin-top: .75rem;
}
.pet-play {
  border: none; cursor: pointer; width: 36px; height: 36px;
  border-radius: 50%; background: #d97706; color: #fff; font-size: 1rem;
}
.pet-dots { display: flex; gap: .4rem; }
.pet-dot {
  width: 10px; height: 10px; border-radius: 50%; border: none; padding: 0;
  cursor: pointer; background: #e0c3a0;
}
.pet-dot--active { background: #d97706; }
.pet-empty { text-align: center; color: #7a3e00; margin: 2rem 0; font-size: 1.1rem; }
</style>
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `cd hugo-apps && npx vitest run src/petoberfest/__tests__/App.test.ts`
Expected: PASS.

- [ ] **Step 8: Run the island build to catch template/TS errors**

Run: `cd hugo-apps && npm run build`
Expected: build succeeds; `petoberfest` entry compiles. (If the repo builds islands via a different script, use `jq '.scripts' hugo-apps/package.json` to find it.)

- [ ] **Step 9: Commit**

```bash
git add hugo-apps/src/petoberfest/App.vue hugo-apps/src/petoberfest/__tests__/App.test.ts
git commit -m "feat(petoberfest): framed slideshow stage with pause/prev/next/dots"
```

---

## Task 2: `purge` bound action — CDS declaration + guarded handler

**Files:**
- Modify: `srv/admin-service.cds:143-151` (the `PetSubmissions` projection `actions {}` block)
- Modify: `srv/admin-service.js:2294-2306` (next to `approve`/`hide` handlers)
- Test: `test/unit/petoberfest-admin.test.js`

**Interfaces:**
- Consumes: `this.entities.PetSubmissions`, CAP `UPDATE`/`SELECT`/`DELETE` query builders, `req.params`, `req.reject`, `req.reply` (same as existing `approve`/`hide`).
- Produces: OData action `AdminService.purge` bound to `PetSubmissions`, referenced by Task 3 annotations as `Action: 'AdminService.purge'`.

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/petoberfest-admin.test.js`. These run after the existing `hide` test has already set `s1` to HIDDEN, but to stay order-independent, seed fresh rows.

```js
test('purge deletes a HIDDEN submission (row and blobs gone)', async () => {
  const { Petoberfests, PetSubmissions, Users } = cds.entities('com.sap.developers.ims');
  await db.run(INSERT.into(PetSubmissions).entries({
    ID: 'del-hidden', petoberfest_ID: 'p1', user_ID: 'u1', petName: 'ToDelete',
    moderation: 'HIDDEN', mimeType: 'image/webp', uploadedAt: '2026-08-01T00:00:00Z',
  }));
  const srv = await cds.connect.to('AdminService');
  await srv.tx({ user: ADMIN_USER }, (tx) =>
    tx.send({ event: 'purge', entity: 'PetSubmissions', params: [{ ID: 'del-hidden' }] }));
  const row = await db.run(SELECT.one.from(PetSubmissions).where({ ID: 'del-hidden' }));
  expect(row).toBeUndefined();
});

test('purge rejects a PENDING submission (400)', async () => {
  const { PetSubmissions } = cds.entities('com.sap.developers.ims');
  await db.run(INSERT.into(PetSubmissions).entries({
    ID: 'del-pending', petoberfest_ID: 'p1', user_ID: 'u1', petName: 'Nope',
    moderation: 'PENDING', mimeType: 'image/webp', uploadedAt: '2026-08-01T00:00:00Z',
  }));
  const srv = await cds.connect.to('AdminService');
  await expect(
    srv.tx({ user: ADMIN_USER }, (tx) =>
      tx.send({ event: 'purge', entity: 'PetSubmissions', params: [{ ID: 'del-pending' }] }))
  ).rejects.toMatchObject({ code: 400 });
  const row = await db.run(SELECT.one.from(PetSubmissions).where({ ID: 'del-pending' }));
  expect(row).toBeDefined();     // still there
});

test('purge rejects an APPROVED submission (400)', async () => {
  const { PetSubmissions } = cds.entities('com.sap.developers.ims');
  await db.run(INSERT.into(PetSubmissions).entries({
    ID: 'del-approved', petoberfest_ID: 'p1', user_ID: 'u1', petName: 'Live',
    moderation: 'APPROVED', mimeType: 'image/webp', uploadedAt: '2026-08-01T00:00:00Z',
  }));
  const srv = await cds.connect.to('AdminService');
  await expect(
    srv.tx({ user: ADMIN_USER }, (tx) =>
      tx.send({ event: 'purge', entity: 'PetSubmissions', params: [{ ID: 'del-approved' }] }))
  ).rejects.toMatchObject({ code: 400 });
});

test('authenticated-user without Admin is rejected (403) from purge', async () => {
  const { PetSubmissions } = cds.entities('com.sap.developers.ims');
  await db.run(INSERT.into(PetSubmissions).entries({
    ID: 'del-unpriv', petoberfest_ID: 'p1', user_ID: 'u1', petName: 'Guard',
    moderation: 'HIDDEN', mimeType: 'image/webp', uploadedAt: '2026-08-01T00:00:00Z',
  }));
  const srv = await cds.connect.to('AdminService');
  await expect(
    srv.tx({ user: UNPRIV_USER }, (tx) =>
      tx.send({ event: 'purge', entity: 'PetSubmissions', params: [{ ID: 'del-unpriv' }] }))
  ).rejects.toMatchObject({ code: 403 });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/unit/petoberfest-admin.test.js`
Expected: the four new tests FAIL (purge unknown event / not rejected as designed). Existing approve/hide/403 tests still pass.

- [ ] **Step 3: Declare the action in `srv/admin-service.cds`**

In the `PetSubmissions` projection `actions {}` block (currently holding `approve`/`hide` at lines 146-151), add:

```cds
    @(requires: ['Tutorial.Author', 'Admin'])
    action purge();
```

Resulting block:

```cds
  } actions {
    @(requires: ['Tutorial.Author', 'Admin'])
    action approve();
    @(requires: ['Tutorial.Author', 'Admin'])
    action hide();
    @(requires: ['Tutorial.Author', 'Admin'])
    action purge();
  };
```

- [ ] **Step 4: Implement the handler in `srv/admin-service.js`**

Immediately after the `hide` handler (ends line 2306), add:

```js
    // purge — permanent DELETE of a submission (row + BLOB columns). Guarded:
    // only HIDDEN submissions may be deleted (Hide-first). Same auth as approve/hide.
    // SELECT only the moderation scalar — never read BLOBs alongside (LOB hygiene);
    // the row DELETE removes photoDisplay/photoThumb as a side effect.
    this.on('purge', PetSubmissions, async (req) => {
      const id = req.params?.[0]?.ID ?? req.params?.[0];
      if (!id) return req.reject(400, 'purge: missing entity key');
      const row = await SELECT.one.from(this.entities.PetSubmissions).columns('moderation').where({ ID: id });
      if (!row) return req.reject(404, 'purge: submission not found');
      if (row.moderation !== 'HIDDEN') {
        return req.reject(400, 'Only hidden submissions can be deleted — hide it first.');
      }
      await DELETE.from(this.entities.PetSubmissions).where({ ID: id });
      return req.reply();
    });
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/unit/petoberfest-admin.test.js`
Expected: all tests PASS (existing 5 + new 4).

- [ ] **Step 6: Validate the CDS model compiles**

Run: `npx cds compile srv/admin-service.cds > /dev/null && echo OK`
Expected: `OK` (no compile errors from the new action).

- [ ] **Step 7: Commit**

```bash
git add srv/admin-service.cds srv/admin-service.js test/unit/petoberfest-admin.test.js
git commit -m "feat(petoberfest): guarded purge action deletes HIDDEN submissions from DB"
```

---

## Task 3: Surface "Delete" in the Admin UI (annotations + version bump)

**Files:**
- Modify: `app/admin-annotations.cds:3886-3922` (`PetSubmissions` `UI.LineItem` + `UI.Identification`)
- Modify: `app/admin/petoberfest/webapp/manifest.json:8` (`applicationVersion.version`)

**Interfaces:**
- Consumes: `AdminService.purge` action from Task 2.
- Produces: FE toolbar/object-page "Delete" button. No downstream code consumers.

- [ ] **Step 1: Add the Delete action to `UI.LineItem`**

In `app/admin-annotations.cds`, in the `PetSubmissions` `UI.LineItem` array (after the `hide` DataFieldForAction at line 3894), add:

```cds
    { $Type: 'UI.DataFieldForAction', Action: 'AdminService.purge', Label: 'Delete' }
```

- [ ] **Step 2: Add the Delete action to `UI.Identification`**

In the same annotate block, in `UI.Identification` (after the `hide` action at line 3917), add the same line:

```cds
    { $Type: 'UI.DataFieldForAction', Action: 'AdminService.purge', Label: 'Delete' }
```

- [ ] **Step 3: Bump the admin app version**

In `app/admin/petoberfest/webapp/manifest.json`, change `"version": "0.1.4"` to `"version": "0.1.5"` (line 8, under `sap.app.applicationVersion`).

- [ ] **Step 4: Validate annotations compile against the service**

Run: `npx cds compile srv/admin-service.cds --to edmx > /dev/null && echo OK`
Expected: `OK` — the `AdminService.purge` reference resolves (proves Task 2's action name matches). If this errors with "unknown action", the annotation Action name is wrong or Task 2 wasn't applied.

- [ ] **Step 5: Run the full unit suite (guard against annotation/model breakage)**

Run: `npm test`
Expected: PASS (in-memory SQLite suite). Confirms the model still boots with the new annotations.

- [ ] **Step 6: Commit**

```bash
git add app/admin-annotations.cds app/admin/petoberfest/webapp/manifest.json
git commit -m "feat(petoberfest): expose Delete action in admin list + object page"
```

---

## Task 4: Manual verification notes (no code)

**Files:** none — this documents how to verify post-deploy (deploy itself is out of scope).

- [ ] **Step 1: Record the verification checklist in the PR description**

Frontend (after an island build ships to a running approuter, or via `npm run dev`):
- Load `/petoberfest/petoberfest-2026/`. Upload area stays put as slides of different aspect ratios cycle (no page jump).
- ⏸ pauses auto-advance; ▶ resumes. ‹ / › step and wrap. Dots jump and highlight the active slide.

Admin (after a FULL `mbt build` deploy — required for annotation + version bump to take effect; clear `ui5-cachemanager-db` IndexedDB if stale):
- Open `/admin-ui/#Petoberfest-manage`. A PENDING/APPROVED row's **Delete** is present but the server rejects it (toast: "Only hidden submissions can be deleted — hide it first.").
- **Hide** a row, then **Delete** it — row disappears; re-query confirms it's gone from the DB.
- Multi-select two HIDDEN rows in the List Report → **Delete** removes both.

- [ ] **Step 2: No commit** (documentation captured in PR body).

---

## Self-Review

**1. Spec coverage:**
- Input jump fix → Task 1 (fixed-aspect stage). ✓
- Chrome/framing → Task 1 (festive scoped styles). ✓
- Pause/resume + prev/next + dots → Task 1 (controls + tests). ✓
- Permanent delete from DB → Task 2 (purge handler DELETEs row + BLOB columns). ✓
- HIDDEN-only gating → Task 2 (guard + rejection tests). ✓
- Single- and multi-row from overview → Task 3 (LineItem DataFieldForAction on `ForceMulti` LR) + Task 4 verification. ✓
- Object-page single delete → Task 3 (Identification). ✓
- Auth unchanged → Task 2 (`@requires` mirrors approve/hide; 403 test). ✓
- Cache-bust version bump → Task 3 Step 3. ✓

**2. Placeholder scan:** No TBD/TODO; all steps carry real code or exact commands. ✓

**3. Type consistency:** Action named `purge` in CDS (Task 2 Step 3), handler `this.on('purge', ...)` (Task 2 Step 4), test event `'purge'` (Task 2 Step 1), annotation `Action: 'AdminService.purge'` (Task 3). Frontend fns `next/prev/goTo/togglePlay/paused/idx` consistent between template (Task 1 Step 5), script (Task 1 Step 4), and tests (Task 1 Step 2). ✓

**4. Ambiguity:** Delete-gating fixed to HIDDEN-only with explicit reject copy. Timer-reset-on-manual-nav behavior specified. ✓
