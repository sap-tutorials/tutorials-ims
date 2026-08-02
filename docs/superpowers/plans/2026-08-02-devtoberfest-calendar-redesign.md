# Devtoberfest Calendar Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Devtoberfest "calendar" pivot table with a real date-driven Month/Week/Day calendar (Outlook-style), keyed on `scheduledDate`, colour-coded by track.

**Architecture:** Rewrite the existing Vue island `hugo-apps/src/devtoberfest-sessions-calendar/` in place. Extract all date math into a pure, unit-tested `calendar-core.ts` and track colours into `track-colors.ts`. Three presentational subcomponents (`MonthGrid.vue`, `WeekAgenda.vue`, `DayAgenda.vue`) are driven by a rewritten `App.vue` controller that holds view/cursor state. Reuse the shared feed loader, completion merge, `DetailPanel`, `EditionPicker`, `PointsBanner`, and YouTube-thumbnail helpers unchanged.

**Tech Stack:** Vue 3 (`<script setup lang="ts">`), TypeScript, Vite (Hugo island build), Vitest (`--project unit`), `@vue/test-utils`, SAP Horizon CSS custom properties.

## Global Constraints

- **No backend/feed/route/schema changes.** Do not touch `srv/`, `approuter/xs-app.json`, `db/`, or `hugo/layouts/devtoberfest/calendar.html`. Frontend island only.
- **No new runtime dependency.** No calendar library. `@vue/test-utils@2.4.11` is already a devDependency.
- **All date math in UTC.** Parse `scheduledDate` as `new Date(date + 'T00:00:00Z')` and format with `getUTC*` — matches the feed's `YYYY-MM-DD` strings and the current island's convention. Never use local-time `Date` getters for calendar cells (TZ drift bug).
- **Monday-first weeks.** Weekday index = `(getUTCDay() + 6) % 7` (0 = Monday … 6 = Sunday).
- **Reuse shared kit as-is** from `hugo-apps/src/devtoberfest-schedule-shared/`: `feed.ts`, `completion.ts` (`mergeCompletion`, `youtubeThumb`), `DetailPanel.vue` (props `{ row: ScheduleRow | null }`, emits `close`), `EditionPicker.vue`, `PointsBanner.vue`, `useAuth.ts`, `types.ts`.
- **Session type** (`types.ts`): `{ id, kind:'session', title, abstract?, trackId?, trackName?, trackDay?, week?, scheduledDate?, scheduledTime?, youtubeUrl?, communityEventUrl?, activityId?, status? }`. `ScheduleRow = (Session | Activity) & { complete?: boolean }`.
- **Preserve fail-soft behaviour.** Loading / error / empty states render themed placeholders (existing `ui5-illustrated-message` pattern), never crash.
- **Tests run via `npm test`** (`vitest run --project unit`, node environment) — pattern `hugo-apps/src/**/*.{test,spec}.{js,ts}`. Any test that mounts a Vue component MUST start with the line `// @vitest-environment happy-dom`.
- **Worktree setup:** if `hugo-apps/node_modules/@vue/test-utils` is missing, run `npm run setup` from the repo root once before running tests (global `ignore-scripts=true`).
- **Windows line endings:** write files with LF. After creating files, do not let editors flip to CRLF.

---

## File Structure

**Create:**
- `hugo-apps/src/devtoberfest-sessions-calendar/calendar-core.ts` — pure date functions.
- `hugo-apps/src/devtoberfest-sessions-calendar/track-colors.ts` — deterministic track→colour map.
- `hugo-apps/src/devtoberfest-sessions-calendar/MonthGrid.vue` — month grid view.
- `hugo-apps/src/devtoberfest-sessions-calendar/WeekAgenda.vue` — week agenda columns.
- `hugo-apps/src/devtoberfest-sessions-calendar/DayAgenda.vue` — single-day agenda.
- `hugo-apps/src/devtoberfest-sessions-calendar/__tests__/calendar-core.test.ts`
- `hugo-apps/src/devtoberfest-sessions-calendar/__tests__/track-colors.test.ts`
- `hugo-apps/src/devtoberfest-sessions-calendar/__tests__/App.view.test.ts`

**Modify:**
- `hugo-apps/src/devtoberfest-sessions-calendar/App.vue` — full rewrite of `<script setup>`, `<template>`, `<style>`.

**Delete:**
- `hugo-apps/src/devtoberfest-sessions-calendar/calendar-grid.ts`
- `hugo-apps/src/devtoberfest-sessions-calendar/__tests__/calendar-grid.test.ts`

**Untouched:** `main.ts` (mount point stays the same).

---

### Task 1: Pure calendar-core date engine

**Files:**
- Create: `hugo-apps/src/devtoberfest-sessions-calendar/calendar-core.ts`
- Test: `hugo-apps/src/devtoberfest-sessions-calendar/__tests__/calendar-core.test.ts`

**Interfaces:**
- Consumes: `Session` from `../devtoberfest-schedule-shared/types`.
- Produces:
  - `iso(date: Date): string` — `YYYY-MM-DD` in UTC.
  - `parseISO(s: string): Date | null` — UTC-midnight Date, or null if invalid/empty.
  - `addDays(date: Date, n: number): Date`, `addWeeks(date, n)`, `addMonths(date, n)` — all UTC.
  - `startOfWeek(date: Date): Date` — Monday (UTC) of that week.
  - `weekDays(date: Date): Date[]` — 7 UTC dates Mon→Sun.
  - `monthGridCells(date: Date): Date[]` — 42 UTC dates (6×7), Monday-first, covering the month of `date` plus leading/trailing adjacent-month days.
  - `groupByDate(sessions: Session[]): Map<string, Session[]>` — key = `iso(scheduledDate)`; each list sorted by `scheduledTime` ascending, missing times last; sessions without a valid `scheduledDate` are excluded.

- [ ] **Step 1: Write the failing test**

```ts
// hugo-apps/src/devtoberfest-sessions-calendar/__tests__/calendar-core.test.ts
import { describe, it, expect } from 'vitest';
import {
  iso, parseISO, addDays, addWeeks, addMonths,
  startOfWeek, weekDays, monthGridCells, groupByDate,
} from '../calendar-core';

describe('calendar-core date helpers', () => {
  it('iso/parseISO round-trip in UTC', () => {
    expect(iso(parseISO('2026-10-05')!)).toBe('2026-10-05');
    expect(parseISO('')).toBeNull();
    expect(parseISO('not-a-date')).toBeNull();
  });

  it('addDays / addWeeks / addMonths do not mutate and wrap correctly', () => {
    const base = parseISO('2026-10-31')!;
    expect(iso(addDays(base, 1))).toBe('2026-11-01');
    expect(iso(addWeeks(base, 1))).toBe('2026-11-07');
    expect(iso(addMonths(parseISO('2026-12-15')!, 1))).toBe('2027-01-15');
    expect(iso(base)).toBe('2026-10-31'); // unchanged
  });

  it('startOfWeek returns Monday for any day', () => {
    expect(iso(startOfWeek(parseISO('2026-10-08')!))).toBe('2026-10-05'); // Thu → Mon
    expect(iso(startOfWeek(parseISO('2026-10-05')!))).toBe('2026-10-05'); // Mon → Mon
    expect(iso(startOfWeek(parseISO('2026-10-11')!))).toBe('2026-10-05'); // Sun → Mon
  });

  it('weekDays returns 7 Mon→Sun dates', () => {
    const days = weekDays(parseISO('2026-10-08')!).map(iso);
    expect(days).toEqual([
      '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08',
      '2026-10-09', '2026-10-10', '2026-10-11',
    ]);
  });

  it('monthGridCells returns 42 Monday-first cells spanning the month', () => {
    const cells = monthGridCells(parseISO('2026-10-15')!).map(iso);
    expect(cells).toHaveLength(42);
    expect(cells[0]).toBe('2026-09-28');  // Monday before Oct 1 (a Thursday)
    expect(cells).toContain('2026-10-01');
    expect(cells).toContain('2026-10-31');
    expect(cells[41]).toBe('2026-11-08'); // trailing Sunday
  });

  it('monthGridCells handles a month starting on Monday', () => {
    // Jun 2026 starts on Monday
    const cells = monthGridCells(parseISO('2026-06-10')!).map(iso);
    expect(cells[0]).toBe('2026-06-01');
    expect(cells).toHaveLength(42);
  });

  it('groupByDate keys by ISO date, sorts by time, drops undated', () => {
    const sessions = [
      { id: 'b', kind: 'session', title: 'B', scheduledDate: '2026-10-05', scheduledTime: '16:00' },
      { id: 'a', kind: 'session', title: 'A', scheduledDate: '2026-10-05', scheduledTime: '14:00' },
      { id: 'n', kind: 'session', title: 'N', scheduledDate: '2026-10-05' }, // no time → last
      { id: 'x', kind: 'session', title: 'X' }, // no date → excluded
    ] as any;
    const map = groupByDate(sessions);
    expect([...map.keys()]).toEqual(['2026-10-05']);
    expect(map.get('2026-10-05')!.map((s) => s.id)).toEqual(['a', 'b', 'n']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd hugo-apps && npx vitest run src/devtoberfest-sessions-calendar/__tests__/calendar-core.test.ts`
Expected: FAIL — cannot resolve `../calendar-core`.

- [ ] **Step 3: Write minimal implementation**

```ts
// hugo-apps/src/devtoberfest-sessions-calendar/calendar-core.ts
import type { Session } from '../devtoberfest-schedule-shared/types';

export function iso(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function parseISO(s?: string): Date | null {
  if (!s) return null;
  const d = new Date(s + 'T00:00:00Z');
  return isNaN(d.getTime()) ? null : d;
}

export function addDays(date: Date, n: number): Date {
  const d = new Date(date.getTime());
  d.setUTCDate(d.getUTCDate() + n);
  return d;
}

export function addWeeks(date: Date, n: number): Date {
  return addDays(date, n * 7);
}

export function addMonths(date: Date, n: number): Date {
  const d = new Date(date.getTime());
  d.setUTCMonth(d.getUTCMonth() + n);
  return d;
}

// Monday-first weekday index: 0 = Monday … 6 = Sunday
function mondayIndex(date: Date): number {
  return (date.getUTCDay() + 6) % 7;
}

export function startOfWeek(date: Date): Date {
  return addDays(date, -mondayIndex(date));
}

export function weekDays(date: Date): Date[] {
  const start = startOfWeek(date);
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

export function monthGridCells(date: Date): Date[] {
  const firstOfMonth = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  const gridStart = startOfWeek(firstOfMonth);
  return Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));
}

export function groupByDate(sessions: Session[]): Map<string, Session[]> {
  const map = new Map<string, Session[]>();
  for (const s of sessions) {
    const d = parseISO(s.scheduledDate);
    if (!d) continue;
    const key = iso(d);
    (map.get(key) ?? map.set(key, []).get(key)!).push(s);
  }
  for (const list of map.values()) {
    list.sort((a, b) => {
      const ta = a.scheduledTime ?? '99:99';
      const tb = b.scheduledTime ?? '99:99';
      return ta.localeCompare(tb);
    });
  }
  return map;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd hugo-apps && npx vitest run src/devtoberfest-sessions-calendar/__tests__/calendar-core.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add hugo-apps/src/devtoberfest-sessions-calendar/calendar-core.ts hugo-apps/src/devtoberfest-sessions-calendar/__tests__/calendar-core.test.ts
git commit -m "feat(calendar): pure UTC date engine for Devtoberfest calendar"
```

---

### Task 2: Deterministic track colours

**Files:**
- Create: `hugo-apps/src/devtoberfest-sessions-calendar/track-colors.ts`
- Test: `hugo-apps/src/devtoberfest-sessions-calendar/__tests__/track-colors.test.ts`

**Interfaces:**
- Produces:
  - `type TrackColor = { bg: string; border: string; text: string }`
  - `buildTrackColorMap(trackNames: string[]): Map<string, TrackColor>` — distinct names sorted alphabetically, each assigned a palette entry by index (modulo palette length for overflow). Deterministic and stable regardless of input order/duplicates.
  - `legendFor(map: Map<string, TrackColor>): { trackName: string; color: TrackColor }[]` — entries in the map's alphabetical order.

- [ ] **Step 1: Write the failing test**

```ts
// hugo-apps/src/devtoberfest-sessions-calendar/__tests__/track-colors.test.ts
import { describe, it, expect } from 'vitest';
import { buildTrackColorMap, legendFor } from '../track-colors';

describe('track-colors', () => {
  it('assigns a stable colour per track regardless of input order/dupes', () => {
    const a = buildTrackColorMap(['CAP', 'ABAP', 'AI', 'ABAP']);
    const b = buildTrackColorMap(['AI', 'ABAP', 'CAP']);
    expect(a.get('ABAP')).toEqual(b.get('ABAP'));
    expect(a.get('CAP')).toEqual(b.get('CAP'));
    // sorted-alphabetical assignment: ABAP gets palette[0]
    expect([...a.keys()]).toEqual(['ABAP', 'AI', 'CAP']);
  });

  it('every colour has bg/border/text strings', () => {
    const m = buildTrackColorMap(['X']);
    const c = m.get('X')!;
    expect(typeof c.bg).toBe('string');
    expect(typeof c.border).toBe('string');
    expect(typeof c.text).toBe('string');
  });

  it('overflow past palette length wraps without throwing', () => {
    const many = Array.from({ length: 20 }, (_, i) => `T${String(i).padStart(2, '0')}`);
    const m = buildTrackColorMap(many);
    expect(m.size).toBe(20);
    for (const name of many) expect(m.get(name)).toBeTruthy();
  });

  it('legendFor lists tracks in alphabetical order', () => {
    const m = buildTrackColorMap(['CAP', 'ABAP']);
    expect(legendFor(m).map((e) => e.trackName)).toEqual(['ABAP', 'CAP']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd hugo-apps && npx vitest run src/devtoberfest-sessions-calendar/__tests__/track-colors.test.ts`
Expected: FAIL — cannot resolve `../track-colors`.

- [ ] **Step 3: Write minimal implementation**

```ts
// hugo-apps/src/devtoberfest-sessions-calendar/track-colors.ts
export type TrackColor = { bg: string; border: string; text: string };

// Horizon-derived palette (bg tint, strong border, dark text). Extend freely.
const PALETTE: TrackColor[] = [
  { bg: '#eaf4ff', border: '#0a6ed1', text: '#08386b' }, // blue
  { bg: '#eafaf0', border: '#107e3e', text: '#0a5c2e' }, // green
  { bg: '#fdeef2', border: '#d20a2e', text: '#8b0a20' }, // red
  { bg: '#fef3e7', border: '#e76500', text: '#8a3d00' }, // orange
  { bg: '#f3edfb', border: '#7858a8', text: '#432c66' }, // purple
  { bg: '#e9f7f8', border: '#0a8189', text: '#064a4f' }, // teal
  { bg: '#fdf6e3', border: '#b8860b', text: '#6b4e00' }, // gold
  { bg: '#f0f2f4', border: '#5b738b', text: '#33404d' }, // slate
];

export function buildTrackColorMap(trackNames: string[]): Map<string, TrackColor> {
  const distinct = [...new Set(trackNames.filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const map = new Map<string, TrackColor>();
  distinct.forEach((name, i) => map.set(name, PALETTE[i % PALETTE.length]));
  return map;
}

export function legendFor(map: Map<string, TrackColor>): { trackName: string; color: TrackColor }[] {
  return [...map.entries()].map(([trackName, color]) => ({ trackName, color }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd hugo-apps && npx vitest run src/devtoberfest-sessions-calendar/__tests__/track-colors.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add hugo-apps/src/devtoberfest-sessions-calendar/track-colors.ts hugo-apps/src/devtoberfest-sessions-calendar/__tests__/track-colors.test.ts
git commit -m "feat(calendar): deterministic track colour palette"
```

---

### Task 3: MonthGrid.vue

**Files:**
- Create: `hugo-apps/src/devtoberfest-sessions-calendar/MonthGrid.vue`

**Interfaces:**
- Consumes: `calendar-core` (`monthGridCells`, `iso`, `groupByDate` output), `track-colors` (`TrackColor`), `Session` type, `youtubeThumb` (not needed here — chips are text only).
- Props:
  - `cursor: Date` — any date in the month to render.
  - `byDate: Map<string, Session[]>` — grouped sessions (already track-filtered by parent).
  - `colors: Map<string, TrackColor>`
  - `today: string` — `iso()` of today.
  - `isAuthenticated: boolean`
  - `maxChips?: number` (default 3)
- Emits:
  - `select(session: Session)` — chip clicked.
  - `openDay(date: Date)` — day number or "+N more" clicked.

- [ ] **Step 1: Write the component**

```vue
<!-- hugo-apps/src/devtoberfest-sessions-calendar/MonthGrid.vue -->
<script setup lang="ts">
import { computed } from 'vue';
import { monthGridCells, iso } from './calendar-core';
import type { TrackColor } from './track-colors';
import type { Session } from '../devtoberfest-schedule-shared/types';

const props = withDefaults(defineProps<{
  cursor: Date;
  byDate: Map<string, Session[]>;
  colors: Map<string, TrackColor>;
  today: string;
  isAuthenticated: boolean;
  maxChips?: number;
}>(), { maxChips: 3 });

const emit = defineEmits<{
  (e: 'select', s: Session): void;
  (e: 'openDay', d: Date): void;
}>();

const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const cells = computed(() => monthGridCells(props.cursor));
const cursorMonth = computed(() => props.cursor.getUTCMonth());

function sessionsFor(d: Date): Session[] {
  return props.byDate.get(iso(d)) ?? [];
}
function chipColor(s: Session): TrackColor | null {
  return s.trackName ? props.colors.get(s.trackName) ?? null : null;
}
function chipStyle(s: Session) {
  const c = chipColor(s);
  return c ? { background: c.bg, borderLeftColor: c.border, color: c.text } : {};
}
</script>

<template>
  <div class="mg" role="grid" aria-label="Month calendar">
    <div class="mg-head" role="row">
      <div v-for="d in DOW" :key="d" class="mg-dow" role="columnheader">{{ d }}</div>
    </div>
    <div class="mg-body">
      <div
        v-for="cell in cells"
        :key="iso(cell)"
        class="mg-cell"
        :class="{ 'mg-cell--other': cell.getUTCMonth() !== cursorMonth, 'mg-cell--today': iso(cell) === today }"
        role="gridcell"
      >
        <button class="mg-daynum" @click="emit('openDay', cell)" :aria-label="'Open ' + iso(cell)">
          {{ cell.getUTCDate() }}
        </button>
        <template v-for="s in sessionsFor(cell).slice(0, maxChips)" :key="s.id">
          <button
            class="mg-chip"
            :class="{ 'mg-chip--complete': isAuthenticated && (s as any).complete }"
            :style="chipStyle(s)"
            @click="emit('select', s)"
            :title="s.title"
          >
            <span v-if="s.scheduledTime" class="mg-chip-t">{{ s.scheduledTime }}</span>
            <span class="mg-chip-n">{{ s.title }}</span>
          </button>
        </template>
        <button
          v-if="sessionsFor(cell).length > maxChips"
          class="mg-more"
          @click="emit('openDay', cell)"
        >+{{ sessionsFor(cell).length - maxChips }} more</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mg { border: 1px solid var(--sapList_BorderColor, #e4e7ed); border-radius: 6px; overflow: hidden; }
.mg-head, .mg-body { display: grid; grid-template-columns: repeat(7, 1fr); }
.mg-dow {
  padding: 0.4rem; text-align: center; font-size: 0.72rem; text-transform: uppercase;
  letter-spacing: 0.04em; font-weight: 700; color: var(--sapContent_LabelColor, #6a6d70);
  background: var(--sapList_HeaderBackground, #f5f6f7); border-bottom: 1px solid var(--sapList_BorderColor, #e4e7ed);
}
.mg-cell {
  min-height: 6rem; padding: 0.25rem; border-right: 1px solid var(--sapList_BorderColor, #e4e7ed);
  border-bottom: 1px solid var(--sapList_BorderColor, #e4e7ed); display: flex; flex-direction: column; gap: 0.15rem;
}
.mg-cell--other { background: var(--sapList_HeaderBackground, #fafafa); }
.mg-daynum {
  align-self: flex-start; border: none; background: transparent; cursor: pointer; font: inherit;
  font-size: 0.75rem; font-weight: 600; color: var(--sapContent_LabelColor, #6a6d70); padding: 0.1rem 0.25rem; border-radius: 4px;
}
.mg-cell--today .mg-daynum { background: var(--sapButton_Emphasized_Background, #0a6ed1); color: #fff; }
.mg-chip {
  display: block; width: 100%; text-align: left; border: none; border-left: 3px solid transparent;
  border-radius: 4px; padding: 0.1rem 0.35rem; cursor: pointer; font: inherit; font-size: 0.72rem;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; background: var(--sapList_Background, #f5f6f7);
}
.mg-chip--complete { outline: 1px solid var(--sapSuccessBorderColor, #107e3e); }
.mg-chip-t { font-variant-numeric: tabular-nums; opacity: 0.75; margin-right: 0.25rem; }
.mg-more { align-self: flex-start; border: none; background: transparent; cursor: pointer; font: inherit;
  font-size: 0.72rem; font-weight: 600; color: var(--sapLinkColor, #0a6ed1); padding: 0.1rem 0.25rem; }
</style>
```

- [ ] **Step 2: Commit** (component verified together with App in Task 6's smoke test)

```bash
git add hugo-apps/src/devtoberfest-sessions-calendar/MonthGrid.vue
git commit -m "feat(calendar): MonthGrid view component"
```

---

### Task 4: WeekAgenda.vue

**Files:**
- Create: `hugo-apps/src/devtoberfest-sessions-calendar/WeekAgenda.vue`

**Interfaces:**
- Consumes: `calendar-core` (`weekDays`, `iso`), `track-colors` (`TrackColor`), `Session`.
- Props: `cursor: Date`, `byDate: Map<string, Session[]>`, `colors: Map<string, TrackColor>`, `today: string`, `isAuthenticated: boolean`.
- Emits: `select(session: Session)`.

- [ ] **Step 1: Write the component**

```vue
<!-- hugo-apps/src/devtoberfest-sessions-calendar/WeekAgenda.vue -->
<script setup lang="ts">
import { computed } from 'vue';
import { weekDays, iso } from './calendar-core';
import type { TrackColor } from './track-colors';
import type { Session } from '../devtoberfest-schedule-shared/types';

const props = defineProps<{
  cursor: Date;
  byDate: Map<string, Session[]>;
  colors: Map<string, TrackColor>;
  today: string;
  isAuthenticated: boolean;
}>();
const emit = defineEmits<{ (e: 'select', s: Session): void }>();

const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const days = computed(() => weekDays(props.cursor));
function sessionsFor(d: Date): Session[] { return props.byDate.get(iso(d)) ?? []; }
function borderColor(s: Session): string {
  const c = s.trackName ? props.colors.get(s.trackName) : null;
  return c ? c.border : 'var(--sapContent_ForegroundBorderColor, #e4e7ed)';
}
</script>

<template>
  <div class="wk">
    <div v-for="(d, i) in days" :key="iso(d)" class="wk-col">
      <div class="wk-head" :class="{ 'wk-head--today': iso(d) === today }">
        <span class="wk-dow">{{ DOW[i] }}</span>
        <span class="wk-dnum">{{ d.getUTCDate() }}</span>
      </div>
      <div class="wk-body">
        <button
          v-for="s in sessionsFor(d)"
          :key="s.id"
          class="wk-card"
          :class="{ 'wk-card--complete': isAuthenticated && (s as any).complete }"
          :style="{ borderLeftColor: borderColor(s) }"
          @click="emit('select', s)"
        >
          <span v-if="s.scheduledTime" class="wk-t">{{ s.scheduledTime }}</span>
          <span class="wk-n">{{ s.title }}</span>
          <span v-if="isAuthenticated && (s as any).complete" class="wk-done" aria-label="Completed">✓</span>
        </button>
        <div v-if="sessionsFor(d).length === 0" class="wk-empty" aria-label="No sessions">—</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.wk { display: grid; grid-template-columns: repeat(7, 1fr); border: 1px solid var(--sapList_BorderColor, #e4e7ed); border-radius: 6px; overflow: hidden; }
.wk-col { border-left: 1px solid var(--sapList_BorderColor, #e4e7ed); min-height: 12rem; }
.wk-col:first-child { border-left: none; }
.wk-head { padding: 0.35rem; text-align: center; border-bottom: 1px solid var(--sapList_BorderColor, #e4e7ed); background: var(--sapList_HeaderBackground, #f5f6f7); }
.wk-head--today .wk-dnum { color: var(--sapButton_Emphasized_Background, #0a6ed1); }
.wk-dow { display: block; font-size: 0.65rem; text-transform: uppercase; color: var(--sapContent_LabelColor, #6a6d70); }
.wk-dnum { font-size: 1rem; font-weight: 700; }
.wk-body { padding: 0.35rem; display: flex; flex-direction: column; gap: 0.35rem; }
.wk-card {
  border: 1px solid var(--sapList_BorderColor, #e4e7ed); border-left: 4px solid transparent; border-radius: 6px;
  padding: 0.35rem 0.4rem; cursor: pointer; font: inherit; text-align: left; background: var(--sapBaseColor, #fff);
}
.wk-card--complete { background: var(--sapSuccessBackground, #f1fdf6); }
.wk-t { display: block; font-size: 0.65rem; color: var(--sapContent_LabelColor, #6a6d70); font-variant-numeric: tabular-nums; }
.wk-n { display: block; font-size: 0.75rem; font-weight: 600; line-height: 1.25; }
.wk-done { color: var(--sapPositiveColor, #107e3e); font-size: 0.7rem; font-weight: 700; }
.wk-empty { color: var(--sapContent_DisabledTextColor, #b0b0b0); font-size: 0.75rem; text-align: center; padding: 0.75rem 0; }
</style>
```

- [ ] **Step 2: Commit**

```bash
git add hugo-apps/src/devtoberfest-sessions-calendar/WeekAgenda.vue
git commit -m "feat(calendar): WeekAgenda view component"
```

---

### Task 5: DayAgenda.vue

**Files:**
- Create: `hugo-apps/src/devtoberfest-sessions-calendar/DayAgenda.vue`

**Interfaces:**
- Consumes: `calendar-core` (`iso`), `track-colors` (`TrackColor`), `Session`, `youtubeThumb` from `../devtoberfest-schedule-shared/completion`.
- Props: `cursor: Date`, `byDate: Map<string, Session[]>`, `colors: Map<string, TrackColor>`, `isAuthenticated: boolean`.
- Emits: `select(session: Session)`.

- [ ] **Step 1: Write the component**

```vue
<!-- hugo-apps/src/devtoberfest-sessions-calendar/DayAgenda.vue -->
<script setup lang="ts">
import { computed } from 'vue';
import { iso } from './calendar-core';
import type { TrackColor } from './track-colors';
import type { Session } from '../devtoberfest-schedule-shared/types';
import { youtubeThumb } from '../devtoberfest-schedule-shared/completion';

const props = defineProps<{
  cursor: Date;
  byDate: Map<string, Session[]>;
  colors: Map<string, TrackColor>;
  isAuthenticated: boolean;
}>();
const emit = defineEmits<{ (e: 'select', s: Session): void }>();

const sessions = computed(() => props.byDate.get(iso(props.cursor)) ?? []);
function borderColor(s: Session): string {
  const c = s.trackName ? props.colors.get(s.trackName) : null;
  return c ? c.border : 'var(--sapContent_ForegroundBorderColor, #e4e7ed)';
}
function onThumbError(ev: Event) {
  const img = ev.target as HTMLImageElement;
  img.style.display = 'none';
  const ph = img.nextElementSibling as HTMLElement | null;
  if (ph) ph.style.display = 'flex';
}
</script>

<template>
  <div class="da">
    <div v-if="sessions.length === 0" class="da-empty" aria-label="No sessions">No sessions this day.</div>
    <button
      v-for="s in sessions"
      :key="s.id"
      class="da-card"
      :class="{ 'da-card--complete': isAuthenticated && (s as any).complete }"
      :style="{ borderLeftColor: borderColor(s) }"
      @click="emit('select', s)"
    >
      <div class="da-thumb-wrap">
        <template v-if="youtubeThumb((s as any).youtubeUrl || '')">
          <img :src="youtubeThumb((s as any).youtubeUrl)!" :alt="s.title" class="da-thumb" loading="lazy" @error="onThumbError" />
          <div class="da-thumb-ph" style="display:none" aria-hidden="true"></div>
        </template>
        <div v-else class="da-thumb-ph" aria-hidden="true"></div>
      </div>
      <div class="da-meta">
        <span v-if="s.scheduledTime" class="da-time">{{ s.scheduledTime }}</span>
        <span class="da-title">{{ s.title }}</span>
        <span v-if="s.trackName" class="da-track">{{ s.trackName }}</span>
        <span v-if="isAuthenticated && (s as any).complete" class="da-done" aria-label="Completed">✓ Completed</span>
      </div>
    </button>
  </div>
</template>

<style scoped>
.da { display: flex; flex-direction: column; gap: 0.6rem; }
.da-empty { padding: 1.5rem; text-align: center; color: var(--sapContent_LabelColor, #6a6d70); }
.da-card {
  display: flex; gap: 0.75rem; align-items: center; border: 1px solid var(--sapList_BorderColor, #e4e7ed);
  border-left: 5px solid transparent; border-radius: 8px; padding: 0.6rem; cursor: pointer; font: inherit;
  text-align: left; background: var(--sapBaseColor, #fff);
}
.da-card--complete { background: var(--sapSuccessBackground, #f1fdf6); }
.da-thumb-wrap { position: relative; width: 7.5rem; aspect-ratio: 16 / 9; flex: 0 0 auto; border-radius: 6px; overflow: hidden; background: var(--sapShellColor, #354a5e); }
.da-thumb { width: 100%; height: 100%; object-fit: cover; display: block; }
.da-thumb-ph { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; background: linear-gradient(135deg, var(--sapShellColor, #354a5e) 0%, #1a2e3e 100%); color: rgba(255,255,255,0.4); font-size: 1.25rem; }
.da-thumb-ph::after { content: '▶'; }
.da-meta { display: flex; flex-direction: column; gap: 0.15rem; }
.da-time { font-size: 0.72rem; color: var(--sapContent_LabelColor, #6a6d70); font-variant-numeric: tabular-nums; }
.da-title { font-size: 1rem; font-weight: 600; }
.da-track { font-size: 0.72rem; color: var(--sapContent_LabelColor, #6a6d70); }
.da-done { font-size: 0.72rem; color: var(--sapPositiveColor, #107e3e); font-weight: 700; }
</style>
```

- [ ] **Step 2: Commit**

```bash
git add hugo-apps/src/devtoberfest-sessions-calendar/DayAgenda.vue
git commit -m "feat(calendar): DayAgenda view component"
```

---

### Task 6: Rewrite App.vue controller + view smoke test

**Files:**
- Modify: `hugo-apps/src/devtoberfest-sessions-calendar/App.vue` (full rewrite)
- Test: `hugo-apps/src/devtoberfest-sessions-calendar/__tests__/App.view.test.ts`

**Interfaces:**
- Consumes: `feed.ts` (`fetchFeed`, `fetchMyCompletions`), `completion.ts` (`mergeCompletion`), `useAuth`, `EditionPicker`, `PointsBanner`, `DetailPanel`, `calendar-core` (`iso`, `parseISO`, `addMonths`, `addWeeks`, `addDays`, `startOfWeek`, `groupByDate`), `track-colors` (`buildTrackColorMap`, `legendFor`), `MonthGrid`, `WeekAgenda`, `DayAgenda`.
- Produces: the mounted island (no external interface).

- [ ] **Step 1: Write the failing smoke test**

```ts
// hugo-apps/src/devtoberfest-sessions-calendar/__tests__/App.view.test.ts
//
// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';

const FEED = {
  activeEditionId: 'e1',
  editions: [{ id: 'e1', name: 'Devtoberfest 2026', isCurrent: true, startDate: '2026-10-01', endDate: '2026-10-31' }],
  sessions: [
    { id: 's1', kind: 'session', title: 'A', trackName: 'CAP', scheduledDate: '2026-10-05', scheduledTime: '14:00' },
    { id: 's2', kind: 'session', title: 'B', trackName: 'ABAP', scheduledDate: '2026-10-05', scheduledTime: '15:00' },
    { id: 's3', kind: 'session', title: 'C', trackName: 'AI', scheduledDate: '2026-10-05', scheduledTime: '16:00' },
    { id: 's4', kind: 'session', title: 'D', trackName: 'BTP', scheduledDate: '2026-10-05', scheduledTime: '17:00' },
  ],
  activities: [],
};

vi.mock('../../devtoberfest-schedule-shared/feed', () => ({
  fetchFeed: vi.fn(async () => FEED),
  fetchMyCompletions: vi.fn(async () => ({ authenticated: false })),
}));

import App from '../App.vue';

describe('calendar App views', () => {
  beforeEach(() => vi.clearAllMocks());

  it('defaults to month view on the edition start month and shows +N more on a busy day', async () => {
    const wrapper = mount(App);
    await flushPromises();
    // month grid renders 42 day cells
    expect(wrapper.findAll('.mg-cell')).toHaveLength(42);
    // Oct 5 has 4 sessions, maxChips=3 → "+1 more"
    expect(wrapper.html()).toContain('+1 more');
  });

  it('switches to week and day views', async () => {
    const wrapper = mount(App);
    await flushPromises();
    const buttons = wrapper.findAll('.cal-switch button');
    // [Month, Week, Day]
    await buttons[1].trigger('click');
    expect(wrapper.find('.wk').exists()).toBe(true);
    await buttons[2].trigger('click');
    expect(wrapper.find('.da').exists()).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd hugo-apps && npx vitest run src/devtoberfest-sessions-calendar/__tests__/App.view.test.ts`
Expected: FAIL — App.vue still renders the old `.sc-table` (no `.mg-cell` / `.cal-switch`).

- [ ] **Step 3: Rewrite App.vue**

```vue
<!-- hugo-apps/src/devtoberfest-sessions-calendar/App.vue -->
<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { fetchFeed, fetchMyCompletions } from '../devtoberfest-schedule-shared/feed';
import { mergeCompletion } from '../devtoberfest-schedule-shared/completion';
import { useAuth } from '../devtoberfest-schedule-shared/useAuth';
import EditionPicker from '../devtoberfest-schedule-shared/EditionPicker.vue';
import PointsBanner from '../devtoberfest-schedule-shared/PointsBanner.vue';
import DetailPanel from '../devtoberfest-schedule-shared/DetailPanel.vue';
import type { Feed, ScheduleRow, Session } from '../devtoberfest-schedule-shared/types';
import {
  iso, parseISO, addMonths, addWeeks, addDays, startOfWeek, groupByDate,
} from './calendar-core';
import { buildTrackColorMap, legendFor } from './track-colors';
import MonthGrid from './MonthGrid.vue';
import WeekAgenda from './WeekAgenda.vue';
import DayAgenda from './DayAgenda.vue';

type ViewMode = 'month' | 'week' | 'day';

const { isAuthenticated } = useAuth();

const loading = ref(true);
const error = ref('');
const editionId = ref<string | null>(null);
const feed = ref<Feed | null>(null);
const sessions = ref<ScheduleRow[]>([]);
const earnedPoints = ref(0);
const maxPoints = ref(0);
const selectedRow = ref<ScheduleRow | null>(null);
const filterTrack = ref('');
const viewMode = ref<ViewMode>('month');
const cursor = ref<Date>(new Date());

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

async function loadData(edition?: string) {
  loading.value = true;
  error.value = '';
  try {
    const [feedData, myData] = await Promise.all([fetchFeed(edition), fetchMyCompletions(edition)]);
    feed.value = feedData;
    editionId.value = edition ?? feedData.activeEditionId;
    const merged = mergeCompletion(feedData, myData);
    sessions.value = merged.rows.filter((r) => r.kind === 'session');
    earnedPoints.value = merged.earnedPoints;
    maxPoints.value = merged.maxPoints;
    cursor.value = initialCursor();
  } catch (e: any) {
    error.value = e?.message ?? 'Failed to load sessions.';
  } finally {
    loading.value = false;
  }
}

function initialCursor(): Date {
  const active = feed.value?.editions.find((e) => e.id === editionId.value) ?? feed.value?.editions[0];
  const fromEdition = parseISO(active?.startDate);
  if (fromEdition) return new Date(Date.UTC(fromEdition.getUTCFullYear(), fromEdition.getUTCMonth(), 1));
  const dated = sessions.value.map((s) => (s as any).scheduledDate).filter(Boolean).sort();
  const earliest = parseISO(dated[0]);
  if (earliest) return new Date(Date.UTC(earliest.getUTCFullYear(), earliest.getUTCMonth(), 1));
  return new Date();
}

async function onEditionChange(id: string) { editionId.value = id; await loadData(id); }

const trackOptions = computed(() => {
  const set = new Set<string>();
  sessions.value.forEach((r) => { if ((r as any).trackName) set.add((r as any).trackName); });
  return Array.from(set).sort();
});

// colours assigned over the FULL track set so they stay stable under filtering
const colorMap = computed(() => buildTrackColorMap(trackOptions.value));
const legend = computed(() => legendFor(colorMap.value));

const completeCount = computed(() => sessions.value.filter((r) => r.complete).length);

const filteredSessions = computed<Session[]>(() => {
  const base = sessions.value as Session[];
  return filterTrack.value ? base.filter((r) => (r as any).trackName === filterTrack.value) : base;
});

const byDate = computed(() => groupByDate(filteredSessions.value));
const todayIso = iso(new Date());

const title = computed(() => {
  const c = cursor.value;
  if (viewMode.value === 'month') return `${MONTHS[c.getUTCMonth()]} ${c.getUTCFullYear()}`;
  if (viewMode.value === 'week') {
    const start = startOfWeek(c); const end = addDays(start, 6);
    return `${MONTHS[start.getUTCMonth()].slice(0,3)} ${start.getUTCDate()} – ${MONTHS[end.getUTCMonth()].slice(0,3)} ${end.getUTCDate()}, ${end.getUTCFullYear()}`;
  }
  return `${MONTHS[c.getUTCMonth()]} ${c.getUTCDate()}, ${c.getUTCFullYear()}`;
});

function prev() {
  cursor.value = viewMode.value === 'month' ? addMonths(cursor.value, -1)
    : viewMode.value === 'week' ? addWeeks(cursor.value, -1) : addDays(cursor.value, -1);
}
function next() {
  cursor.value = viewMode.value === 'month' ? addMonths(cursor.value, 1)
    : viewMode.value === 'week' ? addWeeks(cursor.value, 1) : addDays(cursor.value, 1);
}
function goToday() { cursor.value = new Date(); }
function openDay(d: Date) { cursor.value = d; viewMode.value = 'day'; }

onMounted(() => loadData());
</script>

<template>
  <div class="sc-wrap">
    <div class="sc-header">
      <h1 class="sc-title">Devtoberfest Calendar</h1>
      <EditionPicker v-if="feed" :editions="feed.editions" :model-value="editionId" @update:model-value="onEditionChange" />
    </div>

    <PointsBanner v-if="!loading && !error" :earned-points="earnedPoints" :max-points="maxPoints" :complete-count="completeCount" :is-authenticated="isAuthenticated" />

    <div v-if="loading" class="sc-state">Loading sessions…</div>
    <div v-else-if="error" class="sc-state sc-state--error">
      <ui5-illustrated-message name="UnableToLoad" size="Scene"><div slot="subtitle">{{ error }}</div></ui5-illustrated-message>
    </div>

    <template v-else>
      <!-- toolbar -->
      <div class="cal-toolbar">
        <div class="cal-nav">
          <button class="cal-navbtn" @click="prev" aria-label="Previous">‹</button>
          <button class="cal-navbtn" @click="next" aria-label="Next">›</button>
        </div>
        <span class="cal-title">{{ title }}</span>
        <button class="cal-today" @click="goToday">Today</button>
        <label class="sc-field cal-filter">
          <span class="sr-only">Track</span>
          <select v-model="filterTrack" aria-label="Filter by track">
            <option value="">All tracks</option>
            <option v-for="t in trackOptions" :key="t" :value="t">{{ t }}</option>
          </select>
        </label>
        <div class="cal-switch" role="tablist">
          <button :class="{ active: viewMode === 'month' }" @click="viewMode = 'month'">Month</button>
          <button :class="{ active: viewMode === 'week' }" @click="viewMode = 'week'">Week</button>
          <button :class="{ active: viewMode === 'day' }" @click="viewMode = 'day'">Day</button>
        </div>
      </div>

      <!-- legend -->
      <div v-if="legend.length" class="cal-legend">
        <span v-for="l in legend" :key="l.trackName" class="cal-legend-item">
          <span class="cal-legend-dot" :style="{ background: l.color.border }"></span>{{ l.trackName }}
        </span>
      </div>

      <MonthGrid v-if="viewMode === 'month'" :cursor="cursor" :by-date="byDate" :colors="colorMap" :today="todayIso" :is-authenticated="isAuthenticated" @select="selectedRow = $event as any" @open-day="openDay" />
      <WeekAgenda v-else-if="viewMode === 'week'" :cursor="cursor" :by-date="byDate" :colors="colorMap" :today="todayIso" :is-authenticated="isAuthenticated" @select="selectedRow = $event as any" />
      <DayAgenda v-else :cursor="cursor" :by-date="byDate" :colors="colorMap" :is-authenticated="isAuthenticated" @select="selectedRow = $event as any" />
    </template>

    <DetailPanel :row="selectedRow ?? null" @close="selectedRow = null" />
  </div>
</template>

<style scoped>
.sc-wrap { font-family: var(--sapFontFamily, '72', 'Helvetica Neue', Arial, sans-serif); font-size: var(--sapFontSize, 0.875rem); color: var(--sapTextColor, #32363a); padding: 1rem; display: flex; flex-direction: column; gap: 1rem; }
.sc-header { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 0.75rem; }
.sc-title { font-size: var(--sapFontHeader2Size, 1.5rem); font-weight: 700; margin: 0; }
.sc-state { padding: 2rem; text-align: center; color: var(--sapContent_LabelColor, #6a6d70); }
.sc-state--error { color: var(--sapNegativeColor, #b00020); }
.cal-toolbar { display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap; }
.cal-nav { display: flex; gap: 0.25rem; }
.cal-navbtn { width: 2rem; height: 2rem; border: 1px solid var(--sapField_BorderColor, #89919a); background: var(--sapField_Background, #fff); border-radius: 0.25rem; cursor: pointer; font-size: 1.1rem; line-height: 1; }
.cal-title { font-weight: 700; font-size: 1rem; min-width: 10rem; }
.cal-today { border: 1px solid var(--sapButton_Emphasized_Background, #0a6ed1); color: var(--sapButton_Emphasized_Background, #0a6ed1); background: transparent; border-radius: 0.25rem; padding: 0.35rem 0.9rem; cursor: pointer; font: inherit; }
.cal-filter select { min-width: 9rem; padding: 0.35rem 0.5rem; border: 1px solid var(--sapField_BorderColor, #89919a); border-radius: 0.25rem; background: var(--sapField_Background, #fff); color: inherit; font: inherit; }
.cal-switch { display: inline-flex; margin-left: auto; border: 1px solid var(--sapField_BorderColor, #89919a); border-radius: 0.25rem; overflow: hidden; }
.cal-switch button { border: none; background: var(--sapField_Background, #fff); padding: 0.35rem 0.9rem; cursor: pointer; font: inherit; border-left: 1px solid var(--sapList_BorderColor, #e4e7ed); }
.cal-switch button:first-child { border-left: none; }
.cal-switch button.active { background: var(--sapButton_Emphasized_Background, #0a6ed1); color: #fff; }
.cal-legend { display: flex; flex-wrap: wrap; gap: 0.9rem; font-size: 0.75rem; color: var(--sapContent_LabelColor, #6a6d70); }
.cal-legend-item { display: inline-flex; align-items: center; gap: 0.35rem; }
.cal-legend-dot { width: 0.7rem; height: 0.7rem; border-radius: 3px; display: inline-block; }
.sc-field { display: flex; flex-direction: column; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
</style>
```

- [ ] **Step 4: Run the smoke test to verify it passes**

Run: `cd hugo-apps && npx vitest run src/devtoberfest-sessions-calendar/__tests__/App.view.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add hugo-apps/src/devtoberfest-sessions-calendar/App.vue hugo-apps/src/devtoberfest-sessions-calendar/__tests__/App.view.test.ts
git commit -m "feat(calendar): rewrite App.vue as Month/Week/Day calendar controller"
```

---

### Task 7: Remove dead pivot code + full build verification

**Files:**
- Delete: `hugo-apps/src/devtoberfest-sessions-calendar/calendar-grid.ts`
- Delete: `hugo-apps/src/devtoberfest-sessions-calendar/__tests__/calendar-grid.test.ts`

- [ ] **Step 1: Confirm nothing else imports calendar-grid**

Run: `cd "D:/projects/tutorials-poc/.claude/worktrees/devtoberfest-calendar-redesign" && grep -rn "calendar-grid\|buildCalendar\|weekdayOf" hugo-apps/src/ srv/ scripts/`
Expected: only matches inside the two files about to be deleted. If anything else references them, stop and reconcile.

- [ ] **Step 2: Delete the dead files**

```bash
git rm hugo-apps/src/devtoberfest-sessions-calendar/calendar-grid.ts \
       hugo-apps/src/devtoberfest-sessions-calendar/__tests__/calendar-grid.test.ts
```

- [ ] **Step 3: Run the full unit suite for the island**

Run: `cd hugo-apps && npx vitest run src/devtoberfest-sessions-calendar/`
Expected: PASS (calendar-core, track-colors, App.view — all green; no reference to the deleted test).

- [ ] **Step 4: Type-check + build the island bundle**

Run: `cd hugo-apps && npx vue-tsc --noEmit -p tsconfig.json 2>&1 | head -30 && npm run build 2>&1 | tail -20`
Expected: no type errors in the calendar island; Vite build emits `devtoberfest-sessions-calendar` bundle without error. (If `vue-tsc` is not wired, rely on the Vite build's type step.)

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore(calendar): remove legacy week-pivot calendar-grid"
```

---

## Post-Implementation Verification (mandatory — Tom's #1 rule)

Not a code step — do this before calling the feature done, after the branch is deployed to DEV:

1. Load `/devtoberfest/calendar/` **through the approuter in a real browser** (Playwright with Tom's session — curl is auth-blocked and won't render the island).
2. Verify: Month view is the default and lands on the edition's month; ‹ › changes month; **Today** jumps to the current month; track filter narrows sessions and colours stay stable; a day with >3 sessions shows "+N more"; clicking "+N more" or a day number opens the Day view for that date; a chip/card opens the `DetailPanel` drawer; Week view shows 7 columns; completed sessions (when logged in) show ✓.
3. Only then update status to done.

---

## Self-Review

**Spec coverage:**
- Three views (Month/Week/Day) → Tasks 3/4/5 + switcher in Task 6. ✔
- Month default on edition start month → `initialCursor()` in Task 6. ✔
- ‹ › nav + Today → Task 6 `prev/next/goToday`. ✔
- Colour-code by track + stable under filter → Task 2 + `colorMap` over full track set in Task 6. ✔
- 3 chips + "+N more" → Day → Task 3 `maxChips` + `openDay`. ✔
- Agenda-column Week/Day → Tasks 4/5. ✔
- Reuse feed/completion/DetailPanel/EditionPicker/PointsBanner/youtubeThumb → Task 6 imports; Task 5 thumbnails. ✔
- Fail-soft loading/error/empty → Task 6 template retains states; Day/Week empty markers. ✔
- Pure core unit-tested (boundaries, UTC grouping, sort) → Task 1. ✔
- Remove dead pivot → Task 7. ✔
- Live browser verification → Post-Implementation section. ✔

**Placeholder scan:** No TBD/TODO in code steps; every code step has full content. ✔

**Type consistency:** `iso/parseISO/addDays/addWeeks/addMonths/startOfWeek/weekDays/monthGridCells/groupByDate` defined in Task 1 and consumed with matching signatures in Tasks 3–6. `TrackColor` / `buildTrackColorMap` / `legendFor` defined in Task 2, consumed in Tasks 3–6. `MonthGrid` emits `select`/`openDay`, `WeekAgenda`/`DayAgenda` emit `select` — all wired in Task 6. `DetailPanel` used with its real props (`row`) and emit (`close`). ✔
