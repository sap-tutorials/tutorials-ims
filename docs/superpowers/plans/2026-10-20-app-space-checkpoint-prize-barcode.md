# App Space Checkpoint Prize Barcode — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A completed track's Checkpoint renders a scannable identity barcode; the instructor's scanner resolves it to a "prizes claimed: N of 2" count and records a handover, server-capped at 2.

**Architecture:** CAP Node.js backend (`srv/`) + Vue 3 islands (`hugo-apps/src/`). The App Space page requests a QR from a new **authenticated** Express route that mints it from the logged-in session (identity = DB user UUID, never in a client URL). The scanner (`ScannerService`, XSUAA `MobileApp` scope) resolves the scanned UUID, returns an event-scoped CLAIMED count, and records a handover via an atomic, capped insert into `PrizeRecords`.

**Tech Stack:** `@sap/cds` (CAP), Express, `qrcode` npm lib, Vue 3 + TypeScript, Vitest/Jest unit tests (CAP `cds.test`), Fundamental Styles.

**Spec:** `docs/superpowers/specs/2026-10-20-app-space-checkpoint-prize-barcode-design.md`

## Global Constraints

- No raw SQL in CAP handlers — use `cds.ql`/CQL (CLAUDE.md). The atomic cap guard uses a CQL `INSERT ... ` guarded inside a single transaction; if a raw guard is unavoidable it must be justified and isolated.
- No `req.user` without a `@requires` on the service (scanner is `@requires:'MobileApp'`; the barcode route sits behind `basicAuthMiddleware` + XSUAA like the existing `/api/media-diet/my-picks`).
- Identity in the barcode = **DB user UUID** (`Users.ID`), always present for an authenticated user. Never `sapId`, never `legacyId`. Never placed in a client-supplied query string.
- Prize cap = **2 per user per event**, enforced server-side atomically.
- QR payload shape the scanner already parses: `{ uid: string, payload: { recordId, status } }` (`scanner-vue/ScannerApp.vue:32-42`). The new barcode encodes `{ uid: <UUID>, payload: { eventId: <legacyId> } }`.
- Barcode route cache header must be **private/no-store** (identity-bearing) — NOT the `public, max-age=86400` the old `/api/qrcode` uses.
- Scanner `getContestant`/`claimPrize` resolution may drop the numeric-legacyId path (no working legacy flow exists); if kept, it must not break the new UUID path.
- Follow the `srv-qa` cp-list audit rule if any `srv/lib/` file is added that becomes a transitive dep of `content-store.js` (none expected here).

## Review Focus

- **Authenticated-but-null-identity user** hitting the barcode route → must return a clean 401/empty-state signal, not a 500 or a QR encoding `undefined`. (Task 3)
- **Scan of a UUID that resolves to no user** (stale/typo'd QR) → `getContestant` returns 404, scanner shows a clean error, no crash. (Task 5)
- **Claim when already at 2** → server rejects without inserting a 3rd row; scanner shows "cap reached". (Task 6)
- **Two simultaneous claims for the same user+event** → at most one succeeds past the cap; the pair cannot both insert row #3. (Task 6)
- **Checkpoint item with null `taskLegacyId` and no `Checkpoints` row** (the live broken state) → renders its `checkpointTitle`, not a blank. (Task 1)

---

## Task 1: Checkpoint title resolution fix

**Files:**
- Modify: `srv/developer-service.js` (item build in `getAppSpaceProgress` ~`:720-731`; mirror in `getEventProgress` ~`:600-626`)
- Test: `test/unit/app-space-checkpoint-title.test.js` (create)

**Interfaces:**
- Consumes: `CompletionPathItems.checkpointTitle` (String, `db/schema.cds:475`); the item object `i` already in scope in the `.map`.
- Produces: `getAppSpaceProgress`/`getEventProgress` CHECKPOINT items whose `title` falls back to `i.checkpointTitle` when no task resolves.

- [ ] **Step 1: Write the failing test** — in-memory `cds.test`, seed an Event→Mission→CompletionPath with a CHECKPOINT `CompletionPathItems` row that has `checkpointTitle: 'Claim your prize'`, `taskLegacyId: null`, and no matching `Checkpoints` row. Call `getAppSpaceProgress(eventLegacyId)`.

```js
test('CHECKPOINT item with only checkpointTitle resolves its title', async () => {
  const res = await GET(`/odata/.../getAppSpaceProgress(eventLegacyId=${ev})`) // or srv.send
  const cp = res.paths.flatMap(p => p.items).find(i => i.type === 'CHECKPOINT')
  expect(cp.title).toBe('Claim your prize')
})
```

- [ ] **Step 2: Run test, verify it fails** — Run: `npm test -- app-space-checkpoint-title`. Expected: FAIL (title is `''`).

- [ ] **Step 3: Implement** — in both item-build `.map`s, change the title expression to `title: task?.title || record?.titleSnapshot || i.checkpointTitle || ''`. No other field changes (imsId/recordId staying null/0 for a checkpoint is correct).

- [ ] **Step 4: Run test, verify it passes** — Run: `npm test -- app-space-checkpoint-title`. Expected: PASS.

- [ ] **Step 5: Commit** — `git commit -m "fix(app-space): resolve CHECKPOINT title from checkpointTitle (#<issue>)"`

---

## Task 2: Authenticated barcode endpoint (backend)

**Files:**
- Create: `srv/lib/prize-barcode-handler.js`
- Modify: `srv/server.js` (register route after `app.use(basicAuthMiddleware)`, near `:318`)
- Test: `test/unit/prize-barcode-handler.test.js` (create)

**Interfaces:**
- Consumes: `resolveUserSapId(req.user)` and `resolveDbUserScoped(req, ['ID'])` from `srv/lib/resolve-db-user.js`; `QRCode.toBuffer` from `qrcode`.
- Produces: `GET /api/my-prize-barcode?eventId=<legacyId>` → PNG QR encoding `JSON.stringify({ uid: <Users.ID>, payload: { eventId: Number } })`; 401 when no authenticated DB user resolves; `Cache-Control: private, no-store`.

- [ ] **Step 1: Write the failing test** — unit-test the handler with a fake `req` (mock `resolveDbUserScoped` to return `{ ID: 'uuid-123' }`) and a fake `res`; assert `res` got `image/png`, `Cache-Control: private, no-store`, and that the encoded payload (decode via a QR lib or by spying on `QRCode.toBuffer`'s first arg) is `{"uid":"uuid-123","payload":{"eventId":10000015}}`. Add a second test: unresolved user → `res.status(401)`.

- [ ] **Step 2: Run test, verify it fails** — Run: `npm test -- prize-barcode-handler`. Expected: FAIL (module not found).

- [ ] **Step 3: Implement `export async function prizeBarcodeHandler(req, res)` in `srv/lib/prize-barcode-handler.js`** — resolve the DB user via `resolveDbUserScoped(req, ['ID'])`; if none, `res.status(401).json({error:'auth required'})`. Parse `eventId` from query (Number). Build payload `{ uid: user.ID, payload: { eventId } }`, `QRCode.toBuffer(JSON.stringify(payload), {type:'png', width:200, margin:2, errorCorrectionLevel:'M'})`, set `Content-Type: image/png` + `Cache-Control: private, no-store`, `res.send(buffer)`. Mirror error handling from `qrcode-handler.js`.

- [ ] **Step 4: Register the route** in `srv/server.js` after `app.use(basicAuthMiddleware);` (so XSUAA/basic auth populates `req.user`), e.g. `app.get('/api/my-prize-barcode', prizeBarcodeHandler);` with an import at top. Add the approuter `xs-app.json` route if the app-space page is XSUAA-gated for this path (builder: confirm `/api/my-prize-barcode` needs an authenticated route entry; the app-space page itself is anon, so this endpoint needs its own authenticated route — see Task 4 note).

- [ ] **Step 5: Run test, verify it passes** — Run: `npm test -- prize-barcode-handler`. Expected: PASS.

- [ ] **Step 6: Commit** — `git commit -m "feat(app-space): authenticated prize-barcode QR endpoint"`

---

## Task 3: App Space renders the checkpoint barcode on track completion (frontend)

**Files:**
- Modify: `hugo-apps/src/app-space/AppSpace.vue` (QR render block `:530-565`, `qrCodeUrl` `:284-286`, interfaces `:44-56`)
- Test: `hugo-apps/src/app-space/__tests__/AppSpace.checkpoint-qr.test.ts` (create, if the island test harness exists; else a focused unit test of the URL/condition helpers)

**Interfaces:**
- Consumes: `isItemUnlocked(track, index)` CHECKPOINT branch (`:242-245`) — true when all prior TUTORIAL items COMPLETED; `authenticated` flag from `AppSpaceData`; the new endpoint from Task 2.
- Produces: a CHECKPOINT barcode `<img>` whose `src` = `/api/my-prize-barcode?eventId=<eventId>` shown only when the checkpoint's track is complete AND `authenticated`.

- [ ] **Step 1: Write the failing test** — assert a helper `checkpointBarcodeUrl()` returns `/api/my-prize-barcode?eventId=<id>` and that a `shouldShowCheckpointBarcode(track, index)` returns true only when `item.type==='CHECKPOINT' && isItemUnlocked(track,index) && authenticated`. (Extract these as testable functions in the `<script setup>`.)

- [ ] **Step 2: Run test, verify it fails** — Run: `cd hugo-apps && npm test -- AppSpace.checkpoint-qr`. Expected: FAIL.

- [ ] **Step 3: Implement** — add `checkpointBarcodeUrl()` (uses `eventId.value`) and `shouldShowCheckpointBarcode(track,index)`. In the template, add a CHECKPOINT barcode block rendering `<img :src="checkpointBarcodeUrl()">` gated by `shouldShowCheckpointBarcode`; show a "sign in to get your prize code" hint when `item.type==='CHECKPOINT' && isItemUnlocked && !authenticated`. Remove the dead PRIZE/EARNED block (`:531-565`) since no backend feeds it. Track `authenticated` in component state from `loadData()`.

- [ ] **Step 4: Run test, verify it passes** — Run: `cd hugo-apps && npm test -- AppSpace.checkpoint-qr`. Expected: PASS.

- [ ] **Step 5: Build the island** — Run: `cd hugo-apps && npm run build` (confirm no TS errors). Expected: PASS.

- [ ] **Step 6: Commit** — `git commit -m "feat(app-space): render checkpoint barcode on track completion"`

---

## Task 4: App Space payload exposes `authenticated` to the island (verify/wire)

**Files:**
- Modify: `hugo-apps/src/app-space/AppSpace.vue` `loadData()` (`:98-124`) + `AppSpaceData` interface (`:65-72`)
- Test: covered by Task 3's `shouldShowCheckpointBarcode` test (authenticated=false path)

**Interfaces:**
- Consumes: `getAppSpaceProgress` top-level `authenticated` boolean (already returned, `developer-service.js:711`).
- Produces: `authenticated` reactive state the Task 3 gate reads.

- [ ] **Step 1: Write the failing test** — assert `loadData()` sets an `authenticated` ref from `data.authenticated`, defaulting false on the static fallback. (Fold into Task 3 test file.)
- [ ] **Step 2: Run, verify fail.** Run: `cd hugo-apps && npm test -- AppSpace.checkpoint-qr`. Expected: FAIL.
- [ ] **Step 3: Implement** — add `authenticated` to `AppSpaceData`, set `isLoggedIn`/`authenticated` ref in `loadData()` from `data.authenticated`.
- [ ] **Step 4: Run, verify pass.** Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(app-space): surface authenticated flag to checkpoint gate"`

*(Note: Tasks 3 and 4 touch the same file and may be done together; kept separate so the gate logic and the data-wiring each have their own test.)*

---

## Task 5: Scanner resolves by UUID and returns a count

**Files:**
- Modify: `srv/scanner-service.cds` (`getContestant` return shape), `srv/scanner-service.js` (`getContestant` handler `:11-68`)
- Test: `test/unit/scanner-contestant-count.test.js` (create)

**Interfaces:**
- Consumes: scanned `accountNumber` now carrying a **user UUID** (string); optional `eventId` (legacyId). `Users` resolved by `ID`.
- Produces: `getContestant(accountNumber, eventId?)` → `{ tutorialsCompleted, groupsCompleted, missionsCompleted, claimedCount: Integer, prizeRecords: String }` where `claimedCount` = event-scoped CLAIMED `PrizeRecords` for the user (0–2), and `prizeRecords` becomes a short human string like `"N of 2 prizes claimed"`.

- [ ] **Step 1: Write the failing test** — seed a user (UUID `u1`), an event, and 1 CLAIMED `PrizeRecords` row for (u1, event). Call `getContestant(accountNumber='u1', eventId=<legacyId>)`; assert `claimedCount === 1` and `prizeRecords === '1 of 2 prizes claimed'`. Second test: unknown UUID → rejects 404.

- [ ] **Step 2: Run, verify fail** — Run: `npm test -- scanner-contestant-count`. Expected: FAIL.

- [ ] **Step 3: Implement** — resolve `Users` by `ID` (UUID). Resolve event by legacyId→`Events.ID` when `eventId` given. Count `PrizeRecords` where `{user_ID, status:'CLAIMED'}` (and `event_ID` when event resolved). Return `claimedCount` + `prizeRecords: \`${claimedCount} of 2 prizes claimed\``. Keep the completion counts. Drop/replace the per-prize-title enumeration. Add `eventId` param to the CDS signature (`function getContestant(accountNumber: String, eventId: Integer) returns { ... claimedCount: Integer; prizeRecords: String; }`).

- [ ] **Step 4: Run, verify pass** — Expected: PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat(scanner): resolve by user UUID, return event-scoped claimed count"`

---

## Task 6: Scanner records a capped, atomic handover

**Files:**
- Modify: `srv/scanner-service.cds` (new `claimPrizeForContestant`), `srv/scanner-service.js`
- Test: `test/unit/scanner-claim-capped.test.js` (create)

**Interfaces:**
- Consumes: scanned user UUID + `eventId` (legacyId). `PrizeRecords` entity (`user`, `event`, `status`).
- Produces: `claimPrizeForContestant(accountNumber: String, eventId: Integer) returns { claimedCount: Integer; message: String }` — inserts a CLAIMED `PrizeRecords` row for (user,event) iff current CLAIMED count `< 2`, atomically; returns the resulting count.

- [ ] **Step 1: Write the failing tests** — (a) user with 1 CLAIMED → claim → `claimedCount===2`, a new row exists. (b) user with 2 CLAIMED → claim → `claimedCount===2`, message `'cap reached (2 of 2)'`, no new row. (c) **concurrency**: fire two `claimPrizeForContestant` calls for a user at count 1 via `Promise.all`; assert final CLAIMED count is exactly 2, never 3.

```js
test('simultaneous claims cannot exceed cap of 2', async () => {
  // seed user at claimedCount=1
  await Promise.allSettled([ claim(), claim() ])
  const n = await SELECT`count(*)`.from(PrizeRecords).where({user_ID:u, event_ID:e, status:'CLAIMED'})
  expect(count(n)).toBe(2)
})
```

- [ ] **Step 2: Run, verify fail** — Run: `npm test -- scanner-claim-capped`. Expected: FAIL.

- [ ] **Step 3: Implement the atomic guard** — in one CAP transaction (`cds.tx`), perform a guarded insert whose effect is nil when the count is already 2. Approach (builder's call on exact CQL, must be atomic): `INSERT into PrizeRecords (user_ID,event_ID,status) SELECT :u,:e,'CLAIMED' FROM DUMMY WHERE (SELECT COUNT(*) FROM PrizeRecords WHERE user_ID=:u AND event_ID=:e AND status='CLAIMED') < 2`, then re-count and return. On SQLite unit tests a serialized `cds.tx` with `SERIALIZABLE`-style read-then-insert is acceptable; on HANA the single guarded `INSERT…SELECT…WHERE count<2` is the atomic form. Resolve user by UUID, event by legacyId first; reject 404 if either missing.

- [ ] **Step 4: Run, verify pass** (incl. concurrency test) — Expected: PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat(scanner): atomic capped prize handover (max 2 per user/event)"`

---

## Task 7: Scanner UI — count display + handover button

**Files:**
- Modify: `hugo-apps/src/scanner-vue/ScannerApp.vue`, `useScannerApi.ts`, `types.ts`
- Test: `hugo-apps/src/scanner-vue/__tests__/scanner-claim.test.ts` (create, if harness exists; else test `useScannerApi` call shapes)

**Interfaces:**
- Consumes: new endpoints `getContestant(uid, eventId)` and `claimPrizeForContestant(uid, eventId)` (Tasks 5, 6); QR payload `{ uid, payload: { eventId } }`.
- Produces: scanner shows "Prizes claimed: N of 2" and a handover button disabled at 2.

- [ ] **Step 1: Write the failing test** — `useScannerApi.claimPrizeForContestant(uid, eventId)` fetches `/scanner/claimPrizeForContestant(accountNumber='<uid>',eventId=<n>)` and returns `{claimedCount, message}`; `getContestant(uid, eventId)` passes eventId. Assert URL shapes.

- [ ] **Step 2: Run, verify fail** — Run: `cd hugo-apps && npm test -- scanner-claim`. Expected: FAIL.

- [ ] **Step 3: Implement** — `parseScanData` reads `data.payload.eventId`; add `eventId` to `ScanResult`/`ContestantData`; `getContestant(uid, eventId)`; replace `claimPrize(recordId,...)` with `claimPrizeForContestant(uid, eventId)`; `ContestantData` gains `claimedCount`. Template: show `Prizes claimed: {{ contestant.claimedCount }} of 2`; handover button `:disabled="contestant.claimedCount >= 2 || state==='claiming'"`; on success refresh via `getContestant`.

- [ ] **Step 4: Run, verify pass** — Expected: PASS.

- [ ] **Step 5: Build island** — Run: `cd hugo-apps && npm run build`. Expected: PASS.

- [ ] **Step 6: Commit** — `git commit -m "feat(scanner): show N-of-2 count and capped handover button"`

---

## Task 8: End-to-end sanity + full island/CAP build

**Files:** none new — integration verification.

- [ ] **Step 1: Run the full backend unit suite** — Run: `npm test`. Expected: PASS (all new + existing).
- [ ] **Step 2: Build islands** — Run: `cd hugo-apps && npm run build`. Expected: no TS/build errors.
- [ ] **Step 3: Lint CAP** — Run: `npx cds lint` (or project lint script). Expected: clean.
- [ ] **Step 4: Commit any fixups** — `git commit -m "chore: build + lint fixups for checkpoint barcode"`

---

## Post-deploy verification (not a code task — Tom owns)

Per spec: local `cds bind` cannot reach the app's HDI container, so verify on the **deployed DEV app** after merge:
1. Complete the CX track as a logged-in user → checkpoint shows a barcode.
2. Confirm the barcode is NOT shown for an incomplete track and NOT for an anonymous session.
3. Scan with the scanner app → shows "0 of 2"; tap handover → "1 of 2"; repeat → "2 of 2"; third attempt → "cap reached".
4. Confirm the CX checkpoint's `checkpointTitle` renders (if blank, author it in `/admin-ui/`).
