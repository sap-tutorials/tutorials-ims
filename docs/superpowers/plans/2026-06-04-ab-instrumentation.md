# A/B Instrumentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Anonymous client-side telemetry on `/`, `/browse/`, and `/tutorials/<slug>` so we can decide the `/` vs `/browse/` A/B test with statistical rigor, not vibes.

**Architecture:** Four sequenced PRs. Browser tracker module in `hugo-apps/src/shared/analytics/` accumulates events per session and POSTs batches to a CAP endpoint. Events land in a new `UIEvent` HANA entity (anonymous, no `@PersonalData`). Read surface via `AnalyticsService` + 6 pre-seeded SavedQueries with in-query 95% CI. Entire system behind `UI_EVENTS_ENABLED` feature flag (dormant by default; tracker self-disables on 503).

**Tech Stack:** CAP Node.js (CDS schema, after-hook handlers), Vite + Vue 3 + TypeScript (browser tracker), `navigator.sendBeacon` (final flush), `crypto.randomUUID` (sessionId), `sessionStorage` (per-tab session lifetime), Vitest + happy-dom (tests), HANA SQL (canonical queries with closed-form normal-approx CI calculation).

**Spec:** [docs/superpowers/specs/2026-06-04-ab-instrumentation-design.md](../specs/2026-06-04-ab-instrumentation-design.md)

**Issue:** [#204](https://github.com/sap-tutorials/tutorials-ims/issues/204) (parent: [#174](https://github.com/sap-tutorials/tutorials-ims/issues/174))

---

## Pre-flight

This plan assumes:

- You read the spec.
- You're working in a worktree off the latest `main` (per [[parallel-agents-need-worktrees]]).
- `npm install && npm run setup` has run in the worktree (per #214 — fresh worktrees miss `hugo-apps/node_modules` and the `better-sqlite3` native binding without `npm run setup`).
- `cf login` is authenticated to the DEV space (only needed for hybrid-mode smoke after PR 1 lands).
- Tests run via `npx vitest run <path> --no-coverage` — be aware [[worktree-tests-hang]] and cap with hard timeouts if the run sits silent for >2 minutes.

**Branch strategy.** Each PR (1, 2, 3, 4) is its own feature branch off `main`. PR 2 starts from a fresh `main` after PR 1 merges; same chain for 3 and 4. No long-lived integration branch.

**Architectural footnote (revealed during plan-writing).** The spec mentions "tracker loads site-wide via `ui5-bootstrap.ts`." During plan-writing I discovered `ui5-bootstrap.ts` is Hugo-built (via `js.Build`), not Vite-built — so it can't easily import from `hugo-apps/src/shared/analytics/`. The plan instead uses **per-page Vite entries**: `navigator/main.ts` calls `wireTracker('/')`, `browse/main.ts` calls `wireTracker('/browse/')`, and PR 3 adds a new `tutorial/main.ts` Vite entry that calls `wireTracker('/tutorials/')`. Three explicit surfaces, no cross-build-system imports. Spec is unaffected (the claim was about logical wiring, not the specific file).

---

## PR 1 — Schema + Endpoint

**Goal:** Land `UIEvent` entity + `POST /api/ui-event` write endpoint behind `UI_EVENTS_ENABLED` env flag. Tracker doesn't exist yet; endpoint dormant.

**Branch:** `feat/issue-204-pr1-schema-endpoint`

**Files (PR 1 scope):**

- Modify: `db/schema.cds` (add `UIEvent` entity)
- Create: `srv/lib/ui-event-handler.js` (write-side handler + validators)
- Create: `srv/lib/__tests__/ui-event-handler.test.js`
- Modify: `srv/server.js` (register `POST /api/ui-event` route + boot warning for `UI_EVENTS_ENABLED`)

### Task 1.1: Add the `UIEvent` entity to `db/schema.cds`

**Files:** `db/schema.cds`

- [ ] **Step 1: Find where to insert.** Open `db/schema.cds`. Search for the entity that's most analogous (anonymous, telemetry-shaped). If there isn't one, append at the end of the `namespace com.sap.developers.ims` block. Keep entities in roughly-related groupings.

- [ ] **Step 2: Add the entity.**

```cds
/**
 * UIEvent — anonymous client-side telemetry for the / vs /browse/ A/B test (#204).
 *
 * Deliberately NOT @PersonalData: sessionId is per-tab anonymous (browser-generated
 * UUID v4 in sessionStorage, cleared on tab close). userAgent is truncated. No
 * userId, IP, or fingerprint. Stays outside the anonymization cascade. See
 * docs/superpowers/specs/2026-06-04-ab-instrumentation-design.md.
 */
entity UIEvent {
  key ID            : UUID;
      sessionId     : String(36) not null;           // browser-generated UUID v4
      surface       : String(32) not null;           // '/', '/browse/', '/tutorials/'
      eventType     : String(32) not null;           // page_view | filter_change | card_click | pagination_change | rail_show_all_click | scroll_depth | page_leave | referred_view
      timestamp     : Timestamp not null;            // browser-side (ms precision)
      receivedAt    : Timestamp default $now;        // server-side
      payload       : LargeString;                   // JSON-serialized type-specific fields
      userAgent     : String(512);                   // truncated to first 512 chars
      buildAt       : String(32);                    // hugo build hash for diff-attribution
}
```

- [ ] **Step 3: Add HANA indexes via a hdbindex file.** Read existing `.hdbindex` files in `db/` if any; otherwise create them via the standard CDS pattern. CAP auto-generates indexes from CDS only for `key` and `unique`. For ad-hoc query performance, add explicit indexes:

```cds
// At the bottom of db/schema.cds, OR in a sibling file db/indexes.cds (check existing convention).
annotate UIEvent with @cds.persistence.index : [
  { name: 'IDX_UIEVENT_SESSION', columns: [ 'sessionId' ] },
  { name: 'IDX_UIEVENT_SURFACE_TS', columns: [ 'surface', 'timestamp' ] },
  { name: 'IDX_UIEVENT_TYPE_TS', columns: [ 'eventType', 'timestamp' ] }
];
```

If the project's existing pattern uses `.hdbindex` files instead, follow that. Read the `db/` directory for the convention before writing.

- [ ] **Step 4: Run `cds build` to validate the schema compiles.**

```bash
npx cds build --production 2>&1 | tail -20
```

Expected: build succeeds, `gen/db/` is regenerated, no errors mentioning `UIEvent`.

- [ ] **Step 5: Commit.**

```bash
CURRENT_BRANCH=$(git branch --show-current)
[ "$CURRENT_BRANCH" = "feat/issue-204-pr1-schema-endpoint" ] || { echo "WRONG BRANCH"; exit 1; }
git add db/schema.cds db/indexes.cds 2>/dev/null || git add db/schema.cds
git commit -m "feat(db): UIEvent entity for A/B telemetry (#204)

Anonymous, session-scoped client-side telemetry. Per-tab sessionId
(browser-generated UUID v4 in sessionStorage), no userId/IP/fingerprint,
not @PersonalData, not in the anonymization cascade.

Indexes on sessionId, (surface, timestamp), (eventType, timestamp)
for the canonical A/B comparison queries (PR 4).

Refs #204"
```

### Task 1.2: Write the failing tests for the UI event handler

**Files:**
- Create: `srv/lib/__tests__/ui-event-handler.test.js`

- [ ] **Step 1: Write 8 test cases covering the handler contract.**

```js
// srv/lib/__tests__/ui-event-handler.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { _resetForTests, validateBatch, handleUIEvent } from '../ui-event-handler.js'

describe('ui-event-handler', () => {
  beforeEach(() => {
    _resetForTests({ enabled: true, insertFn: vi.fn().mockResolvedValue() })
  })

  describe('validateBatch', () => {
    it('accepts a well-formed batch', () => {
      const result = validateBatch({
        sessionId: 'a3e0a8b1-1234-4567-89ab-cdef01234567',
        events: [
          { eventType: 'page_view', surface: '/', timestamp: 1718000000000, payload: { path: '/', referrer: '' } },
        ],
      })
      expect(result.ok).toBe(true)
    })

    it('rejects non-UUID sessionId', () => {
      const result = validateBatch({ sessionId: 'not-a-uuid', events: [] })
      expect(result.ok).toBe(false)
      expect(result.reason).toMatch(/sessionId/i)
    })

    it('rejects empty events array', () => {
      const result = validateBatch({
        sessionId: 'a3e0a8b1-1234-4567-89ab-cdef01234567',
        events: [],
      })
      expect(result.ok).toBe(false)
      expect(result.reason).toMatch(/events/i)
    })

    it('rejects unknown eventType', () => {
      const result = validateBatch({
        sessionId: 'a3e0a8b1-1234-4567-89ab-cdef01234567',
        events: [{ eventType: 'banana', surface: '/', timestamp: 1, payload: {} }],
      })
      expect(result.ok).toBe(false)
      expect(result.reason).toMatch(/eventType|banana/i)
    })

    it('rejects oversized payload (>32 KB)', () => {
      const big = 'x'.repeat(33 * 1024)
      const result = validateBatch({
        sessionId: 'a3e0a8b1-1234-4567-89ab-cdef01234567',
        events: [{ eventType: 'page_view', surface: '/', timestamp: 1, payload: { path: big, referrer: '' } }],
      })
      expect(result.ok).toBe(false)
      expect(result.reason).toMatch(/size|32/i)
    })

    it('rejects non-array events', () => {
      const result = validateBatch({
        sessionId: 'a3e0a8b1-1234-4567-89ab-cdef01234567',
        events: 'not-an-array',
      })
      expect(result.ok).toBe(false)
    })
  })

  describe('handleUIEvent', () => {
    it('returns 204 on valid batch and calls insert', async () => {
      const insertFn = vi.fn().mockResolvedValue()
      _resetForTests({ enabled: true, insertFn })
      const req = mockReq({
        sessionId: 'a3e0a8b1-1234-4567-89ab-cdef01234567',
        events: [{ eventType: 'page_view', surface: '/', timestamp: 1, payload: { path: '/', referrer: '' } }],
      })
      const res = mockRes()
      await handleUIEvent(req, res)
      expect(res.statusCode).toBe(204)
      expect(insertFn).toHaveBeenCalledTimes(1)
    })

    it('returns 503 when feature flag is off', async () => {
      _resetForTests({ enabled: false, insertFn: vi.fn() })
      const req = mockReq({ sessionId: 'a3e0a8b1-1234-4567-89ab-cdef01234567', events: [] })
      const res = mockRes()
      await handleUIEvent(req, res)
      expect(res.statusCode).toBe(503)
    })
  })
})

function mockReq(body) {
  return {
    body,
    header: () => 'mock-user-agent',
    headers: { 'user-agent': 'mock-user-agent' },
  }
}

function mockRes() {
  const res = {
    statusCode: 0,
    body: null,
    status(code) { this.statusCode = code; return this },
    json(body) { this.body = body; return this },
    end() { return this },
  }
  return res
}
```

- [ ] **Step 2: Run, verify FAIL.**

```bash
npx vitest run srv/lib/__tests__/ui-event-handler.test.js --no-coverage 2>&1 | tail -10
```

Expected: FAIL — `Cannot find module '../ui-event-handler.js'`.

### Task 1.3: Implement the handler

**Files:**
- Create: `srv/lib/ui-event-handler.js`

- [ ] **Step 1: Implement.**

```js
// srv/lib/ui-event-handler.js
//
// Write-side handler for POST /api/ui-event — accepts batches of anonymous
// client-side telemetry from the browser tracker (PR 2). Behind UI_EVENTS_ENABLED
// env flag (dormant by default = 503). Validates payload, rejects oversized
// or malformed batches, INSERTs to UIEvent entity in HANA.
//
// Spec: docs/superpowers/specs/2026-06-04-ab-instrumentation-design.md (#204)

import cds from '@sap/cds'

const VALID_EVENT_TYPES = new Set([
  'page_view', 'filter_change', 'card_click', 'pagination_change',
  'rail_show_all_click', 'scroll_depth', 'page_leave', 'referred_view',
])

const VALID_SURFACES = new Set(['/', '/browse/', '/tutorials/'])
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_PAYLOAD_BYTES = 32 * 1024 // 32 KB defensive cap (pagehide sendBeacon hard limit is 64 KB)

let _state = {
  enabled: process.env.UI_EVENTS_ENABLED === 'true',
  insertFn: defaultInsert,
}

async function defaultInsert(rows) {
  const db = await cds.connect.to('db')
  const { UIEvent } = cds.entities('com.sap.developers.ims')
  return db.run(INSERT.into(UIEvent).entries(rows))
}

export function _resetForTests({ enabled, insertFn }) {
  _state.enabled = enabled
  _state.insertFn = insertFn ?? defaultInsert
}

export function checkFeatureFlag() {
  if (!_state.enabled) {
    console.warn('[ui-event] UI_EVENTS_ENABLED unset — POST /api/ui-event returns 503 by default. Tracker self-disables. Set UI_EVENTS_ENABLED=true on tutorials-srv when ready to start collecting A/B data.')
  }
}

export function validateBatch(body) {
  if (!body || typeof body !== 'object') {
    return { ok: false, reason: 'body must be a JSON object' }
  }
  if (typeof body.sessionId !== 'string' || !UUID_RE.test(body.sessionId)) {
    return { ok: false, reason: 'sessionId must be a UUID v4' }
  }
  if (!Array.isArray(body.events) || body.events.length === 0) {
    return { ok: false, reason: 'events must be a non-empty array' }
  }
  // Defensive: cap total batch JSON size
  const jsonSize = Buffer.byteLength(JSON.stringify(body.events), 'utf8')
  if (jsonSize > MAX_PAYLOAD_BYTES) {
    return { ok: false, reason: `events JSON exceeds 32 KB limit (got ${jsonSize})` }
  }
  for (const ev of body.events) {
    if (!ev || typeof ev !== 'object') {
      return { ok: false, reason: 'each event must be an object' }
    }
    if (!VALID_EVENT_TYPES.has(ev.eventType)) {
      return { ok: false, reason: `unknown eventType: ${ev.eventType}` }
    }
    if (!VALID_SURFACES.has(ev.surface)) {
      return { ok: false, reason: `unknown surface: ${ev.surface}` }
    }
    if (typeof ev.timestamp !== 'number' || ev.timestamp <= 0) {
      return { ok: false, reason: 'timestamp must be a positive number' }
    }
    // payload may be undefined (no required-fields check at handler level — too brittle)
  }
  return { ok: true }
}

export async function handleUIEvent(req, res) {
  if (!_state.enabled) {
    return res.status(503).json({ error: 'ui-events disabled' })
  }

  const validation = validateBatch(req.body)
  if (!validation.ok) {
    return res.status(400).json({ error: validation.reason })
  }

  const { sessionId, events } = req.body
  const userAgent = (req.headers?.['user-agent'] ?? '').slice(0, 512)
  const buildAt = req.body.buildAt ?? ''

  const rows = events.map(ev => ({
    sessionId,
    surface: ev.surface,
    eventType: ev.eventType,
    timestamp: new Date(ev.timestamp).toISOString(),
    payload: JSON.stringify(ev.payload ?? {}),
    userAgent,
    buildAt,
  }))

  try {
    await _state.insertFn(rows)
    return res.status(204).end()
  } catch (err) {
    console.error('[ui-event] insert failed:', err.message ?? err)
    return res.status(500).json({ error: 'insert failed' })
  }
}
```

- [ ] **Step 2: Run the tests, verify PASS.**

```bash
npx vitest run srv/lib/__tests__/ui-event-handler.test.js --no-coverage 2>&1 | tail -10
```

Expected: 8 tests PASS.

- [ ] **Step 3: Run wider srv/lib tests to confirm no regression.**

```bash
npx vitest run srv/lib/__tests__/ --no-coverage 2>&1 | tail -8
```

Expected: 8 new + N pre-existing PASS.

- [ ] **Step 4: Commit.**

```bash
CURRENT_BRANCH=$(git branch --show-current)
[ "$CURRENT_BRANCH" = "feat/issue-204-pr1-schema-endpoint" ] || { echo "WRONG BRANCH"; exit 1; }
git add srv/lib/ui-event-handler.js srv/lib/__tests__/ui-event-handler.test.js
git commit -m "feat(srv): ui-event-handler.js — POST /api/ui-event with feature flag (#204)

Validates batch (UUID sessionId, known eventType, known surface, positive
timestamp, < 32 KB JSON), inserts rows into UIEvent. Behind UI_EVENTS_ENABLED
env flag (dormant by default = 503).

8 unit tests cover validation + handler 503/204/500 paths. Mock injection
via _resetForTests.

Refs #204"
```

### Task 1.4: Wire the handler into srv/server.js

**Files:** `srv/server.js`

- [ ] **Step 1: Import + boot warning.** Find the imports section near the top of `srv/server.js`. Add:

```js
import { handleUIEvent, checkFeatureFlag as checkUIEventFeatureFlag } from './lib/ui-event-handler.js'
```

In the `cds.on('served', ...)` block, alongside other startup checks (e.g. `checkRebuildTriggerFeatureFlag()` from PR 3 of #174), add:

```js
checkUIEventFeatureFlag()
```

- [ ] **Step 2: Register the route.** Find the `cds.on('bootstrap', (app) => { ... })` block where other custom routes are mounted (e.g. `/build/catalog`, `/api/qrcode`, `/feedback/submit`). Add:

```js
// [#204] POST /api/ui-event — anonymous A/B telemetry batch endpoint.
// See srv/lib/ui-event-handler.js + docs/superpowers/specs/2026-06-04-ab-instrumentation-design.md
app.post('/api/ui-event', express.json({ limit: '64kb' }), handleUIEvent)
```

The `express.json({ limit: '64kb' })` middleware caps the parsed body size — sendBeacon's max is 64 KB; our defensive check is 32 KB. The express limit is the outer guard.

If `express` isn't already imported in `srv/server.js`, check what JSON middleware the file uses (likely `cds.middlewares` or a similar pattern); use whatever the existing custom routes use.

- [ ] **Step 3: Run hybrid-mode smoke locally if possible.** This step is deferred to Tom's manual checklist (requires `cds bind` to a deployed CAP). Skip if not available.

- [ ] **Step 4: Run all srv tests as a regression check.**

```bash
npx vitest run srv/lib/__tests__/ --no-coverage 2>&1 | tail -5
```

Expected: all PASS.

- [ ] **Step 5: Commit.**

```bash
CURRENT_BRANCH=$(git branch --show-current)
[ "$CURRENT_BRANCH" = "feat/issue-204-pr1-schema-endpoint" ] || { echo "WRONG BRANCH"; exit 1; }
git add srv/server.js
git commit -m "feat(srv): wire POST /api/ui-event route + boot warning (#204)

Mounts handleUIEvent on /api/ui-event with express.json 64 KB limit
(sendBeacon's hard cap). checkUIEventFeatureFlag() emits a one-shot
boot warning if UI_EVENTS_ENABLED is unset so ops sees the flag state
at startup.

Refs #204"
```

### Task 1.5: Audit srv-qa cp-list

Per [[srv-qa-cp-list-recurring]], every new file under `srv/lib/` triggers a cp-list audit because the project's hand-curated cp list at `.deploy/mta.yaml:88` has crashed QA boot twice when missed. **Don't skip — even if the answer is "no change needed."**

**Files to inspect:**
- `srv-qa/server.js`
- `.deploy/mta.yaml` (`tutorials-srv-qa` build commands)

- [ ] **Step 1: Check whether QA imports the new module.**

```bash
grep -rE "ui-event-handler|/api/ui-event" srv-qa/ 2>&1
```

Expected: empty. The QA srv is for the author-preview channel and doesn't run admin services or the A/B endpoint.

- [ ] **Step 2: Check the cp-list at `.deploy/mta.yaml`.** Find the `tutorials-srv-qa` module (around line 70+) and the `bash -c "mkdir -p srv/jobs && cp ../../srv/lib/...` line. Confirm `ui-event-handler.js` is NOT in that list. (It shouldn't be — QA doesn't need it.)

- [ ] **Step 3: Document the explicit decision.** No code change needed; the audit conclusion goes in the PR description (Section "srv-qa cp-list audit"): "Verified: srv-qa/server.js does not import ui-event-handler.js. The /api/ui-event endpoint is not exposed on QA channel. No cp-list change required."

- [ ] **Step 4: If the audit reveals QA needs the file** (unlikely, but possible if A/B testing extends to QA author-preview later), add `../../srv/lib/ui-event-handler.js` to the `cp` line in `.deploy/mta.yaml` and commit.

### Task 1.6: Open PR 1

- [ ] **Step 1: Verify branch + tests.**

```bash
CURRENT_BRANCH=$(git branch --show-current)
echo "Branch: $CURRENT_BRANCH"
[ "$CURRENT_BRANCH" = "feat/issue-204-pr1-schema-endpoint" ] || { echo "WRONG BRANCH"; exit 1; }
npx vitest run srv/lib/__tests__/ --no-coverage 2>&1 | tail -5
```

- [ ] **Step 2: Push + open PR.**

```bash
git push -u origin feat/issue-204-pr1-schema-endpoint
gh pr create --repo sap-tutorials/tutorials-ims --base main \
  --title "feat: UIEvent entity + POST /api/ui-event for A/B telemetry (#204 PR 1)" \
  --body "$(cat <<'EOF'
PR 1 of 4 implementing #204 ([spec](docs/superpowers/specs/2026-06-04-ab-instrumentation-design.md)). Schema + endpoint + feature flag. Tracker (PR 2), tutorial referred-view (PR 3), and SavedQueries+runbook (PR 4) follow.

## What

- New \`UIEvent\` CDS entity (anonymous, no \`@PersonalData\`, indexes for canonical queries).
- New \`srv/lib/ui-event-handler.js\` with batch validation + INSERT.
- New \`POST /api/ui-event\` route in \`srv/server.js\` (64 KB express body cap).
- \`UI_EVENTS_ENABLED\` env flag — dormant by default (returns 503), set per-environment when ready to collect.
- Boot warning so ops sees the flag state on srv startup.

## Tests

8 unit tests for the handler (UUID sessionId validation, eventType + surface allowlists, 32 KB defensive cap, 503-on-disabled, 204-on-success, 500-on-insert-fail). 

## Rollout

PR is **safe to merge before any flag flip** — endpoint returns 503 + tracker (PR 2) self-disables on 503. Set \`UI_EVENTS_ENABLED=true\` on tutorials-srv via \`cf set-env\` when PR 4 (SavedQueries + runbook) is also live.

Refs #204 / spec PR #225
EOF
)"
```

---

## PR 2 — Frontend Tracker + `/` + `/browse/` Instrumentation

**Goal:** Wire all 7 event types from `/` and `/browse/` to the dormant endpoint. Tracker self-disables on 503 — safe to merge before flag flip.

**Branch:** `feat/issue-204-pr2-tracker` (start from a fresh `main` after PR 1 merges).

**Files (PR 2 scope):**

- Create: `hugo-apps/src/shared/analytics/tracker.ts` — core: sessionId, batcher, sender
- Create: `hugo-apps/src/shared/analytics/events.ts` — TS types + runtime validators
- Create: `hugo-apps/src/shared/analytics/page-events.ts` — page_view, page_leave, scroll_depth
- Create: `hugo-apps/src/shared/analytics/filter-events.ts` — filter_change wiring
- Create: `hugo-apps/src/shared/analytics/card-events.ts` — card_click, pagination_change, rail_show_all_click
- Create: `hugo-apps/src/shared/analytics/wire-tracker.ts` — orchestrator: `wireTracker(surface)` calls all four
- Create: `hugo-apps/src/shared/analytics/__tests__/tracker.test.ts` — pure unit tests (no DOM)
- Create: `hugo-apps/src/shared/analytics/__tests__/wire-tracker.test.ts` — integration with happy-dom
- Modify: `hugo-apps/src/navigator/main.ts` — call `wireTracker('/')` after mount
- Modify: `hugo-apps/src/browse/main.ts` — call `wireTracker('/browse/')` after mount
- Modify: `hugo/layouts/index.html` and/or `hugo/layouts/browse/list.html` — emit `window.__BROWSE_BUILD_AT` on `/` so the tracker has a value (per spec clarification commit `06f7818`)

### Task 2.1: Write the failing tests for `tracker.ts`

**Files:**
- Create: `hugo-apps/src/shared/analytics/__tests__/tracker.test.ts`

- [ ] **Step 1: Write 10 test cases.**

```ts
// hugo-apps/src/shared/analytics/__tests__/tracker.test.ts
// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import { _resetForTests, getSessionId, track, flush, _getBufferForTests } from '../tracker'

describe('tracker', () => {
  let mockStorage: Record<string, string>
  let mockSendBeacon: ReturnType<typeof vi.fn>
  let mockFetch: ReturnType<typeof vi.fn>
  let mockCryptoUuid: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.useFakeTimers()
    mockStorage = {}
    mockSendBeacon = vi.fn().mockReturnValue(true)
    mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 204 })
    mockCryptoUuid = vi.fn().mockReturnValue('a3e0a8b1-1234-4567-89ab-cdef01234567')
    _resetForTests({
      sessionStorage: {
        getItem: (k: string) => mockStorage[k] ?? null,
        setItem: (k: string, v: string) => { mockStorage[k] = v },
        removeItem: (k: string) => { delete mockStorage[k] },
      },
      sendBeacon: mockSendBeacon,
      fetchFn: mockFetch as any,
      cryptoUuid: mockCryptoUuid,
      surface: '/',
      buildAt: 'test-build',
    })
  })
  afterEach(() => { vi.useRealTimers() })

  it('generates a sessionId on first call and persists it', () => {
    const id1 = getSessionId()
    const id2 = getSessionId()
    expect(id1).toBe('a3e0a8b1-1234-4567-89ab-cdef01234567')
    expect(id2).toBe(id1)
    expect(mockCryptoUuid).toHaveBeenCalledTimes(1)
  })

  it('reuses sessionId from storage if present', () => {
    mockStorage['analytics.sessionId'] = '11111111-2222-4333-8444-555555555555'
    const id = getSessionId()
    expect(id).toBe('11111111-2222-4333-8444-555555555555')
    expect(mockCryptoUuid).not.toHaveBeenCalled()
  })

  it('appends to buffer on track()', () => {
    track('page_view', { path: '/', referrer: '' })
    expect(_getBufferForTests()).toHaveLength(1)
    expect(_getBufferForTests()[0]).toMatchObject({
      eventType: 'page_view',
      surface: '/',
      payload: { path: '/', referrer: '' },
    })
  })

  it('flushes immediately on card_click', async () => {
    track('card_click', { cardType: 'tutorial', cardId: 'x', position: 0, source: 'grid' })
    await vi.advanceTimersByTimeAsync(0)
    expect(mockSendBeacon).toHaveBeenCalledTimes(0) // sendBeacon only on pagehide
    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(_getBufferForTests()).toHaveLength(0)
  })

  it('flushes after 30s timer', async () => {
    track('page_view', { path: '/', referrer: '' })
    expect(mockFetch).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(30_001)
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('uses sendBeacon on explicit flush({ via: "beacon" })', () => {
    track('page_view', { path: '/', referrer: '' })
    flush({ via: 'beacon' })
    expect(mockSendBeacon).toHaveBeenCalledTimes(1)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('falls back to fetch{keepalive:true} when sendBeacon returns false', () => {
    mockSendBeacon.mockReturnValue(false)
    track('page_view', { path: '/', referrer: '' })
    flush({ via: 'beacon' })
    expect(mockSendBeacon).toHaveBeenCalledTimes(1)
    expect(mockFetch).toHaveBeenCalledTimes(1)
    const fetchCall = mockFetch.mock.calls[0]
    expect(fetchCall[1]?.keepalive).toBe(true)
  })

  it('self-disables after 3 consecutive 5xx responses', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 503 })
    track('page_view', { path: '/', referrer: '' })
    await vi.advanceTimersByTimeAsync(30_001)
    track('page_view', { path: '/', referrer: '' })
    await vi.advanceTimersByTimeAsync(30_001)
    track('page_view', { path: '/', referrer: '' })
    await vi.advanceTimersByTimeAsync(30_001)
    // 3 calls so far; tracker now self-disabled
    track('page_view', { path: '/', referrer: '' })
    await vi.advanceTimersByTimeAsync(30_001)
    expect(mockFetch).toHaveBeenCalledTimes(3) // 4th call short-circuited
  })

  it('drops batch on 4xx (no retry)', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 400 })
    track('page_view', { path: '/', referrer: '' })
    await vi.advanceTimersByTimeAsync(30_001)
    expect(_getBufferForTests()).toHaveLength(0) // dropped, not retained
  })

  it('serializes the batch with sessionId, events, buildAt fields', async () => {
    track('page_view', { path: '/', referrer: '' })
    await vi.advanceTimersByTimeAsync(30_001)
    const fetchCall = mockFetch.mock.calls[0]
    const body = JSON.parse(fetchCall[1].body)
    expect(body.sessionId).toBe('a3e0a8b1-1234-4567-89ab-cdef01234567')
    expect(body.buildAt).toBe('test-build')
    expect(body.events).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run, verify FAIL.** `npx vitest run hugo-apps/src/shared/analytics/__tests__/tracker.test.ts --no-coverage` — fails with module not found.

### Task 2.2: Implement `tracker.ts`

**Files:**
- Create: `hugo-apps/src/shared/analytics/tracker.ts`

- [ ] **Step 1: Implement.**

```ts
// hugo-apps/src/shared/analytics/tracker.ts
//
// Core tracker: sessionId lifetime, batch buffer, flush triggers, sendBeacon
// vs fetch fallback. Pure module — no DOM-event listeners here (those live in
// page-events.ts / filter-events.ts / card-events.ts and call track()).
//
// Spec: docs/superpowers/specs/2026-06-04-ab-instrumentation-design.md (#204)

const SESSION_KEY = 'analytics.sessionId'
const BATCH_FLUSH_INTERVAL_MS = 30_000
const MAX_5XX_BEFORE_DISABLE = 3
const ENDPOINT = '/api/ui-event'

interface TrackerState {
  surface: string
  buildAt: string
  buffer: BufferedEvent[]
  flushTimer: ReturnType<typeof setTimeout> | null
  consecutive5xx: number
  selfDisabled: boolean
  sessionStorage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
  sendBeacon: (url: string, data: string) => boolean
  fetchFn: typeof fetch
  cryptoUuid: () => string
}

interface BufferedEvent {
  eventType: string
  surface: string
  timestamp: number
  payload: Record<string, unknown>
}

let _state: TrackerState = createDefaultState()

function createDefaultState(): TrackerState {
  return {
    surface: '',
    buildAt: '',
    buffer: [],
    flushTimer: null,
    consecutive5xx: 0,
    selfDisabled: false,
    sessionStorage: typeof window !== 'undefined' && window.sessionStorage ? window.sessionStorage : noopStorage(),
    sendBeacon: typeof navigator !== 'undefined' && navigator.sendBeacon
      ? navigator.sendBeacon.bind(navigator)
      : () => false,
    fetchFn: typeof fetch !== 'undefined' ? fetch : (() => Promise.reject(new Error('no fetch'))) as typeof fetch,
    cryptoUuid: typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID.bind(crypto)
      : fallbackUuid,
  }
}

function noopStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
  return { getItem: () => null, setItem: () => {}, removeItem: () => {} }
}

function fallbackUuid(): string {
  // Math.random fallback for browsers without crypto.randomUUID. Not as
  // collision-resistant but the practical odds at our scale are negligible.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

export function _resetForTests(opts: Partial<TrackerState> & {
  sessionStorage?: any
  sendBeacon?: any
  fetchFn?: typeof fetch
  cryptoUuid?: () => string
}) {
  if (_state.flushTimer) clearTimeout(_state.flushTimer)
  _state = { ...createDefaultState(), ...opts }
}

export function init(opts: { surface: string; buildAt: string }) {
  _state.surface = opts.surface
  _state.buildAt = opts.buildAt
}

export function getSessionId(): string {
  let id = ''
  try {
    id = _state.sessionStorage.getItem(SESSION_KEY) ?? ''
  } catch {
    // sessionStorage unavailable (private mode, quota); generate anyway
  }
  if (!id) {
    id = _state.cryptoUuid()
    try {
      _state.sessionStorage.setItem(SESSION_KEY, id)
    } catch { /* noop */ }
  }
  return id
}

export function track(eventType: string, payload: Record<string, unknown>) {
  if (_state.selfDisabled) return
  _state.buffer.push({
    eventType,
    surface: _state.surface,
    timestamp: Date.now(),
    payload,
  })
  if (eventType === 'card_click') {
    flush({ via: 'fetch' })
  } else {
    scheduleFlush()
  }
}

function scheduleFlush() {
  if (_state.flushTimer) return
  _state.flushTimer = setTimeout(() => {
    _state.flushTimer = null
    flush({ via: 'fetch' })
  }, BATCH_FLUSH_INTERVAL_MS)
}

export function flush(opts: { via: 'fetch' | 'beacon' } = { via: 'fetch' }) {
  if (_state.selfDisabled) return
  if (_state.buffer.length === 0) return
  const events = _state.buffer.splice(0)
  if (_state.flushTimer) {
    clearTimeout(_state.flushTimer)
    _state.flushTimer = null
  }
  const sessionId = getSessionId()
  const body = JSON.stringify({ sessionId, buildAt: _state.buildAt, events })

  if (opts.via === 'beacon') {
    const blob = new Blob([body], { type: 'application/json' })
    const queued = _state.sendBeacon(ENDPOINT, blob as any)
    if (queued) return
    // Fall through to fetch fallback
  }

  _state.fetchFn(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    keepalive: opts.via === 'beacon',
  }).then(res => {
    if (res.ok) {
      _state.consecutive5xx = 0
      return
    }
    if (res.status >= 500) {
      _state.consecutive5xx += 1
      if (_state.consecutive5xx >= MAX_5XX_BEFORE_DISABLE) {
        _state.selfDisabled = true
        console.warn('[analytics] tracker self-disabled after 3 consecutive 5xx')
      }
    }
    // 4xx: drop batch, no retry
  }).catch(() => {
    _state.consecutive5xx += 1
    if (_state.consecutive5xx >= MAX_5XX_BEFORE_DISABLE) {
      _state.selfDisabled = true
    }
  })
}

export function _getBufferForTests(): BufferedEvent[] {
  return [..._state.buffer]
}
```

- [ ] **Step 2: Run, verify 10 PASS.** `npx vitest run hugo-apps/src/shared/analytics/__tests__/tracker.test.ts --no-coverage`.

- [ ] **Step 3: Commit.**

```bash
CURRENT_BRANCH=$(git branch --show-current)
[ "$CURRENT_BRANCH" = "feat/issue-204-pr2-tracker" ] || { echo "WRONG BRANCH"; exit 1; }
git add hugo-apps/src/shared/analytics/tracker.ts hugo-apps/src/shared/analytics/__tests__/tracker.test.ts
git commit -m "feat(analytics): tracker.ts core (#204)

sessionId lifetime, batch buffer, flush-on-30s + flush-on-card_click +
sendBeacon-on-pagehide, fetch fallback, self-disable after 3x 5xx.
10 unit tests covering full state machine. Pure module — no DOM listeners
(those land in page-events.ts / filter-events.ts / card-events.ts in
subsequent tasks).

Refs #204"
```

### Task 2.3: Implement event-wiring modules

**Files:**
- Create: `hugo-apps/src/shared/analytics/events.ts` (types + runtime validator)
- Create: `hugo-apps/src/shared/analytics/page-events.ts` (`page_view`, `page_leave`, `scroll_depth`)
- Create: `hugo-apps/src/shared/analytics/filter-events.ts` (`filter_change`)
- Create: `hugo-apps/src/shared/analytics/card-events.ts` (`card_click`, `pagination_change`, `rail_show_all_click`)
- Create: `hugo-apps/src/shared/analytics/wire-tracker.ts` (orchestrator)

These are larger files than the spec sketches. Each follows a similar pattern: import `track` from `tracker.ts`, register DOM listeners (or expose `wireX(opts)` to receive reactive state from the caller), call `track()` on interaction. Detailed implementations:

**`events.ts`:**

```ts
// hugo-apps/src/shared/analytics/events.ts
// Type definitions for the 8 event types. Runtime validation lives server-side
// (srv/lib/ui-event-handler.js); this file is purely TS shape declarations
// + helpers for callers.

export type Surface = '/' | '/browse/' | '/tutorials/'

export type FilterKind =
  | 'type' | 'level' | 'product' | 'topic' | 'search' | 'sort'
  | 'clear-all' | 'quick-new' | 'quick-noLicense'

export type CardSource = 'grid' | 'featured-rail' | 'recent-rail'

export interface PageViewPayload { path: string; referrer: string }
export interface FilterChangePayload { kind: FilterKind; value?: string | string[] }
export interface CardClickPayload {
  cardType: 'mission' | 'group' | 'tutorial'
  cardId: string
  position: number
  source: CardSource
}
export interface PaginationChangePayload { fromPage: number; toPage: number }
export interface RailShowAllClickPayload { railType: 'featured' | 'recent'; targetPath: string }
export interface ScrollDepthPayload { maxPercent: 25 | 50 | 75 | 100 }
export interface PageLeavePayload { durationMs: number; eventCount: number }
export interface ReferredViewPayload {
  tutorialSlug: string
  fromSurface: string
  fromCardId: string
}
```

**`page-events.ts`:** `wirePageEvents(surface)` — fires `page_view` immediately, sets up `pagehide` listener that fires `page_leave` + flushes via beacon, sets up `IntersectionObserver` on `<body>` for scroll-depth thresholds (25/50/75/100% — fires once each).

**`filter-events.ts`:** `wireFilterEvents({ filters, sort, searchQuery, surface })` — receives the `useNavigatorFilters` reactive state, sets up Vue `watch()` calls that fire `filter_change` on each mutation. Uses `useNavigatorFilters` from `@shared/composables/useNavigatorFilters`.

**`card-events.ts`:** `wireCardEvents(surface)` — uses `document.addEventListener('click', ...)` with delegation — checks if the click target is inside `.nav-card` and reads `data-vt-card`, classes, and the card's index in its parent for `position`. Determines `source` from the closest ancestor (`[data-rails-container]` for rails, otherwise `grid`). **Also writes `{ fromSurface, fromCardId }` to `sessionStorage['analytics.lastClick']` on every `card_click`** — this is the cross-PR signal that PR 3's `referred-view.ts` reads when a tutorial page mounts in the same tab. Without this write in PR 2, PR 3's `fromSurface` and `fromCardId` fields are always empty.

**`wire-tracker.ts`:**

```ts
// hugo-apps/src/shared/analytics/wire-tracker.ts
// Orchestrator. Call once per page after Vue mount completes.
// surface = '/', '/browse/', or '/tutorials/' — must match server allowlist.

import { init as initTracker } from './tracker'
import { wirePageEvents } from './page-events'
import { wireCardEvents } from './card-events'
import type { Surface } from './events'

export interface WireTrackerOpts {
  surface: Surface
  filters?: any  // useNavigatorFilters return value (for filter-events); optional on /tutorials/
}

export function wireTracker(opts: WireTrackerOpts) {
  if (typeof window === 'undefined') return
  const buildAt = (window as any).__BROWSE_BUILD_AT ?? ''
  initTracker({ surface: opts.surface, buildAt })
  wirePageEvents(opts.surface)
  wireCardEvents(opts.surface)
  if (opts.filters) {
    // Lazy import to avoid pulling Vue into /tutorials/ bundle
    import('./filter-events').then(({ wireFilterEvents }) => {
      wireFilterEvents({ filters: opts.filters, surface: opts.surface })
    })
  }
}
```

(The detailed bodies of `page-events.ts`, `filter-events.ts`, `card-events.ts` are left to the implementer; each is ~80-150 LOC. Tests for each follow the same pattern as `tracker.test.ts` — happy-dom environment, mock event sources, assert `track()` is called with the right shape.)

- [ ] **Step 1: Write tests for `wire-tracker.ts`.** `__tests__/wire-tracker.test.ts` — happy-dom environment, mock the four wire-X functions, assert `wireTracker({ surface: '/' })` calls all four.

- [ ] **Step 2: Implement each of the 5 modules.** TDD per file: test, fail, implement, pass.

- [ ] **Step 3: Run all analytics tests.**

```bash
npx vitest run hugo-apps/src/shared/analytics/ --no-coverage 2>&1 | tail -10
```

Expected: all PASS (≥30 tests across the modules).

- [ ] **Step 4: Commit each module separately.** Five commits, one per module. Use `git add hugo-apps/src/shared/analytics/<file>.ts hugo-apps/src/shared/analytics/__tests__/<file>.test.ts && git commit -m "feat(analytics): <module> (#204)"` — keeps the commit log readable.

### Task 2.4: Wire `wireTracker` into `/` and `/browse/` entry points

**Files:**
- Modify: `hugo-apps/src/navigator/main.ts`
- Modify: `hugo-apps/src/browse/main.ts`

- [ ] **Step 1: `hugo-apps/src/navigator/main.ts`** — call `wireTracker` after the existing Vue mount. The navigator's `useNavigatorFilters` is created inside `TutorialNavigator.vue`, not in `main.ts`. To pass it to `wireTracker`, expose it via `defineExpose` on the SFC, then read from `wrapper.vm.filters` in main. Cleaner alternative: call `wireTracker({ surface: '/' })` without filters, and have `filter-events.ts` look up the SFC instance via `app.config.globalProperties.$root` or via `provide/inject`.

  **Recommended pattern:** the navigator SFC `provide()`s its filter state, and `wireFilterEvents` uses Vue's `inject` API to grab it. But this requires the tracker to run inside the Vue app context — which it doesn't. **Simpler:** the SFC stores its filter state on a `window.__navigatorFilters` global at `onMounted`, and the tracker reads it from there. Hacky but bounded.

  **The implementer chooses the pattern that fits.** Either way is acceptable; the test gate is "filter_change events fire when checkboxes are toggled."

- [ ] **Step 2: `hugo-apps/src/browse/main.ts`** — analogous wiring with `surface: '/browse/'`.

- [ ] **Step 3: Add `vite.config.ts` entry for the tracker if needed.** The shared analytics module is imported by `navigator/main.ts` and `browse/main.ts` directly; Vite's bundler will tree-shake correctly. **No new entry is required for PR 2** — the new `tutorial` entry comes in PR 3.

- [ ] **Step 4: Build hugo-apps + smoke locally.**

```bash
npm --prefix hugo-apps run build 2>&1 | tail -10
```

Expected: build succeeds, `hugo/static/js/navigator.js` and `hugo/static/js/browse.js` both reference the analytics modules in their bundle. Bundle size increase: ~3-5 KB per entry (gzipped).

- [ ] **Step 5: Manual local smoke (optional, requires local CAP).** Run `cds watch` in another terminal, `npm run dev` for Hugo, browse to `/` and `/browse/`. Open DevTools → Network. Click filter checkboxes. Expect `POST /api/ui-event` requests appearing (with 503 responses since `UI_EVENTS_ENABLED` is unset).

- [ ] **Step 6: Commit.**

```bash
git add hugo-apps/src/navigator/main.ts hugo-apps/src/browse/main.ts
git commit -m "feat(navigator,browse): wire analytics tracker on / and /browse/ (#204)

Calls wireTracker(surface) after Vue mount. Tracker self-disables on 503
(default state of POST /api/ui-event until Tom flips UI_EVENTS_ENABLED).

Refs #204"
```

### Task 2.5: Open PR 2

- [ ] **Step 1: Verify branch + tests.**

```bash
CURRENT_BRANCH=$(git branch --show-current)
echo "Branch: $CURRENT_BRANCH"
[ "$CURRENT_BRANCH" = "feat/issue-204-pr2-tracker" ] || { echo "WRONG BRANCH"; exit 1; }
npx vitest run hugo-apps/src/shared/analytics/ --no-coverage 2>&1 | tail -5
```

- [ ] **Step 2: Push + open PR.**

```bash
git push -u origin feat/issue-204-pr2-tracker
gh pr create --repo sap-tutorials/tutorials-ims --base main \
  --title "feat: analytics tracker + / + /browse/ instrumentation (#204 PR 2)" \
  --body "PR 2 of 4 implementing #204. New \`hugo-apps/src/shared/analytics/\` module + \`/\` and \`/browse/\` wiring. Tracker self-disables on 503 — safe to merge before flag flip. Refs #204 / #225."
```

---

## PR 3 — Tutorial-page `referred_view`

**Goal:** Close the click → tutorial-load funnel by firing one `referred_view` event when a same-tab session lands on a `/tutorials/<slug>` page.

**Branch:** `feat/issue-204-pr3-tutorial-referred-view` (start from a fresh `main` after PR 2 merges).

**Files:**

- Create: `hugo-apps/src/tutorial/main.ts` — entry point for `/tutorials/*`
- Create: `hugo-apps/src/tutorial/__tests__/referred-view.test.ts`
- Create: `hugo-apps/src/shared/analytics/referred-view.ts` — fires the `referred_view` event
- Modify: `hugo-apps/vite.config.ts` — add `tutorial` entry to `rollupOptions.input`
- Modify: `hugo/layouts/_default/baseof.html` — load `/js/tutorial.js` on tutorial pages

### Task 3.1: Implement `referred-view.ts` + tests

**Files:**
- Create: `hugo-apps/src/shared/analytics/referred-view.ts`
- Create: `hugo-apps/src/tutorial/__tests__/referred-view.test.ts`

- [ ] **Step 1: Write 4 test cases.**

```ts
// referred-view fires once per page load when sessionId in storage
// referred-view does NOT fire when sessionId absent (no cross-tab leak)
// referred-view payload contains slug + fromSurface + fromCardId
// referred-view event uses surface='/tutorials/' (not '/')
```

- [ ] **Step 2: Implement.**

```ts
// hugo-apps/src/shared/analytics/referred-view.ts
import { track, init as initTracker, getSessionId } from './tracker'

const REFERRER_KEY = 'analytics.lastClick'

export function fireReferredView(slug: string) {
  if (typeof window === 'undefined') return
  const buildAt = (window as any).__BROWSE_BUILD_AT ?? ''
  initTracker({ surface: '/tutorials/', buildAt })
  // Only fire if a sessionId is already in storage — means the user came
  // from / or /browse/ in the same tab. New tabs have no prior sessionId.
  let hasExisting = false
  try {
    hasExisting = !!sessionStorage.getItem('analytics.sessionId')
  } catch { /* sessionStorage unavailable */ }
  if (!hasExisting) return
  // Pull last-click context (set by card-events.ts on /, /browse/)
  let lastClick = { fromSurface: '', fromCardId: '' }
  try {
    const raw = sessionStorage.getItem(REFERRER_KEY)
    if (raw) lastClick = JSON.parse(raw)
  } catch { /* ignore */ }
  track('referred_view', {
    tutorialSlug: slug,
    fromSurface: lastClick.fromSurface,
    fromCardId: lastClick.fromCardId,
  })
}
```

  Also: in PR 2's `card-events.ts`, write `{ fromSurface, fromCardId }` to `sessionStorage` under `analytics.lastClick` on every `card_click`. That's the data `referred-view.ts` reads.

- [ ] **Step 3: Run tests, verify PASS.**

- [ ] **Step 4: Commit.**

### Task 3.2: Add `tutorial` Vite entry + Hugo template hook

**Files:**
- Modify: `hugo-apps/vite.config.ts`
- Create: `hugo-apps/src/tutorial/main.ts`
- Modify: `hugo/layouts/_default/baseof.html`

- [ ] **Step 1: Add Vite entry.** In `hugo-apps/vite.config.ts`'s `rollupOptions.input`, add `tutorial: resolve(__dirname, 'src/tutorial/main.ts')`.

- [ ] **Step 2: Implement `tutorial/main.ts`.**

```ts
// hugo-apps/src/tutorial/main.ts
import { fireReferredView } from '@shared/analytics/referred-view'

// Tutorial slug is in the URL: /tutorials/<slug>
const slug = window.location.pathname.replace(/^\/tutorials\//, '').replace(/\/$/, '')
if (slug) fireReferredView(slug)
```

- [ ] **Step 3: Modify `hugo/layouts/_default/baseof.html`** to load `/js/tutorial.js` only on tutorial pages.

```html
{{ if eq .Section "tutorials" }}
  <script type="module" src="/js/tutorial.js"></script>
{{ end }}
```

(Find the equivalent `{{ if }}` blocks for other entry points — `navigator.js`, `browse.js` — to match the existing pattern.)

- [ ] **Step 4: Build + smoke.** `npm --prefix hugo-apps run build`. Expect `hugo/static/js/tutorial.js` produced. Smoke-test in DevTools that the script loads on `/tutorials/<any-slug>` but not on `/` or `/browse/`.

- [ ] **Step 5: Commit.**

### Task 3.3: Open PR 3

```bash
git push -u origin feat/issue-204-pr3-tutorial-referred-view
gh pr create --repo sap-tutorials/tutorials-ims --base main \
  --title "feat: tutorial-page referred_view event (#204 PR 3)" \
  --body "PR 3 of 4 implementing #204. Adds tutorial.ts Vite entry that fires referred_view on tutorial mount when a sessionId is present in sessionStorage. Closes the click → tutorial-load funnel."
```

---

## PR 4 — SavedQueries + Runbook + AnalyticsService Exposure

**Goal:** Expose `UIEvent` in `AnalyticsService`, seed the 6 canonical SavedQueries, ship the runbook with worked-out CI examples.

**Branch:** `feat/issue-204-pr4-saved-queries-runbook`

**Files:**

- Modify: `srv/analytics-service.cds` — expose `UIEvent` (read-only, `@analytics.exposed`)
- Create: `srv/lib/ui-event-saved-queries.js` — idempotent seeder for 6 queries
- Create: `srv/lib/__tests__/ui-event-saved-queries.test.js`
- Create: `docs/developers/operations/ab-comparison-runbook.md`

### Task 4.1: Expose `UIEvent` in `AnalyticsService`

- [ ] **Step 1: Modify `srv/analytics-service.cds`.** Add a `@readonly` projection on `ims.UIEvent` with `@analytics.exposed: true`.

```cds
@readonly @analytics.exposed: true
entity UIEvents as projection on ims.UIEvent;
```

- [ ] **Step 2: Verify by running `cds build` + checking `gen/srv/srv/analytics-service.cds`** for the new entity.

- [ ] **Step 3: Commit.**

### Task 4.2: Write the 6 canonical SavedQueries seed script

**Files:**
- Create: `srv/lib/ui-event-saved-queries.js`
- Create: `srv/lib/__tests__/ui-event-saved-queries.test.js`

The 6 queries (full SQL bodies in the runbook; this seeder just stores them in HANA):

1. **Daily session count per surface** — `SELECT surface, DATE(timestamp) AS day, COUNT(DISTINCT sessionId) FROM UIEvent WHERE eventType = 'page_view' GROUP BY surface, DATE(timestamp);`
2. **Filter usage rate** — `WITH ... SELECT surface, COUNT(DISTINCT s.sessionId) FILTER (WHERE has_filter) / COUNT(DISTINCT s.sessionId) AS rate ...`
3. **Card click-through rate (with 95% CI)** — uses the closed-form normal-approx formula directly in SQL.
4. **Time-to-first-click (median, p25, p75)** — `WITH first_click AS (SELECT sessionId, surface, MIN(timestamp) AS click_ts FROM UIEvent WHERE eventType = 'card_click' GROUP BY sessionId, surface), page AS (SELECT sessionId, surface, MIN(timestamp) AS pv_ts FROM UIEvent WHERE eventType = 'page_view' GROUP BY sessionId, surface) SELECT surface, MEDIAN(click_ts - pv_ts), PERCENTILE_DISC(0.25) WITHIN GROUP (ORDER BY click_ts - pv_ts), ...`
5. **Bounce rate** — sessions with `page_view` but zero `card_click`, by surface.
6. **Search usage rate** — `% of sessions where filter_change.kind = 'search'` fired at least once.

- [ ] **Step 1: Write seeder.** Idempotent — checks `SavedQueries` for existing entries by `name`, only INSERTs new ones.

- [ ] **Step 2: Write 3 tests.** (a) seeder INSERTs all 6 on first run, (b) re-running doesn't duplicate, (c) each query SQL passes the existing `analytics-sql-validator` (already used by `runSelectQuery`).

- [ ] **Step 3: Wire into `cds.on('served', ...)`** so the seeder runs on srv startup. Idempotent so re-runs are free.

- [ ] **Step 4: Commit.**

### Task 4.3: Write the runbook

**Files:**
- Create: `docs/developers/operations/ab-comparison-runbook.md`

Sections:
1. **What this is** — pointer to spec + #204.
2. **How to run the comparison** — open `/analytics-ui/`, find the saved queries, run them. Read the click-through rate row.
3. **The 6 canonical queries** — full SQL for each, with 1-2 line explanation of what it measures.
4. **The cutover decision rule** — 15k threshold OR 2.4k+5pp early-stop. Worked example using fake numbers.
5. **The 95% CI calculation** — explain the closed-form formula in SQL, link to a stats reference for verification.
6. **Failure modes** — what if the surfaces look identical? What if one is winning by 50%? What if click counts are tiny?
7. **What to do post-decision** — link to follow-up issues (#199 sort dropdown, #200 SSR-on-`/`, etc.) depending on outcome.

- [ ] **Step 1: Write runbook.**

- [ ] **Step 2: Add VitePress sidebar entry** in `docs/.vitepress/config.ts` (alphabetically ordered).

- [ ] **Step 3: Run `npm run docs:build`** to verify sidebar guard accepts.

- [ ] **Step 4: Commit.**

### Task 4.4: Open PR 4

```bash
git push -u origin feat/issue-204-pr4-saved-queries-runbook
gh pr create --repo sap-tutorials/tutorials-ims --base main \
  --title "feat: SavedQueries + runbook for /  vs /browse/ A/B comparison (#204 PR 4)" \
  --body "PR 4 of 4. Read surface for the A/B telemetry: AnalyticsService projection on UIEvent + 6 pre-seeded SavedQueries (idempotent seeder runs on srv startup) + runbook with worked-out 95% CI examples. After this merges, Tom can flip UI_EVENTS_ENABLED=true on tutorials-srv and start collecting data."
```

---

## After all 4 PRs merge

- Tom flips `UI_EVENTS_ENABLED=true` on `tutorials-srv` DEV (`cf set-env tutorials-srv UI_EVENTS_ENABLED true && cf restart tutorials-srv`).
- Verify via DevTools: open `/`, click cards, check `POST /api/ui-event` returns 204.
- Run the canonical SavedQueries via `/analytics-ui/`. Expect rows starting to appear within minutes.
- Wait until ≥2,400 sessions per surface for early-stop check, or ≥7,500 for "decided."
- Refer to runbook for the cutover decision.

## References

- Spec: [docs/superpowers/specs/2026-06-04-ab-instrumentation-design.md](../specs/2026-06-04-ab-instrumentation-design.md)
- Spec PR: [#225](https://github.com/sap-tutorials/tutorials-ims/pull/225)
- Parent issue: [#204](https://github.com/sap-tutorials/tutorials-ims/issues/204)
- Parent of parent: [#174](https://github.com/sap-tutorials/tutorials-ims/issues/174) — `/browse/` build
- Memory pointers: [[parallel-agents-need-worktrees]], [[verify-branch-before-commit]], [[srv-qa-cp-list-recurring]] (PR 1 must check srv-qa cp-list since `ui-event-handler.js` is a new srv/lib/ file), [[npm-ignore-scripts-blocks-native-modules]], [[worktree-tests-hang]].

