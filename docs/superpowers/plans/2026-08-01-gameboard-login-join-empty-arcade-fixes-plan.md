# Gameboard fixes — active-event resolution, login-vs-join, empty-state, arcade content — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use `- [ ]` checkboxes.

**Goal:** Fix the logged-in "log in" bug + empty board, and complete the arcade's missing legacy content. Resolve the active Devtoberfest event from `DevtoberfestConfig` (not the participant list) so it works at 0 registrations; return a status so the UI shows Log-in vs Join-Devtoberfest vs progress; add an empty-state; add the arcade's How-to-Play / Lawyers-Happy / menu / banner and fix layout.

**Architecture:** New provider view `GAMEBOARD_ACTIVE_EVENT_V1` (tutorials-ims) → consumed cross-container by the gameboard backend, which now resolves the event from it and returns a `status`. Both Vue islands render the status-driven CTA + empty-state. Spans 2 repos, deploy-ordered.

**Tech Stack:** HANA `.hdbview`/`.hdbrole`/`.hdbsynonym`, CAP (Node), Vue 3 islands, vitest.

## Global Constraints

- **Deploy order is a hard dependency:** (1) tutorials-ims provider view + role, (2) gameboard backend + facade, (3) tutorials-ims islands. A later layer deployed before its predecessor fails (facade reads a not-yet-deployed view; island reads a not-yet-deployed status).
- **Facade elements UPPERCASE** matching deployed view columns char-for-char.
- **Status contract (frozen):** `getMyGameboard()` returns `status ∈ {'joined','not_joined','no_event'}`; anonymous callers get HTTP 401 (endpoint is `@requires:'authenticated-user'`). `getGameboard()` gains `hasActiveEvent: Boolean` + `activityCount: Integer`.
- **Fail-soft preserved:** any backend read fault → the safe state (`no_event` / empty board / null), never a 500.
- **Reuse existing patterns:** synonym file = `{ "<NAME>": {} }`, config = the `schema.configure`+`object` target (see `EXTERNAL_GAMEBOARDPARTICIPANTV1`). Facades in `db/external/gameboard.cds` (`namespace external`).
- **Legacy text is verbatim** (from `sap-community-activity-badges/srv/_i18n/messages.properties`) — reproduced in Task 6 below.
- **No new MTA/route** — provider view rides the db-deployer; islands ride Hugo/approuter; backend is the existing gameboard MTA.

---

### Task 1: Provider view `GAMEBOARD_ACTIVE_EVENT_V1` + role (tutorials-ims)

**Files:** Create `db/src/GAMEBOARD_ACTIVE_EVENT_V1.hdbview`; modify `db/src/gameboard_reader.hdbrole` + `db/src/gameboard_reader_grantable.hdbrole`; test `test/hybrid/gameboard-active-event.test.js`.

- [ ] **Step 1: Failing hybrid test**

`test/hybrid/gameboard-active-event.test.js`:
```js
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';
cds.test('serve', '--project', '.', '--profile', 'hybrid');
describe('GAMEBOARD_ACTIVE_EVENT_V1 (hybrid)', () => {
  let db; beforeAll(async () => { db = await cds.connect.to('db'); });
  it('resolves the config-active event independent of registrations', async () => {
    const rows = await db.run(`SELECT "EVENT_ID","EVENT_NAME","EVENT_START","EVENT_END" FROM "GAMEBOARD_ACTIVE_EVENT_V1"`);
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBeLessThanOrEqual(1); // 0 or 1 active event
  });
});
```

- [ ] **Step 2: Run — fails** (`invalid view name`). `npx cds bind --exec -- npx vitest run --project hybrid test/hybrid/gameboard-active-event.test.js`

- [ ] **Step 3: Write the view** `db/src/GAMEBOARD_ACTIVE_EVENT_V1.hdbview`:
```sql
VIEW "GAMEBOARD_ACTIVE_EVENT_V1" AS
  SELECT e."ID"        AS "EVENT_ID",
         e."NAME"      AS "EVENT_NAME",
         e."STARTDATE" AS "EVENT_START",
         e."ENDDATE"   AS "EVENT_END"
  FROM "COM_SAP_DEVELOPERS_IMS_DEVTOBERFESTCONFIG" c
  JOIN "COM_SAP_DEVELOPERS_IMS_EVENTS" e ON e."ID" = c."CURRENTEVENT_ID"
  WHERE c."ISACTIVE" = TRUE
```

- [ ] **Step 4: Grant it** — add to both roles' `object_privileges`:
`{ "name": "GAMEBOARD_ACTIVE_EVENT_V1", "type": "VIEW", "privileges": [ "SELECT" ] }` (and the `privileges_with_grant_option` variant in the `#` role).

- [ ] **Step 5: `cds build --production`** — confirm the view compiles into `gen/db/src`. Deploy is the rollout step; hybrid test goes green post-deploy.

- [ ] **Step 6: Commit** — `feat(gameboard): GAMEBOARD_ACTIVE_EVENT_V1 view (config-active event, registration-independent) + grants`

---

### Task 2: Consumer facade + synonym + getActiveEvent rewrite (gameboard repo)

**Files:** Modify `db/external/gameboard.cds`; create `db/src/EXTERNAL_GAMEBOARDACTIVEEVENTV1.hdbsynonym` + `.hdbsynonymconfig`; modify `srv/lib/active-event.js`; test `test/hybrid/active-event-resolve.test.js`.

**Interfaces:** Produces facade `GameboardActiveEventV1`; `getActiveEvent(db)` now reads it (was: participant view).

- [ ] **Step 1: Facade** — add to `db/external/gameboard.cds`:
```cds
@cds.persistence.exists
entity GameboardActiveEventV1 {
  key EVENT_ID    : String(36);
      EVENT_NAME  : String(255);
      EVENT_START : Timestamp;
      EVENT_END   : Timestamp;
}
```

- [ ] **Step 2: Synonym** `db/src/EXTERNAL_GAMEBOARDACTIVEEVENTV1.hdbsynonym`:
```json
{ "EXTERNAL_GAMEBOARDACTIVEEVENTV1": {} }
```
`.hdbsynonymconfig`:
```json
{ "EXTERNAL_GAMEBOARDACTIVEEVENTV1": { "target": { "schema.configure": "tutorials-hana/schema", "object": "GAMEBOARD_ACTIVE_EVENT_V1" } } }
```

- [ ] **Step 3: Rewrite `getActiveEvent`** (`srv/lib/active-event.js`) to read the active-event view, not participants:
```js
// Resolves the active DEVTOBERFEST event from GAMEBOARD_ACTIVE_EVENT_V1
// (DevtoberfestConfig.isActive→currentEvent) — independent of registrations, so
// it returns the event even at 0 participants. null only when no config is active.
module.exports.getActiveEvent = async (db, ActiveEventV1) => {
  const row = await db.run(SELECT.one.from(ActiveEventV1).columns('EVENT_ID', 'EVENT_START', 'EVENT_END'));
  return row ? { id: row.EVENT_ID, start: row.EVENT_START, end: row.EVENT_END } : null;
};
```
(Note the caller change: it now passes `GameboardActiveEventV1` instead of `GameboardParticipantV1` — Task 3.)

- [ ] **Step 4: cds build --production** — confirm facade bakes + synonym emits. Commit — `feat(gameboard): resolve active event from config view (registration-independent)`

---

### Task 3: Backend status contract (gameboard repo)

**Files:** Modify `srv/gameboard-service.cds` (types), `srv/gameboard-service.js` (handlers); tests `test/unit/my-gameboard-status.test.js`, extend `test/hybrid/gameboard-personalized.test.js`.

**Interfaces:** `MyGameboard.status`; `GameboardConfig.hasActiveEvent`+`activityCount`. `computeMyGameboard` returns a status object; `getActiveEvent` now called with `GameboardActiveEventV1`.

- [ ] **Step 1: Failing unit test** `test/unit/my-gameboard-status.test.js` — assert `computeMyGameboard`/the status helper returns `no_event` when no active event, `not_joined` when active event but no participant row, `joined` with score when participant exists. (Use the pure branch or a mocked db per the repo's unit style.)

- [ ] **Step 2: CDS types** — extend in `srv/gameboard-service.cds`:
```cds
  type MyGameboard {
    status      : String;   // 'joined' | 'not_joined' | 'no_event'
    userId      : String;
    score       : Integer;
    level       : Integer;
    avatarIndex : Integer;
    breakdown   : array of WeekTrackBreakdown;
  }
  type GameboardConfig {
    thresholds    : array of LevelThreshold;
    totals        : array of WeekTrackTotal;
    tracks        : array of TrackRef;
    hasActiveEvent: Boolean;
    activityCount : Integer;
    personalized  : MyGameboard;
  }
```

- [ ] **Step 3: Rewrite `computeMyGameboard`** — resolve via `getActiveEvent(db, GameboardActiveEventV1)`:
```js
const event = await getActiveEvent(db, GameboardActiveEventV1);
if (!event) return { status: 'no_event', userId, score: 0, level: 0, avatarIndex: 0, breakdown: [] };
const [me] = await db.run(SELECT.from(GameboardParticipantV1).where({ USER_ID: userId, EVENT_ID: event.id }));
if (!me) return { status: 'not_joined', userId, score: 0, level: 0, avatarIndex: avatarIndexForUser(userId), breakdown: [] };
// … existing window-filtered completions + scoring …
return { status: 'joined', userId, score, level: computeLevel(score, thresholds), avatarIndex: avatarIndex(`${me.FIRST_NAME} ${me.LAST_INITIAL||''}`), breakdown: perWeekBreakdown(inWindow, mappedActivities) };
```
Bind `GameboardActiveEventV1` from `db.entities('external')` alongside the others in `init()`. Update `getLeaderboard` to also resolve via the active-event view (it currently uses participant-derived `getActiveEventId`/`getActiveEvent` — point it at the new one; leaderboard still lists participants from the participant view).

- [ ] **Step 4: `getGameboard`** — set `hasActiveEvent = !!event` and `activityCount = activities.length` on the returned config.

- [ ] **Step 5: Run unit tests — pass.** cds build --production clean. Commit — `feat(gameboard): getMyGameboard status (joined/not_joined/no_event) + getGameboard hasActiveEvent/activityCount`

---

### Task 4: Leaderboard island — status-driven CTA + empty-state (tutorials-ims)

**Files:** Modify `hugo-apps/src/gameboard/CabinetFrame.vue`, `hugo-apps/src/gameboard/types.ts`, `Gameboard.vue`; tests in `__tests__`.

**Interfaces:** Consumes the new `status`/`hasActiveEvent`/`activityCount`.

- [ ] **Step 1: Failing test** — `CabinetFrame` shows: 401/anonymous → "Log in"; `not_joined` → "Join Devtoberfest" (link `/devtoberfest/#join`); `no_event` → "Devtoberfest isn't running right now."; `joined` → avatar + level/score. And an empty-state ("Activities coming soon") when `hasActiveEvent` && `activityCount===0`.

- [ ] **Step 2: types.ts** — add `status?` to `MyGameboard`; `hasActiveEvent?`/`activityCount?` to `GameboardConfig`.

- [ ] **Step 3: `Gameboard.vue`** — `loadMine` catches 401 → set a local `authState:'anonymous'`; otherwise read `personalized.status`. Pass status + config flags to `CabinetFrame`.

- [ ] **Step 4: `CabinetFrame.vue`** — replace the single `v-else` "Log in via the user menu…" line with a computed message keyed on (anonymous | status | empty-activities), rendering the avatar only when `status==='joined'`.

- [ ] **Step 5: Run tests — pass.** Commit — `fix(gameboard-ui): status-driven Log-in/Join/no-event CTA + activities-coming-soon empty-state`

---

### Task 5: Arcade island — status wiring + empty-state (tutorials-ims)

**Files:** Modify `hugo-apps/src/arcade/Arcade.vue`, `types.ts`, `__tests__`.

- [ ] **Step 1: Failing test** — arcade CTA: anonymous(401) → "Log in"; `not_joined` → "Join Devtoberfest"; `no_event`/no-activities → "coming soon"; `joined` → player scene with avatar.

- [ ] **Step 2:** `Arcade.vue` — its fetch already distinguishes success vs 401; extend to read `status` and choose the CTA/scene accordingly (was binary demo/player). Update `types.ts` for `status`.

- [ ] **Step 3: Run tests — pass.** Commit — `fix(arcade): status-driven CTA (login vs join vs coming-soon)`

---

### Task 6: Arcade — missing legacy content + layout (tutorials-ims)

**Files:** Modify `hugo-apps/src/arcade/Scene.vue`, `styles.css`; add `hugo-apps/src/arcade/scene-text.ts` (the verbatim copy); tests.

**Verbatim legacy text (from `_i18n/messages.properties`) — put in `scene-text.ts`:**
- Header: `"{firstName}, Devtoberfest 2025 has started!"` + link "SAP Community Profile" → `https://community.sap.com/t5/user/viewprofilepage/user-id/<khorosId>` (only when community-linked; else omit the link).
- **HOW TO PLAY:** heading `"HOW TO PLAY"`; `"It's simple. Register for"` + link `"Devtoberfest here by clicking Join Group"` → `https://groups.community.sap.com/t5/devtoberfest/gh-p/Devtoberfest`; then `"Complete activities like tutorials or event surveys. Please reference the published list of activities to see where you can earn points:"` + link `"here"` → `https://community.sap.com/t5/devtoberfest-blog-posts/devtoberfest-2025-contest-official-rules/ba-p/13781577`.
- **MAKING THE LAWYERS HAPPY:** heading + `"This gameboard is offered for entertainment purposes only. The actual points calculation for Devtoberfest levels and contest prizes will be done separately and could vary from the points displayed in this gameboard. Final points calculation and prizes are subject to the legal terms and conditions which can be reviewed:"` + link `"here"` → same rules URL.
- **Points banner:** `"POINTS: {score} LEVEL: {level}"` (level 4 label = "Nerdvana").
- **Menu icons:** Awards / Points / Rules → all link the rules URL (`target=_blank`); Sound = existing toggle.

- [ ] **Step 1: Failing test** — `Scene` renders a "HOW TO PLAY" heading, the "MAKING THE LAWYERS HAPPY" heading, the points banner text, and the 3 rules-link menu items; the join/rules links have correct hrefs.

- [ ] **Step 2:** Add `scene-text.ts` (the strings above) + render the two text columns, banner, and menu in `Scene.vue`; interpolate `firstName`/`score`/`level` from the board data.

- [ ] **Step 3: Layout** — in `styles.css`, place the columns (left ~x4%, right ~x37% of the scaled canvas), banner (top-center), menu (top-right) proportional to the legacy 1347×1612 coordinates; verify against the legacy positions in the recon; keep it responsive (percent-based within the scaled `.scene`). Fix the reported spacing so layers don't overlap.

- [ ] **Step 4: Run tests — pass.** Commit — `feat(arcade): add legacy How-to-Play + Lawyers-Happy + menu + banner; fix layout to legacy proportions`

---

### Task 7: Build, e2e, README data note, deploy verification

- [ ] **Step 1: Full island build** — `npm --prefix hugo-apps run build`; `arcade.js`/`gameboard.js` emit clean.
- [ ] **Step 2: Full unit suites** — gameboard-repo (`npx vitest run --project unit`) + hugo-apps island tests all pass.
- [ ] **Step 3: README data note** — in the gameboard repo README, document that the board populates only once Activities are authored in the Planner (`DTF_ACTIVITY_V1`) and users join (`EventRegistrations`); until then the UI shows the coming-soon / join states by design. (Task 24.)
- [ ] **Step 4: Commit + PR each repo.**
- [ ] **Step 5: Deploy (ordered) + verify** — (1) tutorials-ims DB view, (2) gameboard MTA, (3) tutorials-ims islands. Then **verification-before-done**: logged-in on DEV, `/devtoberfest/gameboard/` shows **"Join Devtoberfest"** (not "log in"); `/devtoberfest/arcade/` shows the How-to-Play/Lawyers columns + menu + banner with correct layout; both show the coming-soon empty-state (0 activities). Hybrid test for the active-event view green.

---

## Self-Review

**Spec coverage:** active-event view (Task 1–2) ✅; status contract (Task 3) ✅; leaderboard CTA+empty-state (Task 4) ✅; arcade CTA (Task 5) ✅; arcade legacy content+layout (Task 6) ✅; data-gap doc (Task 7) ✅. Deploy order enforced (Task 7 Step 5).

**Placeholder scan:** No TBDs. Legacy text is verbatim from recon. View SQL uses verified physical names. The only judgment items (exact column x% positions in Task 6 Step 3, community-link presence in the header) are visual-tuning with a stated default, referencing the recon's coordinate table.

**Type consistency:** `status` enum values identical across CDS (Task 3), islands (Tasks 4–5), tests. Facade `GameboardActiveEventV1` cols (`EVENT_ID/EVENT_NAME/EVENT_START/EVENT_END`) match the view (Task 1) and `getActiveEvent` reads (Task 2). `hasActiveEvent`/`activityCount` consistent between Task 3 and Task 4.
