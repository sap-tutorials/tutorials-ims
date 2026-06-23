# Joule on Devtoberfest Pages — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the existing Joule chat icon to work on `/devtoberfest/**` pages with a scoped persona (Devtoberfest + TechEd only) and a new `getDevtoberfestInfo` tool that reads `DevtoberfestConfig` + `currentEvent`, future-proofed for points/gameboard/activities/videos schema additions.

**Architecture:** Three additive changes — (1) Hugo emits `data-page-kind="devtoberfest"` for `/devtoberfest/**` and pages with frontmatter `joule_scope: devtoberfest`; (2) `srv/lib/chat-context.js` gets a new `DEVTOBERFEST_PERSONA` constant + `devtoberfestLayer()` selected via `pageContext.kind`; (3) `srv/lib/chat-orchestrator.js` registers exactly `[getDevtoberfestInfo, searchTutorials]` for the Devtoberfest kind, with the tool reading the existing `DevtoberfestConfig` singleton via CDS QL and returning a typed sectioned response with forward-compat placeholders.

**Tech Stack:** CAP Node.js (`@sap/cds` ESM), Vitest (unit + smoke), Hugo (go-html-template), JSON-Schema tool definitions for SAP AI Core, no schema changes.

**Spec:** [docs/superpowers/specs/2026-06-23-565-joule-devtoberfest-design.md](../specs/2026-06-23-565-joule-devtoberfest-design.md)

---

## Page inventory at time of writing

Only `hugo/content/devtoberfest/_index.md` exists today (homepage). The persona's sub-page hint list (`rules`, `gameboard`, `activities`, `videos`, `live`) is forward-looking — pages will be added in future tickets. The layer handles missing slugs by falling back to `homepage` guidance.

## Rounding rule for date math

`daysUntilStart` and `daysUntilEnd` use `Math.ceil((target.getTime() - now.getTime()) / 86_400_000)`. Computed in UTC. All test fixtures use `ceil` semantics — never `floor` or `round`.

## File structure

### New files

| File | Responsibility |
|---|---|
| `srv/lib/devtoberfest-joule-tool.js` | `getDevtoberfestInfo(args, user)` handler. Reads `DevtoberfestConfig` (with `currentEvent` expanded) via CDS QL. Computes `status` and date deltas. Returns the typed sectioned shape from spec §4.3. ~150 lines. |
| `test/devtoberfest-joule-tool.test.js` | Unit tests for the handler — `cds.test('serve', '--in-memory')`-based, matching the pattern in [test/chat-orchestrator-tools.test.js](../../../test/chat-orchestrator-tools.test.js). |
| `test/chat-context-devtoberfest.test.js` | Unit tests for the persona + layer behavior; pins regressions for `kind: 'tutorial'` / `'admin'`. Pure-function tests; no `cds.test`. |
| `test/chat-orchestrator-devtoberfest.test.js` | Unit tests for `toolsForContext({kind:'devtoberfest'})` — asserts exact tool list AND suppression of feature-flagged tools. |
| `test/smoke/joule-devtoberfest.smoke.test.js` | Smoke test against deployed CF DEV. Asserts `/chat/stream` accepts a Devtoberfest pageContext and emits SSE within 5s. |

### Modified files

| File | Change | Reference |
|---|---|---|
| `srv/lib/chat-context.js` | Add `DEVTOBERFEST_PERSONA` constant + `devtoberfestLayer()` function; extend `pageLayer()` switch with a `'devtoberfest'` branch; extend `buildSystemPrompt()` to use the new persona when `pageContext.kind === 'devtoberfest'`. | [srv/lib/chat-context.js:134-158](../../../srv/lib/chat-context.js#L134-L158) |
| `srv/lib/chat-orchestrator.js` | Add `GET_DEVTOBERFEST_INFO_TOOL` definition; extend `toolsForContext()` with an early-return branch when `pageContext.kind === 'devtoberfest'`; add a `getDevtoberfestInfo` case in `dispatchTool()`. | [srv/lib/chat-orchestrator.js:178-206, 217](../../../srv/lib/chat-orchestrator.js#L178-L217) |
| `hugo/layouts/_default/baseof.html` | Extend the `data-page-kind` expression to detect `/devtoberfest/**` URL prefix and frontmatter `joule_scope` override. `data-page-slug` already exists (line 4) — no change needed there. | [hugo/layouts/_default/baseof.html:3](../../../hugo/layouts/_default/baseof.html#L3) |
| `hugo/content/devtoberfest/_index.md` | No change required (URL-prefix rule covers it). Used as a verification target during smoke. | — |
| `docs/developers/architecture/joule.md` | New "Devtoberfest scope" subsection documenting the persona, the tool, and the URL-prefix rule. | [docs/developers/architecture/joule.md](../../../docs/developers/architecture/joule.md) |

### Files explicitly NOT touched

- `hugo/static/js/joule.js` — `readPageContext()` already reads `dataset.pageKind` and `dataset.pageSlug`. No change.
- `srv/server.js` — `/chat/stream` already routes by `pageContext`. No change.
- `db/devtoberfest.cds`, `db/schema.cds` — no schema changes.
- `srv/admin-service.js` — `DevtoberfestConfig` defensive-init is unchanged.

---

## Conventions for every task

- **ESM only.** All `srv/lib/*.js` use ES modules (`import` / `export`). Match the surrounding files.
- **No raw SQL.** The tool uses CDS QL (`SELECT.one.from(...)`). HANA-vs-SQLite differences are handled by CDS.
- **Test runner:** Vitest. Unit tests live in `test/*.test.js`; smoke tests in `test/smoke/*.smoke.test.js` per the workspace config in `vitest.config.ts`.
- **`cds.test('serve', '--project', '.', '--in-memory')`** at the top of suites that need entities — matches the pattern in [test/chat-orchestrator-tools.test.js](../../../test/chat-orchestrator-tools.test.js).
- **No emojis in commit messages** (project convention).
- **Branch:** `feat/issue-565-joule-devtoberfest` — created off `main`. Spec is already on `spec/joule-devtoberfest`; rebase or branch off `main` independently.
- **Commit cadence:** one commit per task (a task ends with a commit step). Push is left to the human at the end.

Before starting: `git checkout main && git pull && git checkout -b feat/issue-565-joule-devtoberfest`.

---

## Task 1: Add `getDevtoberfestInfo` tool definition (orchestrator schema only)

The tool's LLM-facing JSON schema. No handler yet — that's task 2. We split these so the schema test is bite-sized and the handler test is bite-sized.

**Files:**
- Modify: `srv/lib/chat-orchestrator.js` (add tool constant near the other tool definitions)
- Test: `test/chat-orchestrator-devtoberfest.test.js` (new)

- [ ] **Step 1.1: Write the failing test**

Create `test/chat-orchestrator-devtoberfest.test.js`:

```javascript
import { describe, it, expect } from 'vitest';

// We intentionally import the file (not run cds.test) — the tool list test
// follows in a later task, this one only verifies the exported constant shape.
import * as orchestrator from '../srv/lib/chat-orchestrator.js';

describe('GET_DEVTOBERFEST_INFO_TOOL definition', () => {
  it('exports a JSON-schema function tool with the expected shape', () => {
    const tool = orchestrator.GET_DEVTOBERFEST_INFO_TOOL;
    expect(tool).toBeDefined();
    expect(tool.type).toBe('function');
    expect(tool.function.name).toBe('getDevtoberfestInfo');
    expect(typeof tool.function.description).toBe('string');
    expect(tool.function.description.length).toBeGreaterThan(40);

    const params = tool.function.parameters;
    expect(params.type).toBe('object');
    expect(params.properties.section.type).toBe('string');
    expect(params.properties.section.enum).toEqual([
      'all', 'event', 'terms', 'links', 'points', 'gameboard', 'activities', 'videos'
    ]);
    // Section is optional — handler defaults to 'all'.
    expect(params.required).toBeUndefined();
  });
});
```

- [ ] **Step 1.2: Run test to verify it fails**

Run: `npx vitest run test/chat-orchestrator-devtoberfest.test.js`
Expected: FAIL — `GET_DEVTOBERFEST_INFO_TOOL` is undefined.

- [ ] **Step 1.3: Add the tool constant**

In `srv/lib/chat-orchestrator.js`, immediately after the existing `CHECK_CODE_TOOL` constant block (around line 176, just before `async function toolsForContext`), add:

```javascript
export const GET_DEVTOBERFEST_INFO_TOOL = {
  type: 'function',
  function: {
    name: 'getDevtoberfestInfo',
    description: "Fetch authoritative Devtoberfest event information. Call this for any factual question about the current Devtoberfest event — dates, rules, points, gameboard, activities, legal terms, videos, or live streams. Pass section='all' if unsure which slice is relevant.",
    parameters: {
      type: 'object',
      properties: {
        section: {
          type: 'string',
          enum: ['all', 'event', 'terms', 'links', 'points', 'gameboard', 'activities', 'videos'],
          description: "Which slice of Devtoberfest data to return. Default 'all' returns event + links + a summary of every other section's availability."
        }
      }
    }
  }
};
```

Note: `export const` so the unit test can import it directly. The other tool constants in this file are file-scoped (no `export`); the spec accepts this small inconsistency in exchange for testable isolation.

- [ ] **Step 1.4: Run test to verify it passes**

Run: `npx vitest run test/chat-orchestrator-devtoberfest.test.js`
Expected: PASS.

- [ ] **Step 1.5: Commit**

```bash
git add srv/lib/chat-orchestrator.js test/chat-orchestrator-devtoberfest.test.js
git commit -m "feat(chat): add getDevtoberfestInfo tool definition

LLM-facing JSON schema for the new Devtoberfest tool. Handler arrives
in the next commit; this commit lands the export + a shape test so the
constant is verifiable in isolation.

Refs #565"
```

---

## Task 2: Implement `getDevtoberfestInfo` handler

Reads `DevtoberfestConfig` (with `currentEvent` expanded), computes status, returns the typed sectioned response.

**Files:**
- Create: `srv/lib/devtoberfest-joule-tool.js`
- Test: `test/devtoberfest-joule-tool.test.js` (new)

- [ ] **Step 2.1: Write the failing test scaffold**

Create `test/devtoberfest-joule-tool.test.js`:

```javascript
import { describe, it, expect, beforeEach } from 'vitest';
import cds from '@sap/cds';
import { getDevtoberfestInfo } from '../srv/lib/devtoberfest-joule-tool.js';

cds.test('serve', '--project', '.', '--in-memory');

const CONFIG_ID = '00000000-0000-0000-0000-000000000d10'; // Devtoberfest singleton
const EVENT_ID  = '00000000-0000-0000-0000-000000000e10';

async function seedEvent({ startOffsetDays, endOffsetDays }) {
  const { Events, DevtoberfestConfig } = cds.entities('com.sap.developers.ims');
  const now = Date.now();
  const start = startOffsetDays === null ? null : new Date(now + startOffsetDays * 86_400_000).toISOString();
  const end   = endOffsetDays   === null ? null : new Date(now + endOffsetDays   * 86_400_000).toISOString();

  await UPSERT.into(Events).entries({
    ID: EVENT_ID,
    name: 'Devtoberfest 2026',
    startDate: start,
    endDate: end,
    timeZone: 'Europe/Berlin'
  });
  await UPSERT.into(DevtoberfestConfig).entries({
    ID: CONFIG_ID,
    currentEvent_ID: EVENT_ID,
    termsText: '## Rules\n\nBe excellent to each other.',
    termsVersion: 3,
    contentRulesUrl: 'https://example.test/rules',
    faqUrl: 'https://example.test/faq',
    gameboardUrl: 'https://example.test/gameboard',
    activitiesUrl: 'https://example.test/activities'
  });
}

async function clear() {
  const { Events, DevtoberfestConfig } = cds.entities('com.sap.developers.ims');
  await DELETE.from(DevtoberfestConfig).where({ ID: CONFIG_ID });
  await DELETE.from(Events).where({ ID: EVENT_ID });
}

describe('getDevtoberfestInfo', () => {
  beforeEach(async () => { await clear(); });

  it('returns status=upcoming with positive daysUntilStart before the event', async () => {
    await seedEvent({ startOffsetDays: 7, endOffsetDays: 14 });
    const out = await getDevtoberfestInfo({});
    expect(out.event.status).toBe('upcoming');
    expect(out.event.daysUntilStart).toBeGreaterThan(0);
    expect(out.event.daysUntilStart).toBeLessThanOrEqual(7);
    expect(out.event.name).toBe('Devtoberfest 2026');
    expect(out.event.timeZone).toBe('Europe/Berlin');
  });

  it('returns status=active when now is between start and end', async () => {
    await seedEvent({ startOffsetDays: -2, endOffsetDays: 5 });
    const out = await getDevtoberfestInfo({ section: 'event' });
    expect(out.event.status).toBe('active');
    expect(out.event.daysUntilEnd).toBeGreaterThan(0);
  });

  it('returns status=ended after endDate', async () => {
    await seedEvent({ startOffsetDays: -30, endOffsetDays: -5 });
    const out = await getDevtoberfestInfo({});
    expect(out.event.status).toBe('ended');
    expect(out.event.daysUntilStart).toBeLessThanOrEqual(-30);
  });

  it('returns status=unconfigured when DevtoberfestConfig has no currentEvent', async () => {
    const { DevtoberfestConfig } = cds.entities('com.sap.developers.ims');
    await UPSERT.into(DevtoberfestConfig).entries({ ID: CONFIG_ID, currentEvent_ID: null });
    const out = await getDevtoberfestInfo({});
    expect(out.event.status).toBe('unconfigured');
    expect(out.event.name).toBeNull();
    expect(out.event.startDate).toBeNull();
  });

  it('returns status=unconfigured when the DevtoberfestConfig row itself is missing', async () => {
    // No seed — table is empty.
    const out = await getDevtoberfestInfo({});
    expect(out.event.status).toBe('unconfigured');
  });

  it("section='terms' returns terms body and version, omits links/placeholders", async () => {
    await seedEvent({ startOffsetDays: 7, endOffsetDays: 14 });
    const out = await getDevtoberfestInfo({ section: 'terms' });
    expect(out.terms).toEqual({ available: true, version: 3, body: '## Rules\n\nBe excellent to each other.' });
    expect(out.links).toBeUndefined();
    expect(out.points).toBeUndefined();
  });

  it("section='terms' returns available:false when termsText is empty", async () => {
    await seedEvent({ startOffsetDays: 7, endOffsetDays: 14 });
    const { DevtoberfestConfig } = cds.entities('com.sap.developers.ims');
    await UPDATE(DevtoberfestConfig).set({ termsText: '' }).where({ ID: CONFIG_ID });
    const out = await getDevtoberfestInfo({ section: 'terms' });
    expect(out.terms.available).toBe(false);
  });

  it("section='links' returns the four URL fields", async () => {
    await seedEvent({ startOffsetDays: 7, endOffsetDays: 14 });
    const out = await getDevtoberfestInfo({ section: 'links' });
    expect(out.links.contentRulesUrl).toBe('https://example.test/rules');
    expect(out.links.gameboardUrl).toBe('https://example.test/gameboard');
  });

  it("placeholder sections return { available: false, comingSoon: true }", async () => {
    await seedEvent({ startOffsetDays: 7, endOffsetDays: 14 });
    for (const sec of ['points', 'gameboard', 'activities', 'videos']) {
      const out = await getDevtoberfestInfo({ section: sec });
      expect(out[sec]).toEqual({ available: false, comingSoon: true });
    }
  });

  it("section='all' (default) returns event + terms + links + four placeholders", async () => {
    await seedEvent({ startOffsetDays: 7, endOffsetDays: 14 });
    const out = await getDevtoberfestInfo({});
    expect(out.event).toBeDefined();
    expect(out.terms.available).toBe(true);
    expect(out.links).toBeDefined();
    for (const sec of ['points', 'gameboard', 'activities', 'videos']) {
      expect(out[sec]).toEqual({ available: false, comingSoon: true });
    }
    expect(typeof out.generatedAt).toBe('string');
    expect(() => new Date(out.generatedAt).toISOString()).not.toThrow();
  });

  it('ignores invalid section args and falls back to all', async () => {
    await seedEvent({ startOffsetDays: 7, endOffsetDays: 14 });
    const out = await getDevtoberfestInfo({ section: 'nonsense' });
    expect(out.event).toBeDefined();
    expect(out.links).toBeDefined();
  });
});
```

- [ ] **Step 2.2: Run test to verify it fails**

Run: `npx vitest run test/devtoberfest-joule-tool.test.js`
Expected: FAIL — `getDevtoberfestInfo` is not exported from a file that doesn't exist.

- [ ] **Step 2.3: Create the handler**

Create `srv/lib/devtoberfest-joule-tool.js`:

```javascript
/**
 * Joule tool handler — getDevtoberfestInfo.
 *
 * Reads DevtoberfestConfig (singleton) + currentEvent (Association),
 * computes event.status and date deltas, returns the section payload
 * shape from docs/superpowers/specs/2026-06-23-565-joule-devtoberfest-design.md §4.3.
 *
 * Forward-compat contract: as schema fields land for points/gameboard/
 * activities/videos, the corresponding section flips from
 * { available: false, comingSoon: true } to a populated object. The
 * tool's LLM-facing schema (in chat-orchestrator.js) does NOT change.
 *
 * Refs #565
 */
import cds from '@sap/cds';

const LOG = cds.log('devtoberfest-joule-tool');

const VALID_SECTIONS = new Set([
  'all', 'event', 'terms', 'links', 'points', 'gameboard', 'activities', 'videos'
]);
const PLACEHOLDER_KEYS = ['points', 'gameboard', 'activities', 'videos'];

const warnedMissingEventIds = new Set();

function daysCeil(targetMs, nowMs) {
  return Math.ceil((targetMs - nowMs) / 86_400_000);
}

function computeEvent(config) {
  // No DevtoberfestConfig row OR no currentEvent association OR no startDate.
  if (!config || !config.currentEvent || !config.currentEvent.startDate) {
    if (config?.currentEvent_ID && !config?.currentEvent) {
      // Association points at a deleted Event row — log once per dangling id.
      if (!warnedMissingEventIds.has(config.currentEvent_ID)) {
        warnedMissingEventIds.add(config.currentEvent_ID);
        LOG.warn('DevtoberfestConfig.currentEvent points at a missing Event row',
                 { currentEvent_ID: config.currentEvent_ID });
      }
    }
    return {
      name: null, startDate: null, endDate: null, timeZone: null,
      status: 'unconfigured', daysUntilStart: null, daysUntilEnd: null
    };
  }
  const ev = config.currentEvent;
  const nowMs = Date.now();
  const startMs = new Date(ev.startDate).getTime();
  const endMs   = ev.endDate ? new Date(ev.endDate).getTime() : null;

  let status;
  if (endMs !== null && nowMs > endMs)        status = 'ended';
  else if (nowMs >= startMs)                  status = 'active';
  else                                        status = 'upcoming';

  return {
    name: ev.name || null,
    startDate: ev.startDate,
    endDate: ev.endDate || null,
    timeZone: ev.timeZone || null,
    status,
    daysUntilStart: daysCeil(startMs, nowMs),
    daysUntilEnd: endMs !== null ? daysCeil(endMs, nowMs) : null
  };
}

function buildTerms(config) {
  const body = (config?.termsText || '').trim();
  if (!body) return { available: false };
  return { available: true, version: config.termsVersion ?? 1, body: config.termsText };
}

function buildLinks(config) {
  return {
    contentRulesUrl: config?.contentRulesUrl || null,
    activitiesUrl:   config?.activitiesUrl   || null,
    faqUrl:          config?.faqUrl          || null,
    gameboardUrl:    config?.gameboardUrl    || null
  };
}

function placeholder() {
  return { available: false, comingSoon: true };
}

export async function getDevtoberfestInfo(args, _user) {
  const rawSection = typeof args?.section === 'string' ? args.section : 'all';
  const section = VALID_SECTIONS.has(rawSection) ? rawSection : 'all';

  let config = null;
  try {
    const { DevtoberfestConfig } = cds.entities('com.sap.developers.ims');
    // expand currentEvent — keeps name/dates/timeZone on the row directly.
    config = await SELECT.one
      .from(DevtoberfestConfig)
      .columns(c => {
        c('ID'); c('currentEvent_ID');
        c('termsText'); c('termsVersion');
        c('contentRulesUrl'); c('faqUrl'); c('gameboardUrl'); c('activitiesUrl');
        c.currentEvent(e => { e('ID'); e('name'); e('startDate'); e('endDate'); e('timeZone'); });
      });
  } catch (err) {
    LOG.warn('DevtoberfestConfig read failed', err.message);
  }

  const out = { generatedAt: new Date().toISOString() };
  out.event = computeEvent(config);

  if (section === 'event') return out;

  if (section === 'all' || section === 'terms')  out.terms = buildTerms(config);
  if (section === 'all' || section === 'links')  out.links = buildLinks(config);

  if (section === 'all') {
    for (const k of PLACEHOLDER_KEYS) out[k] = placeholder();
  } else if (PLACEHOLDER_KEYS.includes(section)) {
    out[section] = placeholder();
  }

  return out;
}
```

- [ ] **Step 2.4: Run test to verify it passes**

Run: `npx vitest run test/devtoberfest-joule-tool.test.js`
Expected: PASS — all eleven `it` blocks green.

If the `expand` syntax (`c.currentEvent(e => ...)`) is rejected by the in-memory SQLite driver, fall back to two `SELECT.one` calls and join in JS — same observable behavior. Adjust the test only if needed; otherwise leave it.

- [ ] **Step 2.5: Commit**

```bash
git add srv/lib/devtoberfest-joule-tool.js test/devtoberfest-joule-tool.test.js
git commit -m "feat(chat): implement getDevtoberfestInfo handler

Reads DevtoberfestConfig + currentEvent, computes status + date deltas,
returns the sectioned payload from spec §4.3. Placeholder sections
(points/gameboard/activities/videos) return { available: false,
comingSoon: true } and flip on as schema fields land — no Joule code
change required.

Refs #565"
```

---

## Task 3: Wire the handler into `dispatchTool` and tool registration

`toolsForContext()` learns to return `[searchTutorials, getDevtoberfestInfo]` for the Devtoberfest kind (and only those tools). `dispatchTool()` learns to route `'getDevtoberfestInfo'` to the new handler.

**Files:**
- Modify: `srv/lib/chat-orchestrator.js` (extend `toolsForContext` and `dispatchTool`)
- Test: `test/chat-orchestrator-devtoberfest.test.js` (extend existing file)

- [ ] **Step 3.1: Add the failing tools-list tests**

Append to `test/chat-orchestrator-devtoberfest.test.js` (above-and-beyond the schema test from Task 1):

```javascript
import cds from '@sap/cds';
import { toolsForContext, dispatchTool } from '../srv/lib/chat-orchestrator.js';

cds.test('serve', '--project', '.', '--in-memory');

const CHAT_SETTINGS_ID = '00000000-0000-0000-0000-00000000c8a7';

describe('toolsForContext — devtoberfest kind', () => {
  afterEach(async () => {
    const { ChatSettings } = cds.entities('com.sap.developers.ims');
    await DELETE.from(ChatSettings).where({ ID: CHAT_SETTINGS_ID });
  });

  it("registers exactly [searchTutorials, getDevtoberfestInfo] when kind='devtoberfest'", async () => {
    const tools = await toolsForContext({ pageContext: { kind: 'devtoberfest' }, isAdmin: false });
    const names = tools.map(t => t.function?.name).sort();
    expect(names).toEqual(['getDevtoberfestInfo', 'searchTutorials']);
  });

  it('suppresses all feature-flagged tools on devtoberfest pages even when their flags are on', async () => {
    const { ChatSettings } = cds.entities('com.sap.developers.ims');
    await UPSERT.into(ChatSettings).entries({
      ID: CHAT_SETTINGS_ID,
      ragEnabled: true,
      codeCheckEnabled: true,
      branchingEnabled: true,
      kgPathBetweenEnabled: true
    });

    const tools = await toolsForContext({ pageContext: { kind: 'devtoberfest' }, isAdmin: false });
    const names = tools.map(t => t.function?.name);
    expect(names).not.toContain('getRelevantSteps');
    expect(names).not.toContain('checkCode');
    expect(names).not.toContain('getBranchRecommendation');
    expect(names).not.toContain('findLearningPath');
    expect(names).not.toContain('getUserProgress');
  });

  it("regression: kind='tutorial' still gets the existing learner tool set", async () => {
    const tools = await toolsForContext({ pageContext: { kind: 'tutorial' }, isAdmin: false });
    const names = tools.map(t => t.function?.name);
    expect(names).toContain('searchTutorials');
    expect(names).toContain('getUserProgress');
    expect(names).not.toContain('getDevtoberfestInfo');
  });

  it("regression: kind='admin' with isAdmin=true still gets the admin tool set", async () => {
    const tools = await toolsForContext({ pageContext: { kind: 'admin' }, isAdmin: true });
    const names = tools.map(t => t.function?.name);
    expect(names).toContain('searchAdminDocs');
    expect(names).toContain('analyticsQuery');
    expect(names).not.toContain('getDevtoberfestInfo');
  });
});

describe('dispatchTool — getDevtoberfestInfo route', () => {
  it('routes the tool name to the handler and returns a payload with event + generatedAt', async () => {
    const out = await dispatchTool('getDevtoberfestInfo', { section: 'event' }, null);
    expect(out).toBeDefined();
    expect(out.event).toBeDefined();
    expect(typeof out.event.status).toBe('string');
    expect(typeof out.generatedAt).toBe('string');
  });
});
```

- [ ] **Step 3.2: Run tests to verify they fail**

Run: `npx vitest run test/chat-orchestrator-devtoberfest.test.js`
Expected: FAIL — the devtoberfest branch in `toolsForContext` doesn't exist; `dispatchTool` returns nothing for the new name.

- [ ] **Step 3.3: Extend `toolsForContext`**

In `srv/lib/chat-orchestrator.js`, modify `async function toolsForContext({ pageContext, isAdmin })`. Add a Devtoberfest early-return BEFORE the existing admin/learner branch:

```javascript
async function toolsForContext({ pageContext, isAdmin }) {
  if (pageContext?.kind === 'devtoberfest') {
    // Devtoberfest pages get a scoped tool set: catalog search (the persona
    // instructs the model to pass tags=['devtoberfest']) + the dedicated
    // event-data tool. Feature-flagged tools (RAG, branching, codecheck,
    // findLearningPath) and getUserProgress are explicitly suppressed —
    // their scopes don't apply to Devtoberfest event pages.
    return [SEARCH_TUTORIALS_TOOL, GET_DEVTOBERFEST_INFO_TOOL];
  }

  const tools = [SEARCH_TUTORIALS_TOOL];
  // ... existing body unchanged ...
}
```

- [ ] **Step 3.4: Extend `dispatchTool` to route `getDevtoberfestInfo`**

In the same file, in `export async function dispatchTool(name, args, user)`, add a new `if (name === 'getDevtoberfestInfo')` branch near the other tool-route blocks. To avoid a top-of-file circular-import surprise, use dynamic `import()` (matching how `checkCode` does it):

```javascript
  if (name === 'getDevtoberfestInfo') {
    try {
      const { getDevtoberfestInfo } = await import('./devtoberfest-joule-tool.js');
      return await getDevtoberfestInfo(args, user);
    } catch (err) {
      LOG.warn('getDevtoberfestInfo dispatch failed', err.message);
      return { error: 'devtoberfest_data_unavailable' };
    }
  }
```

Place it just before the existing `getRelevantSteps` block (anywhere in the dispatch chain is acceptable; place it adjacent to `checkCode` since both use dynamic-import for handler isolation).

- [ ] **Step 3.5: Run tests to verify they pass**

Run: `npx vitest run test/chat-orchestrator-devtoberfest.test.js test/chat-orchestrator-tools.test.js`
Expected: ALL PASS — including the existing branching/learner regression tests in `chat-orchestrator-tools.test.js`.

- [ ] **Step 3.6: Commit**

```bash
git add srv/lib/chat-orchestrator.js test/chat-orchestrator-devtoberfest.test.js
git commit -m "feat(chat): wire getDevtoberfestInfo into orchestrator

toolsForContext({kind:'devtoberfest'}) returns exactly
[searchTutorials, getDevtoberfestInfo] and suppresses all
feature-flagged tools regardless of ChatSettings. dispatchTool routes
the new name to the handler via dynamic import.

Regression tests pin kind=tutorial and kind=admin tool sets unchanged.

Refs #565"
```

---

## Task 4: Add `DEVTOBERFEST_PERSONA` and `devtoberfestLayer` to chat-context

The persona + layer + `buildSystemPrompt` switch.

**Files:**
- Modify: `srv/lib/chat-context.js`
- Test: `test/chat-context-devtoberfest.test.js` (new)

- [ ] **Step 4.1: Write the failing test**

Create `test/chat-context-devtoberfest.test.js`:

```javascript
import { describe, it, expect } from 'vitest';
import { buildSystemPrompt } from '../srv/lib/chat-context.js';

describe('buildSystemPrompt — devtoberfest kind', () => {
  const user = { firstName: 'Tom', lastName: 'Jung' };

  it('uses the Devtoberfest persona when kind=devtoberfest', () => {
    const out = buildSystemPrompt({ kind: 'devtoberfest' }, user);
    expect(out).toMatch(/Devtoberfest/);
    expect(out).toMatch(/SAP TechEd/);
    expect(out).toMatch(/SCOPE — STRICT/);
    expect(out).toMatch(/getDevtoberfestInfo/);
    // Persona-side rule: always pass the devtoberfest tag
    expect(out).toMatch(/searchTutorials.*tags.*devtoberfest/s);
    // Refusal copy
    expect(out).toMatch(/That's outside Devtoberfest/);
  });

  it('does NOT include the default-tutorial persona scope guard verbatim', () => {
    const out = buildSystemPrompt({ kind: 'devtoberfest' }, user);
    // The base PERSONA's "I can only help with SAP tutorials" line must
    // NOT appear — the Devtoberfest persona REPLACES it (not stacks).
    expect(out).not.toMatch(/I can only help with SAP tutorials/);
  });

  it("layer mentions the slug when provided", () => {
    const out = buildSystemPrompt({ kind: 'devtoberfest', slug: 'rules' }, user);
    expect(out).toMatch(/PAGE: Devtoberfest — rules/);
  });

  it("falls back to 'homepage' label when slug is empty or _index", () => {
    const a = buildSystemPrompt({ kind: 'devtoberfest', slug: '' }, user);
    const b = buildSystemPrompt({ kind: 'devtoberfest', slug: '_index' }, user);
    expect(a).toMatch(/PAGE: Devtoberfest — homepage/);
    expect(b).toMatch(/PAGE: Devtoberfest — homepage/);
  });

  it("does NOT include RAG_GUIDANCE or PROGRESS_GUIDANCE for devtoberfest kind", () => {
    // These layers exist for tutorial/search/etc.; on Devtoberfest pages
    // there are no RAG-eligible embeddings and no progress-aware
    // recommendations, so the guidance is omitted to keep the prompt tight.
    const out = buildSystemPrompt({ kind: 'devtoberfest' }, user);
    expect(out).not.toMatch(/getRelevantSteps tool returns step excerpts/);
    expect(out).not.toMatch(/getUserProgress/);
  });

  it("regression: kind='tutorial' prompt is unchanged", () => {
    const out = buildSystemPrompt({ kind: 'tutorial', title: 'Build with CAP', stepCount: 7 }, user);
    expect(out).toMatch(/Build with CAP/);
    expect(out).toMatch(/I can only help with SAP tutorials/); // base PERSONA still in effect
    expect(out).not.toMatch(/Devtoberfest/);
  });

  it("regression: kind='admin' prompt is unchanged", () => {
    const out = buildSystemPrompt({ kind: 'admin', tool: 'analytics-builder' }, user);
    expect(out).toMatch(/Admin Console/);
    expect(out).not.toMatch(/Devtoberfest/);
  });
});
```

- [ ] **Step 4.2: Run test to verify it fails**

Run: `npx vitest run test/chat-context-devtoberfest.test.js`
Expected: FAIL — persona not present.

- [ ] **Step 4.3: Add the persona constant and layer function**

In `srv/lib/chat-context.js`, add ABOVE the `pageLayer` function (insertion point: just after the existing `adminLayer` function definition):

```javascript
const DEVTOBERFEST_PERSONA = `You are Joule on a Devtoberfest page in the SAP Tutorial Platform.

DEVTOBERFEST CONTEXT
- Devtoberfest is SAP's free, online developer celebration held in the weeks
  leading up to SAP TechEd. It is a community learning event organised by
  the SAP Developer Advocates, featuring tutorials, weekly themed activities,
  live streams, and a gameboard where developers earn points by completing
  tutorials and challenges.
- Devtoberfest is a TechEd lead-up. TechEd is SAP's annual technology
  conference. Questions about how Devtoberfest connects to TechEd, TechEd
  dates/format, or how to take Devtoberfest learnings into TechEd sessions
  ARE in scope.

SCOPE — STRICT
You ANSWER questions about:
  1. The current Devtoberfest event (dates, rules, terms, points, gameboard,
     activities, videos, live streams) — always call getDevtoberfestInfo
     first, then answer from its data.
  2. Devtoberfest-tagged tutorials — use searchTutorials with
     tags=["devtoberfest"]. Never call searchTutorials without that tag
     on a Devtoberfest page.
  3. General Devtoberfest knowledge (history, purpose, how to join,
     community norms).
  4. SAP TechEd as it relates to Devtoberfest.

You DO NOT ANSWER:
  - Generic SAP product questions (S/4HANA, BTP services, ABAP syntax,
    CAP how-tos, HANA SQL, etc.) — unless the answer is contained in a
    Devtoberfest-tagged tutorial returned by searchTutorials.
  - Tutorial content on tutorials that aren't Devtoberfest-tagged.
  - Coding help, debugging, code reviews.
  - Anything political, personal, or off-topic.

When refusing, be brief and kind, and redirect:
  "That's outside Devtoberfest — try the main Joule on a tutorial page,
   or ask me about the event, the gameboard, or Devtoberfest tutorials."

WHEN ANSWERING
- For factual questions about the event: ALWAYS call getDevtoberfestInfo
  first. Quote dates and numbers verbatim from the tool result. Do not
  guess dates from your training data — the event's dates change yearly.
- For "when is Devtoberfest?": read event.startDate / event.endDate /
  event.status / event.daysUntilStart from the tool result and phrase
  naturally.
- For "what are the rules / terms?": call with section='terms', then
  summarise. Always link to the canonical document (links.contentRulesUrl)
  at the end.
- For "what tutorials are part of Devtoberfest?": call searchTutorials
  with tags=['devtoberfest'] and the user's topic words.
- If getDevtoberfestInfo returns event.status='unconfigured', say so
  honestly: "Devtoberfest isn't currently configured in the system —
  check back when the event is announced."
- If a section returns available=false / comingSoon=true (e.g. points,
  gameboard), tell the user the data isn't published yet rather than
  inventing it.`;

function devtoberfestLayer(ctx) {
  const rawSlug = typeof ctx?.slug === 'string' ? ctx.slug.trim() : '';
  const slug = (!rawSlug || rawSlug === '_index') ? 'homepage' : rawSlug;
  return [
    `PAGE: Devtoberfest — ${slug}`,
    'The user is currently on the Devtoberfest ' + slug + ' page. Tailor responses to where they are in the experience:',
    '- /devtoberfest/ (homepage) → focus on what Devtoberfest is, how to join, what\'s coming up.',
    '- /devtoberfest/rules → assume they want specifics on rules/terms.',
    '- /devtoberfest/gameboard → assume they want to know how points work.',
    '- /devtoberfest/activities → assume they want activity / week details.',
    '- /devtoberfest/videos, /devtoberfest/live → video and stream info.',
    'For any sub-page that doesn\'t have data yet, acknowledge the page they\'re on and answer from the data that IS available.'
  ].join('\n');
}
```

- [ ] **Step 4.4: Extend `pageLayer` and `buildSystemPrompt`**

In `pageLayer(pageContext)`, add a new case before `default`:

```javascript
    case 'devtoberfest': return devtoberfestLayer(pageContext);
```

In `buildSystemPrompt(pageContext, user)`, REPLACE the body to switch personas correctly:

```javascript
export function buildSystemPrompt(pageContext, user) {
  const kind = pageContext?.kind;
  const isAdmin = kind === 'admin';
  const isDevtoberfest = kind === 'devtoberfest';

  let persona;
  if (isAdmin)               persona = ADMIN_PERSONA;
  else if (isDevtoberfest)   persona = DEVTOBERFEST_PERSONA;
  else                       persona = PERSONA;

  const layers = [persona];
  // RAG_GUIDANCE only applies when getRelevantSteps is a possible tool —
  // it isn't on devtoberfest pages, so skip the guidance to keep the
  // prompt focused. Same logic for PROGRESS_GUIDANCE (getUserProgress
  // is also suppressed on devtoberfest pages).
  if (!isDevtoberfest)       layers.push(RAG_GUIDANCE);
  if (!isAdmin && !isDevtoberfest) layers.push(PROGRESS_GUIDANCE);
  layers.push(pageLayer(pageContext), userLayer(user));
  return layers.filter(Boolean).join('\n\n');
}
```

- [ ] **Step 4.5: Run tests to verify they pass**

Run: `npx vitest run test/chat-context-devtoberfest.test.js test/chat-context.test.js`
Expected: BOTH PASS — the new suite green AND the existing 7-test `chat-context.test.js` suite green (regression pinned).

- [ ] **Step 4.6: Commit**

```bash
git add srv/lib/chat-context.js test/chat-context-devtoberfest.test.js
git commit -m "feat(chat): add DEVTOBERFEST_PERSONA + devtoberfestLayer

buildSystemPrompt selects the Devtoberfest persona for
pageContext.kind='devtoberfest', skips RAG_GUIDANCE +
PROGRESS_GUIDANCE (their tools aren't registered on this kind), and
appends a page-specific layer that nudges the model toward sub-page
intent.

Existing tutorial/admin personas are byte-identical (regression
covered by test/chat-context.test.js).

Refs #565"
```

---

## Task 5: Hugo — emit `data-page-kind="devtoberfest"` for `/devtoberfest/**`

The smallest of the changes — one template edit.

**Files:**
- Modify: `hugo/layouts/_default/baseof.html` (line 3 expression)

- [ ] **Step 5.1: Read the file and locate the target line**

Run: `npx --yes -- head -10 hugo/layouts/_default/baseof.html`

You'll see the existing expression on line 3. Make sure the new rule is the FIRST check (so frontmatter override beats URL prefix beats Hugo type — in that order).

- [ ] **Step 5.2: Edit the expression**

Replace line 3:

```go-html-template
  data-page-kind="{{ if .IsHome }}search{{ else if eq .Type "tutorials" }}tutorial{{ else if eq .Type "missions" }}mission{{ else if eq .Type "groups" }}group{{ else }}generic{{ end }}"
```

with:

```go-html-template
  data-page-kind="{{ if eq (.Params.joule_scope | default "") "devtoberfest" }}devtoberfest{{ else if hasPrefix .RelPermalink "/devtoberfest/" }}devtoberfest{{ else if .IsHome }}search{{ else if eq .Type "tutorials" }}tutorial{{ else if eq .Type "missions" }}mission{{ else if eq .Type "groups" }}group{{ else }}generic{{ end }}"
```

- [ ] **Step 5.3: Verify Hugo build still succeeds**

Run: `npx --yes -- npm run build 2>&1 | tail -20`
(Or, if `npm run build` is too heavy for a quick local check, run a focused `hugo --quiet -d hugo/public-check` and remove the dir after — but DO NOT commit the output directory.)

Expected: clean Hugo build, no template errors.

- [ ] **Step 5.4: Spot-check rendered HTML**

After build: `grep -o 'data-page-kind="[^"]*"' hugo/public/devtoberfest/index.html`
Expected: `data-page-kind="devtoberfest"`.

And for a sibling tutorial page (any one): `data-page-kind="tutorial"` — to confirm regression.

If `npm run build` requires CAP_BASE_URL or fetched tutorials and that's heavier than you want for a unit-level check, skip the build verification here — Task 7's smoke test will catch a broken template at deploy time.

- [ ] **Step 5.5: Commit**

```bash
git add hugo/layouts/_default/baseof.html
git commit -m "feat(hugo): emit data-page-kind=devtoberfest for /devtoberfest/**

Frontmatter joule_scope=devtoberfest overrides URL-prefix detection,
which in turn overrides the existing type-based rules. The existing
data-page-slug attribute (line 4) is unchanged — joule.js
readPageContext() picks it up automatically.

Refs #565"
```

---

## Task 6: Unhide the shellbar Joule trigger on Devtoberfest pages

Today the trigger is `hidden` by default and unhidden by JS for certain kinds. Confirm the existing show logic includes the new kind.

**Files:**
- Modify: `hugo/layouts/partials/header.html` (likely line ~5 or in the trigger-setup script block)
- Optionally modify: `hugo/static/js/joule.js` (if the show/hide condition lives there)

- [ ] **Step 6.1: Locate the unhide logic**

Run: `grep -nE "joule-trigger|jouleTrigger" hugo/layouts/partials/header.html hugo/static/js/joule.js | head -20`

Identify the condition that flips `hidden` off. Likely lives in `joule.js`. Examples to look for: `if (pageKind === 'tutorial')`, `dataset.pageKind === 'admin'`, or a `Set` / `includes` lookup.

- [ ] **Step 6.2: Add `'devtoberfest'` to the unhide condition**

If you find `const SHOWN_KINDS = new Set([...])` or similar, add `'devtoberfest'`. If the check is an `if/else` chain, add the kind there. Keep the change minimal — match the existing style.

If the trigger is shown for ALL non-generic kinds today (no allowlist), no change is needed. Confirm by running a temp HTML page or checking `joule.js` for an explicit `display:none` keyed to `data-page-kind`.

- [ ] **Step 6.3: Write or extend a Hugo-render check**

If `joule.js` has an existing unit test for the show/hide logic (`test/*joule*.test.js`), extend it; otherwise this is verified at the smoke layer (Task 7). The plan does not invent a new test file just for this — header rendering is exercised by Task 7's smoke test asserting the page contains `id="joule-trigger"`.

- [ ] **Step 6.4: Quick manual verification**

Optional local check: open `hugo/public/devtoberfest/index.html` after build; confirm `<ui5-shellbar-item id="joule-trigger" ...>` is present and that the unhide JS (or template) targets `devtoberfest`.

- [ ] **Step 6.5: Commit (only if anything changed)**

```bash
# If a code change was made:
git add hugo/layouts/partials/header.html hugo/static/js/joule.js
git commit -m "feat(joule): show shellbar trigger on devtoberfest pages

Refs #565"
# If no change was needed (allowlist already permissive), skip this task's commit.
```

---

## Task 7: Smoke test against deployed `/chat/stream`

A thin SSE-handshake test that runs in CI after every deploy.

**Files:**
- Create: `test/smoke/joule-devtoberfest.smoke.test.js`

- [ ] **Step 7.1: Author the smoke test**

Create `test/smoke/joule-devtoberfest.smoke.test.js`:

```javascript
/**
 * Smoke test — Joule on Devtoberfest pages.
 *
 * Two checks at the HTTP layer; LLM output is NOT asserted (that's an
 * eval concern). The goal is to catch a wholly broken deploy — bad
 * persona switching, missing tool registration, broken /chat/stream.
 *
 * Refs #565
 */
import { describe, it, expect } from 'vitest';
import { BASE_URL, SRV_URL, fetchWithRetry } from './smoke.config.js';

describe('Joule on Devtoberfest — smoke', () => {
  it('GET /devtoberfest/ renders the page with the shellbar Joule trigger', async () => {
    const res = await fetchWithRetry(`${BASE_URL}/devtoberfest/`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('id="joule-trigger"');
    expect(body).toMatch(/data-page-kind="devtoberfest"/);
  });

  it('POST /chat/stream rejects anonymous with 401 (existing rule, on devtoberfest pageContext)', async () => {
    const res = await fetchWithRetry(`${SRV_URL}/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'hi' }],
        pageContext: { kind: 'devtoberfest', slug: '' }
      })
    });
    // 401 (unauth), or 503 if ChatSettings.enabled=false on the deployed env.
    expect([401, 503]).toContain(res.status);
  });
});
```

The "first SSE token within 5s" check from the spec is not in this file — it requires an authenticated request, which the smoke suite doesn't have a fixture for today. The handshake checks above are sufficient for catching a broken deploy; a richer authenticated SSE smoke is a future-ticket concern.

- [ ] **Step 7.2: Run the smoke test against DEV**

Run:

```bash
SMOKE_BASE_URL="https://tutorial-system-dev-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com" \
SMOKE_SRV_URL="https://tutorial-system-dev-tutorials-srv.cfapps.eu10-005.hana.ondemand.com" \
npx vitest run test/smoke/joule-devtoberfest.smoke.test.js
```

The test will fail today (the kind hasn't been deployed yet). It will pass after the merge + deploy in Task 9. That's expected. The point of authoring it now is so CI catches a future regression — its first green run is the post-deploy smoke job.

- [ ] **Step 7.3: Commit**

```bash
git add test/smoke/joule-devtoberfest.smoke.test.js
git commit -m "test(smoke): assert /devtoberfest/ + /chat/stream wiring

Two handshake checks: page renders with the Joule trigger and the
correct data-page-kind, and /chat/stream still rejects anonymous
requests (401) or is disabled (503). LLM output is not asserted —
that's an eval concern.

Will fail until the feature deploys; CI smoke job covers it after
deploy.

Refs #565"
```

---

## Task 8: Update Joule architecture docs

A short doc section so the next maintainer doesn't have to read the spec.

**Files:**
- Modify: `docs/developers/architecture/joule.md`

- [ ] **Step 8.1: Read the existing doc to find the insertion point**

Run: `npx --yes -- head -80 docs/developers/architecture/joule.md` and skim the table of contents. The "Personas" section (or equivalent) is the right insertion target.

- [ ] **Step 8.2: Add a Devtoberfest subsection**

Append (or insert next to the other persona docs) a section like:

```markdown
## Devtoberfest scope

On pages under `/devtoberfest/**` (or any page declaring frontmatter
`joule_scope: devtoberfest`), `pageContext.kind` is `'devtoberfest'` and
Joule switches to a scoped persona:

- **Tools available:** `searchTutorials` (the persona instructs the model
  to pass `tags: ['devtoberfest']`) and `getDevtoberfestInfo` (reads the
  `DevtoberfestConfig` singleton + `currentEvent`).
- **Tools suppressed on this kind regardless of `ChatSettings`:**
  `getUserProgress`, `getRelevantSteps`, `checkCode`,
  `getBranchRecommendation`, `findLearningPath`, and the admin analytics
  tools.
- **Scope policy:** Devtoberfest event + Devtoberfest-tagged tutorials +
  general Devtoberfest knowledge + SAP TechEd as adjacent. Everything
  else is politely refused.
- **Forward-compat:** `getDevtoberfestInfo` returns
  `{ available: false, comingSoon: true }` for points, gameboard,
  activities, and videos sections. When schema fields land for those
  data domains, the handler's section builder flips to a populated
  shape — the tool's LLM-facing schema does not change.

Spec: [docs/superpowers/specs/2026-06-23-565-joule-devtoberfest-design.md](../../superpowers/specs/2026-06-23-565-joule-devtoberfest-design.md).
```

- [ ] **Step 8.3: Commit**

```bash
git add docs/developers/architecture/joule.md
git commit -m "docs(joule): document the Devtoberfest scope

Refs #565"
```

---

## Task 9: Open PR and verify on DEV

- [ ] **Step 9.1: Final local test sweep**

```bash
npx vitest run test/chat-context.test.js \
                test/chat-context-devtoberfest.test.js \
                test/chat-orchestrator-tools.test.js \
                test/chat-orchestrator-devtoberfest.test.js \
                test/devtoberfest-joule-tool.test.js
```

Expected: ALL PASS.

- [ ] **Step 9.2: Push the branch**

```bash
git push -u origin feat/issue-565-joule-devtoberfest
```

- [ ] **Step 9.3: Open the PR**

```bash
gh pr create \
  --base main \
  --title "feat(joule): scope Joule to Devtoberfest on /devtoberfest/** pages" \
  --body "$(cat <<'BODY'
Wires the existing Joule chat icon to work on Devtoberfest pages with a
scoped persona and a new `getDevtoberfestInfo` tool that reads
`DevtoberfestConfig` + `currentEvent`. Future-proofs for points,
gameboard, activities, legal terms, videos, and live streams as those
schema fields land.

## Behavior

- `/devtoberfest/**` or `joule_scope: devtoberfest` frontmatter →
  `pageContext.kind = 'devtoberfest'`.
- New persona: Devtoberfest + Devtoberfest-tagged tutorials + general
  Devtoberfest knowledge + SAP TechEd as adjacent. Refuse the rest.
- Tools: `searchTutorials` (persona instructs `tags=['devtoberfest']`)
  + `getDevtoberfestInfo`. `getUserProgress`, RAG, codecheck,
  branching, KG-path-between are NOT registered on this kind.
- `getDevtoberfestInfo` returns event + terms + links today, with
  `points`/`gameboard`/`activities`/`videos` as `{ available: false,
  comingSoon: true }` placeholders that flip on as schema lands.
- Smoke test asserts page render + `/chat/stream` 401/503 wiring.

## Files

See plan §File structure:
[docs/superpowers/plans/2026-06-23-565-joule-devtoberfest.md](docs/superpowers/plans/2026-06-23-565-joule-devtoberfest.md).

## Risk

Pure additive. Existing kinds are pinned byte-identical by
[test/chat-context.test.js](test/chat-context.test.js) and
[test/chat-orchestrator-tools.test.js](test/chat-orchestrator-tools.test.js).
Rollback is a single `git revert`. No schema changes, no env vars.

Closes #565.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
BODY
)"
```

- [ ] **Step 9.4: Deploy to DEV after merge**

After PR review and merge:

```bash
# From main, freshly pulled:
npm run build:all
cd .deploy && mbt build
cf deploy mta_archives/*.mtar -e ../deploy/dev.mtaext -f
```

Verify deploy with the smoke suite (will now pass):

```bash
SMOKE_BASE_URL="https://tutorial-system-dev-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com" \
SMOKE_SRV_URL="https://tutorial-system-dev-tutorials-srv.cfapps.eu10-005.hana.ondemand.com" \
npx vitest run test/smoke/joule-devtoberfest.smoke.test.js
```

- [ ] **Step 9.5: Run the manual eval sheet (one-off)**

Open `/devtoberfest/` in a browser while signed in. Run through ~20 prompts covering:

1. **In-scope event:** "When is Devtoberfest?", "What are the rules?", "How do I join?", "When does it end?", "What time zone?"
2. **In-scope tutorials:** "Show me Devtoberfest CAP tutorials", "What Devtoberfest tutorials cover HANA?"
3. **TechEd adjacency:** "How does this connect to TechEd?", "Is TechEd online?"
4. **Off-scope SAP:** "How do I write a CAP service?" (should refuse + redirect)
5. **Off-scope general:** "What's the capital of France?" (should refuse + redirect)
6. **Unconfigured state (skip unless you can toggle DEV):** if `DevtoberfestConfig.currentEvent` is null, verify the model says "Devtoberfest isn't currently configured…" rather than hallucinating dates.
7. **Placeholder sections:** "How does the gameboard work?", "How many points do I have?" → expect "isn't published yet" / "points data isn't published yet" rather than confabulation.

Document the results inline in the PR as a comment once green.

- [ ] **Step 9.6: Close**

After eval is acceptable, the PR is done. The issue auto-closes from the `Closes #565` keyword in the PR body.

---

## Risk + rollback

- **Risk surface:** `chat-context.js` and `chat-orchestrator.js` are touched. Regression coverage:
  - `test/chat-context.test.js` (existing) — pins tutorial/search/mission/group/admin/generic outputs byte-identical.
  - `test/chat-orchestrator-tools.test.js` (existing) — pins branching tool registration unchanged.
  - `test/chat-orchestrator-devtoberfest.test.js` — pins tutorial/admin tool sets unchanged in the new test file.
- **Rollback:** `git revert <merge-commit>` of the PR. No schema, no env, nothing to undo on HANA.
- **Feature flag:** None added. `ChatSettings.enabled` is the existing kill-switch. If we ever need a Devtoberfest-only kill-switch, that's a one-line read + one-line check in `chat-orchestrator.js` — deferred until proven needed.

## What this plan does NOT do (future tickets)

- `getMyDevtoberfestStatus` per-user tool (registration, points, leaderboard).
- Tag-labels admin row for `devtoberfest` chip styling.
- AppSpace integration when AppSpace gets mounted under `/devtoberfest/`.
- Defensive server-side wrapper to force `tags=['devtoberfest']` on `searchTutorials` (only if eval shows drift).
- `devtoberfestChatEnabled` `ChatSettings` flag (only if independent kill-switch is needed).
- Automated eval harness for Joule personas (cross-cutting Joule infra).
