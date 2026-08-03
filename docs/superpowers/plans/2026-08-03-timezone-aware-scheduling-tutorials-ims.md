# Timezone-Aware Scheduling — tutorials-ims Consumer (Plan 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Consume the planner's new zone-aware schedule (UTC `scheduledStart` + IANA `scheduledTimeZone`) end-to-end in tutorials-ims, and render every session time in the viewer's own browser timezone with an explicit zone label.

**Architecture:** Update the cross-container facade + route SELECT + feed mapper to carry `scheduledStart`/`scheduledTimeZone`/`recordingStart` (and Edition `startsAt`/`endsAt`/`timeZone`) instead of the dropped naive columns. Add a browser-side `format-session-time.ts` helper (native `Intl`, DST-correct) producing viewer-local text + a home-zone label. Repoint calendar bucketing/sorting from naive strings to the UTC instant. Update the Vue islands and tests.

**Tech Stack:** SAP CAP (Node.js), CDS `@cds.persistence.exists` facade, Vue 3 islands (`hugo-apps/`), Vitest, native `Intl`, Playwright (e2e).

**Design spec:** `devtoberfest-planner/docs/superpowers/specs/2026-08-03-timezone-aware-scheduling-design.md` (§3 output rendering, §4 facade sync).

## Global Constraints

- **Deploy lockstep:** this branch's facade change MUST deploy in the same window as the planner's `_V1` view change (planner-first, then this). The old columns are physically gone from the planner views; a stale facade → 500s on `/api/devtoberfest/*`.
- Conversion/formatting is **DST-correct via native `Intl`** — never static offsets. IANA zone from `scheduledTimeZone`.
- **Viewer-local is the default display; home-zone is a secondary label.** Empty/absent `scheduledStart` → the existing "Unscheduled" bucket (never dropped silently).
- Column names in the facade mirror the DEPLOYED planner view contract exactly (UPPERCASE): `SCHEDULEDSTART`, `SCHEDULEDTIMEZONE`, `RECORDINGSTART`, Edition `STARTSAT`/`ENDSAT`/`TIMEZONE`.
- Never write raw SQL — CDS/CQL only. Facade is read-only (`@cds.persistence.exists`).
- Tests: hugo-apps use Vitest (`npm run test` in `hugo-apps/`, or the repo's configured runner); CAP unit tests use the repo's `npm test`. e2e is Playwright, post-deploy, self-skipping.
- Follow the repo's Vue-island + e2e conventions (islands mount into `<main>`; e2e self-skips without `PLAYWRIGHT_BASE_URL`).

## DECISION (resolved by Tom, 2026-08-03): Viewer's local zone (B)

**Calendar-grid bucketing zone.** With a real UTC instant, which day-cell does a session fall in?
- **CHOSEN — (B) Viewer zone:** bucket by the **viewer's local day**. The grid is personal to each viewer; a session near midnight UTC may land on different calendar days for people in different zones. Times shown on each entry are viewer-local either way; this decision governs only which day-cell/column the session sits in.
- (A) Event/home zone (not chosen): would bucket by the day in `scheduledTimeZone` for one shared grid.

**Task 4 implication:** `groupByDate` derives its day key from the **viewer's** local day (`viewerDayKey(instantISO)` — from the instant in the browser's local zone), NOT the home zone. `homeZoneDayKey` is therefore NOT needed for bucketing; the home zone is used only for the secondary time-label on each entry (`formatHomeZone`). `unscheduled` still filters `!scheduledStart`.

---

### Task 1: Facade — repoint to new planner columns

**Files:**
- Modify: `db/external/devtoberfest.cds` (Session `SCHEDULEDDATE`/`SCHEDULEDTIME`/`RECORDINGDATE`; Edition `STARTDATE`/`ENDDATE`; Speakerconsent `CONSENTSENTDATE`/`CONSENTRECEIVEDDATE`)
- Test: `test/<unit>/devtoberfest-facade-shape.test.js` (new — asserts the facade CSN exposes new fields, not old)

**Interfaces:**
- Produces: facade entities `external.devtoberfest.Session` with `SCHEDULEDSTART : Timestamp`, `SCHEDULEDTIMEZONE : String(50)`, `RECORDINGSTART : Timestamp`; `Edition` with `STARTSAT`/`ENDSAT : Timestamp`, `TIMEZONE : String(50)`; `Speakerconsent` consent dates → `Timestamp`.

- [ ] **Step 1: Write the failing test** — load the model, assert `Session.elements.SCHEDULEDSTART.type === 'cds.Timestamp'`, `SCHEDULEDTIMEZONE` present, `SCHEDULEDDATE`/`SCHEDULEDTIME` undefined; Edition `STARTSAT`/`ENDSAT`/`TIMEZONE` present, `STARTDATE`/`ENDDATE` undefined. (Use the repo's working CAP model-load pattern; see the planner's `test/schema-timezone.test.js` for the `cds.load` + linked-model approach, adapted to this repo's test bootstrap — note this repo's unit bootstrap uses `cds.test('serve',...)`, see [[cap-unit-test-bootstrap-cds-model-undefined]].)
- [ ] **Step 2: Run — verify it fails.**
- [ ] **Step 3: Edit `db/external/devtoberfest.cds`:**
```cds
// Session:
      SCHEDULEDSTART        : Timestamp;
      SCHEDULEDTIMEZONE     : String(50);
      RECORDINGSTART        : Timestamp;
// (remove SCHEDULEDDATE, SCHEDULEDTIME, RECORDINGDATE)
// Edition:
      STARTSAT              : Timestamp;
      ENDSAT                : Timestamp;
      TIMEZONE              : String(50);
// (remove STARTDATE, ENDDATE)
// Speakerconsent: CONSENTSENTDATE / CONSENTRECEIVEDDATE → Timestamp
```
- [ ] **Step 4: Run test + `npx cds build --production`** — passes, compiles. (Expect dangling refs from the route/feed until Tasks 2-3 — sequence 1→2→3 as a green-restoring group like the planner's 2→3 pair.)
- [ ] **Step 5: Commit** — `feat: repoint devtoberfest facade to zone-aware planner columns`.

---

### Task 2: Route SELECT — request the new columns

**Files:**
- Modify: `srv/routes/devtoberfest-schedule.js` (line ~46 Session `.columns(...)`, and any Edition/Activity column lists touching schedule fields)
- Test: covered by Task 3's feed test + Task 1 group's green restore.

**Interfaces:**
- Consumes: facade from Task 1.
- Produces: route hands the feed mapper rows carrying `SCHEDULEDSTART`, `SCHEDULEDTIMEZONE`, (and `RECORDINGSTART` if surfaced).

- [ ] **Step 1: Update the `.columns(...)` list** on the `ext.Session` SELECT (line ~46): replace `'SCHEDULEDDATE', 'SCHEDULEDTIME'` with `'SCHEDULEDSTART', 'SCHEDULEDTIMEZONE'`. If Edition is selected with explicit columns anywhere, swap `STARTDATE`/`ENDDATE` → `STARTSAT`/`ENDSAT`/`TIMEZONE`. Grep the file for any other old column literal.
- [ ] **Step 2: Grep** `grep -n "SCHEDULEDDATE\|SCHEDULEDTIME\|STARTDATE\|ENDDATE" srv/routes/devtoberfest-schedule.js` → zero hits.
- [ ] **Step 3: Commit** — `feat: select zone-aware schedule columns in devtoberfest route`.

---

### Task 3: Feed mapper — emit instant + zone in the DTO

**Files:**
- Modify: `srv/lib/devtoberfest-feed.js` (`assembleFeed`, line ~19 Edition map, ~22-25 Session map, ~58 sort)
- Modify: `hugo-apps/src/devtoberfest-schedule-shared/types.ts` (`Session`, `Edition` interfaces)
- Test: `test/<unit>/devtoberfest-feed.test.js` (extend/create — assert mapper output)

**Interfaces:**
- Consumes: rows from Task 2.
- Produces: `Session` DTO with `scheduledStart?: string` (ISO UTC), `scheduledTimeZone?: string`, `recordingStart?: string`; `Edition` DTO with `startsAt`/`endsAt`/`timeZone`. Old `scheduledDate`/`scheduledTime`/`startDate`/`endDate` removed from the DTO.

- [ ] **Step 1: Write the failing feed test** — `assembleFeed({ sessions:[{ ID:'s', TITLE:'X', SCHEDULEDSTART:'2026-10-01T15:00:00.000Z', SCHEDULEDTIMEZONE:'Europe/Berlin', TRACK_ID:'t', WEEK:'1' }], ... })` → `feed.sessions[0].scheduledStart === '2026-10-01T15:00:00.000Z'` and `.scheduledTimeZone === 'Europe/Berlin'`; assert no `.scheduledDate` key.
- [ ] **Step 2: Run — verify it fails.**
- [ ] **Step 3: Update `assembleFeed`:**
```js
// session map (~line 22-25):
  scheduledStart: s.SCHEDULEDSTART, scheduledTimeZone: s.SCHEDULEDTIMEZONE,
  recordingStart: s.RECORDINGSTART,
// (remove scheduledDate/scheduledTime)
// edition map (~line 19):
  startsAt: e.STARTSAT, endsAt: e.ENDSAT, timeZone: e.TIMEZONE,
// sort (~line 58): sort by scheduledStart instead of scheduledDate:
  return w !== 0 ? w : String(a.scheduledStart || '').localeCompare(String(b.scheduledStart || ''));
```
- [ ] **Step 4: Update `types.ts`** — `Session`: replace `scheduledDate?`, `scheduledTime?` with `scheduledStart?: string; scheduledTimeZone?: string; recordingStart?: string`. `Edition`: replace `startDate?`/`endDate?` with `startsAt?`/`endsAt?`/`timeZone?`.
- [ ] **Step 5: Run feed test + full CAP suite** — green (this completes the 1→2→3 green-restoring group).
- [ ] **Step 6: Commit** — `feat: feed emits scheduledStart + zone; update shared types`.

---

### Task 4: `format-session-time` helper + calendar-core repoint

**Files:**
- Create: `hugo-apps/src/devtoberfest-schedule-shared/format-session-time.ts`
- Modify: `hugo-apps/src/devtoberfest-sessions-calendar/calendar-core.ts` (`parseISO`/`groupByDate`/`unscheduled` — bucket by instant)
- Test: `hugo-apps/src/devtoberfest-schedule-shared/__tests__/format-session-time.test.ts` (new); update `hugo-apps/src/devtoberfest-sessions-calendar/__tests__/calendar-core.test.ts`

**Interfaces:**
- Produces:
  - `formatViewerLocal(instantISO: string, opts?) -> string` — viewer's browser zone, `Intl.DateTimeFormat(undefined, { dateStyle, timeStyle, timeZoneName:'short' })`.
  - `formatHomeZone(instantISO: string, ianaZone: string, opts?) -> string` — pinned to `ianaZone`, with zone label (secondary entry label only, NOT bucketing).
  - `viewerDayKey(instantISO: string) -> string` — `YYYY-MM-DD` of the instant IN the viewer's local browser zone (**decision B — this is what bucketing uses**).
- Consumes: `Session.scheduledStart`/`scheduledTimeZone`.

- [ ] **Step 1: Write failing helper tests** — DST-correct spot checks:
```ts
// formatHomeZone: 2026-10-01T15:00:00Z in Europe/Berlin (CEST, UTC+2) → 17:00 + CEST/GMT+2 label
expect(formatHomeZone('2026-10-01T15:00:00Z','Europe/Berlin')).toMatch(/5:00\s?PM|17:00/);
expect(formatHomeZone('2026-10-01T15:00:00Z','Europe/Berlin')).toMatch(/GMT\+2|CEST/);
// viewerDayKey buckets by the VIEWER's local day (decision B). Pin the test TZ deterministically,
// e.g. TZ='America/Los_Angeles': 2026-10-02T05:00:00Z is 2026-10-01 22:00 in LA → '2026-10-01'
expect(viewerDayKey('2026-10-02T05:00:00Z')).toBe('2026-10-01'); // with TZ=America/Los_Angeles
```
(For `formatViewerLocal` and `viewerDayKey`, pin the test's TZ via `process.env.TZ`/Vitest env so it's deterministic; assert `formatViewerLocal` renders a time + a zone-name token.)
- [ ] **Step 2: Run — verify fail.**
- [ ] **Step 3: Implement the helper** using `Intl.DateTimeFormat` + `formatToParts` (mirror the planner `srv/lib/tz-format.js` approach: `viewerDayKey` formats y/m/d with `timeZone` omitted = browser local, join `YYYY-MM-DD`; `formatHomeZone` pins `timeZone: ianaZone`). Fallback to `'Etc/UTC'` when a home zone is missing (label only).
- [ ] **Step 4: Repoint `calendar-core.ts`** — `groupByDate(sessions)` keys via `viewerDayKey(s.scheduledStart)` (**decision B — viewer's local day**); sort within a day by `scheduledStart` (ISO compares correctly) instead of `scheduledTime`. `unscheduled(sessions)` filters `!s.scheduledStart`. Keep the Monday-first grid math unchanged. NOTE: bucketing no longer needs `scheduledTimeZone` — that field is used only by the Vue render layer (Task 5) for the home-zone label.
- [ ] **Step 5: Update `calendar-core.test.ts`** — fixtures use `scheduledStart` ISO; pin `process.env.TZ` for determinism; assert grouping keys off the viewer-local day, sort by instant, `unscheduled` for missing `scheduledStart`. Keep the "undated → Unscheduled" and "sort by time" intents.
- [ ] **Step 6: Run hugo-apps tests** — green.
- [ ] **Step 7: Commit** — `feat: zone-aware session time formatting + viewer-local calendar bucketing`.

---

### Task 5: Render viewer-local + home-zone in the Vue islands

**Files:**
- Modify: `hugo-apps/src/devtoberfest-sessions-calendar/DayAgenda.vue` (line ~49 `{{ s.scheduledTime }}`)
- Modify: `hugo-apps/src/devtoberfest-schedule-shared/DetailPanel.vue` (lines ~56-62 scheduledDate/scheduledTime `<dd>`s)
- Modify: any other island rendering the removed fields — grep `hugo-apps/src` for `scheduledTime`/`scheduledDate` (e.g. `devtoberfest-schedule`, `devtoberfest-sessions-grid`, `devtoberfest-shared`)
- Test: covered by Task 4 helper tests + Task 6 e2e.

**Interfaces:**
- Consumes: `format-session-time` helper (Task 4), `Session.scheduledStart`/`scheduledTimeZone`.

- [ ] **Step 1: Grep every island reference** — `grep -rn "scheduledTime\|scheduledDate\|startDate\|endDate" hugo-apps/src` and list each render site.
- [ ] **Step 2: DayAgenda.vue** — replace `<span v-if="s.scheduledTime" class="da-time">{{ s.scheduledTime }}</span>` with a computed rendering `formatViewerLocal(s.scheduledStart)` (viewer-local time), guarded on `s.scheduledStart`. Optionally a title/tooltip with `formatHomeZone(...)`.
- [ ] **Step 3: DetailPanel.vue** — replace the `scheduledDate`/`scheduledTime` `<dd>`s with a single "When" row: `formatViewerLocal(row.scheduledStart)` as the primary value + a secondary line `formatHomeZone(row.scheduledStart, row.scheduledTimeZone) + ' · event time'`. Guard on `scheduledStart`.
- [ ] **Step 4: Update any other islands** found in Step 1 the same way (viewer-local primary, home-zone label secondary).
- [ ] **Step 5: Build hugo-apps + run tests** — green; no TS references to removed fields remain.
- [ ] **Step 6: Commit** — `feat: render session times in viewer timezone with home-zone label`.

---

### Task 6: e2e coverage for zone-aware schedule

**Files:**
- Modify: `test/e2e/devtoberfest-schedule.test.js`

**Interfaces:** exercises the deployed pages end-to-end (post-deploy, self-skipping).

- [ ] **Step 1: Add an assertion** to the schedule/calendar spec that, when sessions render, a time cell contains a zone-name token (e.g. matches `/GMT[+-]\d|[A-Z]{2,5}T?\b/` for an abbrev, or at least is non-empty and not a bare `HH:MM` with no zone) — proving the viewer-local+label rendering shipped, not the old raw naive string. Keep the existing empty-state tolerance (fresh DEV edition may have no rows).
- [ ] **Step 2: Keep the `<main>` mount + hydration waits** per repo convention. Do not hard-require rows (DEV data may be empty) — assert the zone rendering only when at least one session cell is present.
- [ ] **Step 3: Commit** — `test(e2e): assert zone-labeled session times on schedule pages`.

---

### Task 7: Full suite + build gate

- [ ] **Step 1:** CAP unit suite green (`npm test`).
- [ ] **Step 2:** hugo-apps tests green.
- [ ] **Step 3:** `npx cds build --production` succeeds (facade compiles; no dangling old-column refs anywhere: `grep -rn "SCHEDULEDDATE\|SCHEDULEDTIME\|RECORDINGDATE\|\.scheduledDate\|\.scheduledTime" srv/ hugo-apps/src db/external` returns only legitimate hits, ideally none).
- [ ] **Step 4:** Open PR. **PR body MUST state the deploy-lockstep requirement** with the planner branch.

---

## Self-Review

**Spec coverage (§3 output + §4 facade):** facade sync (Task 1), route+feed carry the instant (Tasks 2-3), viewer-local + home-zone helper (Task 4), island rendering (Task 5), calendar bucketing by instant (Task 4), e2e (Task 6). SpeakerConsent facade retype (Task 1) — display of consent dates is admin-internal, rendered by existing FE (browser-local), no extra work.

**Placeholder scan:** concrete edits/tests in each task. The one deliberately-open item (calendar bucketing zone) is called out as an OPEN DECISION with a recommended default and the exact one-line divergence for the alternative — not a hidden TBD.

**Type consistency:** DTO field names `scheduledStart`/`scheduledTimeZone`/`recordingStart` and Edition `startsAt`/`endsAt`/`timeZone` match across facade (UPPERCASE) → feed → types → helper → islands. Helper names `formatViewerLocal`/`formatHomeZone`/`homeZoneDayKey` consistent across Tasks 4-5.

**Ordering:** Tasks 1→2→3 are a green-restoring group (facade rename dangles the route/feed until fixed), mirroring the planner's 2→3 pattern. Deploy lockstep with the planner branch is the top operational risk — stated as a Global Constraint and a PR-body requirement.

## Dependencies / sequencing

- **Blocked on:** planner PR (#29) deploying to the target HANA env, OR at minimum the planner `_V1` views being updated in the same deploy window. Do NOT deploy this branch against a HANA where the planner views still expose old columns (facade would still "work" but against stale views) or vice-versa.
- **Gameboard (Plan 3)** is independent of this plan.
