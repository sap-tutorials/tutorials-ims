# Daily Drawings UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A projector-friendly display app where an event operator picks an event, draws one random winner from people scanned as claiming a prize, and sees the winner's name/email revealed with the Kasimir mascot.

**Architecture:** A new CAP service (`srv/drawing-service.cds` + `.js`) at `@path:'/drawings'`, `@requires:'Admin'`, exposing three functions (`listEvents`, `pool`, `draw`). Randomness and PII resolution happen server-side; the browser receives only the one chosen winner. A new standalone Vue 3 + Vite app (`app/display-app-drawings/`, sibling to `app/display-app/`) served at `/drawings-ui/`, wired into the approuter (`Admin` scope) and the MTA builder.

**Tech Stack:** `@sap/cds` CAP service (Node.js, `cds.ql`), Vue 3 `<script setup>` + Vite, vitest + `cds.test` for backend tests.

**Spec:** `docs/superpowers/specs/2026-10-21-daily-drawings-ui-design.md`

## Global Constraints

- `cds.ql` / CQL only — never raw SQL.
- The drawing service and `/drawings-ui/` approuter route are gated on the **`Admin`** XSUAA scope (`@requires:'Admin'`).
- Winner PII (name + email) never leaves the server except the single drawn winner; `pool` and `listEvents` return no PII.
- `PrizeRecords.status` eligibility literal is exactly `'CLAIMED'`.
- Eligibility pool excludes anonymized users: anonymization sets `Users.displayName = 'ANONYMIZED'` and `email = null` (`srv/lib/anonymization.js`), so filter out `displayName = 'ANONYMIZED'`.
- Winner must render gracefully when `email` is null (common on PROD rows — backfills lazily on login): show name only.
- Follow the `/display` service + `app/display-app/` conventions exactly (CAP service with `resolveEvent` 404 pattern; Vite `base`, `main.ts`, generated `index.html`).
- Backend entities namespace: `com.sap.developers.ims`. Events keyed by `legacyId` (Integer) for all public lookups.

## Review Focus

- **Empty pool (event with zero CLAIMED claims):** `draw` must return `{ winner: null, eligibleCount: 0 }`, not error or crash. Covered in Task 2.
- **Unknown event id:** `pool`/`draw`/ with a `legacyId` that matches no `Events` row → 404, matching `/display`'s `resolveEvent`. Covered in Task 2.
- **All eligible claimers anonymized:** every CLAIMED claim points at `displayName='ANONYMIZED'` users → pool is empty (eligibleCount 0), no anonymized identity ever drawn. Covered in Task 2.
- **Duplicate claims by one user (cap-of-2):** a user with 2 CLAIMED rows counts once in the pool (draw people, not claims). Covered in Task 2.
- **Winner with null email:** `draw` returns the winner with `email: null`; UI shows name + "no email on file". Backend covered in Task 2; UI in Task 4.
- **Unauthorized caller (no Admin scope):** service returns 403. Covered in Task 1.

---

### Task 1: Drawing CAP service — skeleton, auth, `listEvents`

**Files:**
- Create: `srv/drawing-service.cds`
- Create: `srv/drawing-service.js`
- Test: `test/drawing-service.test.js`

**Interfaces:**
- Consumes: entities `Events`, `Users`, `PrizeRecords` from `com.sap.developers.ims`.
- Produces:
  - CDS service `DrawingService` at `@path:'/drawings'`, `@requires:'Admin'`.
  - `function listEvents() returns many { legacyId: Integer; name: String; startDate: Timestamp }` — events with ≥1 CLAIMED `PrizeRecords`, newest-first by `startDate`.

- [ ] **Step 1: Write the failing test** — in `test/drawing-service.test.js`, set up `cds.test('serve','--project','.','--in-memory')` with `adminAuth = { auth: { username:'admin', password:'admin' } }` and `devAuth = { auth:{ username:'developer', password:'developer' } }` (mocked creds, per `test/admin-service.test.js:6-7`). Seed in `beforeAll`: two `Events` (legacyId 7001 startDate 2026-06-01, legacyId 7002 startDate 2026-07-01), three `Users`, and `PrizeRecords` so that **only** event 7001 has a CLAIMED claim. Tests:
  - `rejects non-Admin` → `GET /drawings/listEvents()` with `devAuth` → status 403.
  - `listEvents returns only events with claims, newest-first` → with `adminAuth` → status 200, `data.value` length 1, `data.value[0].legacyId === 7001`.

- [ ] **Step 2: Run test to verify it fails** — Run: `npx vitest run test/drawing-service.test.js`. Expected: FAIL (service/route not found).

- [ ] **Step 3: Implement the service.** In `srv/drawing-service.cds`: `using { com.sap.developers.ims as ims } from '../db/schema';` then `@path:'/drawings' @requires:'Admin' service DrawingService { function listEvents() returns many { legacyId: Integer; name: String; startDate: Timestamp; }; }`. In `srv/drawing-service.js`: `export default class DrawingService extends cds.ApplicationService` with `async init()`, resolve `const { Events, Users, PrizeRecords } = cds.entities('com.sap.developers.ims')`, implement `this.on('listEvents', …)`: select distinct `event_ID` from `PrizeRecords` where `status:'CLAIMED'`, load those `Events`, sort by `startDate` desc, map to `{ legacyId, name, startDate }`. Register the service — confirm whether `srv` services autoload or need a line in the services manifest by checking how `display-service.cds` is picked up (it's autoloaded from `srv/`); match that.

- [ ] **Step 4: Run test to verify it passes** — Run: `npx vitest run test/drawing-service.test.js`. Expected: PASS.

- [ ] **Step 5: Commit** — `git add srv/drawing-service.cds srv/drawing-service.js test/drawing-service.test.js && git commit -m "feat(#2865): drawing service skeleton + listEvents (Admin-gated)"`

---

### Task 2: `pool` and `draw` functions

**Files:**
- Modify: `srv/drawing-service.cds`, `srv/drawing-service.js`
- Test: `test/drawing-service.test.js` (extend)

**Interfaces:**
- Consumes: `DrawingService`, entities from Task 1.
- Produces:
  - `function pool(eventId: Integer) returns { eventId: Integer; eligibleCount: Integer }`
  - `function draw(eventId: Integer) returns { winner { displayName: String; email: String }; eligibleCount: Integer }` — `winner` is null when pool is empty.
  - Shared internal `resolveEvent(eventLegacyId, req)` (404 on miss, per `srv/display-service.js`) and `eligibleUserIds(eventID)` → distinct `user_ID` of CLAIMED `PrizeRecords` whose `Users.displayName != 'ANONYMIZED'`.

- [ ] **Step 1: Write the failing tests** — extend `beforeAll` seed so event 7001 has: user A with 2 CLAIMED claims, user B with 1 CLAIMED claim (B has `email:null`), user C CLAIMED but `displayName:'ANONYMIZED'`, and user D with a non-CLAIMED PrizeRecords row only. Event 7002 has no claims. Tests:
  - `pool counts distinct non-anonymized claimers` → `GET /drawings/pool(eventId=7001)` adminAuth → `data.eligibleCount === 2` (A and B; C excluded, D excluded).
  - `pool is 0 for event with no claims` → `pool(eventId=7002)` → `eligibleCount === 0`.
  - `pool 404s unknown event` → `pool(eventId=99999)` with `validateStatus:()=>true` → status 404.
  - `draw returns a pool member` → `draw(eventId=7001)` → status 200, `data.winner.displayName` is one of A's or B's displayName, `data.eligibleCount === 2`.
  - `draw returns null winner for empty pool` → `draw(eventId=7002)` → `data.winner === null`, `eligibleCount === 0`.
  - `draw can return a winner with null email` → seed so B is the only eligible (make A anonymized in a second event 7003 with only B+? ) — simpler: assert that across the 7001 pool, a winner whose displayName === B's has `email === null` is acceptable; to pin determinism, add event 7003 whose only CLAIMED non-anonymized claimer is B, then `draw(eventId=7003)` → `data.winner.displayName === B`, `data.winner.email === null`.

- [ ] **Step 2: Run test to verify it fails** — Run: `npx vitest run test/drawing-service.test.js`. Expected: FAIL (pool/draw unknown).

- [ ] **Step 3: Implement.** Add `pool` and `draw` to the `.cds`. In `.js`: `resolveEvent` as in `display-service.js`; `eligibleUserIds(eventID)` = `SELECT.from(PrizeRecords).columns('user_ID').where({ event_ID:eventID, status:'CLAIMED' })` → `new Set` of ids → `SELECT.from(Users).columns('ID','displayName','email').where({ ID:{ in:[...ids] } })` → keep those with `displayName !== 'ANONYMIZED'`. `pool`: resolve event, return `{ eventId: eventLegacyId, eligibleCount: eligible.length }`. `draw`: resolve event, get eligible users; if empty return `{ winner:null, eligibleCount:0 }`; else pick `eligible[Math.floor(Math.random()*eligible.length)]` and return `{ winner:{ displayName, email }, eligibleCount }`.

- [ ] **Step 4: Run test to verify it passes** — Run: `npx vitest run test/drawing-service.test.js`. Expected: PASS.

- [ ] **Step 5: Commit** — `git add srv/drawing-service.* test/drawing-service.test.js && git commit -m "feat(#2865): pool + draw functions, anonymized-user exclusion"`

---

### Task 3: Scaffold the Vue display app

**Files:**
- Create: `app/display-app-drawings/package.json`, `vite.config.ts`, `tsconfig.json`, `index.template.html`, `index.html`, `src/main.ts`, `src/style.css`, `src/App.vue` (placeholder), `public/kasimir-tuxedo.png`, `env.d.ts`
- Test: none (scaffolding; the deliverable is a building app, verified by build command)

**Interfaces:**
- Produces: a Vite app with `base: '/drawings-ui/'` that builds to `app/display-app-drawings/dist/`, mountable at `#app`.

- [ ] **Step 1: Copy conventions from `app/display-app/`.** Create `package.json` (`"name":"tutorial-drawings"`, scripts `dev`/`build`/`preview`, deps `vue ^3.5.0` only — no socket.io/qrcode), `vite.config.ts` (clone display-app's but `base:'/drawings-ui/'`, keep the `/rest` proxy, drop socket proxies, **add** a `/drawings` proxy to `http://localhost:4004`), `tsconfig.json`, `env.d.ts`, `src/style.css`, `src/main.ts` (`createApp(App).mount('#app')`), `index.template.html` + `index.html` (clone display-app's; title "Tutorial Drawings"), and a placeholder `src/App.vue` (`<template><div>drawings</div></template>`).

- [ ] **Step 2: Save the mascot asset.** Write the tuxedo-Kasimir image the user supplied to `app/display-app-drawings/public/kasimir-tuxedo.png`. (Implementer: the image is attached in the originating conversation; if unavailable at execution time, flag it — the app references `/drawings-ui/kasimir-tuxedo.png`.)

- [ ] **Step 3: Install and build** — Run: `npm --prefix app/display-app-drawings install && npm --prefix app/display-app-drawings run build`. Expected: `dist/index.html` + `dist/assets/*` produced, exit 0.

- [ ] **Step 4: Commit** — `git add app/display-app-drawings && git commit -m "feat(#2865): scaffold drawings Vue display app"`

---

### Task 4: Drawing UI — event picker, draw, reveal

**Files:**
- Modify: `app/display-app-drawings/src/App.vue`
- Create: `app/display-app-drawings/src/composables/useConfetti.ts` (copy from `app/display-app/src/composables/useConfetti.ts`)
- Test: `app/display-app-drawings/src/__tests__/App.test.ts` (only if the app gets a vitest config; otherwise this task's verification is the build + a manual/smoke note — see Step 2)

**Interfaces:**
- Consumes: backend `GET /drawings/listEvents()`, `/drawings/pool(eventId=N)`, `/drawings/draw(eventId=N)` (OData function call URLs return `{ value: [...] }` for `many`, and a single object for the structured returns — confirm the single-return shape against Task 2's test responses and parse accordingly).

- [ ] **Step 1: Implement `App.vue`.** On mount, `fetch('/drawings/listEvents()')`, populate a `<select>` (default = first, newest). Show selected event's pool size via `/drawings/pool(eventId=N)`; disable the Draw button when `eligibleCount === 0` and show "No prize claims scanned yet for this event." A **Draw** button calls `/drawings/draw(eventId=N)`; on a non-null winner, reveal name large (displayName, else firstName+lastName — note `draw` only returns displayName+email, so displayName is the name source), email below (or "no email on file" when null), trigger confetti, and show `kasimir-tuxedo.png`. Each Draw is independent over the full pool (no exclusion). Use native `fetch`.

- [ ] **Step 2: Verify the build** — Run: `npm --prefix app/display-app-drawings run build`. Expected: exit 0, no type errors. (The reveal is visual; a committed e2e/smoke spec is advisory per the repo's e2e pattern and runs post-deploy — add a one-line note in the app README pointing at `/drawings-ui/` for the post-deploy `e2e` job rather than a unit test of the animation.)

- [ ] **Step 3: Commit** — `git add app/display-app-drawings && git commit -m "feat(#2865): drawings UI — event picker, draw, winner reveal with Kasimir"`

---

### Task 5: Deploy wiring — approuter route + MTA builder

**Files:**
- Modify: `approuter/xs-app.json`
- Modify: `.deploy/mta.yaml`
- Test: none directly; verification is the smoke test suite's route expectations + a manual build of the MTA approuter module is out of scope for unit tests. Validate the JSON/YAML parse.

**Interfaces:**
- Consumes: the built `app/display-app-drawings/dist/` and the `/drawings` CAP route (autoserved via `srv-api`).
- Produces: `/drawings-ui/*` route (localDir static, `authenticationType:xsuaa`, `scope:$XSAPPNAME.Admin`) and, if `/drawings` needs an explicit approuter passthrough like `/display` has, a `/drawings/*` → `srv-api` route with `scope:$XSAPPNAME.Admin` (confirm whether CAP OData routes need an explicit `xs-app.json` entry by checking how `/display` is routed at `approuter/xs-app.json:345-355`; mirror it).

- [ ] **Step 1: Add the approuter routes.** In `approuter/xs-app.json`, add a `/drawings-ui/(.*)$` route mirroring the `/display-app/` block (`approuter/xs-app.json:72-79`) but `scope:$XSAPPNAME.Admin`; add a `/drawings/(.*)$` → `srv-api` route mirroring the `/display/(.*)$` block but `scope:$XSAPPNAME.Admin`.

- [ ] **Step 2: Add the MTA builder block.** In `.deploy/mta.yaml`, mirror the display-app builder (`.deploy/mta.yaml:278-285`): `npm --prefix ../app/display-app-drawings install`, `... run build`, `mkdir -p static/drawings-ui`, `cp -r ../app/display-app-drawings/dist/. static/drawings-ui/`.

- [ ] **Step 3: Verify parse** — Run: `node -e "JSON.parse(require('fs').readFileSync('approuter/xs-app.json','utf8')); console.log('xs-app ok')"` and `npx js-yaml .deploy/mta.yaml >/dev/null && echo "mta ok"` (or `yq '.' .deploy/mta.yaml >/dev/null`). Expected: both print ok.

- [ ] **Step 4: Commit** — `git add approuter/xs-app.json .deploy/mta.yaml && git commit -m "feat(#2865): wire /drawings-ui approuter route + MTA builder (Admin scope)"`

---

### Task 6: Document the new surface

**Files:**
- Modify: `docs/developers/operations/testing-endpoints.md`

**Interfaces:** none (docs).

- [ ] **Step 1: Add the drawings surface** to the canonical endpoint reference: the `/drawings-ui/` UI and `DrawingService` functions (`listEvents`, `pool`, `draw`) under the `Admin` scope, noting the service returns winner PII and is Admin-gated.

- [ ] **Step 2: Commit** — `git add docs/developers/operations/testing-endpoints.md && git commit -m "docs(#2865): document drawings UI + DrawingService endpoints"`
